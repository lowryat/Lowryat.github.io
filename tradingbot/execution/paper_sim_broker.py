"""In-memory simulated broker -- used by tests and for dry-run live mode
(no external dependencies, fully deterministic)."""
from __future__ import annotations

from tradingbot.execution.broker import Broker


class PaperSimBroker(Broker):
    def __init__(self, starting_cash: float, prices: dict[str, float] | None = None):
        self.cash = starting_cash
        self.positions: dict[str, float] = {}
        self.prices: dict[str, float] = dict(prices or {})
        self.orders: list[dict] = []

    def set_price(self, symbol: str, price: float) -> None:
        self.prices[symbol] = price

    def get_account_equity(self) -> float:
        mtm = sum(qty * self.prices.get(sym, 0.0) for sym, qty in self.positions.items())
        return self.cash + mtm

    def get_cash(self) -> float:
        return self.cash

    def get_positions(self) -> dict[str, float]:
        return dict(self.positions)

    def get_last_price(self, symbol: str) -> float:
        if symbol not in self.prices:
            raise KeyError(f"No price set for {symbol}")
        return self.prices[symbol]

    def submit_market_order(self, symbol: str, qty: float, side: str) -> dict:
        price = self.get_last_price(symbol)
        if side == "buy":
            cost = qty * price
            self.cash -= cost
            self.positions[symbol] = self.positions.get(symbol, 0.0) + qty
        elif side == "sell":
            proceeds = qty * price
            self.cash += proceeds
            remaining = self.positions.get(symbol, 0.0) - qty
            if abs(remaining) < 1e-12:
                self.positions.pop(symbol, None)
            else:
                self.positions[symbol] = remaining
        else:
            raise ValueError(f"Unknown side: {side}")

        order = {"symbol": symbol, "qty": qty, "side": side, "price": price}
        self.orders.append(order)
        return order
