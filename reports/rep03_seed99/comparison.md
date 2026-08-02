# Backtest Comparison Report: 3 seed99 risk2pct

| Strategy | Total Return | CAGR (equiv) | Sharpe | Sortino | Max DD | Max Daily DD | Max Weekly DD | CB Trips | Win Rate | Avg R | Expectancy (R) | Max Consec Loss | # Trades | Final Equity |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ema_atr_trend | 7.93% | 3.89% | 0.57 | 0.61 | 10.53% | 1.89% | 4.01% | 0 | 27.27% | 0.09 | 0.09 | 7 | 33 | $10,792.51 |
| donchian_breakout | 25.23% | 11.92% | 1.11 | 1.37 | 14.83% | 2.98% | 6.63% | 1 | 41.82% | 0.25 | 0.25 | 4 | 55 | $12,522.87 |
| momentum_regime | 9.73% | 4.76% | 0.63 | 0.75 | 7.95% | 2.05% | 2.97% | 0 | 40.58% | 0.02 | 0.02 | 8 | 69 | $10,972.74 |
| dual_momentum_adaptive | 15.16% | 7.32% | 0.76 | 0.86 | 7.88% | 3.14% | 3.55% | 1 | 35.00% | 0.08 | 0.08 | 5 | 80 | $11,515.95 |

## Per-Regime Breakdown (mean daily return %)

| Strategy | bull | choppy | high_vol_cluster | crash | bear | recovery |
|---|---|---|---|---|---|---|
| ema_atr_trend | 0.007% | 0.127% | -0.106% | 0.000% | 0.000% | 0.006% |
| donchian_breakout | 0.030% | 0.132% | -0.052% | -0.108% | -0.056% | 0.044% |
| momentum_regime | 0.032% | -0.003% | -0.041% | 0.000% | -0.009% | 0.016% |
| dual_momentum_adaptive | 0.030% | 0.001% | -0.091% | -0.080% | -0.013% | 0.037% |

## Circuit Breaker Trips by Regime

| Strategy | bull | choppy | high_vol_cluster | crash | bear | recovery | Total |
|---|---|---|---|---|---|---|---|
| ema_atr_trend | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| donchian_breakout | 0 | 0 | 1 | 0 | 0 | 0 | 1 |
| momentum_regime | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| dual_momentum_adaptive | 0 | 0 | 1 | 0 | 0 | 0 | 1 |

## Verdict

Single-bar drawdowns can briefly exceed the configured limit on daily bars (overnight gaps / jump moves) -- the breaker still halts further entries for the rest of that day/week. The check below flags strategies with **negative expectancy** or **zero trade activity**, which matter more than a one-bar overshoot for daily data.

- **ema_atr_trend**: OK -- expectancy 0.09R over 33 trades, max daily DD 1.89%, max weekly DD 4.01%.
- **donchian_breakout**: OK -- expectancy 0.25R over 55 trades, max daily DD 2.98%, max weekly DD 6.63%.
- **momentum_regime**: OK -- expectancy 0.02R over 69 trades, max daily DD 2.05%, max weekly DD 2.97%.
- **dual_momentum_adaptive**: OK -- expectancy 0.08R over 80 trades, max daily DD 3.14%, max weekly DD 3.55%.
