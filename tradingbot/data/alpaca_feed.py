"""Live daily OHLCV via Alpaca's crypto market-data API.

NOTE: this sandbox cannot reach data.alpaca.markets (network policy), so this
feed is untested here. Verify via a GitHub Actions `workflow_dispatch` run.
"""
from __future__ import annotations

import pandas as pd

from tradingbot.data.feed import DataFeed
from tradingbot.execution.alpaca_broker import SYMBOL_MAP


class AlpacaCryptoFeed(DataFeed):
    def __init__(self, lookback_days: int = 250):
        self.lookback_days = lookback_days

    def get_data(self, symbols: list[str]) -> dict[str, pd.DataFrame]:
        from alpaca.data.historical.crypto import CryptoHistoricalDataClient
        from alpaca.data.requests import CryptoBarsRequest
        from alpaca.data.timeframe import TimeFrame

        client = CryptoHistoricalDataClient()
        pairs = [SYMBOL_MAP.get(s, s) for s in symbols]
        req = CryptoBarsRequest(symbol_or_symbols=pairs, timeframe=TimeFrame.Day, limit=self.lookback_days)
        bars = client.get_crypto_bars(req).df

        out = {}
        for symbol, pair in zip(symbols, pairs):
            df = bars.loc[pair].copy()
            df.index = pd.to_datetime(df.index).tz_localize(None)
            out[symbol] = df[["open", "high", "low", "close", "volume"]]
        return out

    def get_regime_labels(self) -> pd.Series | None:
        return None
