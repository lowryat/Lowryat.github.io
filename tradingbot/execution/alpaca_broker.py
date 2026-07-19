"""Alpaca crypto paper-trading broker adapter.

Requires `alpaca-py` and the ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY env
vars (free Alpaca *paper* trading keys -- create an account at alpaca.markets
and use the paper API keys, never live keys here).

NOTE: this sandbox cannot reach api.alpaca.markets (network policy), so this
adapter is untested here. Verify via a GitHub Actions `workflow_dispatch` run
with `--broker alpaca-paper` before relying on it.
"""
from __future__ import annotations

import os

from tradingbot.execution.broker import Broker

# Map our short symbols to Alpaca crypto pair symbols.
SYMBOL_MAP = {
    "BTC": "BTC/USD",
    "ETH": "ETH/USD",
    "SOL": "SOL/USD",
    "AVAX": "AVAX/USD",
    "BNB": "BNB/USD",
    "LTC": "LTC/USD",
}


class AlpacaPaperBroker(Broker):
    def __init__(self, api_key: str | None = None, secret_key: str | None = None):
        from alpaca.trading.client import TradingClient

        self.api_key = api_key or os.environ["ALPACA_API_KEY_ID"]
        self.secret_key = secret_key or os.environ["ALPACA_API_SECRET_KEY"]
        self.client = TradingClient(self.api_key, self.secret_key, paper=True)

    def get_account_equity(self) -> float:
        account = self.client.get_account()
        return float(account.equity)

    def get_cash(self) -> float:
        account = self.client.get_account()
        return float(account.cash)

    def get_positions(self) -> dict[str, float]:
        positions = self.client.get_all_positions()
        reverse_map = {v: k for k, v in SYMBOL_MAP.items()}
        out = {}
        for p in positions:
            symbol = reverse_map.get(p.symbol, p.symbol)
            out[symbol] = float(p.qty)
        return out

    def get_last_price(self, symbol: str) -> float:
        from alpaca.data.historical.crypto import CryptoHistoricalDataClient
        from alpaca.data.requests import CryptoLatestTradeRequest

        pair = SYMBOL_MAP.get(symbol, symbol)
        client = CryptoHistoricalDataClient()
        req = CryptoLatestTradeRequest(symbol_or_symbols=pair)
        trades = client.get_crypto_latest_trade(req)
        return float(trades[pair].price)

    def submit_market_order(self, symbol: str, qty: float, side: str) -> dict:
        import time
        from alpaca.trading.enums import OrderSide, OrderStatus, TimeInForce
        from alpaca.trading.requests import MarketOrderRequest

        pair = SYMBOL_MAP.get(symbol, symbol)
        order_side = OrderSide.BUY if side == "buy" else OrderSide.SELL
        req = MarketOrderRequest(symbol=pair, qty=qty, side=order_side, time_in_force=TimeInForce.GTC)
        order = self.client.submit_order(req)

        # Poll until the paper order fills so we can return the actual fill price.
        # Paper-trading orders normally fill within a few seconds.
        fill_price: float | None = None
        for _ in range(20):
            order = self.client.get_order_by_id(order.id)
            if order.status == OrderStatus.FILLED and order.filled_avg_price is not None:
                fill_price = float(order.filled_avg_price)
                break
            time.sleep(0.5)

        return {
            "symbol": symbol,
            "qty": qty,
            "side": side,
            "order_id": str(order.id),
            "price": fill_price,  # None if fill wasn't confirmed within the poll window
        }
