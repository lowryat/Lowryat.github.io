"""Markdown report generation for backtest reps."""
from __future__ import annotations

import os

import pandas as pd

from tradingbot.backtest.engine import BacktestResult

HEADER = (
    "| Strategy | Total Return | CAGR (equiv) | Sharpe | Sortino | Max DD | "
    "Max Daily DD | Max Weekly DD | CB Trips | Win Rate | Avg R | Expectancy (R) | "
    "Max Consec Loss | # Trades | Final Equity |"
)
DIVIDER = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"


def _fmt_row(name: str, m: dict) -> str:
    return (
        f"| {name} | {m['total_return']:.2%} | {m['cagr']:.2%} | {m['sharpe']:.2f} | "
        f"{m['sortino']:.2f} | {m['max_dd']:.2%} | {m['max_dd_day']:.2%} | "
        f"{m['max_dd_week']:.2%} | {m['cb_trips']} | {m['win_rate']:.2%} | "
        f"{m['avg_r']:.2f} | {m['expectancy']:.2f} | {m['max_consec_loss']} | "
        f"{m['n_trades']} | ${m['final_equity']:,.2f} |"
    )


def _per_regime_table(results: dict[str, BacktestResult]) -> list[str]:
    lines = ["## Per-Regime Breakdown (mean daily return %)", ""]
    any_regime = any("regime" in res.equity_curve.columns and res.equity_curve["regime"].notna().any() for res in results.values())
    if not any_regime:
        lines.append("_No regime labels available._")
        lines.append("")
        return lines

    regimes: list[str] = []
    for res in results.values():
        ec = res.equity_curve
        if "regime" in ec.columns:
            for r in ec["regime"].dropna().unique():
                if r not in regimes:
                    regimes.append(r)

    lines.append("| Strategy | " + " | ".join(regimes) + " |")
    lines.append("|---|" + "|".join(["---"] * len(regimes)) + "|")
    for name, res in results.items():
        ec = res.equity_curve.copy()
        ec["ret"] = ec["equity"].pct_change()
        cells = []
        for r in regimes:
            sub = ec[ec["regime"] == r]["ret"]
            cells.append(f"{sub.mean() * 100:.3f}%" if len(sub) else "n/a")
        lines.append(f"| {name} | " + " | ".join(cells) + " |")
    lines.append("")
    return lines


def _cb_regime_table(results: dict[str, BacktestResult]) -> list[str]:
    lines = ["## Circuit Breaker Trips by Regime", ""]
    regimes: list[str] = []
    for res in results.values():
        ec = res.equity_curve
        if "regime" in ec.columns:
            for r in ec["regime"].dropna().unique():
                if r not in regimes:
                    regimes.append(r)
    if not regimes:
        lines.append("_No regime labels available._")
        lines.append("")
        return lines

    lines.append("| Strategy | " + " | ".join(regimes) + " | Total |")
    lines.append("|---|" + "|".join(["---"] * len(regimes)) + "|---|")
    for name, res in results.items():
        ec = res.equity_curve.copy()
        halted = ec["halted_today"].astype(bool)
        trips = halted & ~halted.shift(1, fill_value=False)
        cells = []
        for r in regimes:
            cells.append(str(int(trips[ec["regime"] == r].sum())))
        lines.append(f"| {name} | " + " | ".join(cells) + f" | {int(trips.sum())} |")
    lines.append("")
    return lines


def _verdicts(results: dict[str, BacktestResult], daily_limit: float, weekly_limit: float) -> list[str]:
    lines = ["## Verdict", ""]
    lines.append(
        "Single-bar drawdowns can briefly exceed the configured limit on daily bars "
        "(overnight gaps / jump moves) -- the breaker still halts further entries for "
        "the rest of that day/week. The check below flags strategies with **negative "
        "expectancy** or **zero trade activity**, which matter more than a one-bar "
        "overshoot for daily data.\n"
    )
    for name, res in results.items():
        m = res.metrics
        notes = []
        if m["expectancy"] <= 0:
            notes.append("non-positive expectancy")
        if m["n_trades"] == 0:
            notes.append("no trades taken")
        if m["max_dd_day"] > daily_limit * 1.5:
            notes.append(f"daily DD reached {m['max_dd_day']:.1%} (>1.5x limit, large gap)")
        if m["max_dd_week"] > weekly_limit * 1.5:
            notes.append(f"weekly DD reached {m['max_dd_week']:.1%} (>1.5x limit, large gap)")

        if notes:
            lines.append(f"- **{name}**: ⚠ {'; '.join(notes)}.")
        else:
            lines.append(
                f"- **{name}**: OK -- expectancy {m['expectancy']:.2f}R over {m['n_trades']} trades, "
                f"max daily DD {m['max_dd_day']:.2%}, max weekly DD {m['max_dd_week']:.2%}."
            )
    lines.append("")
    return lines


def generate_comparison_report(
    results: dict[str, BacktestResult],
    out_dir: str,
    rep_label: str = "",
    daily_limit: float = 0.03,
    weekly_limit: float = 0.05,
) -> str:
    os.makedirs(out_dir, exist_ok=True)

    lines = [f"# Backtest Comparison Report{': ' + rep_label if rep_label else ''}", ""]
    lines.append(HEADER)
    lines.append(DIVIDER)
    for name, res in results.items():
        lines.append(_fmt_row(name, res.metrics))
    lines.append("")

    lines += _per_regime_table(results)
    lines += _cb_regime_table(results)
    lines += _verdicts(results, daily_limit, weekly_limit)

    text = "\n".join(lines)
    with open(os.path.join(out_dir, "comparison.md"), "w") as f:
        f.write(text)

    for name, res in results.items():
        res.equity_curve.to_csv(os.path.join(out_dir, f"equity_{name}.csv"))
        trades_df = pd.DataFrame([t.__dict__ for t in res.trades])
        trades_df.to_csv(os.path.join(out_dir, f"trades_{name}.csv"), index=False)

    return text
