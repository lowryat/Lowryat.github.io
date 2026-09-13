"""Pure, dependency-free portfolio analytics.

Every function here takes plain dicts/lists and returns plain dicts/lists so
the same logic can be unit-tested offline and mirrored in the dashboard JS.

Money is in USD floats (not cents) throughout this module. The Awaken client
converts its integer-cent fields before handing data here.

Tax assumptions (all configurable via TaxSettings):
  * A lot held more than `long_term_days` (365) is long-term.
  * Short-term gains are taxed at `short_term_rate` (ordinary income) and
    long-term gains at `long_term_rate`; `state_rate` and `niit_rate` (3.8%
    net investment income tax) are added to both.
  * Losses are valued at the rate of the gains they would offset, which is an
    estimate: real netting is short-vs-short first, then long-vs-long, then
    cross-netting, then up to $3,000 against ordinary income with carryforward.
  * Wash-sale rule: as of this writing, IRC §1091 applies to securities, not
    crypto, so a harvested coin can be re-bought immediately. Congress has
    proposed closing this repeatedly, so `wash_sale_conservative=True` adds a
    31-day re-buy caution to every harvest suggestion.

None of this is tax advice; confirm with your CPA before acting.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Iterable


# ----------------------------------------------------------------------------
# Settings
# ----------------------------------------------------------------------------

@dataclass
class TaxSettings:
    short_term_rate: float = 0.35        # federal ordinary-income marginal rate
    long_term_rate: float = 0.20         # federal long-term capital gains rate
    state_rate: float = 0.0              # state income tax on gains
    niit_rate: float = 0.038             # net investment income tax
    long_term_days: int = 365            # > 365 days held => long-term
    ordinary_income_offset: float = 3000.0  # annual net-loss deduction vs wages

    # Signal thresholds
    min_harvest_loss: float = 250.0      # ignore losses smaller than this (USD)
    min_harvest_loss_pct: float = 0.05   # ...or smaller than 5% of the lot's basis
    profit_take_gain_pct: float = 0.50   # position up >= 50% vs basis => review
    max_weight: float = 0.35             # single-asset concentration ceiling
    target_weight: float = 0.25          # trim back to this when over the ceiling
    trailing_dd_pct: float = 0.15        # price >= 15% below 90-day high => fading
    long_term_wait_days: int = 45        # if lot goes long-term within N days, wait
    wash_sale_conservative: bool = False

    def total_short_rate(self) -> float:
        return self.short_term_rate + self.state_rate + self.niit_rate

    def total_long_rate(self) -> float:
        return self.long_term_rate + self.state_rate + self.niit_rate

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict | None) -> "TaxSettings":
        d = d or {}
        known = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        return cls(**known)


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

def _as_date(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    s = str(value)
    # Accept "2025-06-01", "2025-06-01T12:00:00Z", "2025-06-01 12:00:00"
    return date.fromisoformat(s[:10])


def _safe_div(a: float, b: float) -> float:
    return a / b if b else 0.0


# ----------------------------------------------------------------------------
# Lots
# ----------------------------------------------------------------------------

def lot_term(purchased_at: Any, as_of: Any, long_term_days: int = 365) -> dict:
    """Classify a lot's holding period.

    Returns {"holding_days", "term": "short"|"long", "days_to_long_term",
    "long_term_on"}. A lot becomes long-term the day AFTER it has been held
    for `long_term_days` (i.e. "more than one year").
    """
    bought = _as_date(purchased_at)
    today = _as_date(as_of)
    holding_days = (today - bought).days
    long_on = bought + timedelta(days=long_term_days + 1)
    is_long = holding_days > long_term_days
    return {
        "holding_days": holding_days,
        "term": "long" if is_long else "short",
        "days_to_long_term": 0 if is_long else max(0, (long_on - today).days),
        "long_term_on": long_on.isoformat(),
    }


def enrich_lots(positions: Iterable[dict], as_of: Any, settings: TaxSettings) -> list[dict]:
    """Flatten positions -> lots with value, gain, term, and tax rate applied.

    Each position: {"symbol", "price", "lots": [{"amount", "basis", "purchased_at", "account"?}]}
    """
    out: list[dict] = []
    for pos in positions:
        price = float(pos.get("price") or 0.0)
        for i, lot in enumerate(pos.get("lots") or []):
            amount = float(lot.get("amount") or 0.0)
            basis = float(lot.get("basis") or 0.0)
            if amount <= 0:
                continue
            term = lot_term(lot["purchased_at"], as_of, settings.long_term_days)
            value = amount * price
            gain = value - basis
            rate = settings.total_long_rate() if term["term"] == "long" else settings.total_short_rate()
            out.append({
                "id": lot.get("id") or f"{pos['symbol']}-{i}",
                "symbol": pos["symbol"],
                "account": lot.get("account") or pos.get("account") or "",
                "amount": amount,
                "basis": basis,
                "basis_per_unit": _safe_div(basis, amount),
                "purchased_at": _as_date(lot["purchased_at"]).isoformat(),
                "price": price,
                "value": value,
                "gain": gain,
                "gain_pct": _safe_div(gain, basis),
                "tax_rate": rate,
                **term,
            })
    return out


# ----------------------------------------------------------------------------
# Tax-loss harvesting
# ----------------------------------------------------------------------------

def harvest_candidates(lots: Iterable[dict], settings: TaxSettings, as_of: Any = None) -> list[dict]:
    """Lots sitting at a loss big enough to be worth harvesting.

    Estimated savings = loss x the rate of the gain it would offset (short-term
    losses are assumed to offset short-term gains first, which is why a
    short-term loss is 'worth' more). Sorted by estimated savings, descending.
    """
    cands = []
    for lot in lots:
        loss = -lot["gain"]
        if loss <= 0:
            continue
        if loss < settings.min_harvest_loss and loss < settings.min_harvest_loss_pct * lot["basis"]:
            continue
        cands.append({
            **lot,
            "loss": loss,
            "est_tax_savings": loss * lot["tax_rate"],
            "rebuy_caution_until": (
                (_as_date(as_of or date.today()) + timedelta(days=31)).isoformat()
                if settings.wash_sale_conservative else None
            ),
        })
    cands.sort(key=lambda c: c["est_tax_savings"], reverse=True)
    return cands


def harvest_summary(candidates: Iterable[dict], realized: dict | None, settings: TaxSettings) -> dict:
    """Roll harvest candidates up against realized year-to-date gains."""
    cands = list(candidates)
    short_loss = sum(c["loss"] for c in cands if c["term"] == "short")
    long_loss = sum(c["loss"] for c in cands if c["term"] == "long")
    total_loss = short_loss + long_loss
    realized = realized or {}
    r_short = float(realized.get("short_term") or 0.0)
    r_long = float(realized.get("long_term") or 0.0)

    # Net per IRS ordering: ST vs ST, LT vs LT, then cross-net.
    net_short = r_short - short_loss
    net_long = r_long - long_loss
    if net_short < 0 < net_long:
        moved = min(-net_short, net_long)
        net_short += moved
        net_long -= moved
    elif net_long < 0 < net_short:
        moved = min(-net_long, net_short)
        net_long += moved
        net_short -= moved
    net_total = net_short + net_long
    ordinary_offset = min(settings.ordinary_income_offset, -net_total) if net_total < 0 else 0.0
    carryforward = max(0.0, -net_total - ordinary_offset)

    tax_before = max(r_short, 0) * settings.total_short_rate() + max(r_long, 0) * settings.total_long_rate()
    tax_after = (max(net_short, 0) * settings.total_short_rate()
                 + max(net_long, 0) * settings.total_long_rate()
                 - ordinary_offset * settings.total_short_rate())
    return {
        "candidates": len(cands),
        "short_term_loss": short_loss,
        "long_term_loss": long_loss,
        "total_loss": total_loss,
        "realized_short_term": r_short,
        "realized_long_term": r_long,
        "net_short_after": net_short,
        "net_long_after": net_long,
        "net_total_after": net_total,
        "ordinary_income_offset": ordinary_offset,
        "carryforward": carryforward,
        "est_tax_before": tax_before,
        "est_tax_after": tax_after,
        "est_tax_savings": max(0.0, tax_before - tax_after),
    }


# ----------------------------------------------------------------------------
# Profit taking / rebalancing
# ----------------------------------------------------------------------------

def sma(values: list[float], window: int) -> float | None:
    if len(values) < window or window <= 0:
        return None
    return sum(values[-window:]) / window


def price_signals(history: list[float] | None, settings: TaxSettings) -> dict:
    """Momentum context for one asset from its daily close history (oldest->newest)."""
    if not history:
        return {"available": False}
    closes = [float(x) for x in history if x is not None]
    if len(closes) < 2:
        return {"available": False}
    last = closes[-1]
    hi90 = max(closes[-90:])
    dd = 1 - last / hi90 if hi90 else 0.0
    s20, s50 = sma(closes, 20), sma(closes, 50)
    ret30 = _safe_div(last, closes[-31]) - 1 if len(closes) > 30 else None
    return {
        "available": True,
        "last": last,
        "high_90d": hi90,
        "drawdown_from_90d_high": dd,
        "sma20": s20,
        "sma50": s50,
        "above_sma50": (last > s50) if s50 else None,
        "return_30d": ret30,
        "fading": dd >= settings.trailing_dd_pct,
    }


def tax_cost_of_sale(lots: list[dict], amount_to_sell: float, method: str = "HIFO") -> dict:
    """Estimate realized gain and tax if `amount_to_sell` units are sold from `lots`.

    HIFO (highest basis first) minimizes the tax bill; FIFO is the IRS default
    when no specific-ID election exists. Awaken's `costBasisAlgorithm` tells
    you which one your ledger actually uses.
    """
    if method.upper() == "FIFO":
        ordered = sorted(lots, key=lambda l: l["purchased_at"])
    elif method.upper() == "LIFO":
        ordered = sorted(lots, key=lambda l: l["purchased_at"], reverse=True)
    else:  # HIFO
        ordered = sorted(lots, key=lambda l: l["basis_per_unit"], reverse=True)
    remaining = amount_to_sell
    gain = tax = proceeds = 0.0
    used = []
    for lot in ordered:
        if remaining <= 1e-12:
            break
        take = min(remaining, lot["amount"])
        g = take * (lot["price"] - lot["basis_per_unit"])
        gain += g
        tax += max(g, 0.0) * lot["tax_rate"]
        proceeds += take * lot["price"]
        used.append({"lot_id": lot["id"], "amount": take, "gain": g, "term": lot["term"]})
        remaining -= take
    return {"method": method.upper(), "amount": amount_to_sell - remaining,
            "proceeds": proceeds, "realized_gain": gain, "est_tax": tax, "lots_used": used}


def profit_take_candidates(positions: list[dict], lots: list[dict], total_value: float,
                           settings: TaxSettings, price_history: dict | None = None,
                           basis_method: str = "HIFO") -> list[dict]:
    """Positions worth trimming, with the cheapest-tax way to do it.

    Three triggers, any of which puts a position on the list:
      * concentration: weight > max_weight
      * big winner:     unrealized gain >= profit_take_gain_pct of basis
      * fading:         price >= trailing_dd_pct below its 90-day high while
                        still at a gain (protect profits)
    """
    price_history = price_history or {}
    by_symbol: dict[str, list[dict]] = {}
    for lot in lots:
        by_symbol.setdefault(lot["symbol"], []).append(lot)

    out = []
    for pos in positions:
        sym = pos["symbol"]
        plots = by_symbol.get(sym, [])
        value = float(pos.get("value") or 0.0)
        basis = sum(l["basis"] for l in plots) or float(pos.get("cost_basis") or 0.0)
        gain = value - basis
        gain_pct = _safe_div(gain, basis)
        weight = _safe_div(value, total_value)
        sig = price_signals(price_history.get(sym), settings)

        reasons = []
        if weight > settings.max_weight:
            reasons.append("concentration")
        if basis > 0 and gain_pct >= settings.profit_take_gain_pct:
            reasons.append("big_winner")
        if sig.get("fading") and gain > 0:
            reasons.append("fading")
        if not reasons:
            continue

        # How much to trim: to target weight if concentrated, else a third of the gain's worth.
        if "concentration" in reasons:
            trim_value = max(0.0, value - settings.target_weight * total_value)
        elif "fading" in reasons:
            trim_value = 0.5 * value
        else:
            trim_value = min(value, max(gain * 0.5, 0.0))
        price = float(pos.get("price") or 0.0)
        trim_units = _safe_div(trim_value, price)
        sale = tax_cost_of_sale(plots, trim_units, basis_method) if plots else None

        # Would waiting turn short-term gain into long-term?
        soon = [l for l in plots if l["term"] == "short" and l["gain"] > 0
                and l["days_to_long_term"] <= settings.long_term_wait_days]
        wait = None
        if soon:
            saved = sum(l["gain"] * (settings.total_short_rate() - settings.total_long_rate()) for l in soon)
            wait = {
                "lots": len(soon),
                "max_days": max(l["days_to_long_term"] for l in soon),
                "est_tax_saved_by_waiting": saved,
                "gain_at_stake": sum(l["gain"] for l in soon),
            }

        out.append({
            "symbol": sym,
            "reasons": reasons,
            "weight": weight,
            "value": value,
            "basis": basis,
            "gain": gain,
            "gain_pct": gain_pct,
            "trim_value": trim_value,
            "trim_units": trim_units,
            "sale": sale,
            "wait_for_long_term": wait,
            "signals": sig,
        })
    priority = {"concentration": 0, "fading": 1, "big_winner": 2}
    out.sort(key=lambda p: (min(priority[r] for r in p["reasons"]), -p["gain"]))
    return out


# ----------------------------------------------------------------------------
# Risk & performance
# ----------------------------------------------------------------------------

def risk_metrics(history: list[dict], weights: dict[str, float] | None = None,
                 risk_free_rate: float = 0.04, periods_per_year: int = 365) -> dict:
    """Portfolio-level stats from a daily value series [{"date", "value"}, ...]."""
    values = [float(h["value"]) for h in history if h.get("value") is not None and float(h["value"]) > 0]
    out: dict[str, Any] = {"days": len(values)}
    if len(values) >= 2:
        rets = [values[i] / values[i - 1] - 1 for i in range(1, len(values))]
        mean = sum(rets) / len(rets)
        var = sum((r - mean) ** 2 for r in rets) / max(1, len(rets) - 1)
        vol = math.sqrt(var) * math.sqrt(periods_per_year)
        ann_ret = (values[-1] / values[0]) ** (periods_per_year / max(1, len(rets))) - 1
        peak = values[0]
        max_dd = 0.0
        for v in values:
            peak = max(peak, v)
            max_dd = max(max_dd, 1 - v / peak)
        downside = [min(0.0, r) for r in rets]
        dvar = sum(d * d for d in downside) / max(1, len(downside))
        dvol = math.sqrt(dvar) * math.sqrt(periods_per_year)
        out.update({
            "total_return": values[-1] / values[0] - 1,
            "annualized_return": ann_ret,
            "annualized_volatility": vol,
            "sharpe": _safe_div(ann_ret - risk_free_rate, vol),
            "sortino": _safe_div(ann_ret - risk_free_rate, dvol),
            "max_drawdown": max_dd,
            "current_drawdown": 1 - values[-1] / max(values),
            "best_day": max(rets),
            "worst_day": min(rets),
            "return_30d": (values[-1] / values[-31] - 1) if len(values) > 30 else None,
            "return_90d": (values[-1] / values[-91] - 1) if len(values) > 90 else None,
        })
    if weights:
        w = [max(0.0, float(x)) for x in weights.values()]
        s = sum(w)
        if s > 0:
            hhi = sum((x / s) ** 2 for x in w)
            out["hhi"] = hhi
            out["effective_assets"] = 1 / hhi
            out["top_weight"] = max(w) / s
    return out


# ----------------------------------------------------------------------------
# Insights (what the alerts and the dashboard's "Today" list are built from)
# ----------------------------------------------------------------------------

def build_insights(positions: list[dict], history: list[dict], realized: dict | None,
                   as_of: Any, settings: TaxSettings, price_history: dict | None = None,
                   basis_method: str = "HIFO", missing_basis_count: int = 0) -> dict:
    """Run every analysis and return one dict the snapshot embeds verbatim."""
    total_value = sum(float(p.get("value") or 0.0) for p in positions)
    lots = enrich_lots(positions, as_of, settings)
    harvest = harvest_candidates(lots, settings, as_of)
    hsum = harvest_summary(harvest, realized, settings)
    takes = profit_take_candidates(positions, lots, total_value, settings, price_history, basis_method)
    weights = {p["symbol"]: float(p.get("value") or 0.0) for p in positions}
    risk = risk_metrics(history, weights)

    items: list[dict] = []
    for c in harvest[:10]:
        items.append({
            "kind": "harvest", "priority": 1 if c["est_tax_savings"] >= 500 else 2,
            "symbol": c["symbol"], "amount_usd": c["loss"], "tax_effect": c["est_tax_savings"],
            "title": f"Harvest {c['symbol']} loss of ${c['loss']:,.0f}",
            "detail": (f"Lot bought {c['purchased_at']} ({c['term']}-term) is down "
                       f"{-c['gain_pct']*100:.0f}%. Selling realizes a ${c['loss']:,.0f} loss, "
                       f"worth about ${c['est_tax_savings']:,.0f} in tax at {c['tax_rate']*100:.0f}%."
                       + (" Crypto is not currently subject to the wash-sale rule, so you can re-buy immediately."
                          if not settings.wash_sale_conservative else
                          " Conservative mode: wait 31 days before re-buying.")),
        })
    for t in takes:
        why = ", ".join(t["reasons"]).replace("_", " ")
        tax = t["sale"]["est_tax"] if t["sale"] else 0.0
        items.append({
            "kind": "profit_take", "priority": 1 if "concentration" in t["reasons"] else 2,
            "symbol": t["symbol"], "amount_usd": t["trim_value"], "tax_effect": -tax,
            "title": f"Trim {t['symbol']} by ${t['trim_value']:,.0f} ({why})",
            "detail": (f"{t['symbol']} is {t['weight']*100:.0f}% of the portfolio and up "
                       f"{t['gain_pct']*100:.0f}% on a ${t['basis']:,.0f} basis. Selling "
                       f"{t['trim_units']:.4g} units via {basis_method} realizes about "
                       f"${(t['sale'] or {}).get('realized_gain', 0):,.0f} gain, ~${tax:,.0f} tax."),
        })
        if t["wait_for_long_term"]:
            w = t["wait_for_long_term"]
            items.append({
                "kind": "hold", "priority": 1,
                "symbol": t["symbol"], "amount_usd": w["gain_at_stake"], "tax_effect": w["est_tax_saved_by_waiting"],
                "title": f"Hold {t['symbol']} {w['max_days']} more days before selling",
                "detail": (f"{w['lots']} lot(s) with ${w['gain_at_stake']:,.0f} of gain turn long-term within "
                           f"{w['max_days']} days, saving about ${w['est_tax_saved_by_waiting']:,.0f} in tax."),
            })
    if risk.get("top_weight", 0) > settings.max_weight:
        top = max(weights, key=weights.get)
        items.append({
            "kind": "risk", "priority": 2, "symbol": top, "amount_usd": None, "tax_effect": None,
            "title": f"Concentration: {top} is {risk['top_weight']*100:.0f}% of holdings",
            "detail": f"Effective number of assets is {risk.get('effective_assets', 0):.1f}. "
                      f"Ceiling is {settings.max_weight*100:.0f}%.",
        })
    if risk.get("current_drawdown", 0) >= 0.10:
        items.append({
            "kind": "risk", "priority": 2, "symbol": None, "amount_usd": None, "tax_effect": None,
            "title": f"Portfolio is {risk['current_drawdown']*100:.0f}% below its high",
            "detail": "Drawdowns are when harvestable losses are largest; review the Tax tab.",
        })
    if missing_basis_count:
        items.append({
            "kind": "basis", "priority": 1, "symbol": None, "amount_usd": None, "tax_effect": None,
            "title": f"{missing_basis_count} transaction(s) missing cost basis in Awaken",
            "detail": "Awaken assumes $0 cost for these, which overstates gains. Fix them in Awaken "
                      "(import the source wallet, link the transfer, or set a receive price).",
        })
    items.sort(key=lambda i: (i["priority"], -(i.get("tax_effect") or 0)))

    return {
        "as_of": _as_date(as_of).isoformat(),
        "settings": settings.to_dict(),
        "basis_method": basis_method,
        "totals": {
            "value": total_value,
            "cost_basis": sum(l["basis"] for l in lots),
            "unrealized": sum(l["gain"] for l in lots),
            "unrealized_short": sum(l["gain"] for l in lots if l["term"] == "short"),
            "unrealized_long": sum(l["gain"] for l in lots if l["term"] == "long"),
        },
        "lots": lots,
        "harvest": harvest,
        "harvest_summary": hsum,
        "profit_take": takes,
        "risk": risk,
        "items": items,
    }
