"""CLI: python -m tradingbot.live --strategy <name> --broker {paper-sim,alpaca-paper}

Intended for a daily scheduled run (e.g. GitHub Actions). `--broker
alpaca-paper` requires `alpaca-py` and ALPACA_API_KEY_ID/ALPACA_API_SECRET_KEY
(Alpaca *paper* trading keys) -- untested in this sandbox since network
access to Alpaca is blocked here; verify via `workflow_dispatch`.

`--broker paper-sim` (default) uses an in-memory simulated broker fed by
synthetic data, so the whole pipeline is runnable end-to-end without network
access (useful for local dry runs / CI smoke tests).
"""
from __future__ import annotations

import argparse
import json
import os

from tradingbot.config import DEFAULT_RISK_CONFIG, DEFAULT_STRATEGY
from tradingbot.data.feed import SyntheticDataFeed
from tradingbot.execution.paper_sim_broker import PaperSimBroker
from tradingbot.runner import run_daily_step
from tradingbot.strategies import build_strategy

DEFAULT_SYMBOLS = ["BTC", "ETH", "SOL", "AVAX"]


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Run one live/paper trading step.")
    p.add_argument("--strategy", default=DEFAULT_STRATEGY)
    p.add_argument("--broker", default="paper-sim", choices=["paper-sim", "alpaca-paper"])
    p.add_argument("--symbols", default=",".join(DEFAULT_SYMBOLS))
    p.add_argument("--state", default="reports/live/state.json")
    p.add_argument("--out", default="reports/live")
    p.add_argument("--starting-equity", type=float, default=10_000.0)
    p.add_argument("--params", default=None)
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    overrides = json.loads(args.params) if args.params else None
    strategy = build_strategy(args.strategy, overrides)
    risk_config = DEFAULT_RISK_CONFIG

    if args.broker == "alpaca-paper":
        from tradingbot.data.alpaca_feed import AlpacaCryptoFeed
        from tradingbot.execution.alpaca_broker import AlpacaPaperBroker

        broker = AlpacaPaperBroker()
        data_feed = AlpacaCryptoFeed()
    else:
        data_feed = SyntheticDataFeed(days=400, seed=1)
        data = data_feed.get_data(symbols)
        last_prices = {sym: float(df["close"].iloc[-1]) for sym, df in data.items()}
        broker = PaperSimBroker(args.starting_equity, last_prices)

    report = run_daily_step(
        data_feed=data_feed,
        broker=broker,
        strategy=strategy,
        symbols=symbols,
        risk_config=risk_config,
        state_path=args.state,
        starting_equity=args.starting_equity,
    )

    os.makedirs(args.out, exist_ok=True)
    out_path = os.path.join(args.out, f"{report['date']}.json")
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2, default=str)

    print(json.dumps(report, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
