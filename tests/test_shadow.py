import json

import pandas as pd
import pytest

from tradingbot.shadow import (DEFAULT_VARIANTS, _drawdown_series, _round_trip_cost,
                               build_ensemble, load_variants, run_variant)
from tradingbot.data.synthetic import generate_multi_regime_ohlcv


class FakeTrade:
    def __init__(self, entry_price, exit_price, qty, pnl=0.0, r_multiple=0.0):
        self.entry_price, self.exit_price, self.qty = entry_price, exit_price, qty
        self.pnl, self.r_multiple = pnl, r_multiple


@pytest.fixture(scope="module")
def data():
    d, _ = generate_multi_regime_ohlcv(["BTC", "ETH"], days=200, seed=5)
    return d


# ------------------------------------------------------------------ variants

def test_default_variants_cover_every_strategy():
    from tradingbot.strategies import STRATEGY_REGISTRY
    assert {v["strategy"] for v in DEFAULT_VARIANTS} == set(STRATEGY_REGISTRY)


def test_unknown_strategy_is_rejected(tmp_path):
    p = tmp_path / "v.json"
    p.write_text(json.dumps({"variants": [{"label": "x", "strategy": "nope"}]}))
    with pytest.raises(ValueError, match="unknown strategy"):
        load_variants(str(p))


def test_variants_file_accepts_bare_list(tmp_path):
    p = tmp_path / "v.json"
    p.write_text(json.dumps([{"label": "a", "strategy": "ema_atr_trend"}]))
    assert load_variants(str(p))[0]["label"] == "a"


# ---------------------------------------------------------------------- cost

def test_round_trip_cost_charges_both_sides():
    t = FakeTrade(entry_price=100.0, exit_price=110.0, qty=2.0)
    # (200 + 220) * 30bp
    assert _round_trip_cost(t, 30.0) == pytest.approx(420.0 * 0.003)


def test_zero_cost_bps_is_free():
    assert _round_trip_cost(FakeTrade(100, 110, 2), 0.0) == 0.0


# ----------------------------------------------------------------- drawdown

def test_drawdown_series_finds_worst_day_and_week():
    idx = pd.date_range("2026-01-05", periods=10, freq="D")  # Mon-start
    eq = pd.Series([100, 99, 97, 96, 95, 110, 108, 107, 106, 105], index=idx, dtype=float)
    dd = _drawdown_series(eq)
    assert dd["worst_daily"] == pytest.approx(0.0202, abs=1e-3)   # 99 -> 97
    assert dd["max_drawdown"] > 0
    assert 0 < dd["worst_weekly"] <= dd["max_drawdown"] + 1e-9


def test_flat_equity_has_no_drawdown():
    idx = pd.date_range("2026-01-05", periods=5, freq="D")
    dd = _drawdown_series(pd.Series([100.0] * 5, index=idx))
    assert dd["worst_daily"] == 0.0 and dd["worst_weekly"] == 0.0


# -------------------------------------------------------------- run_variant

def test_run_variant_shape_and_net_below_gross(data):
    v = {"label": "t", "strategy": "ema_atr_trend", "risk_per_trade_pct": 0.02}
    r = run_variant(v, data, allocation=2500.0, cost_bps=30.0)

    for key in ("label", "net_equity", "gross_equity", "equity_curve",
                "trades", "open_positions", "worst_weekly", "n_trades"):
        assert key in r

    assert r["allocation"] == 2500.0
    assert len(r["equity_curve"]) == 200
    # Costs are always a drag, never a boost.
    if r["n_trades"] > 0:
        assert r["estimated_costs"] > 0
        assert r["net_equity"] < r["gross_equity"]


def test_run_variant_is_deterministic(data):
    """Stateless replay must give identical results for identical input --
    this is what makes the daily job idempotent."""
    v = {"label": "t", "strategy": "donchian_breakout", "risk_per_trade_pct": 0.02}
    a = run_variant(v, data, 2500.0, 30.0)
    b = run_variant(v, data, 2500.0, 30.0)
    assert a["net_equity"] == b["net_equity"]
    assert a["n_trades"] == b["n_trades"]
    assert a["trades"] == b["trades"]


def test_replaying_a_longer_window_preserves_earlier_history():
    """Appending a day must not rewrite yesterday -- otherwise the dashboard
    history would silently change under the user."""
    full, _ = generate_multi_regime_ohlcv(["BTC", "ETH"], days=201, seed=5)
    short = {k: df.iloc[:200] for k, df in full.items()}
    v = {"label": "t", "strategy": "ema_atr_trend", "risk_per_trade_pct": 0.02}

    a = run_variant(v, short, 2500.0, 30.0)["equity_curve"]
    b = run_variant(v, full, 2500.0, 30.0)["equity_curve"]

    assert len(b) == len(a) + 1
    assert b[:len(a)] == a


