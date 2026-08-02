"""Extended backtest reps: large seed sweep (Rep 5) + historical validation (Rep 6).

Run from repo root:
    python scripts/run_extended_reps.py

Rep 5 -- statistical seed sweep
    ema_atr_trend @ risk_per_trade_pct=0.02 across 20 seeds (0-9, 15, 20, 30,
    42, 50, 99, 100, 200, 500, 999).  Builds the distribution of returns,
    Sharpe, max weekly DD so we can quote median / 10th-pct / worst-case.

Rep 6 -- historical 2022-2024 validation
    Runs all four strategies on the historically-calibrated data (real monthly
    price anchors for BTC/ETH/SOL/AVAX) at both 1% and 2% risk-per-trade.
    Shows how the circuit breakers and trailing stops would have behaved
    through the LUNA/FTX crashes and 2024 bull run.

Rep 7 -- parameter robustness (ema_atr_trend)
    Grid search over fast EMA period {8,12,16} x slow EMA {40,48,60} on
    synthetic seed 42 to confirm the default params are not cherry-picked.
"""
from __future__ import annotations

import os
import sys
import json
import statistics

# Make sure repo root is on the path.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pandas as pd

from tradingbot.backtest.engine import Backtester
from tradingbot.backtest.report import generate_comparison_report
from tradingbot.config import RiskConfig
from tradingbot.data.synthetic import generate_multi_regime_ohlcv
from tradingbot.data.historical_prices import generate_historical_ohlcv, write_historical_csvs
from tradingbot.strategies import STRATEGY_REGISTRY, build_strategy


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def run_one(name, data, regimes, risk_config, starting_equity=10_000.0, params=None):
    strategy = build_strategy(name, params)
    bt = Backtester(data, strategy, risk_config, starting_equity=starting_equity, regime_labels=regimes)
    return bt.run()


def run_all(data, regimes, risk_config, starting_equity=10_000.0, params=None):
    results = {}
    for name in STRATEGY_REGISTRY:
        results[name] = run_one(name, data, regimes, risk_config, starting_equity, params)
    return results


# ---------------------------------------------------------------------------
# Rep 5: large seed sweep -- ema_atr_trend only, many seeds
# ---------------------------------------------------------------------------

SEEDS = [0, 1, 2, 3, 4, 5, 7, 10, 15, 20, 30, 42, 50, 99, 100, 200, 300, 500, 999, 1234]
RISK_2PCT = RiskConfig(risk_per_trade_pct=0.02)


