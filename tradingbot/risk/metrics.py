"""Performance and risk metrics computed from a backtest equity curve / trade log."""
from __future__ import annotations

import numpy as np
import pandas as pd

from tradingbot.risk.manager import Trade


def max_drawdown(equity: pd.Series) -> float:
    if equity.empty:
        return 0.0
    running_max = equity.cummax()
    dd = (running_max - equity) / running_max.replace(0, np.nan)
    return float(dd.max(skipna=True) or 0.0)


def cagr(equity: pd.Series, periods_per_year: int = 365) -> float:
    if len(equity) < 2 or equity.iloc[0] <= 0:
        return 0.0
    total_return = equity.iloc[-1] / equity.iloc[0]
    years = (len(equity) - 1) / periods_per_year
    if years <= 0 or total_return <= 0:
        return 0.0
    return float(total_return ** (1.0 / years) - 1.0)


def daily_returns(equity: pd.Series) -> pd.Series:
    return equity.pct_change().dropna()


def sharpe_ratio(returns: pd.Series, periods_per_year: int = 365, rf: float = 0.0) -> float:
    if returns.empty or returns.std(ddof=0) == 0:
        return 0.0
    excess = returns - rf / periods_per_year
    return float(excess.mean() / returns.std(ddof=0) * np.sqrt(periods_per_year))


def sortino_ratio(returns: pd.Series, periods_per_year: int = 365, rf: float = 0.0) -> float:
    if returns.empty:
        return 0.0
    downside = returns[returns < 0]
    dd_std = downside.std(ddof=0)
    if dd_std == 0 or np.isnan(dd_std):
        return 0.0
    excess = returns - rf / periods_per_year
    return float(excess.mean() / dd_std * np.sqrt(periods_per_year))


def win_rate(trades: list[Trade]) -> float:
    if not trades:
        return 0.0
    wins = sum(1 for t in trades if t.pnl > 0)
    return wins / len(trades)


def avg_r_multiple(trades: list[Trade]) -> float:
    if not trades:
        return 0.0
    return float(np.mean([t.r_multiple for t in trades]))


def expectancy(trades: list[Trade]) -> float:
    """Mean R-multiple across trades -- the expected R per trade."""
    return avg_r_multiple(trades)


def max_consecutive_losses(trades: list[Trade]) -> int:
    streak = 0
    worst = 0
    for t in trades:
        if t.pnl < 0:
            streak += 1
            worst = max(worst, streak)
        else:
            streak = 0
    return worst


def compute_metrics(equity_curve: pd.DataFrame, trades: list[Trade]) -> dict:
    equity = equity_curve["equity"]
    returns = daily_returns(equity)

    total_return = (equity.iloc[-1] / equity.iloc[0] - 1.0) if len(equity) > 1 else 0.0

    cb_trips = 0
    if "halted_today" in equity_curve.columns:
        halted = equity_curve["halted_today"].astype(bool)
        cb_trips = int((halted & ~halted.shift(1, fill_value=False)).sum())

    return {
        "total_return": float(total_return),
        "cagr": cagr(equity),
        "sharpe": sharpe_ratio(returns),
        "sortino": sortino_ratio(returns),
        "max_dd": max_drawdown(equity),
        "max_dd_day": float(equity_curve["dd_day"].max()) if "dd_day" in equity_curve else 0.0,
        "max_dd_week": float(equity_curve["dd_week"].max()) if "dd_week" in equity_curve else 0.0,
        "cb_trips": cb_trips,
        "win_rate": win_rate(trades),
        "avg_r": avg_r_multiple(trades),
        "expectancy": expectancy(trades),
        "max_consec_loss": max_consecutive_losses(trades),
        "n_trades": len(trades),
        "final_equity": float(equity.iloc[-1]) if len(equity) else 0.0,
    }
