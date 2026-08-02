from tradingbot.backtest.engine import Backtester
from tradingbot.config import RiskConfig
from tradingbot.data.synthetic import generate_multi_regime_ohlcv
from tradingbot.strategies import STRATEGY_REGISTRY, build_strategy


def test_backtest_runs_and_equity_stays_positive():
    data, regimes = generate_multi_regime_ohlcv(["BTC", "ETH"], days=400, seed=42)
    strategy = build_strategy("ema_atr_trend")
    bt = Backtester(data, strategy, RiskConfig(), starting_equity=10_000.0, regime_labels=regimes)
    result = bt.run()

    assert len(result.equity_curve) == 400
    assert (result.equity_curve["equity"] > 0).all()
    assert result.metrics["final_equity"] > 0
    assert "regime" in result.equity_curve.columns


def test_all_strategies_run_without_error_on_small_dataset():
    data, regimes = generate_multi_regime_ohlcv(["BTC", "ETH"], days=120, seed=3)
    for name in STRATEGY_REGISTRY:
        strategy = build_strategy(name)
        bt = Backtester(data, strategy, RiskConfig(), starting_equity=10_000.0, regime_labels=regimes)
        result = bt.run()
        assert len(result.equity_curve) == 120
        assert (result.equity_curve["equity"] > 0).all()


def test_circuit_breaker_never_silently_exceeded_intraweek():
    """Drawdown limits can be overshot on a single bar (gap risk), but once
    halted_today/halted_week is set, no *new* positions should open until the
    period rolls over."""
    data, regimes = generate_multi_regime_ohlcv(["BTC", "ETH", "SOL", "AVAX"], days=730, seed=42)
    for name in STRATEGY_REGISTRY:
        strategy = build_strategy(name)
        bt = Backtester(data, strategy, RiskConfig(), starting_equity=10_000.0, regime_labels=regimes)
        result = bt.run()
        ec = result.equity_curve

        halted_days = ec[ec["halted_today"]]
        if halted_days.empty:
            continue
        # On halted days, no new position should be opened beyond what was
        # already open at the moment of breach (n_positions should not
        # increase while halted_today is True on consecutive days).
        halted_idx = ec.index.get_indexer(halted_days.index)
        for i in halted_idx:
            if i + 1 < len(ec) and ec.iloc[i]["halted_today"] and ec.iloc[i + 1]["halted_today"]:
                assert ec.iloc[i + 1]["n_positions"] <= ec.iloc[i]["n_positions"]
