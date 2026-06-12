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
        from alpaca.trading.enums import OrderSide, TimeInForce
        from alpaca.trading.requests import MarketOrderRequest

        pair = SYMBOL_MAP.get(symbol, symbol)
        order_side = OrderSide.BUY if side == "buy" else OrderSide.SELL
        req = MarketOrderRequest(symbol=pair, qty=qty, side=order_side, time_in_force=TimeInForce.GTC)
        order = self.client.submit_order(req)
        return {"symbol": symbol, "qty": qty, "side": side, "order_id": str(order.id)}
