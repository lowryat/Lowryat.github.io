"""Broker interface used by the live runner.

Implementations: `PaperSimBroker` (in-memory, used in tests / dry runs) and
`AlpacaPaperBroker` (Alpaca crypto paper-trading account, untested in this
sandbox -- verify via GitHub Actions `workflow_dispatch`).
"""
from __future__ import annotations

from abc import ABC, abstractmethod


class Broker(ABC):
    @abstractmethod
    def get_account_equity(self) -> float:
        """Total account equity (cash + market value of positions)."""
        raise NotImplementedError

    @abstractmethod
    def get_cash(self) -> float:
        raise NotImplementedError

    @abstractmethod
    def get_positions(self) -> dict[str, float]:
        """symbol -> qty currently held."""
        raise NotImplementedError

    @abstractmethod
    def get_last_price(self, symbol: str) -> float:
        raise NotImplementedError

    @abstractmethod
    def submit_market_order(self, symbol: str, qty: float, side: str) -> dict:
        """side: 'buy' or 'sell'. Returns a dict describing the fill."""
        raise NotImplementedError
