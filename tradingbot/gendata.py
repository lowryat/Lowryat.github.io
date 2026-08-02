"""CLI: python -m tradingbot.gendata --symbols BTC,ETH,SOL,AVAX --days 730 --seed 42 --out data/synthetic/rep01"""
from __future__ import annotations

import argparse

from tradingbot.data.synthetic import generate_multi_regime_ohlcv, write_csvs

DEFAULT_SYMBOLS = ["BTC", "ETH", "SOL", "AVAX"]


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Generate synthetic multi-regime OHLCV data.")
    p.add_argument("--symbols", default=",".join(DEFAULT_SYMBOLS))
    p.add_argument("--days", type=int, default=730)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--out", required=True)
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    data, regime_labels = generate_multi_regime_ohlcv(symbols, days=args.days, seed=args.seed)
    write_csvs(data, regime_labels, args.out)
    print(f"Wrote {len(symbols)} symbols x {args.days} days to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
