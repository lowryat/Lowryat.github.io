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
        from datetime import datetime, timedelta, timezone

        from alpaca.data.historical.crypto import CryptoHistoricalDataClient
        from alpaca.data.requests import CryptoBarsRequest
        from alpaca.data.timeframe import TimeFrame

        client = CryptoHistoricalDataClient()
        pairs = [SYMBOL_MAP.get(s, s) for s in symbols]

        # `start` is required. Without it Alpaca returns only the most recent
        # bar, and `limit` caps total rows across ALL symbols rather than per
        # symbol -- which silently yielded one bar each and made every
        # indicator (EMA-100 regime filter especially) unusable.
        # Pad the window so warm-up periods still have history behind them.
        start = datetime.now(timezone.utc) - timedelta(days=self.lookback_days + 10)
        req = CryptoBarsRequest(
            symbol_or_symbols=pairs,
            timeframe=TimeFrame.Day,
            start=start,
        )
        bars = client.get_crypto_bars(req).df

        out = {}
        for symbol, pair in zip(symbols, pairs):
            if pair not in bars.index.get_level_values(0):
                raise RuntimeError(f"Alpaca returned no bars for {pair}")
            df = bars.loc[pair].copy()
            df.index = pd.to_datetime(df.index).tz_localize(None)
            df = df[["open", "high", "low", "close", "volume"]].tail(self.lookback_days)
            if len(df) < 2:
                raise RuntimeError(
                    f"Alpaca returned only {len(df)} bar(s) for {pair} since "
                    f"{start:%Y-%m-%d}; indicators need far more history."
                )
            out[symbol] = df
        return out

    def get_regime_labels(self) -> pd.Series | None:
        return None
