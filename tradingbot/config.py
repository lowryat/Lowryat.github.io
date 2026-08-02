"""Configuration dataclasses shared across the backtester, risk manager and live runner."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class RiskConfig:
    """Hard risk limits and position sizing rules.

    The 3% daily / 5% weekly drawdown limits are circuit breakers: once the
    drawdown from the period's high-water mark reaches the limit, all open
    positions are flattened and no new positions may be opened until the
    next period (UTC day / ISO week) begins.
    """

    daily_dd_limit: float = 0.03
    weekly_dd_limit: float = 0.05

    # Position sizing: risk_per_trade_pct of current equity is risked on the
    # distance to the initial stop (ATR based). Sizing reads *current*
    # equity, so position sizes automatically compound with daily P&L.
    risk_per_trade_pct: float = 0.01

    atr_period: int = 14
    atr_init_mult: float = 2.5
    atr_trail_mult: float = 3.0

    # Portfolio-level caps.
    max_alloc_per_asset: float = 0.25
    max_gross_exposure: float = 1.0
    max_positions: int = 4


@dataclass
class StrategyConfig:
    name: str
    params: dict = field(default_factory=dict)


@dataclass
class RunConfig:
    symbols: list[str]
    starting_equity: float = 10_000.0
    risk: RiskConfig = field(default_factory=RiskConfig)


# ----------------------------------------------------------------------
# Frozen "winner" configuration, selected after reps 1-4 (see
# reports/final/summary.md). ema_atr_trend was the only strategy that was
# (a) profitable across all three tested seeds, (b) never tripped the
# circuit breaker, and (c) stayed comfortably under the 5% weekly limit
# even at 2% risk-per-trade. Used as the default for `tradingbot.live`.
# ----------------------------------------------------------------------
DEFAULT_STRATEGY = "ema_atr_trend"
DEFAULT_RISK_CONFIG = RiskConfig(risk_per_trade_pct=0.02)
