from tradingbot.data.synthetic import generate_multi_regime_ohlcv
from tradingbot.strategies import STRATEGY_REGISTRY, build_strategy


def test_all_strategies_generate_valid_signal_frames():
    data, _ = generate_multi_regime_ohlcv(["BTC"], days=200, seed=1)
    df = data["BTC"]

    for name in STRATEGY_REGISTRY:
        strategy = build_strategy(name)
        sig = strategy.generate_signals(df)

        assert list(sig.index) == list(df.index), name
        for col in ["atr", "entry_signal", "exit_signal"]:
            assert col in sig.columns, f"{name} missing column {col}"

        assert sig["entry_signal"].dtype == bool, name
        assert sig["exit_signal"].dtype == bool, name
        # ATR should be non-negative once warmed up.
        assert (sig["atr"].dropna() >= 0).all(), name


def test_dual_momentum_adaptive_tightens_trail_after_big_winner():
    from tradingbot.risk.manager import Position
    import pandas as pd

    strategy = build_strategy("dual_momentum_adaptive")
    pos = Position(
        symbol="BTC",
        qty=1.0,
        entry_price=100.0,
        entry_date=pd.Timestamp("2023-01-01"),
        initial_stop=90.0,  # risk_per_unit = 10
        stop=90.0,
        atr_at_entry=10.0,
        highest_price=100.0,
    )

    # +1R: price = 110 -> r_multiple = 1.0, below tighten threshold (3.0)
    bar_small = pd.Series({"close": 110.0})
    assert strategy.trail_multiple(pos, bar_small) == strategy.atr_trail_mult

    # +3R: price = 130 -> r_multiple = 3.0, trail should tighten
    bar_big = pd.Series({"close": 130.0})
    assert strategy.trail_multiple(pos, bar_big) == strategy.tighten_trail_mult
