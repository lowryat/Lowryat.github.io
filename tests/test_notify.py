from tradingbot.notify import format_report_message, notify_report, send_ntfy


class FakeResponse:
    status_code = 200


def test_format_report_with_trades():
    report = {
        "date": "2026-08-24 00:00:00",
        "equity": 10_512.34,
        "dd_day": 0.012,
        "dd_week": 0.021,
        "halted_today": False,
        "halted_week": False,
        "actions": [
            {"symbol": "BTC", "action": "entry", "qty": 0.05, "price": 62_000.0, "stop": 59_000.0},
            {"symbol": "SOL", "action": "exit_stop",
             "trade": {"pnl": -120.5, "r_multiple": -1.0}},
        ],
    }
    title, body = format_report_message(report)
    assert "2 trades" in title
    assert "BUY BTC" in body
    assert "SELL SOL (stop)" in body
    assert "$10,512.34" in body


def test_format_report_halted():
    report = {"date": "2026-08-24", "equity": 9_500.0, "dd_day": 0.035,
              "dd_week": 0.035, "halted_today": True, "halted_week": False,
              "actions": []}
    title, body = format_report_message(report)
    assert "HALTED" in title
    assert "CIRCUIT BREAKER" in body


def test_format_report_skipped():
    report = {"date": "2026-08-24", "equity": 10_000.0, "skipped": True}
    title, body = format_report_message(report)
    assert "no new bar" in title


def test_notify_report_no_channels_is_noop():
    report = {"date": "2026-08-24", "equity": 10_000.0, "actions": []}
    assert notify_report(report, env={}) == []


def _entry_report():
    return {
        "date": "2024-02-04 00:00:00", "equity": 2500.0,
        "dd_day": 0.0, "dd_week": 0.0,
        "halted_today": False, "halted_week": False,
        "actions": [{"symbol": "ETH", "action": "entry", "qty": 0.348,
                     "price": 1796.0, "stop": 1668.06}],
    }


def test_empty_ntfy_server_falls_back_to_default(monkeypatch):
    """GitHub Actions sets `FOO: ${{ secrets.FOO }}` to an empty string when
    the secret is absent -- env.get(k, default) returns "" not the default.
    That produced an invalid URL ("/topic") and a silently swallowed
    MissingSchema, so no notification was ever sent."""
    posted = {}

    def fake_post(url, **kwargs):
        posted["url"] = url
        return FakeResponse()

    monkeypatch.setattr("tradingbot.notify.requests.post", fake_post)

    sent = notify_report(_entry_report(), env={
        "NTFY_TOPIC": "my-topic",
        "NTFY_SERVER": "",            # <- the bug trigger
        "NOTIFY_ONLY_ON_ACTION": "true",
    })

    assert sent == ["ntfy"]
    assert posted["url"] == "https://ntfy.sh/my-topic"


def test_whitespace_only_topic_treated_as_unset():
    assert notify_report(_entry_report(), env={"NTFY_TOPIC": "   "}) == []


def test_custom_ntfy_server_still_honoured(monkeypatch):
    posted = {}

    def fake_post(url, **kwargs):
        posted["url"] = url
        return FakeResponse()

    monkeypatch.setattr("tradingbot.notify.requests.post", fake_post)
    notify_report(_entry_report(), env={
        "NTFY_TOPIC": "t", "NTFY_SERVER": "https://ntfy.example.com/",
    })
    assert posted["url"] == "https://ntfy.example.com/t"


def test_send_failure_is_reported_not_swallowed(capsys, monkeypatch):
    def boom(url, **kwargs):
        raise RuntimeError("network down")

    monkeypatch.setattr("tradingbot.notify.requests.post", boom)
    sent = notify_report(_entry_report(), env={"NTFY_TOPIC": "t"})

    assert sent == []
    out = capsys.readouterr().out
    assert "ntfy send failed" in out and "network down" in out


def test_send_ntfy_posts_to_topic():
    calls = []

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        return FakeResponse()

    ok = send_ntfy("my-topic", "Title", "Body", post=fake_post)
    assert ok
    url, kwargs = calls[0]
    assert url == "https://ntfy.sh/my-topic"
    assert kwargs["headers"]["Title"] == "Title"
