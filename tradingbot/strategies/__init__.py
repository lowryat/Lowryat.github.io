"""Trend-following strategy prototypes, all built on shared indicators in `base`."""
from __future__ import annotations

from tradingbot.strategies.base import Strategy
from tradingbot.strategies.donchian_breakout import DonchianBreakoutStrategy
from tradingbot.strategies.dual_momentum_adaptive import DualMomentumAdaptiveStrategy
from tradingbot.strategies.ema_atr_trend import EmaAtrTrendStrategy
from tradingbot.strategies.momentum_regime import MomentumRegimeStrategy

STRATEGY_REGISTRY: dict[str, type[Strategy]] = {
    "ema_atr_trend": EmaAtrTrendStrategy,
    "donchian_breakout": DonchianBreakoutStrategy,
    "momentum_regime": MomentumRegimeStrategy,
    "dual_momentum_adaptive": DualMomentumAdaptiveStrategy,
}


def build_strategy(name: str, params: dict | None = None) -> Strategy:
    cls = STRATEGY_REGISTRY[name]
    return cls(**(params or {}))
