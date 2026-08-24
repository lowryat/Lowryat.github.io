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
              server: str = "https://ntfy.sh", post=requests.post) -> bool:
    resp = post(
        f"{server.rstrip('/')}/{topic}",
        data=body.encode("utf-8"),
        headers={"Title": title, "Tags": "chart_with_upwards_trend"},
        timeout=10,
    )
    return 200 <= resp.status_code < 300


def send_twilio_sms(account_sid: str, auth_token: str, from_num: str, to_num: str,
                    body: str, post=requests.post) -> bool:
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

    topic = env.get("NTFY_TOPIC")
    if topic:
        try:
            if send_ntfy(topic, title, body, server=env.get("NTFY_SERVER", "https://ntfy.sh")):
                sent.append("ntfy")
        except Exception:
            pass

    sid = env.get("TWILIO_ACCOUNT_SID")
    token = env.get("TWILIO_AUTH_TOKEN")
    from_num = env.get("TWILIO_FROM")
    to_num = env.get("TWILIO_TO")
    if sid and token and from_num and to_num:
        try:
            if send_twilio_sms(sid, token, from_num, to_num, f"{title}\n{body}"):
                sent.append("sms")
        except Exception:
            pass

    return sent
