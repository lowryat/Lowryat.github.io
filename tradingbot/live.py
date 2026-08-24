"""CLI: python -m tradingbot.live --broker {paper-sim,alpaca-paper,robinhood}

Intended for a daily scheduled run (e.g. GitHub Actions).

Brokers:
  paper-sim     (default) in-memory simulated broker fed by synthetic data;
                runnable end-to-end with no network access (CI smoke tests).
  alpaca-paper  Alpaca *paper* trading account (simulated money). Requires
                alpaca-py + ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY.
  robinhood     ⚠️ REAL MONEY. Robinhood crypto has no paper mode. Requires
                ROBINHOOD_API_KEY / ROBINHOOD_PRIVATE_KEY *and* the explicit
                acknowledgment env var
                ROBINHOOD_LIVE_ACK=I_UNDERSTAND_THIS_TRADES_REAL_MONEY.
                Market data comes from Alpaca's free crypto data feed
                (no keys needed); execution goes to Robinhood.

Neither network broker is testable in this sandbox (egress blocked) --
verify via GitHub Actions `workflow_dispatch`.

After each run, trade confirmations are sent via any configured notification
channel (NTFY_TOPIC for push, TWILIO_* for SMS) -- see tradingbot/notify.py.
"""
from __future__ import annotations

import argparse
import json
import os

from tradingbot.config import DEFAULT_RISK_CONFIG, DEFAULT_STRATEGY
from tradingbot.data.feed import SyntheticDataFeed
from tradingbot.execution.paper_sim_broker import PaperSimBroker
from tradingbot.notify import notify_report
from tradingbot.runner import run_daily_step
from tradingbot.strategies import build_strategy

DEFAULT_SYMBOLS = ["BTC", "ETH", "SOL", "AVAX"]


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Run one live/paper trading step.")
    p.add_argument("--strategy", default=DEFAULT_STRATEGY)
    p.add_argument("--broker", default="paper-sim",
                   choices=["paper-sim", "alpaca-paper", "robinhood"])
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
    elif args.broker == "robinhood":
        # Real-money broker: RobinhoodCryptoBroker refuses to construct
        # without the explicit ROBINHOOD_LIVE_ACK env var.
        from tradingbot.data.alpaca_feed import AlpacaCryptoFeed
        from tradingbot.execution.robinhood_broker import RobinhoodCryptoBroker

        broker = RobinhoodCryptoBroker()
        data_feed = AlpacaCryptoFeed()  # free crypto candles, no keys needed
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
    report["broker"] = args.broker

    os.makedirs(args.out, exist_ok=True)
    out_path = os.path.join(args.out, f"{report['date']}.json")
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2, default=str)

    channels = notify_report(report)
    if channels:
        report["notified_via"] = channels

    print(json.dumps(report, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
