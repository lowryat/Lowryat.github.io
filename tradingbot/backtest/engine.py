"""Event-driven, multi-symbol backtester.

Each daily bar:
  1. Roll day/week boundaries (RiskManager.begin_bar).
  2. Check existing positions' stops against the bar's low; close on hit.
  3. Mark-to-market with the bar's close; update drawdown HWMs/breakers.
  4. If a circuit breaker just tripped, flatten all remaining positions.
     Otherwise: process signal-based exits, update trailing stops, then
     open new entries (subject to risk limits).
  5. Re-mark-to-market and record the daily equity snapshot.

Position sizing reads `RiskManager.equity` at entry time, so position sizes
automatically compound with prior daily P&L.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from tradingbot.config import RiskConfig
from tradingbot.risk.manager import RiskManager, Trade
from tradingbot.risk.metrics import compute_metrics
from tradingbot.strategies.base import Strategy


@dataclass
class BacktestResult:
    equity_curve: pd.DataFrame
    trades: list[Trade] = field(default_factory=list)
    metrics: dict = field(default_factory=dict)


class Backtester:
    def __init__(
        self,
        data: dict[str, pd.DataFrame],
        strategy: Strategy,
        risk_config: RiskConfig | None = None,
        starting_equity: float = 10_000.0,
        regime_labels: pd.Series | None = None,
    ):
        self.data = data
        self.strategy = strategy
        self.risk_config = risk_config or RiskConfig()
        self.starting_equity = starting_equity
        self.regime_labels = regime_labels

    def run(self) -> BacktestResult:
        rm = RiskManager(self.starting_equity, self.risk_config)
        signals = {sym: self.strategy.generate_signals(df) for sym, df in self.data.items()}

        common_index = None
        for df in self.data.values():
            common_index = df.index if common_index is None else common_index.union(df.index)
        common_index = common_index.sort_values()

        records: list[dict] = []
        trades: list[Trade] = []

        for date in common_index:
            rm.begin_bar(date)

            prices_close: dict[str, float] = {}

            # 1. Stop-hit check against this bar's low (existing positions only).
            for sym, df in self.data.items():
                if date not in df.index:
                    continue
                bar = df.loc[date]
                prices_close[sym] = float(bar["close"])

                if sym in rm.positions and rm.check_stop_hit(sym, float(bar["low"])):
                    pos = rm.positions[sym]
                    trade = rm.close_position(sym, pos.stop, date, "stop")
                    if trade:
                        trades.append(trade)

            # 2. Mark-to-market -> updates drawdown HWMs and breaker flags.
            rm.mark_to_market(prices_close)

            if rm.should_flatten_all():
                for sym in list(rm.positions.keys()):
                    price = prices_close.get(sym, rm.positions[sym].entry_price)
                    trade = rm.close_position(sym, price, date, "circuit_breaker")
                    if trade:
                        trades.append(trade)
            else:
                # 3. Signal-based exits.
                for sym, df in self.data.items():
                    if date not in df.index or sym not in rm.positions:
                        continue
                    sig = signals[sym].loc[date]
                    if bool(sig.get("exit_signal", False)):
                        price = float(df.loc[date, "close"])
                        trade = rm.close_position(sym, price, date, "signal")
                        if trade:
                            trades.append(trade)

                # 4. Update trailing stops on remaining positions.
                for sym, df in self.data.items():
                    if date not in df.index or sym not in rm.positions:
                        continue
                    bar = df.loc[date]
                    sig = signals[sym].loc[date]
                    pos = rm.positions[sym]
                    trail_mult = self.strategy.trail_multiple(pos, bar)
                    atr_val = float(sig["atr"])
                    if not np.isnan(atr_val) and atr_val > 0:
                        rm.update_trailing_stop(sym, float(bar["high"]), atr_val, trail_mult)

                # 5. New entries.
                for sym, df in self.data.items():
                    if date not in df.index or sym in rm.positions:
                        continue
                    if not rm.can_open_new_position():
                        continue
                    sig = signals[sym].loc[date]
                    atr_val = float(sig["atr"])
                    if bool(sig.get("entry_signal", False)) and not np.isnan(atr_val) and atr_val > 0:
                        price = float(df.loc[date, "close"])
                        rm.open_position(sym, price, date, atr_val)

            # Re-mark after the day's trades.
            rm.mark_to_market(prices_close)

            regime = None
            if self.regime_labels is not None and date in self.regime_labels.index:
                regime = self.regime_labels.loc[date]

            records.append(
                {
                    "date": date,
                    "equity": rm.equity,
                    "dd_day": rm.dd_day,
                    "dd_week": rm.dd_week,
                    "regime": regime,
                    "halted_today": rm.halted_today,
                    "halted_week": rm.halted_week,
                    "n_positions": len(rm.positions),
                }
            )

        equity_curve = pd.DataFrame(records).set_index("date")
        metrics = compute_metrics(equity_curve, trades)
        return BacktestResult(equity_curve=equity_curve, trades=trades, metrics=metrics)
