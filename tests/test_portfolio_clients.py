"""Awaken / Robinhood client tests with a fake HTTP session (no network)."""
import base64
import json

import pytest

from portfolio_analytics.awaken import (AwakenClient, AwakenError, parse_money_string, positions_from_portfolio,
                                        realized_from_cap_gains)
from portfolio_analytics.robinhood import RobinhoodReadOnly, lots_from_orders, positions_from_robinhood, recent_activity


class FakeResp:
    def __init__(self, payload, status=200, headers=None, text=None):
        self._payload, self.status_code, self.headers = payload, status, headers or {}
        self.text = text if text is not None else json.dumps(payload)

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeSession:
    def __init__(self, responses):
        self.responses, self.calls = list(responses), []

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append(("POST", url, json, headers))
        return self.responses.pop(0)

    def get(self, url, headers=None, timeout=None):
        self.calls.append(("GET", url, None, headers))
        return self.responses.pop(0)


# --- Awaken -------------------------------------------------------------------

def test_awaken_requires_key(monkeypatch):
    monkeypatch.delenv("AWAKEN_API_KEY", raising=False)
    with pytest.raises(AwakenError):
        AwakenClient()


def test_awaken_sends_api_key_header_and_returns_data():
    sess = FakeSession([FakeResp({"data": {"getMyClients": [{"id": "c1", "name": "Me"}]}})])
    c = AwakenClient(api_key="awaken_x", session=sess, min_interval_s=0)
    assert c.get_my_clients() == [{"id": "c1", "name": "Me"}]
    method, url, body, headers = sess.calls[0]
    assert headers["x-api-key"] == "awaken_x" and "getMyClients" in body["query"]


def test_awaken_discovers_client_by_probing_403s():
    sess = FakeSession([
        FakeResp({"data": {"getMyClients": [{"id": "a"}, {"id": "b"}]}}),
        FakeResp({"errors": [{"message": "nope", "extensions": {"code": "403"}}]}),
        FakeResp({"data": {"getClientTransactions": {"total": 3}}}),
    ])
    c = AwakenClient(api_key="k", session=sess, min_interval_s=0)
    assert c.discover_client_id() == "b"


def test_awaken_error_codes_surface():
    sess = FakeSession([FakeResp({"errors": [{"message": "bad key", "extensions": {"code": "UNAUTHENTICATED"}}]}, status=401)])
    c = AwakenClient(api_key="k", client_id="c", session=sess, min_interval_s=0)
    with pytest.raises(AwakenError) as exc:
        c.get_client()
    assert exc.value.code == "UNAUTHENTICATED"
    sess = FakeSession([FakeResp({}, status=429, headers={"RateLimit-Reset": "12"})])
    with pytest.raises(AwakenError) as exc:
        AwakenClient(api_key="k", client_id="c", session=sess, min_interval_s=0).get_client()
    assert exc.value.code == "RATE_LIMITED"


def test_positions_from_portfolio_converts_cents_and_lots():
    portfolio = {"balances": [
        {"symbol": "ETH", "name": "Ethereum", "provider": "coinbase", "assetPricingKey": "eth", "totalAmount": "2",
         "totalFiatAmountCents": 800000, "costBasisCents": 500000, "gainLossCents": 300000},
        {"symbol": "DUST", "totalAmount": 0, "totalFiatAmountCents": 0},
    ]}
    lots = {"eth": [{"amount": 1.5, "fiatAmountCents": 300000, "purchasedAt": "2025-01-05T00:00:00.000Z", "accountId": "acc1"},
                    {"amount": 0.5, "fiatAmountCents": 200000, "purchasedAt": "2026-08-01", "accountId": "acc2"}]}
    pos = positions_from_portfolio(portfolio, lots, {"acc1": "Coinbase"})
    assert len(pos) == 1
    p = pos[0]
    assert p["value"] == 8000.0 and p["cost_basis"] == 5000.0 and p["price"] == 4000.0 and p["unrealized"] == 3000.0
    assert p["lots"][0] == {"id": "ETH-0", "amount": 1.5, "basis": 3000.0, "purchased_at": "2025-01-05", "account": "Coinbase"}
    assert p["lots"][1]["account"] == "acc2"


