"""Rep 8: bot-vs-bot tournament.

Runs the four strategy bots head-to-head across 10 synthetic seeds at the
frozen default risk (2% per trade), plus a fifth contender: the ENSEMBLE bot
-- all four bots running side by side, each with 25% of starting capital in
its own sub-account (which is exactly how you'd deploy multiple bots against
one broker account with separate allocations).

Output: reports/rep08_tournament/summary.md + results.csv

Run from repo root:  python scripts/run_bot_tournament.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import pandas as pd

from tradingbot.backtest.engine import Backtester
from tradingbot.config import RiskConfig
from tradingbot.data.synthetic import generate_multi_regime_ohlcv
from tradingbot.strategies import STRATEGY_REGISTRY, build_strategy

SEEDS = [0, 1, 2, 3, 4, 5, 7, 42, 99, 100]
RISK = RiskConfig(risk_per_trade_pct=0.02)
SYMBOLS = ["BTC", "ETH", "SOL", "AVAX"]
DAYS = 730
START_EQUITY = 10_000.0


def weekly_max_dd(equity: pd.Series) -> float:
    """Max intra-ISO-week drawdown from that week's running high-water mark."""
    worst = 0.0
    for _, week in equity.groupby([equity.index.isocalendar().year,
                                   equity.index.isocalendar().week]):
        hwm = week.cummax()
        dd = ((hwm - week) / hwm).max()
        worst = max(worst, float(dd))
    return worst


def daily_max_dd(equity: pd.Series) -> float:
    """Max single-day equity drop (close-to-close)."""
    rets = equity.pct_change().dropna()
    return float(max(0.0, -rets.min())) if len(rets) else 0.0


def curve_metrics(equity: pd.Series) -> dict:
    rets = equity.pct_change().dropna()
    total = float(equity.iloc[-1] / equity.iloc[0] - 1.0)
    sharpe = float(rets.mean() / rets.std() * np.sqrt(365)) if rets.std() > 0 else 0.0
    hwm = equity.cummax()
    max_dd = float(((hwm - equity) / hwm).max())
    return {
        "total_return_pct": round(total * 100, 2),
        "sharpe": round(sharpe, 3),
        "max_dd_pct": round(max_dd * 100, 2),
        "max_daily_dd_pct": round(daily_max_dd(equity) * 100, 2),
        "max_weekly_dd_pct": round(weekly_max_dd(equity) * 100, 2),
    }


def main() -> None:
    strategy_names = list(STRATEGY_REGISTRY.keys())
    rows = []

    for seed in SEEDS:
        data, regimes = generate_multi_regime_ohlcv(SYMBOLS, days=DAYS, seed=seed)
        curves: dict[str, pd.Series] = {}
        for name in strategy_names:
            bt = Backtester(data, build_strategy(name), RISK,
                            starting_equity=START_EQUITY, regime_labels=regimes)
            res = bt.run()
            eq = res.equity_curve["equity"]
            curves[name] = eq
            rows.append({"seed": seed, "bot": name, **curve_metrics(eq),
                         "cb_trips": res.metrics["cb_trips"],
                         "n_trades": res.metrics["n_trades"]})

        # Ensemble: each bot runs 25% of capital in its own sub-account.
        # Sum of the four curves each scaled to START_EQUITY/4.
        ensemble = sum(c / START_EQUITY * (START_EQUITY / len(curves)) for c in curves.values())
        rows.append({"seed": seed, "bot": "ENSEMBLE_4x25pct", **curve_metrics(ensemble),
                     "cb_trips": None, "n_trades": None})
        print(f"seed {seed:>4}: " + "  ".join(
            f"{r['bot'][:12]}={r['total_return_pct']:+.1f}%"
            for r in rows[-5:]))

    df = pd.DataFrame(rows)
    out_dir = "reports/rep08_tournament"
    os.makedirs(out_dir, exist_ok=True)
    df.to_csv(f"{out_dir}/results.csv", index=False)

    # Aggregate leaderboard
    agg = df.groupby("bot").agg(
        median_return=("total_return_pct", "median"),
        pct_positive=("total_return_pct", lambda s: 100.0 * (s > 0).mean()),
        worst_return=("total_return_pct", "min"),
        median_sharpe=("sharpe", "median"),
        median_wkly_dd=("max_weekly_dd_pct", "median"),
        worst_wkly_dd=("max_weekly_dd_pct", "max"),
    ).round(2).sort_values("median_sharpe", ascending=False)

    with open(f"{out_dir}/summary.md", "w") as f:
        f.write("# Rep 8: Bot-vs-Bot Tournament\n\n")
        f.write(f"{len(SEEDS)} seeds x 730 days x {SYMBOLS} @ 2% risk-per-trade. ")
        f.write("ENSEMBLE = all four bots side by side, 25% capital each.\n\n")
        f.write("| Bot | Median Return | % Seeds Positive | Worst Return | "
                "Median Sharpe | Median Wkly DD | Worst Wkly DD |\n")
        f.write("|---|---|---|---|---|---|---|\n")
        for bot, r in agg.iterrows():
            f.write(f"| {bot} | {r.median_return:+.2f}% | {r.pct_positive:.0f}% | "
                    f"{r.worst_return:+.2f}% | {r.median_sharpe:.2f} | "
                    f"{r.median_wkly_dd:.2f}% | {r.worst_wkly_dd:.2f}% |\n")
        f.write("\n## Per-seed detail\n\nSee `results.csv`.\n")

    print("\n=== LEADERBOARD (by median Sharpe) ===")
    print(agg.to_string())
    print(f"\n-> {out_dir}/")


if __name__ == "__main__":
    main()
