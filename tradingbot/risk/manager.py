"""Core risk manager: position sizing, ATR-based stops/trailing, and the
3% daily / 5% weekly drawdown circuit breakers.

The breakers measure drawdown from the *high-water mark within the current
period* (UTC day / ISO week), recomputed on every mark-to-market -- so an
unrealized loss counts even if no position is closed. Once tripped,
`should_flatten_all()` returns True (the caller is expected to close all
positions) and `can_open_new_position()` returns False until the period
rolls over.
"""
from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from tradingbot.config import RiskConfig


@dataclass
class Position:
    symbol: str
    qty: float
    entry_price: float
    entry_date: pd.Timestamp
    initial_stop: float
    stop: float
    atr_at_entry: float
    highest_price: float

    @property
    def risk_per_unit(self) -> float:
        return self.entry_price - self.initial_stop

    def r_multiple(self, price: float) -> float:
        rpu = self.risk_per_unit
        if rpu <= 0:
            return 0.0
        return (price - self.entry_price) / rpu


@dataclass
class Trade:
    symbol: str
    entry_date: pd.Timestamp
    exit_date: pd.Timestamp
    entry_price: float
    exit_price: float
    qty: float
    r_multiple: float
    pnl: float
    exit_reason: str  # "stop" | "trail" | "signal" | "circuit_breaker"


class RiskManager:
    def __init__(self, starting_equity: float, config: RiskConfig):
        self.config = config
        self.cash = starting_equity
        self.positions: dict[str, Position] = {}
        self._last_prices: dict[str, float] = {}

        self.current_day: pd.Timestamp | None = None
        self.current_week: tuple[int, int] | None = None

        self.day_start_equity = starting_equity
        self.week_start_equity = starting_equity
        self.day_hwm = starting_equity
        self.week_hwm = starting_equity

        self.halted_today = False
        self.halted_week = False

        self.dd_day = 0.0
        self.dd_week = 0.0

    # ------------------------------------------------------------------
    # Equity / period bookkeeping
    # ------------------------------------------------------------------
    @property
    def equity(self) -> float:
        mtm = sum(
            pos.qty * self._last_prices.get(pos.symbol, pos.entry_price)
            for pos in self.positions.values()
        )
        return self.cash + mtm

    def begin_bar(self, date: pd.Timestamp) -> None:
        """Call once per bar, before mark_to_market, to roll day/week boundaries."""
        day = date.normalize()
        iso = date.isocalendar()
        week_key = (int(iso.year), int(iso.week))

        if self.current_day is None:
            self.current_day = day
            self.current_week = week_key
            return

        if day != self.current_day:
            self.current_day = day
            eq = self.equity
            self.day_start_equity = eq
            self.day_hwm = eq
            self.halted_today = False
            self.dd_day = 0.0

        if week_key != self.current_week:
            self.current_week = week_key
            eq = self.equity
            self.week_start_equity = eq
            self.week_hwm = eq
            self.halted_week = False
            self.dd_week = 0.0

    def mark_to_market(self, prices: dict[str, float]) -> None:
        self._last_prices.update(prices)
        eq = self.equity
        self.day_hwm = max(self.day_hwm, eq)
        self.week_hwm = max(self.week_hwm, eq)
        self.dd_day = (self.day_hwm - eq) / self.day_hwm if self.day_hwm > 0 else 0.0
        self.dd_week = (self.week_hwm - eq) / self.week_hwm if self.week_hwm > 0 else 0.0

        if self.dd_day >= self.config.daily_dd_limit:
            self.halted_today = True
        if self.dd_week >= self.config.weekly_dd_limit:
            self.halted_week = True
            self.halted_today = True

    def should_flatten_all(self) -> bool:
        return self.halted_today or self.halted_week

    def can_open_new_position(self) -> bool:
        return (
            not self.halted_today
            and not self.halted_week
            and len(self.positions) < self.config.max_positions
        )

    # ------------------------------------------------------------------
    # Sizing & order management
    # ------------------------------------------------------------------
    def position_size(self, price: float, atr: float) -> float:
        if atr <= 0 or price <= 0:
            return 0.0

        risk_dollars = self.equity * self.config.risk_per_trade_pct
        stop_distance = self.config.atr_init_mult * atr
        if stop_distance <= 0:
            return 0.0
        qty = risk_dollars / stop_distance

        max_qty_by_alloc = (self.equity * self.config.max_alloc_per_asset) / price
        qty = min(qty, max_qty_by_alloc)

        current_exposure = sum(
            pos.qty * self._last_prices.get(pos.symbol, pos.entry_price)
            for pos in self.positions.values()
        )
        remaining_exposure = max(self.equity * self.config.max_gross_exposure - current_exposure, 0.0)
        max_qty_by_gross = remaining_exposure / price
        qty = min(qty, max_qty_by_gross)

        return max(qty, 0.0)

    def open_position(self, symbol: str, price: float, date: pd.Timestamp, atr: float) -> Position | None:
        qty = self.position_size(price, atr)
        if qty <= 0:
            return None

        cost = qty * price
        if cost > self.cash:
            qty = self.cash / price
            cost = qty * price
        if qty <= 0:
            return None

        stop = price - self.config.atr_init_mult * atr
        pos = Position(
            symbol=symbol,
            qty=qty,
            entry_price=price,
            entry_date=date,
            initial_stop=stop,
            stop=stop,
            atr_at_entry=atr,
            highest_price=price,
        )
        self.positions[symbol] = pos
        self.cash -= cost
        self._last_prices[symbol] = price
        return pos

    def close_position(self, symbol: str, price: float, date: pd.Timestamp, reason: str) -> Trade | None:
        pos = self.positions.pop(symbol, None)
        if pos is None:
            return None

        proceeds = pos.qty * price
        self.cash += proceeds
        pnl = (price - pos.entry_price) * pos.qty
        r_mult = pos.r_multiple(price)
        self._last_prices[symbol] = price

        return Trade(
            symbol=symbol,
            entry_date=pos.entry_date,
            exit_date=date,
            entry_price=pos.entry_price,
            exit_price=price,
            qty=pos.qty,
            r_multiple=r_mult,
            pnl=pnl,
            exit_reason=reason,
        )

    def update_trailing_stop(self, symbol: str, high: float, atr: float, trail_mult: float) -> None:
        pos = self.positions.get(symbol)
        if pos is None:
            return
        pos.highest_price = max(pos.highest_price, high)
        new_stop = pos.highest_price - trail_mult * atr
        pos.stop = max(pos.stop, new_stop)

    def check_stop_hit(self, symbol: str, low: float) -> bool:
        pos = self.positions.get(symbol)
        if pos is None:
            return False
        return low <= pos.stop
