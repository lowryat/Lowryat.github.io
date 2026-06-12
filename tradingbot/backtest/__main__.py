"""CLI: python -m tradingbot.backtest --strategy all --data data/synthetic/rep01 --rep 1 --out reports/rep01

If --data points to a directory containing `<SYMBOL>.csv` files (and
optionally `regimes.csv`), those are used. Otherwise synthetic data is
generated on the fly using --symbols/--days/--seed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from tradingbot.config import RiskConfig
from tradingbot.backtest.engine import Backtester
from tradingbot.backtest.report import generate_comparison_report
from tradingbot.data.feed import CSVDataFeed, SyntheticDataFeed
from tradingbot.strategies import STRATEGY_REGISTRY, build_strategy

DEFAULT_SYMBOLS = ["BTC", "ETH", "SOL", "AVAX"]


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Run trading bot backtests on synthetic or CSV data.")
    p.add_argument("--strategy", default="all", help="strategy name, or 'all'")
    p.add_argument("--data", default=None, help="directory of <SYMBOL>.csv + regimes.csv")
    p.add_argument("--symbols", default=",".join(DEFAULT_SYMBOLS), help="comma-separated symbols (synthetic mode)")
    p.add_argument("--days", type=int, default=730, help="days of synthetic data")
    p.add_argument("--seed", type=int, default=42, help="synthetic data seed")
    p.add_argument("--starting-equity", type=float, default=10_000.0)
    p.add_argument("--risk-per-trade-pct", type=float, default=None, help="override RiskConfig.risk_per_trade_pct")
    p.add_argument("--rep", default="", help="rep label, included in the report title")
    p.add_argument("--out", default="reports/rep_out", help="output directory for the report")
    p.add_argument("--params", default=None, help='JSON dict of {strategy_name: {param: value}} overrides')
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]

    if args.data and os.path.isdir(args.data):
        feed = CSVDataFeed(args.data)
    else:
        feed = SyntheticDataFeed(days=args.days, seed=args.seed)

    data = feed.get_data(symbols)
    regime_labels = feed.get_regime_labels() if hasattr(feed, "get_regime_labels") else None

    if args.strategy == "all":
        names = list(STRATEGY_REGISTRY.keys())
    else:
        names = [args.strategy]
        if args.strategy not in STRATEGY_REGISTRY:
            print(f"Unknown strategy '{args.strategy}'. Available: {list(STRATEGY_REGISTRY.keys())}", file=sys.stderr)
            return 1

    overrides = json.loads(args.params) if args.params else {}

    risk_config = RiskConfig()
    if args.risk_per_trade_pct is not None:
        risk_config.risk_per_trade_pct = args.risk_per_trade_pct
    results = {}
    for name in names:
        strategy = build_strategy(name, overrides.get(name))
        bt = Backtester(
            data=data,
            strategy=strategy,
            risk_config=risk_config,
            starting_equity=args.starting_equity,
            regime_labels=regime_labels,
        )
        results[name] = bt.run()

    report = generate_comparison_report(
        results,
        out_dir=args.out,
        rep_label=args.rep,
        daily_limit=risk_config.daily_dd_limit,
        weekly_limit=risk_config.weekly_dd_limit,
    )
    print(report)
    print(f"\nReport written to {args.out}/comparison.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
