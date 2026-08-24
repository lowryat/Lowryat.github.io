"""Consolidated performance dashboard across all bots.

    python -m tradingbot.stats                # read committed reports
    python -m tradingbot.stats --reconcile    # also compare vs the live Alpaca account

Reads reports/live/**/*.json (the daily run reports each bot writes) plus the
state_*.json files, and prints per-bot and portfolio-level statistics.

--reconcile additionally queries the broker and flags any disagreement between
what a bot *thinks* it holds and what the account actually holds. Divergence
usually means a bot's state was carried over from a different broker (e.g.
dry-run paper-sim positions surviving into an Alpaca run).
"""
from __future__ import annotations

import argparse
import glob
import json
import os
from collections import defaultdict

BOTS = ["ema_atr_trend", "donchian_breakout", "momentum_regime", "dual_momentum_adaptive"]


def _load_reports(live_dir: str, bot: str) -> list[dict]:
    out = []
    for path in sorted(glob.glob(os.path.join(live_dir, bot, "*.json"))):
        try:
            with open(path) as f:
                d = json.load(f)
            d["_path"] = path
            out.append(d)
        except (json.JSONDecodeError, OSError):
            continue
    return out


def _load_state(live_dir: str, bot: str) -> dict | None:
    path = os.path.join(live_dir, f"state_{bot}.json")
    if not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def collect(live_dir: str = "reports/live", starting_equity: float = 2500.0) -> dict:
    """Gather per-bot stats. Only reports from a real broker are counted as
    live performance; paper-sim (dry-run) reports are tallied separately."""
    bots = {}
    for bot in BOTS:
        reports = _load_reports(live_dir, bot)
        live = [r for r in reports if r.get("broker") and r["broker"] != "paper-sim"]
        dry = [r for r in reports if r.get("broker") == "paper-sim" or not r.get("broker")]

        trades, entries = [], []
        for r in live:
            for a in r.get("actions", []):
                if a.get("action") == "entry":
                    entries.append({"date": r.get("date"), **a})
                elif a.get("trade"):
                    trades.append({"date": r.get("date"), "reason": a.get("action"), **a["trade"]})

        state = _load_state(live_dir, bot)
        equity = live[-1]["equity"] if live else (state or {}).get("cash", starting_equity)

        wins = [t for t in trades if t.get("pnl", 0) > 0]
        losses = [t for t in trades if t.get("pnl", 0) <= 0]
        rs = [t.get("r_multiple", 0.0) for t in trades]

        bots[bot] = {
            "live_days": len(live),
            "dry_days": len(dry),
            "equity": equity,
            "start": starting_equity,
            "pnl": equity - starting_equity,
            "return_pct": (equity / starting_equity - 1) * 100 if starting_equity else 0.0,
            "n_trades": len(trades),
            "n_entries": len(entries),
            "wins": len(wins),
            "losses": len(losses),
            "win_rate": 100.0 * len(wins) / len(trades) if trades else None,
            "avg_r": sum(rs) / len(rs) if rs else None,
            "total_r": sum(rs) if rs else 0.0,
            "best": max((t.get("r_multiple", 0) for t in trades), default=None),
            "worst": min((t.get("r_multiple", 0) for t in trades), default=None),
            "dd_day": live[-1].get("dd_day", 0.0) if live else 0.0,
            "dd_week": live[-1].get("dd_week", 0.0) if live else 0.0,
            "halted": bool(live and (live[-1].get("halted_today") or live[-1].get("halted_week"))),
            "positions": (state or {}).get("positions", {}),
            "last_prices": (state or {}).get("last_prices", {}),
            "trades": trades,
            "last_date": live[-1].get("date") if live else None,
        }
    return bots


def _fmt(v, spec="+,.2f", dash="—"):
    return dash if v is None else format(v, spec)


