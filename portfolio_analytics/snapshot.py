"""Build the dashboard snapshot: reports/portfolio/latest.json (+ dated history).

Sources are optional and independent. Whatever is configured is used; the
`sources` block in the snapshot says which ones were live, which fell back
to demo data, and why -- so the dashboard can show an honest banner.
"""
from __future__ import annotations

import json
import os
from datetime import date, datetime, timezone

from portfolio_analytics import demo
from portfolio_analytics.analytics import TaxSettings, build_insights

SNAPSHOT_VERSION = 1


def _env(key: str, default: str = "") -> str:
    return (os.environ.get(key) or "").strip() or default


def load_settings(path: str | None = None) -> TaxSettings:
    """Settings come from portfolio/settings.json (committed, editable) with env overrides."""
    data = {}
    path = path or os.path.join("portfolio", "settings.json")
    if os.path.exists(path):
        with open(path) as f:
            data = json.load(f)
    for key in TaxSettings.__dataclass_fields__:
        env_key = f"PORTFOLIO_{key.upper()}"
        if _env(env_key):
            raw = _env(env_key)
            data[key] = raw.lower() == "true" if isinstance(getattr(TaxSettings, key, None), bool) else float(raw)
    return TaxSettings.from_dict(data)


def _merge_positions(primary: list[dict], secondary: list[dict]) -> list[dict]:
    """Awaken positions win; Robinhood positions fill in symbols Awaken lacks."""
    seen = {p["symbol"] for p in primary}
    merged = list(primary)
    for p in secondary:
        if p["symbol"] not in seen:
            merged.append(p)
    merged.sort(key=lambda p: p.get("value") or 0.0, reverse=True)
    return merged


def collect_awaken(as_of: date, year: int) -> tuple[dict, dict]:
    """Return (data, status). Never raises; status carries the error text."""
    from portfolio_analytics.awaken import (AwakenClient, AwakenError, positions_from_portfolio,
                                            realized_from_cap_gains)
    status = {"mode": "unavailable", "detail": ""}
    if not _env("AWAKEN_API_KEY"):
        status["detail"] = "AWAKEN_API_KEY not set"
        return {}, status
    try:
        client = AwakenClient()
        client.discover_client_id()
        info = client.get_client()
        portfolio = client.get_portfolio()
        accounts = {a["id"]: (a.get("description") or a.get("provider") or a["id"]) for a in client.get_accounts()}
        lots = {}
        for b in portfolio.get("balances") or []:
            key = b.get("assetPricingKey")
            if key and float(b.get("totalAmount") or 0) > 0:
                try:
                    lots[key] = client.get_tax_lots(key)
                except AwakenError as exc:
                    print(f"[awaken] tax lots for {b.get('symbol')}: {exc}")
        positions = positions_from_portfolio(portfolio, lots, accounts)
        try:
            realized = realized_from_cap_gains(client.get_income_and_cap_gains(year), year)
        except AwakenError as exc:
            print(f"[awaken] cap gains: {exc}")
            realized = None
        try:
            history = client.get_chart("Year")
        except AwakenError as exc:
            print(f"[awaken] chart: {exc}")
            history = []
        try:
            harvestable = client.get_harvestable_losses(as_of.isoformat())
        except AwakenError as exc:
            print(f"[awaken] harvestable losses: {exc}")
            harvestable = []
        try:
            missing = client.count_missing_basis()
        except AwakenError:
            missing = 0
        try:
            dirty = client.count_dirty()
        except AwakenError:
            dirty = 0
        status.update({"mode": "live", "client": info.get("name"), "client_id": client.client_id,
                       "cost_basis_algorithm": info.get("costBasisAlgorithm"), "dirty": dirty})
        return {
            "positions": positions, "realized": realized, "history": history,
            "harvestable": [{
                "symbol": r.get("assetSymbol"), "name": r.get("assetName"), "balance": r.get("balance"),
                "cost_basis": (r.get("costBasisCents") or 0) / 100, "value": (r.get("fiatValueCents") or 0) / 100,
                "loss": (r.get("lossCents") or 0) / 100, "account": r.get("accountName"), "provider": r.get("provider"),
            } for r in harvestable],
            "missing_basis": missing, "basis_method": (info.get("costBasisAlgorithm") or "HIFO"),
        }, status
    except Exception as exc:  # noqa: BLE001 - surface everything in the snapshot banner
        status["detail"] = f"{type(exc).__name__}: {exc}"
        return {}, status


def collect_robinhood(as_of: date) -> tuple[dict, dict]:
    from portfolio_analytics.robinhood import (RobinhoodReadOnly, lots_from_orders, positions_from_robinhood,
                                               recent_activity)
    status = {"mode": "unavailable", "detail": ""}
    if not (_env("ROBINHOOD_API_KEY") and _env("ROBINHOOD_PRIVATE_KEY")):
        status["detail"] = "ROBINHOOD_API_KEY / ROBINHOOD_PRIVATE_KEY not set"
        return {}, status
    try:
        rh = RobinhoodReadOnly()
        account = rh.account()
        holdings = rh.holdings()
        orders = rh.orders()
        pairs = [f"{h['asset_code']}-USD" for h in holdings if float(h.get("total_quantity") or 0) > 0]
        prices = rh.best_bid_ask(pairs)
        lots = lots_from_orders(orders)
        positions = positions_from_robinhood(holdings, prices, lots)
        status.update({"mode": "live", "account": account.get("account_number", "")[-4:]})
        return {
            "buying_power": float(account.get("buying_power") or 0),
            "holdings": [{"asset_code": h.get("asset_code"), "total_quantity": float(h.get("total_quantity") or 0)}
                         for h in holdings],
            "positions": positions,
            "recent_activity": recent_activity(orders, 30, as_of),
            "prices": prices,
        }, status
    except Exception as exc:  # noqa: BLE001
        status["detail"] = f"{type(exc).__name__}: {exc}"
        return {}, status


