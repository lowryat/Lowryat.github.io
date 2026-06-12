"""Strategy 1: EMA cross + ATR trend filter + chandelier exit.

Baseline/reference trend-follower. Long entry when the fast EMA crosses
above the slow EMA while price is above a longer-term EMA (broad regime
filter). Exit on the reverse cross (fast trend-change signal) or the
chandelier trailing stop, whichever comes first.
"""
from __future__ import annotations

import pandas as pd

from tradingbot.strategies.base import Strategy, atr, ema


class EmaAtrTrendStrategy(Strategy):
    name = "ema_atr_trend"

    def __init__(
        self,
        fast: int = 12,
        slow: int = 48,
        regime: int = 100,
        atr_period: int = 14,
        atr_init_mult: float = 2.5,
        atr_trail_mult: float = 3.0,
    ):
        self.fast = fast
        self.slow = slow
        self.regime = regime
        self.atr_period = atr_period
        self.atr_init_mult = atr_init_mult
        self.atr_trail_mult = atr_trail_mult

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        close = df["close"]
        ema_fast = ema(close, self.fast)
        ema_slow = ema(close, self.slow)
        ema_regime = ema(close, self.regime)
        atr_val = atr(df, self.atr_period)

        cross_up = (ema_fast > ema_slow) & (ema_fast.shift(1) <= ema_slow.shift(1))
        cross_down = (ema_fast < ema_slow) & (ema_fast.shift(1) >= ema_slow.shift(1))

        entry = cross_up & (close > ema_regime)
        exit_ = cross_down

        out = pd.DataFrame(index=df.index)
        out["atr"] = atr_val
        out["entry_signal"] = entry.fillna(False)
        out["exit_signal"] = exit_.fillna(False)
        return out
