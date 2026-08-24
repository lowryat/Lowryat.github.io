import json
import os

from tradingbot.stats import collect, render


def _write(tmp_path, bot, name, payload):
    d = tmp_path / bot
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_text(json.dumps(payload))


def test_dry_run_reports_excluded_from_live_stats(tmp_path):
    """paper-sim reports are dry runs -- they must not count as live performance."""
    _write(tmp_path, "ema_atr_trend", "2024-02-04.json",
           {"date": "2024-02-04", "equity": 9999.0, "broker": "paper-sim", "actions": []})
    bots = collect(str(tmp_path), starting_equity=2500.0)
    assert bots["ema_atr_trend"]["live_days"] == 0
    assert bots["ema_atr_trend"]["dry_days"] == 1
    assert bots["ema_atr_trend"]["equity"] == 2500.0  # falls back to allocation
    assert "No live-broker runs recorded yet" in render(bots)


def test_live_reports_and_trade_metrics(tmp_path):
    _write(tmp_path, "donchian_breakout", "2026-08-24.json", {
        "date": "2026-08-24", "equity": 2600.0, "broker": "alpaca-paper",
        "dd_day": 0.01, "dd_week": 0.02, "halted_today": False, "halted_week": False,
        "actions": [
            {"symbol": "ETH", "action": "exit_stop",
             "trade": {"symbol": "ETH", "pnl": 150.0, "r_multiple": 3.0,
                       "exit_date": "2026-08-24", "exit_reason": "stop"}},
            {"symbol": "SOL", "action": "exit_signal",
             "trade": {"symbol": "SOL", "pnl": -50.0, "r_multiple": -1.0,
                       "exit_date": "2026-08-24", "exit_reason": "signal"}},
        ],
    })
    bots = collect(str(tmp_path), starting_equity=2500.0)
    b = bots["donchian_breakout"]
    assert b["live_days"] == 1
    assert b["n_trades"] == 2
    assert b["wins"] == 1 and b["losses"] == 1
    assert b["win_rate"] == 50.0
    assert b["avg_r"] == 1.0
    assert b["pnl"] == 100.0

    out = render(bots)
    assert "donchian_breakout" in out
    assert "PORTFOLIO" in out


def test_halted_bot_shows_in_risk_status(tmp_path):
    _write(tmp_path, "momentum_regime", "2026-08-24.json", {
        "date": "2026-08-24", "equity": 2400.0, "broker": "alpaca-paper",
        "dd_day": 0.035, "dd_week": 0.035, "halted_today": True, "halted_week": False,
        "actions": [],
    })
    bots = collect(str(tmp_path), starting_equity=2500.0)
    assert bots["momentum_regime"]["halted"] is True
    assert "HALTED" in render(bots)


def test_missing_directory_is_safe(tmp_path):
    bots = collect(str(tmp_path / "nope"), starting_equity=2500.0)
    assert all(b["live_days"] == 0 for b in bots.values())
    assert "No live-broker runs" in render(bots)
