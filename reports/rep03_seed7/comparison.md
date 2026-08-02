# Backtest Comparison Report: 3 seed7 risk2pct

| Strategy | Total Return | CAGR (equiv) | Sharpe | Sortino | Max DD | Max Daily DD | Max Weekly DD | CB Trips | Win Rate | Avg R | Expectancy (R) | Max Consec Loss | # Trades | Final Equity |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ema_atr_trend | 8.16% | 4.00% | 0.53 | 0.59 | 8.42% | 2.21% | 3.66% | 0 | 35.48% | 0.21 | 0.21 | 6 | 31 | $10,815.77 |
| donchian_breakout | 33.16% | 15.42% | 0.99 | 1.67 | 13.04% | 4.90% | 4.90% | 1 | 37.50% | 0.60 | 0.60 | 6 | 48 | $13,316.31 |
| momentum_regime | 10.71% | 5.22% | 0.64 | 0.74 | 7.23% | 2.10% | 3.20% | 0 | 29.03% | 0.14 | 0.14 | 9 | 62 | $11,070.68 |
| dual_momentum_adaptive | 0.65% | 0.32% | 0.08 | 0.09 | 11.72% | 2.00% | 3.19% | 0 | 29.51% | 0.03 | 0.03 | 7 | 61 | $10,064.53 |

## Per-Regime Breakdown (mean daily return %)

| Strategy | bull | choppy | high_vol_cluster | crash | bear | recovery |
|---|---|---|---|---|---|---|
| ema_atr_trend | -0.009% | 0.085% | 0.117% | 0.000% | -0.024% | 0.008% |
| donchian_breakout | -0.068% | 0.154% | 0.930% | 0.000% | -0.015% | 0.018% |
| momentum_regime | -0.020% | 0.072% | 0.081% | 0.000% | -0.047% | 0.028% |
| dual_momentum_adaptive | -0.031% | 0.128% | -0.072% | -0.020% | -0.021% | 0.008% |

## Circuit Breaker Trips by Regime

| Strategy | bull | choppy | high_vol_cluster | crash | bear | recovery | Total |
|---|---|---|---|---|---|---|---|
| ema_atr_trend | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| donchian_breakout | 0 | 0 | 1 | 0 | 0 | 0 | 1 |
| momentum_regime | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| dual_momentum_adaptive | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Verdict

Single-bar drawdowns can briefly exceed the configured limit on daily bars (overnight gaps / jump moves) -- the breaker still halts further entries for the rest of that day/week. The check below flags strategies with **negative expectancy** or **zero trade activity**, which matter more than a one-bar overshoot for daily data.

- **ema_atr_trend**: OK -- expectancy 0.21R over 31 trades, max daily DD 2.21%, max weekly DD 3.66%.
- **donchian_breakout**: ⚠ daily DD reached 4.9% (>1.5x limit, large gap).
- **momentum_regime**: OK -- expectancy 0.14R over 62 trades, max daily DD 2.10%, max weekly DD 3.20%.
- **dual_momentum_adaptive**: OK -- expectancy 0.03R over 61 trades, max daily DD 2.00%, max weekly DD 3.19%.
