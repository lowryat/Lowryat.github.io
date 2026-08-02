"""Shared indicators and the Strategy interface.

All strategies implement `generate_signals(df) -> pd.DataFrame`, returning a
frame indexed identically to `df` with at least:

  - `atr`: ATR value used for position sizing and initial stop distance
  - `entry_signal`: bool, True => open a long position at this bar's close
  - `exit_signal`: bool, True => close the position at this bar's close
    (signal-based exit; the trailing/initial stop is handled separately by
    the risk manager regardless of this flag)

Strategies may override `trail_multiple()` to dynamically adjust the ATR
trailing-stop multiple based on the current position's R-multiple (used by
`DualMomentumAdaptiveStrategy` to tighten trails on big winners).
"""
from __future__ import annotations

from abc import ABC, abstractmethod

import numpy as np
import pandas as pd


# ----------------------------------------------------------------------
# Indicators
# ----------------------------------------------------------------------
def ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()


def sma(series: pd.Series, period: int) -> pd.Series:
    return series.rolling(period).mean()


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    high, low, close = df["high"], df["low"], df["close"]
    prev_close = close.shift(1)
    tr = pd.concat(
        [
            high - low,
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return tr.ewm(span=period, adjust=False).mean()


def roc(series: pd.Series, period: int) -> pd.Series:
    return series.pct_change(period)


def donchian_high(df: pd.DataFrame, period: int) -> pd.Series:
    return df["high"].rolling(period).max()


def donchian_low(df: pd.DataFrame, period: int) -> pd.Series:
    return df["low"].rolling(period).min()


def adx(df: pd.DataFrame, period: int = 14) -> pd.Series:
    high, low = df["high"], df["low"]
    up_move = high.diff()
    down_move = -low.diff()

    plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
    minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)

    tr = atr(df, period)
    plus_di = 100 * pd.Series(plus_dm, index=df.index).ewm(span=period, adjust=False).mean() / tr
    minus_di = 100 * pd.Series(minus_dm, index=df.index).ewm(span=period, adjust=False).mean() / tr

    denom = (plus_di + minus_di).replace(0, np.nan)
    dx = 100 * (plus_di - minus_di).abs() / denom
    return dx.ewm(span=period, adjust=False).mean().fillna(0.0)


def kama(series: pd.Series, period: int = 10, fast: int = 2, slow: int = 30) -> pd.Series:
    """Kaufman's Adaptive Moving Average -- speeds up in trends, slows in noise."""
    change = (series - series.shift(period)).abs()
    volatility = series.diff().abs().rolling(period).sum()
    er = (change / volatility).fillna(0.0)

    fast_sc = 2.0 / (fast + 1)
    slow_sc = 2.0 / (slow + 1)
    sc = (er * (fast_sc - slow_sc) + slow_sc) ** 2

    values = series.to_numpy(dtype=float)
    sc_vals = sc.to_numpy(dtype=float)
    out = np.full(len(values), np.nan)

    start_idx = period
    if start_idx >= len(values):
        return pd.Series(out, index=series.index)

    out[start_idx - 1] = values[start_idx - 1]
    for i in range(start_idx, len(values)):
        out[i] = out[i - 1] + sc_vals[i] * (values[i] - out[i - 1])

    return pd.Series(out, index=series.index)


# ----------------------------------------------------------------------
# Strategy interface
# ----------------------------------------------------------------------
class Strategy(ABC):
    name: str = "base"
    atr_period: int = 14
    atr_init_mult: float = 2.5
    atr_trail_mult: float = 3.0

    @abstractmethod
    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        raise NotImplementedError

    def trail_multiple(self, position, bar: pd.Series) -> float:
        """ATR multiple for the trailing stop on this bar. Default: constant."""
        return self.atr_trail_mult
