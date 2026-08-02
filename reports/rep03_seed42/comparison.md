# Backtest Comparison Report: 3 seed42 risk2pct

| Strategy | Total Return | CAGR (equiv) | Sharpe | Sortino | Max DD | Max Daily DD | Max Weekly DD | CB Trips | Win Rate | Avg R | Expectancy (R) | Max Consec Loss | # Trades | Final Equity |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ema_atr_trend | 7.27% | 3.57% | 0.64 | 0.64 | 7.53% | 1.40% | 2.48% | 0 | 25.93% | 0.19 | 0.19 | 5 | 27 | $10,726.53 |
| donchian_breakout | -1.03% | -0.52% | -0.01 | -0.01 | 12.35% | 2.48% | 3.73% | 0 | 35.85% | -0.05 | -0.05 | 6 | 53 | $9,896.80 |
| momentum_regime | -2.04% | -1.03% | -0.09 | -0.11 | 9.36% | 1.87% | 3.04% | 0 | 34.57% | -0.01 | -0.01 | 9 | 81 | $9,795.70 |
| dual_momentum_adaptive | 10.40% | 5.08% | 0.67 | 0.77 | 10.12% | 2.00% | 3.20% | 0 | 43.08% | 0.13 | 0.13 | 7 | 65 | $11,039.58 |

## Per-Regime Breakdown (mean daily return %)

| Strategy | bull | choppy | high_vol_cluster | crash | bear | recovery |
|---|---|---|---|---|---|---|
| ema_atr_trend | 0.057% | -0.003% | -0.039% | 0.000% | 0.000% | -0.004% |
| donchian_breakout | 0.022% | -0.011% | -0.056% | 0.000% | 0.033% | -0.010% |
| momentum_regime | -0.034% | 0.063% | -0.029% | 0.000% | -0.016% | 0.007% |
| dual_momentum_adaptive | -0.007% | 0.086% | -0.067% | 0.000% | 0.000% | 0.022% |

## Circuit Breaker Trips by Regime

| Strategy | bull | choppy | high_vol_cluster | crash | bear | recovery | Total |
|---|---|---|---|---|---|---|---|
| ema_atr_trend | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| donchian_breakout | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| momentum_regime | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| dual_momentum_adaptive | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Verdict

Single-bar drawdowns can briefly exceed the configured limit on daily bars (overnight gaps / jump moves) -- the breaker still halts further entries for the rest of that day/week. The check below flags strategies with **negative expectancy** or **zero trade activity**, which matter more than a one-bar overshoot for daily data.

- **ema_atr_trend**: OK -- expectancy 0.19R over 27 trades, max daily DD 1.40%, max weekly DD 2.48%.
- **donchian_breakout**: ⚠ non-positive expectancy.
- **momentum_regime**: ⚠ non-positive expectancy.
- **dual_momentum_adaptive**: OK -- expectancy 0.13R over 65 trades, max daily DD 2.00%, max weekly DD 3.20%.