def test_params_override_reaches_the_strategy(data):
    slow = run_variant({"label": "s", "strategy": "ema_atr_trend",
                        "params": {"fast": 30, "slow": 120}}, data, 2500.0, 30.0)
    fast = run_variant({"label": "f", "strategy": "ema_atr_trend",
                        "params": {"fast": 5, "slow": 15}}, data, 2500.0, 30.0)
    # A much faster pair must trade more often; otherwise params were ignored.
    assert fast["n_trades"] > slow["n_trades"]


# ------------------------------------------------------------------ ensemble

def test_ensemble_averages_and_diversifies(data):
    variants = [
        run_variant({"label": n, "strategy": n, "risk_per_trade_pct": 0.02},
                    data, 2500.0, 30.0)
        for n in ("ema_atr_trend", "donchian_breakout", "momentum_regime")
    ]
    ens = build_ensemble(variants, 2500.0)

    assert ens["allocation"] == 7500.0
    assert len(ens["equity_curve"]) == 200
    # Equal weighting: ensemble return is the mean of member returns (gross).
    mean_gross = sum(v["gross_return_pct"] for v in variants) / len(variants)
    assert ens["gross_return_pct"] == pytest.approx(mean_gross, abs=0.5)
    # Diversification should not make drawdown worse than the worst member.
    assert ens["worst_weekly"] <= max(v["worst_weekly"] for v in variants) + 1e-9


def test_ensemble_of_nothing_is_empty():
    assert build_ensemble([], 2500.0) == {}


def test_strategy_params_own_the_trail_not_riskconfig(data):
    """atr_trail_mult lives on the Strategy; the Backtester asks the strategy
    for the trail multiple, so a RiskConfig override of it is a silent no-op.
    Documented here because the shipped example variants got it wrong once."""
    base = run_variant({"label": "b", "strategy": "ema_atr_trend"}, data, 2500.0, 30.0)
    via_risk = run_variant({"label": "r", "strategy": "ema_atr_trend",
                            "risk": {"atr_trail_mult": 2.0}}, data, 2500.0, 30.0)
    via_params = run_variant({"label": "p", "strategy": "ema_atr_trend",
                              "params": {"atr_trail_mult": 2.0}}, data, 2500.0, 30.0)

    assert via_risk["net_equity"] == base["net_equity"], "RiskConfig trail override should be inert"
    assert via_params["net_equity"] != base["net_equity"], "params trail override must bite"


def test_riskconfig_overrides_that_do_bite(data):
    """max_positions is genuinely enforced by the RiskManager."""
    wide = run_variant({"label": "w", "strategy": "ema_atr_trend",
                        "risk": {"max_positions": 4}}, data, 2500.0, 30.0)
    narrow = run_variant({"label": "n", "strategy": "ema_atr_trend",
                          "risk": {"max_positions": 1}}, data, 2500.0, 30.0)
    assert narrow["n_trades"] != wide["n_trades"]


def test_shipped_variants_file_is_valid_and_has_no_dead_overrides():
    """Every shipped example must parse and name a real strategy."""
    variants = load_variants("tradingbot/shadow_variants.json")
    assert len(variants) >= 4
    labels = [v["label"] for v in variants]
    assert len(labels) == len(set(labels)), f"duplicate labels: {labels}"
    for v in variants:
        # The trail multiple is a strategy param; catching it in `risk` here
        # stops a silently-inert example shipping again.
        assert "atr_trail_mult" not in (v.get("risk") or {}), \
            f"{v['label']}: atr_trail_mult in risk is a no-op, put it in params"


def test_too_little_history_is_refused(monkeypatch, tmp_path, capsys):
    """One bar in means no indicator can warm up; every strategy sits flat and
    the dashboard would show a meaningless row of zeros. Fail loudly instead.
    This is the shape of the bug that returned 1 bar from Alpaca."""
    import tradingbot.shadow as sh
    thin, _ = generate_multi_regime_ohlcv(["BTC", "ETH"], days=200, seed=3)
    thin = {k: df.iloc[-5:] for k, df in thin.items()}
    monkeypatch.setattr(sh, "get_data", lambda *a, **k: (thin, "alpaca-crypto (live)"))

    rc = sh.main(["--out", str(tmp_path)])
    assert rc == 1
    assert "Refusing to write a misleading report" in capsys.readouterr().err
    assert not (tmp_path / "latest.json").exists()
