"""READ-ONLY Robinhood Crypto API client.

This class deliberately exposes only GET endpoints: account, holdings, order
history, trading pairs, and best bid/ask. It has no method that can place,
modify, or cancel an order, and it does not require the ROBINHOOD_LIVE_ACK
speed-bump that the trading broker in `tradingbot/` does, because it cannot
move money.

Credentials (Robinhood app: Account -> Crypto -> API; grant READ scopes only):
    ROBINHOOD_API_KEY      the API key string
    ROBINHOOD_PRIVATE_KEY  base64-encoded Ed25519 private key seed

Signing reuses `tradingbot.execution.robinhood_broker.sign_request`.
"""
from __future__ import annotations

import os
import time
from datetime import date, datetime, timezone
from typing import Any

import requests

from tradingbot.execution.robinhood_broker import sign_request

BASE_URL = "https://trading.robinhood.com"


class RobinhoodReadOnly:
    """GET-only client. Any attempt to call a non-GET method raises."""

    ALLOWED_METHODS = ("GET",)

    def __init__(self, api_key: str | None = None, private_key_b64: str | None = None,
                 session: requests.Session | None = None):
        self.api_key = api_key or os.environ.get("ROBINHOOD_API_KEY", "")
        self.private_key_b64 = private_key_b64 or os.environ.get("ROBINHOOD_PRIVATE_KEY", "")
        if not self.api_key or not self.private_key_b64:
            raise RuntimeError("ROBINHOOD_API_KEY / ROBINHOOD_PRIVATE_KEY not set")
        self.session = session or requests.Session()

    def _get(self, path: str) -> dict:
        method = "GET"
        if method not in self.ALLOWED_METHODS:  # defensive: this client is read-only
            raise PermissionError("RobinhoodReadOnly only performs GET requests")
        ts = int(time.time())
        sig = sign_request(self.private_key_b64, self.api_key, ts, path, method, "")
        resp = self.session.get(BASE_URL + path, headers={
            "x-api-key": self.api_key, "x-signature": sig, "x-timestamp": str(ts),
        }, timeout=20)
        resp.raise_for_status()
        return resp.json() if resp.text else {}

    # -- endpoints -------------------------------------------------------------

    def account(self) -> dict:
        return self._get("/api/v1/crypto/trading/accounts/")

    def holdings(self) -> list[dict]:
        out, cursor = [], None
        path = "/api/v1/crypto/trading/holdings/"
        while True:
            data = self._get(path if not cursor else cursor)
            out.extend(data.get("results") or [])
            nxt = data.get("next")
            if not nxt:
                return out
            cursor = nxt.replace(BASE_URL, "")

    def orders(self, max_pages: int = 20) -> list[dict]:
        out, path = [], "/api/v1/crypto/trading/orders/"
        for _ in range(max_pages):
            data = self._get(path)
            out.extend(data.get("results") or [])
            nxt = data.get("next")
            if not nxt:
                break
            path = nxt.replace(BASE_URL, "")
        return out

    def best_bid_ask(self, pairs: list[str]) -> dict[str, float]:
        if not pairs:
            return {}
        qs = "&".join(f"symbol={p}" for p in pairs)
        data = self._get(f"/api/v1/crypto/marketdata/best_bid_ask/?{qs}")
        prices = {}
        for r in data.get("results") or []:
            bid = float(r.get("bid_inclusive_of_sell_spread") or r.get("bid_price") or 0)
            ask = float(r.get("ask_inclusive_of_buy_spread") or r.get("ask_price") or 0)
            prices[r["symbol"]] = (bid + ask) / 2 if bid and ask else (bid or ask)
        return prices


# ----------------------------------------------------------------------------
# Normalisation
# ----------------------------------------------------------------------------

def _ts(value: Any) -> str:
    if not value:
        return ""
    return str(value)[:10]


def lots_from_orders(orders: list[dict]) -> dict[str, list[dict]]:
    """Rebuild open FIFO lots per asset from Robinhood order history.

    Used as a fallback when Awaken has no lot detail for the Robinhood
    account. Robinhood itself reports cost basis on its 1099 using FIFO
    unless you tell it otherwise, so FIFO is the safe default here.
    """
    fills: list[tuple[str, str, str, float, float]] = []  # (ts, symbol, side, qty, price)
    for o in orders:
        if o.get("state") not in ("filled", "partially_filled"):
            continue
        sym = str(o.get("symbol", "")).split("-")[0]
        for e in o.get("executions") or []:
            qty = float(e.get("quantity") or 0)
            px = float(e.get("effective_price") or 0)
            if qty > 0 and px > 0:
                fills.append((str(e.get("timestamp") or o.get("created_at") or ""), sym, o.get("side", ""), qty, px))
    fills.sort(key=lambda f: f[0])
    lots: dict[str, list[dict]] = {}
    for ts, sym, side, qty, px in fills:
        book = lots.setdefault(sym, [])
        if side == "buy":
            book.append({"amount": qty, "basis": qty * px, "purchased_at": _ts(ts), "account": "Robinhood"})
        elif side == "sell":
            remaining = qty
            while remaining > 1e-12 and book:
                lot = book[0]
                take = min(remaining, lot["amount"])
                lot["basis"] -= lot["basis"] / lot["amount"] * take if lot["amount"] else 0
                lot["amount"] -= take
                remaining -= take
                if lot["amount"] <= 1e-12:
                    book.pop(0)
    for sym, book in lots.items():
        for i, lot in enumerate(book):
            lot["id"] = f"RH-{sym}-{i}"
    return {s: b for s, b in lots.items() if b}


def positions_from_robinhood(holdings: list[dict], prices: dict[str, float],
                             lots: dict[str, list[dict]] | None = None) -> list[dict]:
    lots = lots or {}
    out = []
    for h in holdings:
        sym = h.get("asset_code")
        qty = float(h.get("total_quantity") or 0)
        if not sym or qty <= 0:
            continue
        price = float(prices.get(f"{sym}-USD") or 0.0)
        plots = lots.get(sym, [])
        basis = sum(l["basis"] for l in plots)
        out.append({
            "symbol": sym, "name": sym, "provider": "robinhood", "quantity": qty,
            "price": price, "value": qty * price, "cost_basis": basis,
            "unrealized": qty * price - basis if plots else None, "lots": plots,
        })
    out.sort(key=lambda p: p["value"], reverse=True)
    return out


def recent_activity(orders: list[dict], days: int = 30, as_of: date | None = None) -> list[dict]:
    """Filled orders in the last `days`, newest first, compacted for the dashboard."""
    as_of = as_of or datetime.now(timezone.utc).date()
    out = []
    for o in orders:
        if o.get("state") != "filled":
            continue
        created = _ts(o.get("created_at") or o.get("updated_at"))
        if not created:
            continue
        try:
            if (as_of - date.fromisoformat(created)).days > days:
                continue
        except ValueError:
            continue
        execs = o.get("executions") or []
        qty = sum(float(e.get("quantity") or 0) for e in execs)
        notional = sum(float(e.get("quantity") or 0) * float(e.get("effective_price") or 0) for e in execs)
        out.append({
            "date": created, "symbol": str(o.get("symbol", "")).split("-")[0],
            "side": o.get("side"), "type": o.get("type"), "quantity": qty,
            "avg_price": notional / qty if qty else 0.0, "notional": notional,
        })
    out.sort(key=lambda a: a["date"], reverse=True)
    return out