def test_positions_without_lot_detail_get_unknown_age_lot():
    pos = positions_from_portfolio({"balances": [{"symbol": "X", "totalAmount": 1, "totalFiatAmountCents": 1000, "costBasisCents": 500}]})
    assert pos[0]["lots"][0]["age_unknown"] is True and pos[0]["lots"][0]["basis"] == 5.0


def test_money_strings():
    assert parse_money_string("-$4,863.81") == -4863.81
    assert parse_money_string("$160,372.75") == 160372.75
    assert parse_money_string(None) == 0.0
    r = realized_from_cap_gains({"capGainsShortTerm": "$1,000.00", "capGainsLongTerm": "-$200.00", "capGainsTotal": "$800.00", "incomeTotal": "$5.00"}, "2026")
    assert r == {"year": 2026, "short_term": 1000.0, "long_term": -200.0, "total": 800.0, "income": 5.0}


# --- Robinhood ----------------------------------------------------------------

SEED_B64 = base64.b64encode(b"\x07" * 32).decode()


def test_robinhood_readonly_has_no_order_methods():
    forbidden = {"submit_market_order", "cancel_order", "place_order", "post", "_post"}
    assert not forbidden & set(dir(RobinhoodReadOnly))
    assert RobinhoodReadOnly.ALLOWED_METHODS == ("GET",)


def test_robinhood_readonly_signs_get_requests(monkeypatch):
    monkeypatch.delenv("ROBINHOOD_LIVE_ACK", raising=False)  # not needed for read-only
    sess = FakeSession([FakeResp({"buying_power": "12.50"})])
    rh = RobinhoodReadOnly(api_key="key", private_key_b64=SEED_B64, session=sess)
    assert rh.account()["buying_power"] == "12.50"
    method, url, _, headers = sess.calls[0]
    assert method == "GET" and url.endswith("/api/v1/crypto/trading/accounts/")
    assert {"x-api-key", "x-signature", "x-timestamp"} <= set(headers)


def test_robinhood_holdings_paginate():
    sess = FakeSession([
        FakeResp({"results": [{"asset_code": "BTC", "total_quantity": "1"}], "next": "https://trading.robinhood.com/api/v1/crypto/trading/holdings/?cursor=2"}),
        FakeResp({"results": [{"asset_code": "ETH", "total_quantity": "2"}], "next": None}),
    ])
    rh = RobinhoodReadOnly(api_key="key", private_key_b64=SEED_B64, session=sess)
    assert [h["asset_code"] for h in rh.holdings()] == ["BTC", "ETH"]
    assert sess.calls[1][1].endswith("?cursor=2")


ORDERS = [
    {"state": "filled", "symbol": "BTC-USD", "side": "buy", "created_at": "2025-01-01T00:00:00Z",
     "executions": [{"quantity": "1.0", "effective_price": "50000", "timestamp": "2025-01-01T00:00:00Z"}]},
    {"state": "filled", "symbol": "BTC-USD", "side": "buy", "created_at": "2025-06-01T00:00:00Z",
     "executions": [{"quantity": "1.0", "effective_price": "70000", "timestamp": "2025-06-01T00:00:00Z"}]},
    {"state": "filled", "symbol": "BTC-USD", "side": "sell", "created_at": "2026-09-10T00:00:00Z", "type": "market",
     "executions": [{"quantity": "1.5", "effective_price": "100000", "timestamp": "2026-09-10T00:00:00Z"}]},
    {"state": "canceled", "symbol": "ETH-USD", "side": "buy", "executions": []},
]


def test_lots_from_orders_fifo():
    lots = lots_from_orders(ORDERS)
    assert list(lots) == ["BTC"]
    (lot,) = lots["BTC"]
    assert lot["amount"] == pytest.approx(0.5) and lot["basis"] == pytest.approx(35000) and lot["purchased_at"] == "2025-06-01"


def test_positions_from_robinhood_and_activity():
    from datetime import date
    pos = positions_from_robinhood([{"asset_code": "BTC", "total_quantity": "0.5"}, {"asset_code": "ZERO", "total_quantity": "0"}],
                                   {"BTC-USD": 100000.0}, lots_from_orders(ORDERS))
    assert len(pos) == 1 and pos[0]["value"] == 50000.0 and pos[0]["cost_basis"] == pytest.approx(35000)
    act = recent_activity(ORDERS, days=30, as_of=date(2026, 9, 13))
    assert len(act) == 1 and act[0]["side"] == "sell" and act[0]["notional"] == 150000.0
