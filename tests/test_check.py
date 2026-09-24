import pytest

from tradingbot import check as chk
from tradingbot.notify import notify_failure


class FakeResponse:
    status_code = 200


# ---------------------------------------------------------------- check_alpaca

def test_missing_secrets_named_explicitly(monkeypatch):
    monkeypatch.delenv("ALPACA_API_KEY_ID", raising=False)
    monkeypatch.delenv("ALPACA_API_SECRET_KEY", raising=False)
    ok, msg = chk.check_alpaca()
    assert not ok
    assert "ALPACA_API_KEY_ID" in msg and "ALPACA_API_SECRET_KEY" in msg


def test_empty_string_secret_counts_as_missing(monkeypatch):
    """GitHub sets an absent secret to "" -- it must not look configured."""
    monkeypatch.setenv("ALPACA_API_KEY_ID", "")
    monkeypatch.setenv("ALPACA_API_SECRET_KEY", "   ")
    ok, msg = chk.check_alpaca()
    assert not ok
    assert "missing secret" in msg


def test_unauthorized_gets_actionable_message(monkeypatch):
    monkeypatch.setenv("ALPACA_API_KEY_ID", "PKTEST")
    monkeypatch.setenv("ALPACA_API_SECRET_KEY", "s3cret")

    class FakeClient:
        def __init__(self, *a, **k): pass
        def get_account(self): raise RuntimeError('{"message": "unauthorized."}')

    import alpaca.trading.client as tc
    monkeypatch.setattr(tc, "TradingClient", FakeClient)

    ok, msg = chk.check_alpaca()
    assert not ok
    assert "rejected the credentials" in msg
    assert "regenerated" in msg or "paper key" in msg


def test_live_key_prefix_is_called_out(monkeypatch):
    """An AK (live) key against the paper endpoint is a common mistake."""
    monkeypatch.setenv("ALPACA_API_KEY_ID", "AKLIVEKEY")
    monkeypatch.setenv("ALPACA_API_SECRET_KEY", "s3cret")

    class FakeClient:
        def __init__(self, *a, **k): pass
        def get_account(self): raise RuntimeError('{"message": "unauthorized."}')

    import alpaca.trading.client as tc
    monkeypatch.setattr(tc, "TradingClient", FakeClient)

    ok, msg = chk.check_alpaca()
    assert not ok
    assert "LIVE key" in msg


def test_successful_auth_reports_equity(monkeypatch):
    monkeypatch.setenv("ALPACA_API_KEY_ID", "PKTEST")
    monkeypatch.setenv("ALPACA_API_SECRET_KEY", "s3cret")

    class FakeAccount:
        equity, cash, status = "10000.00", "2500.00", "ACTIVE"

    class FakeClient:
        def __init__(self, *a, **k): pass
        def get_account(self): return FakeAccount()

    import alpaca.trading.client as tc
    monkeypatch.setattr(tc, "TradingClient", FakeClient)

    ok, msg = chk.check_alpaca()
    assert ok
    assert "10,000.00" in msg


# ------------------------------------------------------------------ check main

def test_paper_sim_needs_no_network(monkeypatch, capsys):
    """paper-sim must pass offline -- it uses the synthetic feed, so a
    market-data outage must not make a dry run look broken."""
    def boom():
        raise AssertionError("market data must not be checked for paper-sim")
    monkeypatch.setattr(chk, "check_market_data", boom)

    assert chk.main(["--broker", "paper-sim"]) == 0
    assert "all checks passed" in capsys.readouterr().out


def test_main_returns_nonzero_when_broker_unreachable(monkeypatch):
    monkeypatch.setattr(chk, "check_market_data", lambda: (True, "ok"))
    monkeypatch.setattr(chk, "check_alpaca", lambda: (False, "unauthorized"))
    assert chk.main(["--broker", "alpaca-paper"]) == 1


def test_robinhood_without_ack_is_a_failure(monkeypatch):
    monkeypatch.delenv("ROBINHOOD_LIVE_ACK", raising=False)
    ok, msg = chk.check_robinhood()
    assert not ok
    assert "ROBINHOOD_LIVE_ACK" in msg


# --------------------------------------------------------------- notify_failure

def test_failure_alert_ignores_quiet_mode(monkeypatch):
    """A crash must alert even when NOTIFY_ONLY_ON_ACTION suppresses routine
    reports -- this is the gap that hid a month of dead runs."""
    posted = {}

    def fake_post(url, **kwargs):
        posted["url"] = url
        posted["headers"] = kwargs.get("headers", {})
        posted["data"] = kwargs.get("data", b"")
        return FakeResponse()

    monkeypatch.setattr("tradingbot.notify.requests.post", fake_post)

    sent = notify_failure("Alpaca rejected credentials", env={
        "NTFY_TOPIC": "t", "NOTIFY_ONLY_ON_ACTION": "true",
    })

    assert sent == ["ntfy"]
    assert posted["url"] == "https://ntfy.sh/t"
    assert "FAILED" in posted["headers"]["Title"]
    assert posted["headers"].get("Priority") == "high"
    assert b"did NOT trade" in posted["data"]


def test_failure_alert_survives_send_error(monkeypatch, capsys):
    monkeypatch.setattr("tradingbot.notify.requests.post",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down")))
    assert notify_failure("boom", env={"NTFY_TOPIC": "t"}) == []
    assert "could not be" in capsys.readouterr().out
