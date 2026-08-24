"""Robinhood Crypto trading broker adapter (official Robinhood Crypto API).

⚠️  REAL MONEY — Robinhood has NO paper-trading mode for crypto. Every order
this broker submits spends actual dollars from the linked Robinhood account.
Because of that, construction REQUIRES an explicit acknowledgment env var:

    ROBINHOOD_LIVE_ACK=I_UNDERSTAND_THIS_TRADES_REAL_MONEY

Recommended setup: use Robinhood's dedicated agentic/crypto sub-account funded
with a small amount, never your main portfolio.

Credentials (create in Robinhood app: Account → Crypto → API):
    ROBINHOOD_API_KEY      -- the API key string
    ROBINHOOD_PRIVATE_KEY  -- base64-encoded Ed25519 private key seed

Auth model (per Robinhood Crypto API docs): each request is signed with
Ed25519 over  f"{api_key}{timestamp}{path}{method}{body}"  and sent with
x-api-key / x-signature / x-timestamp headers.

NOTE: this sandbox cannot reach trading.robinhood.com (network policy), so
this adapter is untested here. Verify via a GitHub Actions `workflow_dispatch`
run before relying on it — ideally with the account holding only a small
test balance.
"""
from __future__ import annotations

import base64
import json
import os
import time
import uuid

import requests

from tradingbot.execution.broker import Broker

BASE_URL = "https://trading.robinhood.com"

# Map our short symbols to Robinhood crypto trading pairs.
SYMBOL_MAP = {
    "BTC": "BTC-USD",
    "ETH": "ETH-USD",
    "SOL": "SOL-USD",
    "AVAX": "AVAX-USD",
    "LTC": "LTC-USD",
    "XRP": "XRP-USD",
    "DOGE": "DOGE-USD",
}

ACK_VALUE = "I_UNDERSTAND_THIS_TRADES_REAL_MONEY"


def sign_request(private_key_b64: str, api_key: str, timestamp: int,
                 path: str, method: str, body: str = "") -> str:
    """Return the base64 Ed25519 signature Robinhood expects.

    Split out as a pure function so it can be unit-tested offline.
    """
    from nacl.signing import SigningKey

    key = SigningKey(base64.b64decode(private_key_b64))
    message = f"{api_key}{timestamp}{path}{method}{body}"
    signed = key.sign(message.encode("utf-8"))
    return base64.b64encode(signed.signature).decode("utf-8")


class RobinhoodCryptoBroker(Broker):
    def __init__(self, api_key: str | None = None, private_key_b64: str | None = None):
        ack = os.environ.get("ROBINHOOD_LIVE_ACK", "")
        if ack != ACK_VALUE:
            raise RuntimeError(
                "Refusing to construct RobinhoodCryptoBroker: Robinhood crypto has "
                "no paper mode, so this trades REAL money. Set the env var "
                f"ROBINHOOD_LIVE_ACK={ACK_VALUE} to proceed deliberately."
            )
        self.api_key = api_key or os.environ["ROBINHOOD_API_KEY"]
        self.private_key_b64 = private_key_b64 or os.environ["ROBINHOOD_PRIVATE_KEY"]

    # -- internal ----------------------------------------------------------

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        timestamp = int(time.time())
        body_str = json.dumps(body) if body is not None else ""
        signature = sign_request(
            self.private_key_b64, self.api_key, timestamp, path, method, body_str
        )
        headers = {
            "x-api-key": self.api_key,
            "x-signature": signature,
            "x-timestamp": str(timestamp),
            "Content-Type": "application/json; charset=utf-8",
        }
        url = BASE_URL + path
        resp = requests.request(method, url, headers=headers,
                                data=body_str if body is not None else None,
                                timeout=15)
        resp.raise_for_status()
        return resp.json() if resp.text else {}

    # -- Broker interface --------------------------------------------------

    def get_account_equity(self) -> float:
        cash = self.get_cash()
        holdings = self.get_positions()
        mtm = 0.0
        for sym, qty in holdings.items():
            try:
                mtm += qty * self.get_last_price(sym)
            except Exception:
                pass  # unknown/unpriceable asset: count as 0 rather than crash
        return cash + mtm

    def get_cash(self) -> float:
        account = self._request("GET", "/api/v1/crypto/trading/accounts/")
        return float(account["buying_power"])

    def get_positions(self) -> dict[str, float]:
        data = self._request("GET", "/api/v1/crypto/trading/holdings/")
        reverse = {}  # asset_code is already the short symbol (e.g. "BTC")
        out: dict[str, float] = {}
        for h in data.get("results", []):
            qty = float(h.get("total_quantity", 0) or 0)
            if qty > 0:
                out[h["asset_code"]] = qty
        return out

    def get_last_price(self, symbol: str) -> float:
        pair = SYMBOL_MAP.get(symbol, f"{symbol}-USD")
        path = f"/api/v1/crypto/marketdata/best_bid_ask/?symbol={pair}"
        data = self._request("GET", path)
        result = data["results"][0]
        # Use the mid of bid/ask (both inclusive of spread) as "last".
        bid = float(result["bid_inclusive_of_sell_spread"])
        ask = float(result["ask_inclusive_of_buy_spread"])
        return (bid + ask) / 2.0

    def submit_market_order(self, symbol: str, qty: float, side: str) -> dict:
        pair = SYMBOL_MAP.get(symbol, f"{symbol}-USD")
        body = {
            "client_order_id": str(uuid.uuid4()),
            "side": side,
            "type": "market",
            "symbol": pair,
            "market_order_config": {
                # Robinhood accepts up to 8 decimal places of asset quantity.
                "asset_quantity": f"{qty:.8f}",
            },
        }
        order = self._request("POST", "/api/v1/crypto/trading/orders/", body)
        order_id = order["id"]

        # Poll for fill so the risk manager can record the true fill price.
        fill_price: float | None = None
        for _ in range(20):
            status = self._request("GET", f"/api/v1/crypto/trading/orders/{order_id}/")
            if status.get("state") == "filled":
                executions = status.get("executions") or []
                if executions:
                    total_qty = sum(float(e["quantity"]) for e in executions)
                    if total_qty > 0:
                        fill_price = sum(
                            float(e["effective_price"]) * float(e["quantity"])
                            for e in executions
                        ) / total_qty
                break
            if status.get("state") in ("canceled", "failed", "rejected"):
                raise RuntimeError(f"Robinhood order {order_id} ended in state {status.get('state')}")
            time.sleep(0.5)

        return {
            "symbol": symbol,
            "qty": qty,
            "side": side,
            "order_id": order_id,
            "price": fill_price,  # None if fill wasn't confirmed in the poll window
        }
