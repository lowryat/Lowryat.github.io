"""Read-only client for the Awaken (awaken.tax) public GraphQL API.

Auth: an API key created at awaken.tax -> Settings -> API Keys, sent as the
`x-api-key` header. A `Read` key is all this module needs -- it never runs a
mutation.

Rules the server enforces that this client respects:
  * exactly one root field per request (no batching / aliases)
  * `limit` <= 500 on transaction queries
  * 300 requests/minute per IP -> small sleep between paginated calls

Money fields suffixed `Cents` are integer cents; this client converts them to
USD floats in the `*_usd` helpers so the analytics layer only sees dollars.
"""
from __future__ import annotations

import json
import os
import time
from typing import Any

import requests

ENDPOINT = "https://api.awaken.tax/graphql"


class AwakenError(RuntimeError):
    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        self.code = code


def _cents(v: Any) -> float:
    if v in (None, ""):
        return 0.0
    return float(v) / 100.0


class AwakenClient:
    def __init__(self, api_key: str | None = None, client_id: str | None = None,
                 endpoint: str = ENDPOINT, session: requests.Session | None = None,
                 min_interval_s: float = 0.25):
        self.api_key = api_key or os.environ.get("AWAKEN_API_KEY", "")
        if not self.api_key:
            raise AwakenError("AWAKEN_API_KEY is not set", code="UNAUTHENTICATED")
        self.client_id = client_id or os.environ.get("AWAKEN_CLIENT_ID") or None
        self.endpoint = endpoint
        self.session = session or requests.Session()
        self.min_interval_s = min_interval_s
        self._last_call = 0.0

    # -- transport -----------------------------------------------------------

    def query(self, query: str, variables: dict | None = None) -> dict:
        """POST one operation; return its `data` or raise AwakenError."""
        wait = self.min_interval_s - (time.time() - self._last_call)
        if wait > 0:
            time.sleep(wait)
        resp = self.session.post(
            self.endpoint,
            json={"query": query, "variables": variables or {}},
            headers={"content-type": "application/json", "x-api-key": self.api_key},
            timeout=30,
        )
        self._last_call = time.time()
        if resp.status_code == 429:
            reset = resp.headers.get("RateLimit-Reset", "?")
            raise AwakenError(f"rate limited (429); resets in {reset}s", code="RATE_LIMITED")
        try:
            payload = resp.json()
        except ValueError as exc:
            raise AwakenError(f"non-JSON response (HTTP {resp.status_code})") from exc
        if payload.get("errors"):
            err = payload["errors"][0]
            code = (err.get("extensions") or {}).get("code")
            raise AwakenError(err.get("message", "GraphQL error"), code=code)
        return payload.get("data") or {}

    # -- discovery -----------------------------------------------------------

    def get_my_clients(self) -> list[dict]:
        return self.query("query { getMyClients { id name } }")["getMyClients"]

    def discover_client_id(self) -> str:
        """Find the one client this key can actually read (others 403)."""
        if self.client_id:
            return self.client_id
        clients = self.get_my_clients()
        if len(clients) == 1:
            self.client_id = clients[0]["id"]
            return self.client_id
        probe = ("query ($clientId: ID!) { getClientTransactions(clientId: $clientId, limit: 1, page: 0) { total } }")
        for c in clients:
            try:
                self.query(probe, {"clientId": c["id"]})
                self.client_id = c["id"]
                return self.client_id
            except AwakenError as exc:
                if exc.code in ("403", "FORBIDDEN"):
                    continue
                raise
        raise AwakenError("API key cannot read any visible client", code="FORBIDDEN")

    def _cid(self) -> str:
        return self.client_id or self.discover_client_id()

    # -- reads ---------------------------------------------------------------

    def get_client(self) -> dict:
        q = ("query ($clientId: String!) { getClientById(clientId: $clientId) "
             "{ id name country currency timezone costBasisAlgorithm } }")
        return self.query(q, {"clientId": self._cid()})["getClientById"]

    def get_portfolio(self) -> dict:
        q = """query ($clientId: ID!) {
          getPortfolioV2(clientId: $clientId, includeCoins: true, includeDefi: true, includeNFTs: false) {
            balanceTotalValueCents coinTotalValueCents defiTotalValueCents nftTotalValueCents
            balances { symbol name provider assetPricingKey totalAmount totalFiatAmountCents costBasisCents gainLossCents }
            defiPositions { name provider totalValueCents }
          }
        }"""
        return self.query(q, {"clientId": self._cid()})["getPortfolioV2"]

    def get_tax_lots(self, asset_pricing_key: str) -> list[dict]:
        # Inline the key (JSON-escaped) rather than declare a typed variable:
        # the argument's scalar type isn't documented and a wrong name fails validation.
        q = """query ($clientId: ID!) {
          getTaxLots(clientId: $clientId, assetPricingKey: %s) {
            lots { amount fiatAmountCents purchasedAt accountId algorithm }
          }
        }""" % json.dumps(str(asset_pricing_key))
        data = self.query(q, {"clientId": self._cid()})
        return (data.get("getTaxLots") or {}).get("lots") or []

    def get_chart(self, interval: str = "Year") -> list[dict]:
        if interval not in ("Day", "Week", "Month", "ThreeMonth", "Year", "YearToDate", "All"):
            raise ValueError(f"bad chart interval {interval!r}")
        q = "query ($clientId: ID!) { getChart(clientId: $clientId, interval: %s) }" % interval
        data = self.query(q, {"clientId": self._cid()})
        chart = data.get("getChart")
        # The chart payload is a JSON scalar; normalise the common shapes.
        points = chart.get("points") if isinstance(chart, dict) else chart
        out = []
        for p in points or []:
            if isinstance(p, dict):
                ts = p.get("timestamp") or p.get("date") or p.get("x")
                val = p.get("valueCents")
                val = _cents(val) if val is not None else float(p.get("value") or p.get("y") or 0)
                out.append({"date": str(ts)[:10], "value": val})
        return out

    def get_income_and_cap_gains(self, year: int | str) -> dict:
        q = """query ($clientId: ID!) {
          getIncomeAndCapGains(clientId: $clientId, year: %s) {
            capGainsShortTerm capGainsLongTerm capGainsTotal incomeTotal
          }
        }""" % json.dumps(str(int(year)))
        return self.query(q, {"clientId": self._cid()})["getIncomeAndCapGains"]

    def get_harvestable_losses(self, as_of: str) -> list[dict]:
        q = """query ($clientId: ID!) {
          getHarvestableLosses(clientId: $clientId, date: %s) {
            rows { assetSymbol assetName balance costBasisCents fiatValueCents lossCents accountName provider }
          }
        }""" % json.dumps(str(as_of)[:10])
        data = self.query(q, {"clientId": self._cid()})
        return (data.get("getHarvestableLosses") or {}).get("rows") or []

    def get_insights_summary(self) -> dict:
        q = "query ($clientId: ID!) { getInsightsSummary(clientId: $clientId) { potentialSavingsCents } }"
        return self.query(q, {"clientId": self._cid()}).get("getInsightsSummary") or {}

    def count_missing_basis(self) -> int:
        q = ("query ($clientId: ID!) { getClientTransactions(clientId: $clientId, isMissingBasis: true, "
             "limit: 1, page: 0) { total } }")
        return int(self.query(q, {"clientId": self._cid()})["getClientTransactions"]["total"])

    def count_dirty(self) -> int:
        q = "query ($clientId: ID!) { countDirty(clientId: $clientId) }"
        return int(self.query(q, {"clientId": self._cid()}).get("countDirty") or 0)

    def get_accounts(self) -> list[dict]:
        q = ("query ($clientId: String!) { getClientAccounts(clientId: $clientId) "
             "{ id description provider walletAddress importType integrationStatus } }")
        return self.query(q, {"clientId": self._cid()})["getClientAccounts"]


