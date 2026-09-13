"""CLI:  python -m portfolio_analytics snapshot [--demo] [--as-of YYYY-MM-DD] [--no-alerts]
        python -m portfolio_analytics alerts  [--dry-run]
        python -m portfolio_analytics check    (verify Awaken / Robinhood credentials)
"""
from __future__ import annotations

import argparse
import json
import os
from datetime import date

from portfolio_analytics.snapshot import build_snapshot, load_settings, write_snapshot


def cmd_snapshot(args) -> int:
    as_of = date.fromisoformat(args.as_of) if args.as_of else None
    snap = build_snapshot(as_of=as_of, demo_mode=args.demo, settings=load_settings(args.settings),
                          fetch_prices=not args.no_prices)
    path = write_snapshot(snap, out_dir=args.out)
    a = snap["analytics"]
    print(f"[snapshot] wrote {path}")
    print(f"[snapshot] sources: " + ", ".join(f"{k}={v['mode']}" for k, v in snap["sources"].items()))
    print(f"[snapshot] value ${a['totals']['value']:,.0f}  unrealized {a['totals']['unrealized']:+,.0f}  "
          f"harvestable ${a['harvest_summary']['total_loss']:,.0f}  insights {len(a['items'])}")
    for it in a["items"][:8]:
        print(f"  P{it['priority']} [{it['kind']}] {it['title']}")
    if not args.no_alerts:
        from portfolio_analytics.alerts import send_alerts
        send_alerts(snap, dry_run=args.dry_run or snap["demo"])
    return 0


def cmd_alerts(args) -> int:
    from portfolio_analytics.alerts import send_alerts
    with open(os.path.join(args.out, "latest.json")) as f:
        snap = json.load(f)
    send_alerts(snap, dry_run=args.dry_run)
    return 0


def cmd_check(args) -> int:
    ok = True
    if os.environ.get("AWAKEN_API_KEY"):
        from portfolio_analytics.awaken import AwakenClient, AwakenError
        try:
            c = AwakenClient()
            cid = c.discover_client_id()
            info = c.get_client()
            print(f"[awaken] OK  client={info.get('name')!r} id={cid} basis={info.get('costBasisAlgorithm')}")
        except AwakenError as exc:
            ok = False
            print(f"[awaken] FAIL ({exc.code}): {exc}")
    else:
        print("[awaken] skipped: AWAKEN_API_KEY not set")
    if os.environ.get("ROBINHOOD_API_KEY") and os.environ.get("ROBINHOOD_PRIVATE_KEY"):
        from portfolio_analytics.robinhood import RobinhoodReadOnly
        try:
            acct = RobinhoodReadOnly().account()
            print(f"[robinhood] OK  buying_power=${float(acct.get('buying_power') or 0):,.2f}")
        except Exception as exc:  # noqa: BLE001
            ok = False
            print(f"[robinhood] FAIL: {type(exc).__name__}: {exc}")
    else:
        print("[robinhood] skipped: ROBINHOOD_API_KEY / ROBINHOOD_PRIVATE_KEY not set")
    return 0 if ok else 1


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="portfolio_analytics")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("snapshot", help="pull data, compute insights, write reports/portfolio/latest.json")
    s.add_argument("--demo", action="store_true", help="use the built-in demo dataset (no network)")
    s.add_argument("--as-of", default=None)
    s.add_argument("--out", default=os.path.join("reports", "portfolio"))
    s.add_argument("--settings", default=None, help="path to settings.json (default portfolio/settings.json)")
    s.add_argument("--no-alerts", action="store_true")
    s.add_argument("--no-prices", action="store_true", help="skip CoinGecko price history")
    s.add_argument("--dry-run", action="store_true", help="print alerts instead of sending")
    s.set_defaults(func=cmd_snapshot)
    a = sub.add_parser("alerts", help="re-send alerts from the latest snapshot")
    a.add_argument("--out", default=os.path.join("reports", "portfolio"))
    a.add_argument("--dry-run", action="store_true")
    a.set_defaults(func=cmd_alerts)
    c = sub.add_parser("check", help="verify credentials without writing anything")
    c.set_defaults(func=cmd_check)
    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
