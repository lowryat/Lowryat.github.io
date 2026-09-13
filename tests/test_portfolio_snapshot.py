"""Snapshot builder + alert selection, offline."""
import json
from datetime import date

from portfolio_analytics.alerts import format_alert, select_alerts, send_alerts
from portfolio_analytics.analytics import TaxSettings
from portfolio_analytics.snapshot import build_snapshot, load_settings, write_snapshot

AS_OF = date(2026, 9, 13)


def test_demo_snapshot_shape(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    snap = build_snapshot(as_of=AS_OF, demo_mode=True, settings=TaxSettings())
    assert snap["demo"] is True and snap["as_of"] == "2026-09-13"
    assert {"positions", "history", "price_history", "realized", "robinhood", "analytics", "sources"} <= set(snap)
    assert all(v["mode"] == "demo" for v in snap["sources"].values())
    assert snap["analytics"]["totals"]["value"] > 0 and snap["analytics"]["items"]
    path = write_snapshot(snap, out_dir=str(tmp_path / "out"))
    data = json.loads(open(path).read())
    assert data["version"] == 1
    assert not (tmp_path / "out" / "history").exists()  # demo snapshots don't pollute history


def test_falls_back_to_demo_without_credentials(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    for k in ("AWAKEN_API_KEY", "ROBINHOOD_API_KEY", "ROBINHOOD_PRIVATE_KEY"):
        monkeypatch.delenv(k, raising=False)
    snap = build_snapshot(as_of=AS_OF, demo_mode=False, settings=TaxSettings(), fetch_prices=False)
    assert snap["demo"] is True
    assert "not set" in snap["sources"]["awaken"]["detail"]


def test_load_settings_env_override(tmp_path, monkeypatch):
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({"short_term_rate": 0.32, "wash_sale_conservative": True}))
    monkeypatch.setenv("PORTFOLIO_MAX_WEIGHT", "0.5")
    s = load_settings(str(p))
    assert s.short_term_rate == 0.32 and s.wash_sale_conservative is True and s.max_weight == 0.5


def test_alert_selection_and_cooldown(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    snap = build_snapshot(as_of=AS_OF, demo_mode=True, settings=TaxSettings())
    items = select_alerts(snap, {}, as_of=AS_OF, min_usd=250)
    assert items and all(i["priority"] == 1 or abs(i["tax_effect"] or 0) >= 250 for i in items)
    title, body = format_alert(snap, items)
    assert "demo data" in title and "Harvestable" in body
    # Everything sent today is suppressed for the cooldown window.
    from portfolio_analytics.alerts import _key
    sent = {_key(i): "2026-09-10" for i in items}
    assert select_alerts(snap, sent, as_of=AS_OF, cooldown_days=7) == []
    assert select_alerts(snap, sent, as_of=AS_OF, cooldown_days=2) == items


def test_send_alerts_records_state(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    snap = build_snapshot(as_of=AS_OF, demo_mode=True, settings=TaxSettings())
    posted = []

    class R:
        status_code = 200

    monkeypatch.setattr("portfolio_analytics.alerts.send_ntfy", lambda topic, title, body, server: posted.append((topic, title)) or True)
    state = tmp_path / "alerts_sent.json"
    res = send_alerts(snap, env={"NTFY_TOPIC": "t1"}, state_path=str(state))
    assert res["channels"] == ["ntfy"] and posted[0][0] == "t1"
    assert json.loads(state.read_text())
    res2 = send_alerts(snap, env={"NTFY_TOPIC": "t1"}, state_path=str(state))
    assert res2["selected"] == 0  # cooldown
    dry = send_alerts(snap, env={}, state_path=str(tmp_path / "x.json"), dry_run=True)
    assert dry["channels"] == [] and dry["title"]
