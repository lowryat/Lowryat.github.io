"""Unit tests for portfolio_analytics.analytics (pure functions, no network)."""
from datetime import date

import pytest

from portfolio_analytics import demo
from portfolio_analytics.analytics import (TaxSettings, build_insights, enrich_lots, harvest_candidates,
                                           harvest_summary, lot_term, price_signals, profit_take_candidates,
                                           risk_metrics, tax_cost_of_sale)

AS_OF = date(2026, 9, 13)


def test_lot_term_boundaries():
    # Exactly 365 days held is still short-term; 366 is long-term ("more than one year").
    assert lot_term("2025-09-13", AS_OF)["term"] == "short"
    assert lot_term("2025-09-13", AS_OF)["days_to_long_term"] == 1
    assert lot_term("2025-09-12", AS_OF)["term"] == "long"
    assert lot_term("2025-09-12", AS_OF)["days_to_long_term"] == 0
    assert lot_term("2026-09-13T10:00:00Z", AS_OF)["holding_days"] == 0


def test_enrich_lots_applies_rates_and_gain():
    s = TaxSettings(short_term_rate=0.30, long_term_rate=0.15, state_rate=0.05, niit_rate=0.0)
    positions = [{"symbol": "BTC", "price": 100.0, "lots": [
        {"amount": 1.0, "basis": 80.0, "purchased_at": "2026-08-01"},
        {"amount": 2.0, "basis": 300.0, "purchased_at": "2024-01-01"},
        {"amount": 0.0, "basis": 5.0, "purchased_at": "2024-01-01"},  # zero lots are dropped
    ]}]
    lots = enrich_lots(positions, AS_OF, s)
    assert len(lots) == 2
    short, long_ = lots
    assert short["gain"] == pytest.approx(20.0) and short["tax_rate"] == pytest.approx(0.35)
    assert long_["gain"] == pytest.approx(-100.0) and long_["tax_rate"] == pytest.approx(0.20)


def test_harvest_candidates_thresholds_and_ordering():
    s = TaxSettings(min_harvest_loss=250, min_harvest_loss_pct=0.05)
    positions = [{"symbol": "X", "price": 10.0, "lots": [
        {"amount": 10, "basis": 120, "purchased_at": "2026-06-01"},     # -20 loss, 17% -> flagged by pct rule
        {"amount": 10, "basis": 103, "purchased_at": "2026-06-01"},     # -3 loss, 3%  -> ignored
        {"amount": 100, "basis": 1400, "purchased_at": "2024-06-01"},   # -400 long-term loss
        {"amount": 10, "basis": 50, "purchased_at": "2026-06-01"},      # gain -> ignored
    ]}]
    cands = harvest_candidates(enrich_lots(positions, AS_OF, s), s, AS_OF)
    assert [round(c["loss"]) for c in cands] == [400, 20]
    assert cands[0]["est_tax_savings"] == pytest.approx(400 * s.total_long_rate())
    assert cands[0]["rebuy_caution_until"] is None
    cons = harvest_candidates(enrich_lots(positions, AS_OF, s), TaxSettings(wash_sale_conservative=True), AS_OF)
    assert cons[0]["rebuy_caution_until"] == "2026-10-14"


def test_harvest_summary_nets_short_then_long_then_cross():
    s = TaxSettings(short_term_rate=0.40, long_term_rate=0.20, niit_rate=0.0)
    cands = [{"loss": 5000, "term": "short"}, {"loss": 1000, "term": "long"}]
    out = harvest_summary(cands, {"short_term": 2000, "long_term": 3000}, s)
    # ST: 2000-5000 = -3000; LT: 3000-1000 = 2000; cross-net -> LT 0, ST -1000 -> ordinary offset 1000.
    assert out["net_long_after"] == pytest.approx(0.0)
    assert out["net_short_after"] == pytest.approx(-1000.0)
    assert out["ordinary_income_offset"] == pytest.approx(1000.0)
    assert out["carryforward"] == pytest.approx(0.0)
    assert out["est_tax_before"] == pytest.approx(2000 * 0.4 + 3000 * 0.2)
    assert out["est_tax_after"] == pytest.approx(-1000 * 0.4)
    assert out["est_tax_savings"] == pytest.approx(1400 + 400)


def test_harvest_summary_carryforward_beyond_3000():
    s = TaxSettings()
    out = harvest_summary([{"loss": 10000, "term": "short"}], {"short_term": 0, "long_term": 0}, s)
    assert out["ordinary_income_offset"] == 3000
    assert out["carryforward"] == 7000


