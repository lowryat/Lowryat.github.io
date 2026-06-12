# Final Summary: Strategy Selection (Reps 0-4)

## TL;DR

**Default strategy: `ema_atr_trend`** (EMA cross + EMA(100) regime filter + ATR
chandelier exit) **at `risk_per_trade_pct = 0.02`** (2% of equity risked per
trade). This is now frozen as `DEFAULT_STRATEGY` / `DEFAULT_RISK_CONFIG` in
`tradingbot/config.py` and is the default used by `tradingbot.live`.

It was the only strategy that was:
- **Profitable across all three tested seeds** (42, 7, 99)
- **Never tripped the 3%/5% circuit breaker** in any seed
- **Stayed comfortably under the 5% weekly drawdown limit** even at 2% risk
  per trade (max observed weekly DD: 4.01%)

## Methodology

Each rep runs all four candidate strategies (or a subset, where noted)
against 730 days of synthetic multi-regime OHLCV data
(`tradingbot.data.synthetic.generate_multi_regime_ohlcv`), covering bull,
choppy, high-vol-cluster, crash, bear, and recovery regimes with a shared
cross-asset "market factor" across BTC/ETH/SOL/AVAX.

- **Rep 0**: built the framework (risk manager, strategies, backtester,
  metrics, paper broker) with unit tests (`pytest tests/ -v`), including
  explicit tests proving the 3% daily / 5% weekly circuit breakers trip and
  reset correctly.
- **Rep 1**: baseline run, seed 42, default `RiskConfig` (`risk_per_trade_pct
  = 0.01`). All four strategies run end-to-end without error; established
  baseline metrics.
- **Rep 2**: parameter tuning experiments for `donchian_breakout` and
  `momentum_regime`. `momentum_regime` got materially worse under the tuned
  params (-9.75% vs -1.10% baseline), so the tuning direction was abandoned;
  defaults were kept for Rep 3+.
- **Rep 3**: re-ran all four strategies across seeds 42, 7, and 99 at
  `risk_per_trade_pct = 0.02` to test robustness to the random seed.
- **Rep 4**: focused robustness checks on the two strongest/most volatile
  candidates (`ema_atr_trend` at 2% risk, `donchian_breakout` at a reduced 1%
  risk after a weekly-DD-limit breach was found at 2%).

## Results

### `ema_atr_trend` @ `risk_per_trade_pct = 0.02` (chosen default)

| Seed | Total Return | Sharpe | Max Daily DD | Max Weekly DD | CB Trips | Win Rate | Expectancy (R) | # Trades |
|---|---|---|---|---|---|---|---|---|
| 42 | +7.27% | 0.64 | 1.40% | 2.48% | 0 | 25.93% | 0.19 | 27 |
| 7  | +8.16% | 0.53 | 2.21% | 3.66% | 0 | 35.48% | 0.21 | 31 |
| 99 | +7.93% | 0.57 | 1.89% | 4.01% | 0 | 27.27% | 0.09 | 33 |

Positive expectancy, positive return, and **zero circuit breaker trips** in
every seed. The worst single-week drawdown (4.01%, seed 99) stayed under the
5% hard limit with headroom.

### `dual_momentum_adaptive` (secondary/complementary candidate)

| Seed | Total Return | Sharpe | Max Weekly DD | CB Trips | Expectancy (R) |
|---|---|---|---|---|---|
| 42 | +10.40% | 0.67 | 3.20% | 0 | 0.13 |
| 7  | +0.65%  | 0.08 | 3.19% | 0 | 0.03 |
| 99 | +15.16% | 0.76 | 3.55% | 1 | 0.08 |

Positive in all three seeds and the best single-seed returns of any strategy,
but much higher variance (0.65% to 15.16%) and one CB trip (seed 99, within
the expected "weekly halt during a high-vol/crash regime" behavior, not a
silent breach). Worth running alongside `ema_atr_trend` for diversification,
but not robust enough on its own to be the sole default.

### `donchian_breakout` (high-variance, limit-breach risk at >1% risk)

At 2% risk per trade (Rep 3), seed 99 produced a **max weekly drawdown of
6.63%** -- a real breach of the 5% hard limit (not just a single-bar gap
overshoot), even though the breaker itself fired correctly and halted further
entries. At a reduced 1% risk per trade (Rep 4):

| Seed | Total Return | Max Weekly DD | CB Trips | Expectancy (R) |
|---|---|---|---|---|
| 42 | -2.95%  | 2.47% | 0 | -0.05 |
| 7  | +29.46% | 4.06% | 1 | 0.60 |
| 99 | +15.25% | 3.41% | 0 | 0.24 |

Weekly DD comes back under the 5% limit at 1% risk, but seed 42 is now
negative (-2.95%, non-positive expectancy). High variance and a tendency to
overshoot the weekly limit at higher risk make this strategy unsuitable as
the default; **if used, cap it at `risk_per_trade_pct <= 0.01`**.

### `momentum_regime` (inconsistent across seeds)

Mixed results across seeds 42/7/99 (-2.04% / +10.71% / +9.73% at 2% risk in
Rep 3) with no clear edge over `ema_atr_trend` and no robustness improvement
found during Rep 2 tuning. Not selected as a default.

## Decision

`ema_atr_trend` at `risk_per_trade_pct = 0.02` is frozen as
`DEFAULT_STRATEGY` / `DEFAULT_RISK_CONFIG` in `tradingbot/config.py` and used
by `python -m tradingbot.live` (and the daily GitHub Actions automation). All
other `RiskConfig` defaults (3% daily / 5% weekly circuit breakers, ATR-based
sizing and trailing stops, position/exposure caps) are unchanged from
Rep 0.

## Caveats

- All results above are on **synthetic** data. Synthetic regimes are designed
  to be representative (bull/choppy/high-vol/crash/bear/recovery) but are not
  real market history -- they do not capture every real-world failure mode
  (e.g. exchange outages, slippage spikes, correlated black-swan events across
  all majors simultaneously).
- Only three seeds were tested. This is enough to rule out "this only works
  on one lucky random path" but is not a statistical guarantee of future
  performance.
- The circuit breaker can still be overshot **within a single bar** on daily
  data (gap risk / jump moves) -- the breaker halts further entries for the
  rest of that day/week once triggered, but cannot prevent the loss that
  already happened on that bar. This is expected behavior, not a bug, and is
  why position sizing (2% risk per trade, ATR-based stops) matters as the
  first line of defense, with the drawdown breaker as a second line.
- See `reports/README.md` for the full disclaimer on synthetic data, paper
  vs. live trading, and risk of loss.