def rep5_seed_sweep():
    print("\n" + "="*70)
    print("REP 5 — LARGE SEED SWEEP (ema_atr_trend, 2% risk)")
    print("="*70)

    rows = []
    for seed in SEEDS:
        data, regimes = generate_multi_regime_ohlcv(["BTC", "ETH", "SOL", "AVAX"], days=730, seed=seed)
        result = run_one("ema_atr_trend", data, regimes, RISK_2PCT)
        m = result.metrics
        rows.append({
            "seed": seed,
            "total_return_pct": round(m["total_return"] * 100, 2),
            "sharpe": round(m["sharpe"], 3),
            "sortino": round(m["sortino"], 3),
            "max_dd_pct": round(m["max_dd"] * 100, 2),
            "max_daily_dd_pct": round(m["max_dd_day"] * 100, 2),
            "max_weekly_dd_pct": round(m["max_dd_week"] * 100, 2),
            "cb_trips": m["cb_trips"],
            "win_rate_pct": round(m["win_rate"] * 100, 1),
            "expectancy_r": round(m["expectancy"], 3),
            "n_trades": m["n_trades"],
        })
        sign = "+" if rows[-1]["total_return_pct"] >= 0 else ""
        print(f"  seed {seed:>4d}: {sign}{rows[-1]['total_return_pct']:>6.2f}%  "
              f"Sharpe={rows[-1]['sharpe']:.2f}  MaxWklyDD={rows[-1]['max_weekly_dd_pct']:.2f}%  "
              f"CBtrips={rows[-1]['cb_trips']}")

    df = pd.DataFrame(rows)
    n_pos = (df.total_return_pct > 0).sum()
    n_no_breach = (df.max_weekly_dd_pct <= 5.0).sum()
    n_no_trip = (df.cb_trips == 0).sum()

    print(f"\nResults across {len(SEEDS)} seeds:")
    print(f"  Positive return:          {n_pos}/{len(SEEDS)}")
    print(f"  Weekly DD <= 5% (limit):  {n_no_breach}/{len(SEEDS)}")
    print(f"  Zero CB trips:            {n_no_trip}/{len(SEEDS)}")
    print(f"  Median return:            {df.total_return_pct.median():.2f}%")
    print(f"  10th-pct return:          {df.total_return_pct.quantile(0.10):.2f}%")
    print(f"  Worst return:             {df.total_return_pct.min():.2f}%")
    print(f"  Best return:              {df.total_return_pct.max():.2f}%")
    print(f"  Median Sharpe:            {df.sharpe.median():.3f}")
    print(f"  Median max-weekly-DD:     {df.max_weekly_dd_pct.median():.2f}%")

    os.makedirs("reports/rep05_seed_sweep", exist_ok=True)
    df.to_csv("reports/rep05_seed_sweep/results.csv", index=False)

    # Write markdown summary
    with open("reports/rep05_seed_sweep/summary.md", "w") as f:
        f.write("# Rep 5: Large Seed Sweep — `ema_atr_trend` @ 2% risk\n\n")
        f.write(f"Strategy: `ema_atr_trend` | Risk: `risk_per_trade_pct=0.02` | ")
        f.write(f"Data: 730-day synthetic multi-regime | Symbols: BTC/ETH/SOL/AVAX\n\n")
        f.write(f"| Metric | Value |\n|---|---|\n")
        f.write(f"| Seeds tested | {len(SEEDS)} |\n")
        f.write(f"| Positive return | {n_pos}/{len(SEEDS)} |\n")
        f.write(f"| Weekly DD ≤ 5% limit | {n_no_breach}/{len(SEEDS)} |\n")
        f.write(f"| Zero CB trips | {n_no_trip}/{len(SEEDS)} |\n")
        f.write(f"| Median return | {df.total_return_pct.median():.2f}% |\n")
        f.write(f"| 10th-pct return | {df.total_return_pct.quantile(0.10):.2f}% |\n")
        f.write(f"| Worst return | {df.total_return_pct.min():.2f}% |\n")
        f.write(f"| Best return | {df.total_return_pct.max():.2f}% |\n")
        f.write(f"| Median Sharpe | {df.sharpe.median():.3f} |\n")
        f.write(f"| Median max-weekly-DD | {df.max_weekly_dd_pct.median():.2f}% |\n\n")
        f.write("## Per-Seed Detail\n\n")
        f.write("| Seed | Return | Sharpe | Sortino | Max DD | Max Daily DD | Max Weekly DD | CB Trips | Trades |\n")
        f.write("|---|---|---|---|---|---|---|---|---|\n")
        for r in rows:
            sign = "+" if r["total_return_pct"] >= 0 else ""
            breach = " ⚠" if r["max_weekly_dd_pct"] > 5.0 else ""
            f.write(f"| {r['seed']} | {sign}{r['total_return_pct']:.2f}% | {r['sharpe']:.3f} | "
                    f"{r['sortino']:.3f} | {r['max_dd_pct']:.2f}% | {r['max_daily_dd_pct']:.2f}% | "
                    f"{r['max_weekly_dd_pct']:.2f}%{breach} | {r['cb_trips']} | {r['n_trades']} |\n")
    print("  -> reports/rep05_seed_sweep/")
    return df


# ---------------------------------------------------------------------------
# Rep 6: historical 2022-2024 validation
# ---------------------------------------------------------------------------

def rep6_historical():
    print("\n" + "="*70)
    print("REP 6 — HISTORICAL VALIDATION (2022-2024 anchored prices)")
    print("="*70)

    # Write CSVs so they can be replayed later
    write_historical_csvs("data/historical/btc_eth_sol_avax_2022_2024")
    data, regimes = generate_historical_ohlcv(["BTC", "ETH", "SOL", "AVAX"])
    print(f"  Period: {data['BTC'].index[0].date()} -> {data['BTC'].index[-1].date()}  "
          f"({len(data['BTC'])} trading days)")
    print(f"  BTC range: ${data['BTC'].close.min():.0f} – ${data['BTC'].close.max():.0f}")
    print(f"  SOL range: ${data['SOL'].close.min():.0f} – ${data['SOL'].close.max():.0f}")
    print(f"  Regime counts: {dict(regimes.value_counts())}")

    for risk_label, rpc in [("1pct", 0.01), ("2pct", 0.02)]:
        rc = RiskConfig(risk_per_trade_pct=rpc)
        results = run_all(data, regimes, rc)
        out_dir = f"reports/rep06_historical_{risk_label}"
        report = generate_comparison_report(
            results,
            out_dir=out_dir,
            rep_label=f"historical_2022_2024_{risk_label}",
            daily_limit=rc.daily_dd_limit,
            weekly_limit=rc.weekly_dd_limit,
        )
        print(f"\n  [{risk_label}] -> {out_dir}/comparison.md")
        for name, res in results.items():
            m = res.metrics
            sign = "+" if m["total_return"] >= 0 else ""
            print(f"    {name:<30s}  {sign}{m['total_return']*100:.2f}%  "
                  f"Sharpe={m['sharpe']:.2f}  MaxWkDD={m['max_dd_week']*100:.2f}%  "
                  f"CBtrips={m['cb_trips']}")