def render(bots: dict, starting_equity: float = 2500.0) -> str:
    L = []
    W = 78
    L.append("=" * W)
    L.append("TRADING BOT PERFORMANCE".center(W))
    L.append("=" * W)

    live_days = max((b["live_days"] for b in bots.values()), default=0)
    dates = [b["last_date"] for b in bots.values() if b["last_date"]]
    if live_days == 0:
        L.append("")
        L.append("  No live-broker runs recorded yet (dry-run reports only).")
        L.append("  Set TRADING_ENABLED=true to start trading against Alpaca paper.")
        L.append("")
        return "\n".join(L)

    L.append(f"  Live sessions: {live_days}    Latest bar: {max(dates)}")
    L.append("")

    hdr = f"  {'Bot':<24}{'Equity':>11}{'P&L':>10}{'Ret':>8}{'Trades':>8}{'Win%':>7}{'Avg R':>7}"
    L.append(hdr)
    L.append("  " + "-" * (W - 4))

    tot_eq = tot_start = 0.0
    tot_tr = tot_w = 0
    for bot, b in bots.items():
        tot_eq += b["equity"]
        tot_start += b["start"]
        tot_tr += b["n_trades"]
        tot_w += b["wins"]
        L.append(
            f"  {bot:<24}"
            f"{b['equity']:>11,.2f}"
            f"{b['pnl']:>+10,.2f}"
            f"{b['return_pct']:>7.1f}%"
            f"{b['n_trades']:>8}"
            f"{_fmt(b['win_rate'], '.0f'):>7}"
            f"{_fmt(b['avg_r'], '+.2f'):>7}"
        )

    L.append("  " + "-" * (W - 4))
    tot_ret = (tot_eq / tot_start - 1) * 100 if tot_start else 0.0
    tot_wr = f"{100.0*tot_w/tot_tr:.0f}" if tot_tr else "—"
    L.append(
        f"  {'PORTFOLIO':<24}{tot_eq:>11,.2f}{tot_eq-tot_start:>+10,.2f}"
        f"{tot_ret:>7.1f}%{tot_tr:>8}{tot_wr:>7}{'':>7}"
    )
    L.append("")

    # Open positions
    open_rows = []
    for bot, b in bots.items():
        for sym, p in b["positions"].items():
            last = b["last_prices"].get(sym)
            entry = p.get("entry_price", 0)
            unreal = (last - entry) * p.get("qty", 0) if last else None
            risk = p.get("entry_price", 0) - p.get("initial_stop", 0)
            r_now = ((last - entry) / risk) if (last and risk) else None
            open_rows.append((bot, sym, p, last, unreal, r_now))

    if open_rows:
        L.append("  OPEN POSITIONS")
        L.append(f"  {'Bot':<24}{'Sym':<6}{'Qty':>10}{'Entry':>10}{'Now':>10}{'Stop':>10}{'R':>7}")
        L.append("  " + "-" * (W - 4))
        for bot, sym, p, last, unreal, r_now in open_rows:
            L.append(
                f"  {bot:<24}{sym:<6}"
                f"{p.get('qty',0):>10.4f}"
                f"{p.get('entry_price',0):>10,.2f}"
                f"{(last or 0):>10,.2f}"
                f"{p.get('stop',0):>10,.2f}"
                f"{_fmt(r_now,'+.2f'):>7}"
            )
        L.append("")
    else:
        L.append("  No open positions — all bots flat.\n")

    # Risk status
    L.append("  RISK STATUS  (limits: 3% daily / 5% weekly)")
    L.append(f"  {'Bot':<24}{'DD day':>10}{'DD week':>10}{'Status':>12}")
    L.append("  " + "-" * (W - 4))
    for bot, b in bots.items():
        status = "HALTED" if b["halted"] else "ok"
        L.append(f"  {bot:<24}{b['dd_day']*100:>9.2f}%{b['dd_week']*100:>9.2f}%{status:>12}")
    L.append("")

    # Trade log
    all_trades = [(bot, t) for bot, b in bots.items() for t in b["trades"]]
    if all_trades:
        L.append("  CLOSED TRADES")
        L.append(f"  {'Date':<12}{'Bot':<24}{'Sym':<6}{'Reason':<14}{'P&L':>10}{'R':>7}")
        L.append("  " + "-" * (W - 4))
        for bot, t in sorted(all_trades, key=lambda x: str(x[1].get("exit_date", ""))):
            L.append(
                f"  {str(t.get('exit_date',''))[:10]:<12}{bot:<24}"
                f"{t.get('symbol',''):<6}{str(t.get('exit_reason',''))[:13]:<14}"
                f"{t.get('pnl',0):>+10,.2f}{t.get('r_multiple',0):>+7.2f}"
            )
        L.append("")

    L.append("=" * W)
    return "\n".join(L)


def reconcile(bots: dict) -> str:
    """Compare each bot's believed positions against the real broker account."""
    L = ["", "  BROKER RECONCILIATION", "  " + "-" * 74]
    try:
        from tradingbot.execution.alpaca_broker import AlpacaPaperBroker
        broker = AlpacaPaperBroker()
        actual = broker.get_positions()
        cash = broker.get_cash()
        equity = broker.get_account_equity()
    except Exception as exc:
        L.append(f"  Could not reach broker: {type(exc).__name__}: {exc}")
        L.append("  (needs ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY in the environment)")
        return "\n".join(L)

    L.append(f"  Alpaca account: equity ${equity:,.2f}   cash ${cash:,.2f}")
    L.append(f"  Actual holdings: {actual or '(none)'}")
    L.append("")

    believed: dict[str, float] = defaultdict(float)
    for bot, b in bots.items():
        for sym, p in b["positions"].items():
            believed[sym] += p.get("qty", 0.0)

    problems = []
    for sym in set(believed) | set(actual):
        want, have = believed.get(sym, 0.0), float(actual.get(sym, 0.0))
        if abs(want - have) > 1e-6:
            problems.append((sym, want, have))

    if not problems:
        L.append("  ✓ Bot state matches the broker account.")
    else:
        L.append("  ✗ MISMATCH — bots disagree with the account:")
        for sym, want, have in problems:
            L.append(f"      {sym}: bots think {want:.6f}, account holds {have:.6f}")
        L.append("")
        L.append("  A phantom position (bots think they hold what the account does not)")
        L.append("  usually means state carried over from dry-run paper-sim trading.")
        L.append("  Fix: delete the affected reports/live/state_*.json and let the bots")
        L.append("  restart flat from the real account balance.")
    return "\n".join(L)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Show trading bot performance statistics.")
    p.add_argument("--live-dir", default="reports/live")
    p.add_argument("--starting-equity", type=float, default=2500.0,
                   help="per-bot starting allocation (default 2500, matching ensemble mode)")
    p.add_argument("--reconcile", action="store_true",
                   help="also compare bot state against the live broker account")
    p.add_argument("--json", action="store_true", help="emit raw JSON instead of a table")
    args = p.parse_args(argv)

    bots = collect(args.live_dir, args.starting_equity)

    if args.json:
        slim = {k: {kk: vv for kk, vv in v.items() if kk != "trades"} for k, v in bots.items()}
        print(json.dumps(slim, indent=2, default=str))
        return 0

    print(render(bots, args.starting_equity))
    if args.reconcile:
        print(reconcile(bots))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
