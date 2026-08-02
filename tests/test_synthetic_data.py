import pandas as pd

from tradingbot.data.schema import validate_ohlcv
from tradingbot.data.synthetic import generate_multi_regime_ohlcv


def test_generate_multi_regime_ohlcv_shapes():
    data, regimes = generate_multi_regime_ohlcv(["BTC", "ETH"], days=120, seed=1)
    assert set(data.keys()) == {"BTC", "ETH"}
    for sym, df in data.items():
        assert len(df) == 120
        validate_ohlcv(df, symbol=sym)
    assert len(regimes) == 120


def test_deterministic_with_seed():
    data1, regimes1 = generate_multi_regime_ohlcv(["BTC"], days=60, seed=7)
    data2, regimes2 = generate_multi_regime_ohlcv(["BTC"], days=60, seed=7)
    pd.testing.assert_frame_equal(data1["BTC"], data2["BTC"])
    pd.testing.assert_series_equal(regimes1, regimes2)


def test_different_seeds_diverge():
    data1, _ = generate_multi_regime_ohlcv(["BTC"], days=60, seed=7)
    data2, _ = generate_multi_regime_ohlcv(["BTC"], days=60, seed=8)
    assert not data1["BTC"]["close"].equals(data2["BTC"]["close"])


def test_regime_labels_present_for_full_plan():
    _, regimes = generate_multi_regime_ohlcv(["BTC"], days=730, seed=42)
    names = set(regimes.unique())
    for expected in ["bull", "choppy", "high_vol_cluster", "crash", "bear", "recovery"]:
        assert expected in names
