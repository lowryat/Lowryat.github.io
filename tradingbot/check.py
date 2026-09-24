"""Pre-flight credential and connectivity check.

    python -m tradingbot.check                 # check the configured broker
    python -m tradingbot.check --broker alpaca-paper

Exits non-zero if the broker cannot be reached or rejects the credentials.
Run this before the trading step so an auth problem produces one clear line
instead of a stack trace buried in a loop over four bots.
"""
from __future__ import annotations

import argparse
import os
import sys


def check_alpaca() -> tuple[bool, str]:
    key = (os.environ.get("ALPACA_API_KEY_ID") or "").strip()
    secret = (os.environ.get("ALPACA_API_SECRET_KEY") or "").strip()

    if not key or not secret:
        missing = [n for n, v in (("ALPACA_API_KEY_ID", key),
                                  ("ALPACA_API_SECRET_KEY", secret)) if not v]
        return False, f"missing secret(s): {', '.join(missing)}"

    # Paper keys are issued with a PK prefix; live keys use AK and will be
    # rejected by the paper endpoint. Worth saying out loud rather than
    # letting it surface as a bare 'unauthorized'.
    hint = ""
    if key.startswith("AK"):
        hint = ("  NOTE: this key starts with 'AK', which is a LIVE key. "
                "The paper endpoint needs a 'PK' key generated with the "
                "dashboard's Live/Paper toggle set to Paper.")

    try:
        from alpaca.trading.client import TradingClient
        client = TradingClient(key, secret, paper=True)
        account = client.get_account()
    except Exception as exc:
        detail = str(exc)
        if "unauthorized" in detail.lower():
            return False, (
                "Alpaca rejected the credentials (unauthorized)." + (hint or
                "  The key/secret is wrong, was regenerated in Alpaca without "
                "updating the repo secret, or is a live key rather than a paper key.")
            )
        return False, f"{type(exc).__name__}: {detail}"

    return True, (f"authenticated  equity=${float(account.equity):,.2f}  "
                  f"cash=${float(account.cash):,.2f}  status={account.status}")


def check_market_data() -> tuple[bool, str]:
    """Alpaca crypto market data is keyless, so this can succeed even when
    the trading credentials are broken -- which is exactly how a dead bot can
    still emit reports that look real."""
    try:
        from tradingbot.data.alpaca_feed import AlpacaCryptoFeed
        data = AlpacaCryptoFeed(lookback_days=5).get_data(["BTC"])
        df = data["BTC"]
        return True, f"{len(df)} bars, latest BTC close ${float(df['close'].iloc[-1]):,.2f}"
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"


def check_robinhood() -> tuple[bool, str]:
    ack = os.environ.get("ROBINHOOD_LIVE_ACK", "")
    from tradingbot.execution.robinhood_broker import ACK_VALUE
    if ack != ACK_VALUE:
        return False, "ROBINHOOD_LIVE_ACK not set — real-money trading is disabled (this is the safe default)"
    try:
        from tradingbot.execution.robinhood_broker import RobinhoodCryptoBroker
        broker = RobinhoodCryptoBroker()
        cash = broker.get_cash()
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"
    return True, f"authenticated  buying_power=${cash:,.2f}  ** REAL MONEY **"


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Check broker credentials and connectivity.")
    p.add_argument("--broker", default="alpaca-paper",
                   choices=["alpaca-paper", "robinhood", "paper-sim"])
    args = p.parse_args(argv)

    print(f"[check] broker: {args.broker}")
    failures = 0

    if args.broker == "paper-sim":
        # paper-sim is driven by the synthetic feed and an in-memory broker,
        # so it needs neither market data nor credentials.
        print("[check] paper-sim    : OK   in-memory broker + synthetic feed, no credentials needed")
        print("[check] all checks passed")
        return 0

    ok, msg = check_market_data()
    print(f"[check] market data  : {'OK  ' if ok else 'FAIL'} {msg}")
    if not ok:
        failures += 1

    if args.broker == "alpaca-paper":
        ok, msg = check_alpaca()
        print(f"[check] alpaca paper : {'OK  ' if ok else 'FAIL'} {msg}")
        if not ok:
            failures += 1
    else:
        ok, msg = check_robinhood()
        print(f"[check] robinhood    : {'OK  ' if ok else 'FAIL'} {msg}")
        if not ok:
            failures += 1

    if failures:
        print(f"[check] {failures} check(s) failed — the bot will NOT be able to trade.",
              file=sys.stderr)
        return 1
    print("[check] all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