def collect_prices(symbols: list[str]) -> tuple[dict, dict]:
    from portfolio_analytics.prices import price_history
    status = {"mode": "unavailable", "detail": ""}
    if _env("PORTFOLIO_SKIP_PRICES") == "true":
        status["detail"] = "PORTFOLIO_SKIP_PRICES=true"
        return {}, status
    hist = price_history(symbols)
    if hist:
        status.update({"mode": "live", "symbols": sorted(hist)})
    else:
        status["detail"] = "no price history returned"
    return hist, status


def build_snapshot(as_of: date | None = None, demo_mode: bool = False,
                   settings: TaxSettings | None = None, fetch_prices: bool = True) -> dict:
    as_of = as_of or datetime.now(timezone.utc).date()
    settings = settings or load_settings()
    year = as_of.year
    sources: dict[str, dict] = {}

    awaken_data, sources["awaken"] = ({}, {"mode": "demo", "detail": "--demo"}) if demo_mode else collect_awaken(as_of, year)
    rh_data, sources["robinhood"] = ({}, {"mode": "demo", "detail": "--demo"}) if demo_mode else collect_robinhood(as_of)

    positions = awaken_data.get("positions") or []
    if rh_data.get("positions"):
        positions = _merge_positions(positions, rh_data["positions"])
    realized = awaken_data.get("realized")
    history = awaken_data.get("history") or []
    basis_method = awaken_data.get("basis_method") or "HIFO"
    missing_basis = int(awaken_data.get("missing_basis") or 0)

    using_demo = demo_mode or not positions
    if using_demo:
        positions = demo.demo_positions(as_of)
        realized = realized or demo.demo_realized(as_of)
        if sources["awaken"]["mode"] != "live":
            sources["awaken"] = {"mode": "demo", "detail": sources["awaken"].get("detail") or "no positions"}
        if sources["robinhood"]["mode"] != "live":
            sources["robinhood"] = {"mode": "demo", "detail": sources["robinhood"].get("detail") or ""}
            rh_data = demo.demo_robinhood(as_of)

    total_value = sum(p["value"] for p in positions)
    if not history:
        history = demo.demo_history(as_of, end_value=total_value) if using_demo else []
    history = _append_own_history(history, as_of, total_value, using_demo)

    symbols = [p["symbol"] for p in positions]
    if using_demo or not fetch_prices:
        prices_hist, sources["prices"] = demo.demo_price_history(positions), {"mode": "demo", "detail": ""}
    else:
        prices_hist, sources["prices"] = collect_prices(symbols)

    insights = build_insights(positions, history, realized, as_of, settings, prices_hist, basis_method, missing_basis)

    # Reconcile Robinhood quantities against the tax ledger (drift = un-imported trades).
    reconciliation = []
    for h in rh_data.get("holdings") or []:
        sym = h.get("asset_code")
        ledger_qty = sum(l["amount"] for l in insights["lots"] if l["symbol"] == sym and l["account"].lower().startswith("robinhood"))
        rh_qty = float(h.get("total_quantity") or 0)
        if ledger_qty or rh_qty:
            reconciliation.append({"symbol": sym, "robinhood_qty": rh_qty, "ledger_qty": ledger_qty,
                                   "diff": rh_qty - ledger_qty, "ok": abs(rh_qty - ledger_qty) <= 1e-6 * max(1.0, rh_qty)})

    return {
        "version": SNAPSHOT_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "as_of": as_of.isoformat(),
        "demo": using_demo,
        "sources": sources,
        "currency": "USD",
        "positions": positions,
        "history": history,
        "price_history": {k: v[-180:] for k, v in prices_hist.items()},
        "realized": realized,
        "awaken_harvestable": awaken_data.get("harvestable") or [],
        "robinhood": {
            "buying_power": rh_data.get("buying_power"),
            "holdings": rh_data.get("holdings") or [],
            "recent_activity": rh_data.get("recent_activity") or [],
            "reconciliation": reconciliation,
        },
        "analytics": insights,
    }


def _append_own_history(history: list[dict], as_of: date, total_value: float, using_demo: bool,
                        path: str = os.path.join("reports", "portfolio", "history")) -> list[dict]:
    """Awaken's chart is authoritative; otherwise stitch daily values from our own dated snapshots."""
    if history:
        return history
    if using_demo:
        return history
    series = {}
    if os.path.isdir(path):
        for name in sorted(os.listdir(path)):
            if name.endswith(".json"):
                try:
                    with open(os.path.join(path, name)) as f:
                        snap = json.load(f)
                    series[snap["as_of"]] = float(snap["analytics"]["totals"]["value"])
                except Exception:
                    continue
    series[as_of.isoformat()] = total_value
    return [{"date": d, "value": v} for d, v in sorted(series.items())]


def write_snapshot(snapshot: dict, out_dir: str = os.path.join("reports", "portfolio"),
                   keep_history: bool = True) -> str:
    os.makedirs(out_dir, exist_ok=True)
    latest = os.path.join(out_dir, "latest.json")
    with open(latest, "w") as f:
        json.dump(snapshot, f, indent=1, default=str)
    if keep_history and not snapshot.get("demo"):
        hist_dir = os.path.join(out_dir, "history")
        os.makedirs(hist_dir, exist_ok=True)
        slim = {k: v for k, v in snapshot.items() if k not in ("price_history",)}
        with open(os.path.join(hist_dir, f"{snapshot['as_of']}.json"), "w") as f:
            json.dump(slim, f, default=str)
    return latest
