"""Strategy 3: dual ROC momentum + volatility regime switch.

Long when both a fast and slow rate-of-change are positive and momentum is
accelerating (fast ROC > slow ROC), unless the asset is in a "crash" vol
regime (5-day realized vol far above its 60-day average). Exits as soon as
fast momentum turns negative or a crash regime is detected -- this is the
most explicitly "quick trend change" strategy: it reacts to momentum decay
before price fully reverses.
"""
from __future__ import annotations

import pandas as pd

from tradingbot.strategies.base import Strategy, atr, roc


class MomentumRegimeStrategy(Strategy):
    name = "momentum_regime"

    def __init__(
        self,
        fast_roc: int = 10,
        slow_roc: int = 30,
        vol_window: int = 60,
        crash_z: float = 3.0,
        atr_period: int = 14,
        atr_init_mult: float = 2.0,
        atr_trail_mult: float = 3.0,
    ):
        self.fast_roc = fast_roc
        self.slow_roc = slow_roc
        self.vol_window = vol_window
        self.crash_z = crash_z
        self.atr_period = atr_period
        self.atr_init_mult = atr_init_mult
        self.atr_trail_mult = atr_trail_mult

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        close = df["close"]
        roc_fast = roc(close, self.fast_roc)
        roc_slow = roc(close, self.slow_roc)
        atr_val = atr(df, self.atr_period)

        returns = close.pct_change()
        short_vol = returns.rolling(5).std()
        long_vol_mean = short_vol.rolling(self.vol_window).mean()
        long_vol_std = short_vol.rolling(self.vol_window).std()
        vol_z = (short_vol - long_vol_mean) / long_vol_std

        crash = vol_z > self.crash_z

        entry = (roc_fast > 0) & (roc_slow > 0) & (roc_fast > roc_slow) & (~crash)
        exit_ = (roc_fast < 0) | crash

        out = pd.DataFrame(index=df.index)
        out["atr"] = atr_val
        out["entry_signal"] = entry.fillna(False)
        out["exit_signal"] = exit_.fillna(False)
        return out
