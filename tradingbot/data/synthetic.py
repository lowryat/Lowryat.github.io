"""Synthetic multi-regime OHLCV generator.

Generates deterministic (seeded), regime-labelled daily OHLCV series for a
set of crypto symbols. The default regime plan walks through bull, choppy
(mean-reverting), high-volatility-cluster, crash (jump process), bear and
recovery regimes so that backtests can be evaluated overall *and* broken
down per regime -- in particular to verify that the risk manager's 3%
daily / 5% weekly circuit breakers fire during the crash / high-vol
regimes and that the system behaves sanely afterwards.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np
import pandas as pd

# Approximate current-ish prices, reused from the existing `fi` dashboard for
# narrative continuity. Only used as a starting reference point.
BASE_PRICES = {
    "BTC": 62_000.0,
    "ETH": 3_200.0,
    "SOL": 145.0,
    "AVAX": 35.0,
    "BNB": 580.0,
    "NEAR": 5.0,
    "ATOM": 8.0,
    "TIA": 5.0,
    "DOT": 7.0,
    "APT": 9.0,
    "SUI": 1.5,
    "SEI": 0.5,
    "XRP": 0.6,
    "LTC": 80.0,
    "ARB": 1.0,
    "OP": 2.0,
}

START_DATE = "2023-01-01"


@dataclass
class RegimeSpec:
    name: str
    days: int
    drift: float  # mean daily log return
    vol: float  # daily log return stdev
    jump_prob: float = 0.0
    jump_mean: float = 0.0
    jump_std: float = 0.0
    mean_revert: bool = False
    vol_cluster: bool = False


def default_regime_plan(total_days: int) -> list[RegimeSpec]:
    """Bull -> choppy -> high-vol cluster -> crash -> bear -> recovery."""
    fixed = [
        RegimeSpec("bull", 180, drift=0.0020, vol=0.025),
        RegimeSpec("choppy", 60, drift=0.0000, vol=0.020, mean_revert=True),
        RegimeSpec("high_vol_cluster", 30, drift=-0.0005, vol=0.050, vol_cluster=True),
        RegimeSpec("crash", 15, drift=-0.0250, vol=0.040, jump_prob=0.15, jump_mean=-0.10, jump_std=0.05),
        RegimeSpec("bear", 60, drift=-0.0015, vol=0.030),
    ]
    used = sum(r.days for r in fixed)
    remaining = max(total_days - used, 30)
    fixed.append(RegimeSpec("recovery", remaining, drift=0.0018, vol=0.025))
    return fixed


def _symbol_seed(seed: int, symbol: str) -> int:
    return (seed * 1_000_003 + sum(ord(c) for c in symbol) * 97) % (2**31 - 1)


def _regime_returns(spec: RegimeSpec, n: int, rng: np.random.Generator, market_factor: np.ndarray) -> np.ndarray:
    base = rng.normal(spec.drift, spec.vol, size=n)

    if spec.vol_cluster:
        out = np.empty(n)
        prev_abs = spec.vol
        for i in range(n):
            local_vol = spec.vol * (1 + 0.7 * prev_abs / spec.vol)
            out[i] = rng.normal(spec.drift, local_vol)
            prev_abs = abs(out[i])
        base = out

    if spec.mean_revert:
        out = np.empty(n)
        level = 0.0
        for i in range(n):
            level += -0.3 * level + rng.normal(0.0, spec.vol)
            out[i] = level * 0.5
        base = out

    if spec.jump_prob > 0:
        jumps = rng.random(n) < spec.jump_prob
        jump_sizes = rng.normal(spec.jump_mean, spec.jump_std, size=n)
        base = base + jumps * jump_sizes

    # Blend in a shared "market factor" so assets are correlated like real crypto.
    return 0.6 * base + 0.4 * market_factor[:n]


def generate_regime_labels(days: int, regime_plan: list[RegimeSpec] | None = None) -> pd.Series:
    plan = regime_plan or default_regime_plan(days)
    labels: list[str] = []
    for spec in plan:
        labels += [spec.name] * spec.days
    labels = labels[:days]
    while len(labels) < days:
        labels.append(plan[-1].name)
    dates = pd.date_range(start=START_DATE, periods=days, freq="D")
    return pd.Series(labels, index=dates, name="regime")


def generate_multi_regime_ohlcv(
    symbols: list[str],
    days: int = 730,
    seed: int = 42,
    regime_plan: list[RegimeSpec] | None = None,
) -> tuple[dict[str, pd.DataFrame], pd.Series]:
    """Generate `days` of daily OHLCV for each symbol plus a regime-label series.

    Returns (data, regime_labels) where data[symbol] is a DataFrame indexed by
    date with columns open/high/low/close/volume.
    """
    plan = regime_plan or default_regime_plan(days)
    total = sum(r.days for r in plan)
    days = min(days, total)

    market_rng = np.random.default_rng(seed)
    market_factor = market_rng.normal(0.0, 0.015, size=total)

    data: dict[str, pd.DataFrame] = {}
    dates = pd.date_range(start=START_DATE, periods=days, freq="D")

    for symbol in symbols:
        rng = np.random.default_rng(_symbol_seed(seed, symbol))
        returns = np.empty(total)
        idx = 0
        for spec in plan:
            n = spec.days
            seg_market = market_factor[idx : idx + n]
            returns[idx : idx + n] = _regime_returns(spec, n, rng, seg_market)
            idx += n
        returns = returns[:days]

        base_price = BASE_PRICES.get(symbol, 10.0)
        closes = base_price * 0.5 * np.exp(np.cumsum(returns))

        opens = np.empty(days)
        opens[0] = closes[0] / np.exp(returns[0])
        opens[1:] = closes[:-1]

        intraday_vol = np.abs(returns) * 0.6 + 0.005
        rand_hi = rng.random(days)
        rand_lo = rng.random(days)
        highs = np.maximum(opens, closes) * (1 + intraday_vol * (0.2 + 0.8 * rand_hi))
        lows = np.minimum(opens, closes) * (1 - intraday_vol * (0.2 + 0.8 * rand_lo))
        # Guard against any floating point inversion.
        highs = np.maximum(highs, np.maximum(opens, closes))
        lows = np.minimum(lows, np.minimum(opens, closes))

        volumes = np.exp(rng.normal(15.0, 0.3, size=days)) * (1 + np.abs(returns) * 10)

        data[symbol] = pd.DataFrame(
            {
                "open": opens,
                "high": highs,
                "low": lows,
                "close": closes,
                "volume": volumes,
            },
            index=dates,
        )

    regime_labels = generate_regime_labels(days, plan)
    return data, regime_labels


def write_csvs(data: dict[str, pd.DataFrame], regime_labels: pd.Series, out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    for symbol, df in data.items():
        df.to_csv(os.path.join(out_dir, f"{symbol}.csv"))
    regime_labels.to_frame().to_csv(os.path.join(out_dir, "regimes.csv"))
