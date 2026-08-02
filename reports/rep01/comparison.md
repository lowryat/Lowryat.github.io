# Backtest Comparison Report: 1

| Strategy | Total Return | CAGR (equiv) | Sharpe | Sortino | Max DD | Max Daily DD | Max Weekly DD | CB Trips | Win Rate | Avg R | Expectancy (R) | Max Consec Loss | # Trades | Final Equity |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ema_atr_trend | 5.03% | 2.49% | 0.69 | 0.73 | 4.81% | 0.79% | 1.40% | 0 | 25.93% | 0.19 | 0.19 | 5 | 27 | $10,503.08 |
| donchian_breakout | -2.95% | -1.49% | -0.25 | -0.29 | 9.61% | 1.43% | 2.47% | 0 | 35.85% | -0.05 | -0.05 | 6 | 53 | $9,704.77 |
| momentum_regime | -1.10% | -0.55% | -0.08 | -0.10 | 5.62% | 1.29% | 2.00% | 0 | 34.57% | -0.01 | -0.01 | 9 | 81 | $9,890.15 |
| dual_momentum_adaptive | 8.61% | 4.22% | 0.85 | 1.01 | 6.06% | 1.49% | 2.79% | 0 | 43.08% | 0.13 | 0.13 | 7 | 65 | $10,860.84 |

## Per-Regime Breakdown (mean daily return %)

| Strategy | bull | choppy | high_vol_cluster | crash | bear | recovery |
|---|---|---|---|---|---|---|
| ema_atr_trend | 0.039% | -0.002% | -0.025% | 0.000% | 0.000% | -0.003% |
| donchian_breakout | 0.011% | -0.015% | -0.040% | 0.000% | 0.019% | -0.010% |
| momentum_regime | -0.020% | 0.054% | -0.017% | 0.000% | -0.010% | 0.002% |
| dual_momentum_adaptive | 0.001% | 0.072% | -0.033% | 0.000% | 0.000% | 0.013% |

## Circuit Breaker Trips by Regime

| Strategy | bull | choppy | high_vol_cluster | crash | bear | recovery | Total |
|---|---|---|---|---|---|---|---|
| ema_atr_trend | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| donchian_breakout | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| momentum_regime | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| dual_momentum_adaptive | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Verdict

Single-bar drawdowns can briefly exceed the configured limit on daily bars (overnight gaps / jump moves) -- the breaker still halts further entries for the rest of that day/week. The check below flags strategies with **negative expectancy** or **zero trade activity**, which matter more than a one-bar overshoot for daily data.

- **ema_atr_trend**: OK -- expectancy 0.19R over 27 trades, max daily DD 0.79%, max weekly DD 1.40%.
- **donchian_breakout**: ⚠ non-positive expectancy.
- **momentum_regime**: ⚠ non-positive expectancy.
- **dual_momentum_adaptive**: OK -- expectancy 0.13R over 65 trades, max daily DD 1.49%, max weekly DD 2.79%.
