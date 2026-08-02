"""Strategy 2: Donchian channel breakout + ATR chandelier trail.

Turtle-style breakout: long entry when the close exceeds the prior
N-day high, gated by an ADX trend-strength filter to reduce false
breakouts in choppy markets. Initial stop and trailing stop are both
ATR-based; a Donchian low break provides a secondary signal exit.
"""
from __future__ import annotations

import pandas as pd

from tradingbot.strategies.base import Strategy, adx, atr, donchian_high, donchian_low


class DonchianBreakoutStrategy(Strategy):
    name = "donchian_breakout"

    def __init__(
        self,
        entry_period: int = 20,
        exit_period: int = 10,
        adx_period: int = 14,
        adx_threshold: float = 20.0,
        atr_period: int = 14,
        atr_init_mult: float = 2.5,
        atr_trail_mult: float = 3.0,
    ):
        self.entry_period = entry_period
        self.exit_period = exit_period
        self.adx_period = adx_period
        self.adx_threshold = adx_threshold
        self.atr_period = atr_period
        self.atr_init_mult = atr_init_mult
        self.atr_trail_mult = atr_trail_mult

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        # Shift by 1 so the breakout level is the *prior* N-day high/low
        # (avoids using today's own high/low to trigger today's entry).
        dc_high = donchian_high(df, self.entry_period).shift(1)
        dc_low = donchian_low(df, self.exit_period).shift(1)
        atr_val = atr(df, self.atr_period)
        adx_val = adx(df, self.adx_period)

        entry = (df["close"] > dc_high) & (adx_val > self.adx_threshold)
        exit_ = df["close"] < dc_low

        out = pd.DataFrame(index=df.index)
        out["atr"] = atr_val
        out["entry_signal"] = entry.fillna(False)
        out["exit_signal"] = exit_.fillna(False)
        return out