def test_tax_cost_of_sale_hifo_vs_fifo():
    s = TaxSettings(short_term_rate=0.4, long_term_rate=0.2, niit_rate=0.0)
    positions = [{"symbol": "ETH", "price": 100.0, "lots": [
        {"id": "old-cheap", "amount": 1.0, "basis": 10.0, "purchased_at": "2023-01-01"},
        {"id": "new-pricey", "amount": 1.0, "basis": 90.0, "purchased_at": "2026-08-01"},
    ]}]
    lots = enrich_lots(positions, AS_OF, s)
    hifo = tax_cost_of_sale(lots, 1.0, "HIFO")
    fifo = tax_cost_of_sale(lots, 1.0, "FIFO")
    assert hifo["lots_used"][0]["lot_id"] == "new-pricey" and hifo["realized_gain"] == pytest.approx(10.0)
    assert hifo["est_tax"] == pytest.approx(4.0)
    assert fifo["lots_used"][0]["lot_id"] == "old-cheap" and fifo["realized_gain"] == pytest.approx(90.0)
    assert fifo["est_tax"] == pytest.approx(18.0)
    # Over-selling is capped at what the lots hold.
    assert tax_cost_of_sale(lots, 5.0)["amount"] == pytest.approx(2.0)


def test_price_signals_fading_and_sma():
    s = TaxSettings(trailing_dd_pct=0.15)
    flat = [100.0] * 60
    sig = price_signals(flat, s)
    assert sig["available"] and sig["fading"] is False and sig["sma50"] == 100.0 and sig["above_sma50"] is False
    dropping = [100.0] * 50 + [80.0] * 10
    sig = price_signals(dropping, s)
    assert sig["fading"] is True and sig["drawdown_from_90d_high"] == pytest.approx(0.2)
    assert price_signals([], s) == {"available": False}


def test_profit_take_concentration_and_wait():
    s = TaxSettings(max_weight=0.35, target_weight=0.25, profit_take_gain_pct=0.5, long_term_wait_days=45,
                    short_term_rate=0.4, long_term_rate=0.2, niit_rate=0.0)
    positions = [
        {"symbol": "BIG", "price": 10.0, "value": 700.0, "lots": [{"amount": 70, "basis": 350, "purchased_at": "2025-10-01"}]},
        {"symbol": "SMALL", "price": 1.0, "value": 300.0, "lots": [{"amount": 300, "basis": 290, "purchased_at": "2024-01-01"}]},
    ]
    lots = enrich_lots(positions, AS_OF, s)
    takes = profit_take_candidates(positions, lots, 1000.0, s)
    assert [t["symbol"] for t in takes] == ["BIG"]
    t = takes[0]
    assert set(t["reasons"]) == {"concentration", "big_winner"}
    assert t["trim_value"] == pytest.approx(700 - 250)
    assert t["wait_for_long_term"]["max_days"] == lot_term("2025-10-01", AS_OF)["days_to_long_term"]
    assert t["wait_for_long_term"]["est_tax_saved_by_waiting"] == pytest.approx(350 * 0.2)


def test_risk_metrics_basic():
    hist = [{"date": f"d{i}", "value": v} for i, v in enumerate([100, 110, 99, 120, 90, 130])]
    r = risk_metrics(hist, {"A": 60, "B": 40})
    assert r["total_return"] == pytest.approx(0.3)
    assert r["max_drawdown"] == pytest.approx(0.25)  # 120 -> 90
    assert r["current_drawdown"] == pytest.approx(0.0)
    assert r["hhi"] == pytest.approx(0.52) and r["top_weight"] == pytest.approx(0.6)
    assert risk_metrics([], None) == {"days": 0}


def test_build_insights_demo_is_consistent():
    positions = demo.demo_positions(AS_OF)
    history = demo.demo_history(AS_OF, end_value=sum(p["value"] for p in positions))
    out = build_insights(positions, history, demo.demo_realized(AS_OF), AS_OF, TaxSettings(),
                         demo.demo_price_history(positions), "HIFO", missing_basis_count=2)
    assert out["totals"]["value"] == pytest.approx(sum(p["value"] for p in positions))
    assert out["totals"]["unrealized"] == pytest.approx(out["totals"]["unrealized_short"] + out["totals"]["unrealized_long"])
    kinds = {i["kind"] for i in out["items"]}
    assert {"harvest", "profit_take", "basis"} <= kinds
    priorities = [i["priority"] for i in out["items"]]
    assert priorities == sorted(priorities)
    assert any("missing cost basis" in i["title"] for i in out["items"])


def test_settings_roundtrip_ignores_unknown_keys():
    s = TaxSettings.from_dict({"short_term_rate": 0.37, "bogus": 1})
    assert s.short_term_rate == 0.37 and s.to_dict()["long_term_rate"] == 0.20
