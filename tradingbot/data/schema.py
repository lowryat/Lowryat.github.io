"""OHLCV DataFrame schema and validation helpers."""
from __future__ import annotations

import pandas as pd

REQUIRED_COLUMNS = ["open", "high", "low", "close", "volume"]


def validate_ohlcv(df: pd.DataFrame, symbol: str = "") -> None:
    """Raise ValueError if `df` is not a well-formed OHLCV frame."""
    label = f"{symbol}: " if symbol else ""

    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"{label}missing columns {missing}")

    if not isinstance(df.index, pd.DatetimeIndex):
        raise ValueError(f"{label}index must be a DatetimeIndex")

    if not df.index.is_monotonic_increasing:
        raise ValueError(f"{label}index must be sorted ascending")

    bad = df[
        (df["high"] < df["low"])
        | (df["high"] < df["close"])
        | (df["high"] < df["open"])
        | (df["low"] > df["close"])
        | (df["low"] > df["open"])
    ]
    if not bad.empty:
        raise ValueError(f"{label}{len(bad)} rows with inconsistent OHLC values")


def load_ohlcv_csv(path: str) -> pd.DataFrame:
    """Load an OHLCV CSV written by `synthetic.write_csvs` (or compatible)."""
    df = pd.read_csv(path, index_col=0, parse_dates=True)
    df = df[REQUIRED_COLUMNS]
    validate_ohlcv(df, symbol=path)
    return df
