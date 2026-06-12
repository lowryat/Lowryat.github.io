# Backtest Comparison Report: 2 (seed42, tuned)

| Strategy | Total Return | CAGR (equiv) | Sharpe | Sortino | Max DD | Max Daily DD | Max Weekly DD | CB Trips | Win Rate | Avg R | Expectancy (R) | Max Consec Loss | # Trades | Final Equity |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ema_atr_trend | 5.03% | 2.49% | 0.69 | 0.73 | 4.81% | 0.79% | 1.40% | 0 | 25.93% | 0.19 | 0.19 | 5 | 27 | $10,503.08 |
| donchian_breakout | -1.33% | -0.67% | -0.11 | -0.12 | 7.96% | 1.26% | 2.21% | 0 | 32.56% | -0.03 | -0.03 | 7 | 43 | $9,867.17 |
| momentum_regime | -9.75% | -5.00% | -1.19 | -1.32 | 12.15% | 1.08% | 1.91% | 0 | 23.81% | -0.16 | -0.16 | 14 | 63 | $9,025.47 |
| dual_momentum_adaptive | 8.61% | 4.22% | 0.85 | 1.01 | 6.06% | 1.49% | 2.79% | 0 | 43.08% | 0.13 | 0.13 | 7 | 65 | $10,860.84 |

## Per-Regime Breakdown (mean daily return %)

| Strategy | bull | choppy | high_vol_cluster | crash | bear | recovery |
|---|---|---|---|---|---|---|
| ema_atr_trend | 0.039% | -0.002% | -0.025% | 0.000% | 0.000% | -0.003% |
| donchian_breakout | 0.028% | -0.023% | -0.040% | 0.000% | 0.004% | -0.010% |
| momentum_regime | -0.025% | -0.012% | -0.007% | 0.000% | -0.004% | -0.012% |
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