# ---------------------------------------------------------------------------
# Rep 7: EMA parameter grid on synthetic seed 42
# ---------------------------------------------------------------------------

FAST_PERIODS = [8, 12, 16]
SLOW_PERIODS = [40, 48, 60]
ATR_MULTS_INIT = [2.0, 2.5, 3.0]


def rep7_param_grid():
    print("\n" + "="*70)
    print("REP 7 — PARAMETER GRID (ema_atr_trend, seed 42, 2% risk)")
    print("="*70)

    data, regimes = generate_multi_regime_ohlcv(["BTC", "ETH", "SOL", "AVAX"], days=730, seed=42)
    rc = RISK_2PCT

    rows = []
    for fast in FAST_PERIODS:
        for slow in SLOW_PERIODS:
            for init_mult in ATR_MULTS_INIT:
                if fast >= slow:
                    continue
                params = {"fast": fast, "slow": slow, "atr_init_mult": init_mult}
                result = run_one("ema_atr_trend", data, regimes, rc, params=params)
                m = result.metrics
                rows.append({
                    "fast": fast, "slow": slow, "atr_init_mult": init_mult,
                    "total_return_pct": round(m["total_return"] * 100, 2),
                    "sharpe": round(m["sharpe"], 3),
                    "max_weekly_dd_pct": round(m["max_dd_week"] * 100, 2),
                    "cb_trips": m["cb_trips"],
                    "n_trades": m["n_trades"],
                    "expectancy_r": round(m["expectancy"], 3),
                })

    df = pd.DataFrame(rows).sort_values("sharpe", ascending=False)
    os.makedirs("reports/rep07_param_grid", exist_ok=True)
    df.to_csv("reports/rep07_param_grid/results.csv", index=False)

    with open("reports/rep07_param_grid/summary.md", "w") as f:
        f.write("# Rep 7: EMA Parameter Grid Search (seed 42, 2% risk)\n\n")
        f.write("Sorted by Sharpe ratio descending.\n\n")
        f.write("| Fast | Slow | ATR Init Mult | Return | Sharpe | Max Wkly DD | CB Trips | Trades | Expectancy |\n")
        f.write("|---|---|---|---|---|---|---|---|---|\n")
        for _, r in df.iterrows():
            default_marker = " **default**" if r.fast == 12 and r.slow == 48 and r.atr_init_mult == 2.5 else ""
            sign = "+" if r.total_return_pct >= 0 else ""
            f.write(f"| {int(r.fast)} | {int(r.slow)} | {r.atr_init_mult} | "
                    f"{sign}{r.total_return_pct:.2f}%{default_marker} | {r.sharpe:.3f} | "
                    f"{r.max_weekly_dd_pct:.2f}% | {int(r.cb_trips)} | {int(r.n_trades)} | {r.expectancy_r:.3f} |\n")

    print(f"\n  Grid size: {len(df)} combinations")
    print("  Top 5 by Sharpe:")
    for _, r in df.head(5).iterrows():
        sign = "+" if r.total_return_pct >= 0 else ""
        print(f"    fast={int(r.fast)} slow={int(r.slow)} atr_init={r.atr_init_mult}: "
              f"{sign}{r.total_return_pct:.2f}%  Sharpe={r.sharpe:.3f}  MaxWkDD={r.max_weekly_dd_pct:.2f}%")

    default_row = df[(df.fast == 12) & (df.slow == 48) & (df.atr_init_mult == 2.5)]
    if not default_row.empty:
        rank = df.index.get_loc(default_row.index[0]) + 1
        print(f"\n  Default params (fast=12, slow=48, atr_init=2.5): rank #{rank}/{len(df)} by Sharpe")
    print(f"  -> reports/rep07_param_grid/")
    return df


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    sweep_df = rep5_seed_sweep()
    rep6_historical()
    rep7_param_grid()
    print("\n" + "="*70)
    print("ALL REPS COMPLETE")
    print("="*70)
