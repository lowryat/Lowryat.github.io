"""Shared live/paper-trading orchestration with JSON state persistence.

Each invocation (e.g. one daily GitHub Actions run) is a fresh process:
risk-manager state -- open positions, day/week high-water marks, halted
flags -- is loaded from a JSON file, advanced by one bar using the latest
data, and saved back. The logic mirrors `backtest.engine.Backtester` but
drives a real `Broker` instead of an in-memory ledger.
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict

import pandas as pd

from tradingbot.config import RiskConfig
from tradingbot.data.feed import DataFeed
from tradingbot.execution.broker import Broker
from tradingbot.risk.manager import Position, RiskManager
from tradingbot.strategies.base import Strategy


def load_state(path: str, starting_equity: float, risk_config: RiskConfig) -> RiskManager:
    rm = RiskManager(starting_equity, risk_config)
    if not os.path.exists(path):
        return rm

    with open(path) as f:
        state = json.load(f)

    rm.cash = state["cash"]
    rm.day_start_equity = state["day_start_equity"]
    rm.week_start_equity = state["week_start_equity"]
    rm.day_hwm = state["day_hwm"]
    rm.week_hwm = state["week_hwm"]
    rm.halted_today = state["halted_today"]
    rm.halted_week = state["halted_week"]
    rm.current_day = pd.Timestamp(state["current_day"]) if state["current_day"] else None
    rm.current_week = tuple(state["current_week"]) if state["current_week"] else None
    rm.dd_day = state.get("dd_day", 0.0)
    rm.dd_week = state.get("dd_week", 0.0)
    rm._last_prices = state.get("last_prices", {})

    for sym, pdata in state.get("positions", {}).items():
        rm.positions[sym] = Position(
            symbol=sym,
            qty=pdata["qty"],
            entry_price=pdata["entry_price"],
            entry_date=pd.Timestamp(pdata["entry_date"]),
            initial_stop=pdata["initial_stop"],
            stop=pdata["stop"],
            atr_at_entry=pdata["atr_at_entry"],
            highest_price=pdata["highest_price"],
        )
    return rm


def save_state(rm: RiskManager, path: str) -> None:
    state = {
        "cash": rm.cash,
        "day_start_equity": rm.day_start_equity,
        "week_start_equity": rm.week_start_equity,
        "day_hwm": rm.day_hwm,
        "week_hwm": rm.week_hwm,
        "halted_today": rm.halted_today,
        "halted_week": rm.halted_week,
        "current_day": rm.current_day.isoformat() if rm.current_day is not None else None,
        "current_week": list(rm.current_week) if rm.current_week is not None else None,
        "dd_day": rm.dd_day,
        "dd_week": rm.dd_week,
        "last_prices": rm._last_prices,
        "positions": {
            sym: {
                "qty": pos.qty,
                "entry_price": pos.entry_price,
                "entry_date": pos.entry_date.isoformat(),
                "initial_stop": pos.initial_stop,
                "stop": pos.stop,
                "atr_at_entry": pos.atr_at_entry,
                "highest_price": pos.highest_price,
            }
            for sym, pos in rm.positions.items()
        },
    }
    out_dir = os.path.dirname(path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(path, "w") as f:
        json.dump(state, f, indent=2)


def run_daily_step(
    data_feed: DataFeed,
    broker: Broker,
    strategy: Strategy,
    symbols: list[str],
    risk_config: RiskConfig,
    state_path: str,
    starting_equity: float = 10_000.0,
) -> dict:
    """Advance state by one bar using the latest data, submitting any
    resulting orders via `broker`. Returns a JSON-able report dict."""
    data = data_feed.get_data(symbols)

    rm = load_state(state_path, starting_equity, risk_config)
    if rm.current_day is None:
        # First run: seed cash from the broker's actual account.
        rm.cash = broker.get_cash()

    latest_date = max(df.index[-1] for df in data.values())
    rm.begin_bar(latest_date)

    signals = {sym: strategy.generate_signals(df) for sym, df in data.items()}

    actions: list[dict] = []
    prices_close: dict[str, float] = {}

    for sym, df in data.items():
        if latest_date not in df.index:
            continue
        bar = df.loc[latest_date]
        prices_close[sym] = float(bar["close"])

        if sym in rm.positions and rm.check_stop_hit(sym, float(bar["low"])):
            pos = rm.positions[sym]
            broker.submit_market_order(sym, pos.qty, "sell")
            trade = rm.close_position(sym, pos.stop, latest_date, "stop")
            actions.append({"symbol": sym, "action": "exit_stop", "trade": asdict(trade) if trade else None})

    rm.mark_to_market(prices_close)

    if rm.should_flatten_all():
        for sym in list(rm.positions.keys()):
            pos = rm.positions[sym]
            broker.submit_market_order(sym, pos.qty, "sell")
            price = prices_close.get(sym, pos.entry_price)
            trade = rm.close_position(sym, price, latest_date, "circuit_breaker")
            actions.append(
                {"symbol": sym, "action": "exit_circuit_breaker", "trade": asdict(trade) if trade else None}
            )
    else:
        for sym, df in data.items():
            if latest_date not in df.index or sym not in rm.positions:
                continue
            sig = signals[sym].loc[latest_date]
            if bool(sig.get("exit_signal", False)):
                pos = rm.positions[sym]
                broker.submit_market_order(sym, pos.qty, "sell")
                trade = rm.close_position(sym, float(df.loc[latest_date, "close"]), latest_date, "signal")
                actions.append({"symbol": sym, "action": "exit_signal", "trade": asdict(trade) if trade else None})

        for sym, df in data.items():
            if latest_date not in df.index or sym not in rm.positions:
                continue
            bar = df.loc[latest_date]
            sig = signals[sym].loc[latest_date]
            pos = rm.positions[sym]
            trail_mult = strategy.trail_multiple(pos, bar)
            atr_val = float(sig["atr"])
            if atr_val > 0:
                rm.update_trailing_stop(sym, float(bar["high"]), atr_val, trail_mult)

        for sym, df in data.items():
            if latest_date not in df.index or sym in rm.positions:
                continue
            if not rm.can_open_new_position():
                continue
            sig = signals[sym].loc[latest_date]
            atr_val = float(sig["atr"])
            if bool(sig.get("entry_signal", False)) and atr_val > 0:
                price = float(df.loc[latest_date, "close"])
                pos = rm.open_position(sym, price, latest_date, atr_val)
                if pos:
                    broker.submit_market_order(sym, pos.qty, "buy")
                    actions.append(
                        {"symbol": sym, "action": "entry", "qty": pos.qty, "price": price, "stop": pos.stop}
                    )

    rm.mark_to_market(prices_close)
    save_state(rm, state_path)

    return {
        "date": str(latest_date),
        "equity": rm.equity,
        "dd_day": rm.dd_day,
        "dd_week": rm.dd_week,
        "halted_today": rm.halted_today,
        "halted_week": rm.halted_week,
        "positions": {sym: asdict(pos) for sym, pos in rm.positions.items()},
        "actions": actions,
    }
