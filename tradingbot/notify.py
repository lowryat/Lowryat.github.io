"""Trade-confirmation notifications: push (ntfy.sh) and SMS (Twilio).

Configured entirely via env vars so the GitHub Actions workflow can enable
either channel with repo secrets and no code changes:

Push (free, easiest — install the ntfy app on your phone and subscribe to
your topic):
    NTFY_TOPIC   e.g. "lowryat-tradebot-x7q2"  (pick something unguessable)
    NTFY_SERVER  optional, default https://ntfy.sh

SMS (requires a Twilio account):
    TWILIO_ACCOUNT_SID
    TWILIO_AUTH_TOKEN
    TWILIO_FROM   e.g. "+15551234567" (your Twilio number)
    TWILIO_TO     e.g. "+15557654321" (your phone)

If neither channel is configured, `notify_report` is a silent no-op, so the
bot never fails just because notifications aren't set up.
"""
from __future__ import annotations

import os

import requests


def format_report_message(report: dict) -> tuple[str, str]:
    """Build (title, body) for a daily-run report dict from run_daily_step."""
    date = str(report.get("date", "?")).split(" ")[0]
    equity = report.get("equity", 0.0)

    if report.get("skipped"):
        return (
            f"Tradebot {date}: no new bar",
            f"Already processed this bar. Equity ${equity:,.2f}.",
        )

    actions = report.get("actions", [])
    halted = report.get("halted_today") or report.get("halted_week")

    lines = []
    if not actions:
        lines.append("No trades today.")
    for a in actions:
        act = a.get("action", "?")
        sym = a.get("symbol", "?")
        if act == "entry":
            lines.append(f"BUY {sym}: {a.get('qty', 0):.6g} @ ${a.get('price', 0):,.2f} (stop ${a.get('stop', 0):,.2f})")
        else:
            trade = a.get("trade") or {}
            pnl = trade.get("pnl", 0.0)
            r = trade.get("r_multiple", 0.0)
            reason = act.replace("exit_", "")
            lines.append(f"SELL {sym} ({reason}): P&L ${pnl:+,.2f} ({r:+.2f}R)")

    lines.append(f"Equity: ${equity:,.2f}")
    lines.append(f"DD day {report.get('dd_day', 0)*100:.2f}% / week {report.get('dd_week', 0)*100:.2f}%")
    if halted:
        lines.append("⛔ CIRCUIT BREAKER HALT ACTIVE")

    n_trades = len(actions)
    title = f"Tradebot {date}: {n_trades} trade{'s' if n_trades != 1 else ''}"
    if halted:
        title = f"⛔ Tradebot {date}: HALTED"
    return title, "\n".join(lines)


def send_ntfy(topic: str, title: str, body: str,
              server: str = "https://ntfy.sh", post=None) -> bool:
    # Resolve at call time (not as a default arg) so tests can monkeypatch
    # requests.post and so no real request escapes during unit tests.
    post = post or requests.post
    resp = post(
        f"{server.rstrip('/')}/{topic}",
        data=body.encode("utf-8"),
        headers={"Title": title, "Tags": "chart_with_upwards_trend"},
        timeout=10,
    )
    return 200 <= resp.status_code < 300


def send_twilio_sms(account_sid: str, auth_token: str, from_num: str, to_num: str,
                    body: str, post=None) -> bool:
    post = post or requests.post
    resp = post(
        f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json",
        auth=(account_sid, auth_token),
        data={"From": from_num, "To": to_num, "Body": body},
        timeout=10,
    )
    return 200 <= resp.status_code < 300