# ----------------------------------------------------------------------------
# Normalisation into the analytics schema
# ----------------------------------------------------------------------------

def parse_money_string(s: Any) -> float:
    """'-$4,863.81' -> -4863.81 ; numbers pass through."""
    if s is None:
        return 0.0
    if isinstance(s, (int, float)):
        return float(s)
    txt = str(s).strip().replace("$", "").replace(",", "")
    neg = txt.startswith("-") or txt.startswith("(")
    txt = txt.strip("-()")
    try:
        val = float(txt or 0)
    except ValueError:
        return 0.0
    return -val if neg else val


def positions_from_portfolio(portfolio: dict, lots_by_key: dict[str, list[dict]] | None = None,
                             account_names: dict[str, str] | None = None) -> list[dict]:
    """Convert getPortfolioV2 balances (+ getTaxLots) into analytics positions."""
    lots_by_key = lots_by_key or {}
    account_names = account_names or {}
    out = []
    for b in portfolio.get("balances") or []:
        amount = float(b.get("totalAmount") or 0.0)
        if amount <= 0:
            continue
        value = _cents(b.get("totalFiatAmountCents"))
        basis = _cents(b.get("costBasisCents"))
        price = value / amount if amount else 0.0
        raw_lots = lots_by_key.get(b.get("assetPricingKey") or "", [])
        lots = []
        for i, l in enumerate(raw_lots):
            amt = float(l.get("amount") or 0.0)
            if amt <= 0:
                continue
            lots.append({
                "id": f"{b['symbol']}-{i}",
                "amount": amt,
                "basis": _cents(l.get("fiatAmountCents")),
                "purchased_at": str(l.get("purchasedAt"))[:10],
                "account": account_names.get(l.get("accountId") or "", l.get("accountId") or ""),
            })
        if not lots and basis > 0:
            # No lot detail available: treat the whole balance as one lot of unknown age.
            lots = [{"id": f"{b['symbol']}-0", "amount": amount, "basis": basis,
                     "purchased_at": "1970-01-01", "account": b.get("provider") or "", "age_unknown": True}]
        out.append({
            "symbol": b["symbol"],
            "name": b.get("name") or b["symbol"],
            "provider": b.get("provider") or "",
            "asset_pricing_key": b.get("assetPricingKey"),
            "quantity": amount,
            "price": price,
            "value": value,
            "cost_basis": basis,
            "unrealized": _cents(b.get("gainLossCents")) if b.get("gainLossCents") is not None else value - basis,
            "lots": lots,
        })
    out.sort(key=lambda p: p["value"], reverse=True)
    return out


def realized_from_cap_gains(payload: dict, year: int | str) -> dict:
    return {
        "year": int(year),
        "short_term": parse_money_string(payload.get("capGainsShortTerm")),
        "long_term": parse_money_string(payload.get("capGainsLongTerm")),
        "total": parse_money_string(payload.get("capGainsTotal")),
        "income": parse_money_string(payload.get("incomeTotal")),
    }
