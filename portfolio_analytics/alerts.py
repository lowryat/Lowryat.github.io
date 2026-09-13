"""Push alerts for actionable insights, via the existing ntfy/Twilio plumbing.

Alert rules (each must be true to send):
  * the insight is priority 1, or its tax effect >= PORTFOLIO_ALERT_MIN_USD (default $250)
  * it was not already sent within PORTFOLIO_ALERT_COOLDOWN_DAYS (default 7)
    -- tracked in reports/portfolio/alerts_sent.json so a daily job doesn't nag
"""
from __future__ import annotations

import json
import os
from datetime import date, datetime

from tradingbot.notify import send_ntfy, send_twilio_sms

STATE_PATH = os.path.join("reports", "portfolio", "alerts_sent.json")


def _key(item: dict) -> str:
    return f"{item['kind']}:{item.get('symbol') or '-'}:{round(item.get('amount_usd') or 0, -2)}"


def select_alerts(snapshot: dict, sent: dict | None = None, as_of: date | None = None,
                  min_usd: float = 250.0, cooldown_days: int = 7) -> list[dict]:
    sent = sent or {}
    as_of = as_of or date.fromisoformat(snapshot["as_of"])
    out = []
    for item in snapshot["analytics"]["items"]:
        effect = abs(item.get("tax_effect") or 0.0)
        if not (item["priority"] == 1 or effect >= min_usd):
            continue
        last = sent.get(_key(item))
        if last:
            try:
                if (as_of - date.fromisoformat(last)).days < cooldown_days:
                    continue
            except ValueError:
                pass
        out.append(item)
    return out


def format_alert(snapshot: dict, items: list[dict]) -> tuple[str, str]:
    totals = snapshot["analytics"]["totals"]
    hs = snapshot["analytics"]["harvest_summary"]
    lines = [f"Portfolio ${totals['value']:,.0f} (unrealized {totals['unrealized']:+,.0f})"]
    for it in items[:6]:
        eff = it.get("tax_effect")
        tail = f" (~${eff:+,.0f} tax)" if eff else ""
        lines.append(f"• {it['title']}{tail}")
    if hs.get("est_tax_savings"):
        lines.append(f"Harvestable: ${hs['total_loss']:,.0f} loss ≈ ${hs['est_tax_savings']:,.0f} saved")
    demo = " (demo data)" if snapshot.get("demo") else ""
    title = f"Portfolio {snapshot['as_of']}: {len(items)} action{'s' if len(items) != 1 else ''}{demo}"
    return title, "\n".join(lines)


def send_alerts(snapshot: dict, env: dict | None = None, state_path: str = STATE_PATH,
                dry_run: bool = False) -> dict:
    env = env if env is not None else dict(os.environ)

    def cfg(k: str, d: str = "") -> str:
        return (env.get(k) or "").strip() or d

    min_usd = float(cfg("PORTFOLIO_ALERT_MIN_USD", "250"))
    cooldown = int(cfg("PORTFOLIO_ALERT_COOLDOWN_DAYS", "7"))
    sent: dict = {}
    if os.path.exists(state_path):
        with open(state_path) as f:
            sent = json.load(f)
    items = select_alerts(snapshot, sent, min_usd=min_usd, cooldown_days=cooldown)
    result = {"selected": len(items), "channels": [], "title": None, "body": None}
    if not items:
        print("[alerts] nothing new worth an alert")
        return result
    title, body = format_alert(snapshot, items)
    result.update({"title": title, "body": body})
    if dry_run:
        print(f"[alerts] DRY RUN\n{title}\n{body}")
        return result

    topic = cfg("NTFY_TOPIC")
    if topic:
        try:
            if send_ntfy(topic, title, body, server=cfg("NTFY_SERVER", "https://ntfy.sh")):
                result["channels"].append("ntfy")
        except Exception as exc:  # noqa: BLE001
            print(f"[alerts] ntfy failed: {exc}")
    sid, tok, frm, to = cfg("TWILIO_ACCOUNT_SID"), cfg("TWILIO_AUTH_TOKEN"), cfg("TWILIO_FROM"), cfg("TWILIO_TO")
    if sid and tok and frm and to:
        try:
            if send_twilio_sms(sid, tok, frm, to, f"{title}\n{body}"):
                result["channels"].append("sms")
        except Exception as exc:  # noqa: BLE001
            print(f"[alerts] sms failed: {exc}")

    if result["channels"]:
        today = snapshot["as_of"]
        for it in items:
            sent[_key(it)] = today
        os.makedirs(os.path.dirname(state_path), exist_ok=True)
        with open(state_path, "w") as f:
            json.dump(sent, f, indent=1, sort_keys=True)
        print(f"[alerts] sent via {', '.join(result['channels'])}")
    else:
        print("[alerts] no channel configured or all failed (set NTFY_TOPIC)")
    return result
