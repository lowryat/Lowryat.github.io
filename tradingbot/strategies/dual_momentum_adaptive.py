"""Strategy 4: dual-timeframe adaptive momentum "flip detector" with a
tightening trailing stop.

Combines Kaufman's Adaptive Moving Average (KAMA, which speeds up in trends
and slows in noise) with a slow EMA regime gate. A "flip" -- KAMA slope
changing sign, confirmed by a short-lookback ROC in the same direction --
triggers fast entries/exits around regime transitions, while the slow EMA
avoids whipsaws in pure noise.

Asymmetric exit: once a trade reaches +3R, the chandelier trailing stop
multiple tightens from 3x ATR to 2x ATR, ratcheting in more of a big
winner's gains.
"""
from __future__ import annotations

import pandas as pd

from tradingbot.strategies.base import Strategy, atr, ema, kama, roc


class DualMomentumAdaptiveStrategy(Strategy):
    name = "dual_momentum_adaptive"

    def __init__(
        self,
        slow: int = 48,
        fast_lookback: int = 5,
        kama_period: int = 10,
        kama_fast: int = 2,
        kama_slow: int = 30,
        atr_period: int = 14,
        atr_init_mult: float = 2.5,
        atr_trail_mult: float = 3.0,
        tighten_trail_mult: float = 2.0,
        tighten_r: float = 3.0,
    ):
        self.slow = slow
        self.fast_lookback = fast_lookback
        self.kama_period = kama_period
        self.kama_fast = kama_fast
        self.kama_slow = kama_slow
        self.atr_period = atr_period
        self.atr_init_mult = atr_init_mult
        self.atr_trail_mult = atr_trail_mult
        self.tighten_trail_mult = tighten_trail_mult
        self.tighten_r = tighten_r

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        close = df["close"]
        ema_slow = ema(close, self.slow)
        kama_val = kama(close, self.kama_period, self.kama_fast, self.kama_slow)
        atr_val = atr(df, self.atr_period)

        kama_slope = kama_val.diff()
        roc_fast = roc(close, self.fast_lookback)

        flip_up = (kama_slope > 0) & (kama_slope.shift(1) <= 0) & (roc_fast > 0)
        flip_down = (kama_slope < 0) & (kama_slope.shift(1) >= 0) & (roc_fast < 0)

        entry = flip_up & (close > ema_slow)
        exit_ = flip_down

        out = pd.DataFrame(index=df.index)
        out["atr"] = atr_val
        out["entry_signal"] = entry.fillna(False)
        out["exit_signal"] = exit_.fillna(False)
        return out

    def trail_multiple(self, position, bar: pd.Series) -> float:
        if position.r_multiple(bar["close"]) >= self.tighten_r:
            return self.tighten_trail_mult
        return self.atr_trail_mult
