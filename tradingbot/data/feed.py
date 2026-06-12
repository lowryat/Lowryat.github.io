"""DataFeed abstractions: a uniform interface for backtests and live runs.

Concrete feeds usable in this sandbox (no network access): `CSVDataFeed` and
`SyntheticDataFeed`. `alpaca_feed.AlpacaCryptoFeed` implements the same
interface against the Alpaca crypto market-data API for live use on
GitHub Actions runners (untested here).
"""
from __future__ import annotations

import os
from abc import ABC, abstractmethod

import pandas as pd

from tradingbot.data.schema import load_ohlcv_csv
from tradingbot.data.synthetic import generate_multi_regime_ohlcv


class DataFeed(ABC):
    """Returns a dict of symbol -> OHLCV DataFrame (indexed by date, ascending)."""

    @abstractmethod
    def get_data(self, symbols: list[str]) -> dict[str, pd.DataFrame]:
        raise NotImplementedError


class CSVDataFeed(DataFeed):
    """Loads OHLCV CSVs (as written by `synthetic.write_csvs`) from a directory."""

    def __init__(self, data_dir: str):
        self.data_dir = data_dir

    def get_data(self, symbols: list[str]) -> dict[str, pd.DataFrame]:
        data = {}
        for symbol in symbols:
            path = os.path.join(self.data_dir, f"{symbol}.csv")
            data[symbol] = load_ohlcv_csv(path)
        return data

    def get_regime_labels(self) -> pd.Series | None:
        path = os.path.join(self.data_dir, "regimes.csv")
        if not os.path.exists(path):
            return None
        df = pd.read_csv(path, index_col=0, parse_dates=True)
        return df["regime"]


class SyntheticDataFeed(DataFeed):
    """Generates synthetic multi-regime OHLCV on the fly (deterministic via seed)."""

    def __init__(self, days: int = 730, seed: int = 42):
        self.days = days
        self.seed = seed
        self._regime_labels: pd.Series | None = None

    def get_data(self, symbols: list[str]) -> dict[str, pd.DataFrame]:
        data, regime_labels = generate_multi_regime_ohlcv(symbols, days=self.days, seed=self.seed)
        self._regime_labels = regime_labels
        return data

    def get_regime_labels(self) -> pd.Series | None:
        return self._regime_labels