def notify_report(report: dict, env: dict | None = None) -> list[str]:
    """Send the daily report over every configured channel.

    Returns the list of channels that succeeded ("ntfy", "sms"). Never raises:
    a notification failure must not kill the trading run (state is already
    saved by then).
    """
    env = env if env is not None else dict(os.environ)

    # Quiet mode (useful when several bots run daily): only notify when
    # something actually happened -- a trade, a halt, or a skipped bar is
    # NOT worth a ping; "no trades today" is suppressed.
    if env.get("NOTIFY_ONLY_ON_ACTION") == "true":
        eventful = bool(report.get("actions")) or report.get("halted_today") or report.get("halted_week")
        if not eventful:
            return []

    title, body = format_report_message(report)
    sent: list[str] = []

    # GitHub Actions sets `FOO: ${{ secrets.FOO }}` to an EMPTY STRING when the
    # secret doesn't exist -- it does not leave the variable unset. So
    # env.get(k, default) would return "" rather than the default. Treat empty
    # as absent everywhere.
    def cfg(key: str, default: str = "") -> str:
        return (env.get(key) or "").strip() or default

    topic = cfg("NTFY_TOPIC")
    if topic:
        server = cfg("NTFY_SERVER", "https://ntfy.sh")
        try:
            if send_ntfy(topic, title, body, server=server):
                sent.append("ntfy")
            else:
                # Non-2xx: surface it so it's visible in the workflow log.
                print(f"[notify] ntfy POST to {server} returned a non-success status")
        except Exception as exc:
            print(f"[notify] ntfy send failed: {type(exc).__name__}: {exc}")

    sid = cfg("TWILIO_ACCOUNT_SID")
    token = cfg("TWILIO_AUTH_TOKEN")
    from_num = cfg("TWILIO_FROM")
    to_num = cfg("TWILIO_TO")
    if sid and token and from_num and to_num:
        try:
            if send_twilio_sms(sid, token, from_num, to_num, f"{title}\n{body}"):
                sent.append("sms")
            else:
                print("[notify] Twilio returned a non-success status")
        except Exception as exc:
            print(f"[notify] SMS send failed: {type(exc).__name__}: {exc}")

    if not sent:
        configured = [n for n in ("NTFY_TOPIC", "TWILIO_ACCOUNT_SID") if cfg(n)]
        if not configured:
            print("[notify] no notification channel configured (set NTFY_TOPIC)")
        else:
            print(f"[notify] all configured channels failed: {configured}")
    else:
        print(f"[notify] sent via {', '.join(sent)}")

    return sent


def notify_failure(summary: str, env: dict | None = None) -> list[str]:
    """Alert that the daily run FAILED.

    This exists because a crash happens before `notify_report` is ever
    reached, so a broken run is otherwise completely silent -- the bot can
    stop trading for weeks without the operator noticing. Failure alerts
    ignore NOTIFY_ONLY_ON_ACTION: a failure is always worth a ping.
    """
    env = env if env is not None else dict(os.environ)

    def cfg(key: str, default: str = "") -> str:
        return (env.get(key) or "").strip() or default

    title = "Tradebot FAILED — not trading"
    body = (
        f"{summary}\n\n"
        "The bot did NOT trade. It will keep failing every day until fixed.\n"
        "Check: Actions > tradingbot-daily > latest run."
    )

    sent: list[str] = []
    topic = cfg("NTFY_TOPIC")
    if topic:
        server = cfg("NTFY_SERVER", "https://ntfy.sh")
        try:
            resp = requests.post(
                f"{server.rstrip('/')}/{topic}",
                data=body.encode("utf-8"),
                headers={"Title": title, "Tags": "rotating_light", "Priority": "high"},
                timeout=10,
            )
            if 200 <= resp.status_code < 300:
                sent.append("ntfy")
        except Exception as exc:
            print(f"[notify] failure alert could not be sent: {type(exc).__name__}: {exc}")

    sid, token = cfg("TWILIO_ACCOUNT_SID"), cfg("TWILIO_AUTH_TOKEN")
    from_num, to_num = cfg("TWILIO_FROM"), cfg("TWILIO_TO")
    if sid and token and from_num and to_num:
        try:
            if send_twilio_sms(sid, token, from_num, to_num, f"{title}\n{body}"):
                sent.append("sms")
        except Exception as exc:
            print(f"[notify] failure SMS could not be sent: {type(exc).__name__}: {exc}")

    print(f"[notify] failure alert sent via {', '.join(sent)}" if sent
          else "[notify] failure alert could not be delivered (no channel configured)")
    return sent


def main(argv=None) -> int:
    """CLI so CI can raise an alert: python -m tradingbot.notify --failure "..." """
    import argparse
    p = argparse.ArgumentParser(description="Send a tradingbot notification.")
    p.add_argument("--failure", metavar="SUMMARY",
                   help="send a high-priority failure alert with this summary")
    args = p.parse_args(argv)
    if args.failure:
        notify_failure(args.failure)
        return 0
    p.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
