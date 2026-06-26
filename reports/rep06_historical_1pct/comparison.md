# Backtest Comparison Report: historical_2022_2024_1pct

| Strategy | Total Return | CAGR (equiv) | Sharpe | Sortino | Max DD | Max Daily DD | Max Weekly DD | CB Trips | Win Rate | Avg R | Expectancy (R) | Max Consec Loss | # Trades | Final Equity |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ema_atr_trend | 59.22% | 30.98% | 6.82 | 7.72 | 2.61% | 0.73% | 1.34% | 0 | 66.67% | 6.44 | 6.44 | 1 | 9 | $15,921.68 |
| donchian_breakout | 117.48% | 56.96% | 7.65 | 11.95 | 5.17% | 0.85% | 2.41% | 0 | 83.33% | 5.23 | 5.23 | 2 | 18 | $21,747.64 |
| momentum_regime | 107.35% | 52.68% | 9.34 | 17.05 | 1.57% | 0.67% | 1.41% | 0 | 78.57% | 2.96 | 2.96 | 3 | 28 | $20,735.17 |
| dual_momentum_adaptive | 16.11% | 9.05% | 3.78 | 2.47 | 1.76% | 0.68% | 1.76% | 0 | 55.56% | 1.76 | 1.76 | 3 | 9 | $11,610.66 |

## Per-Regime Breakdown (mean daily return %)

| Strategy | choppy | bull | bear | crash | high_vol_cluster |
|---|---|---|---|---|---|
| ema_atr_trend | -0.002% | 0.203% | 0.000% | 0.003% | -0.024% |
| donchian_breakout | -0.008% | 0.276% | -0.007% | 0.038% | 0.195% |
| momentum_regime | 0.003% | 0.237% | 0.002% | 0.000% | 0.265% |
| dual_momentum_adaptive | 0.003% | 0.067% | 0.000% | 0.000% | -0.022% |

## Circuit Breaker Trips by Regime

| Strategy | choppy | bull | bear | crash | high_vol_cluster | Total |
|---|---|---|---|---|---|---|
| ema_atr_trend | 0 | 0 | 0 | 0 | 0 | 0 |
| donchian_breakout | 0 | 0 | 0 | 0 | 0 | 0 |
| momentum_regime | 0 | 0 | 0 | 0 | 0 | 0 |
| dual_momentum_adaptive | 0 | 0 | 0 | 0 | 0 | 0 |

## Verdict

Single-bar drawdowns can briefly exceed the configured limit on daily bars (overnight gaps / jump moves) -- the breaker still halts further entries for the rest of that day/week. The check below flags strategies with **negative expectancy** or **zero trade activity**, which matter more than a one-bar overshoot for daily data.

- **ema_atr_trend**: OK -- expectancy 6.44R over 9 trades, max daily DD 0.73%, max weekly DD 1.34%.
- **donchian_breakout**: OK -- expectancy 5.23R over 18 trades, max daily DD 0.85%, max weekly DD 2.41%.
- **momentum_regime**: OK -- expectancy 2.96R over 28 trades, max daily DD 0.67%, max weekly DD 1.41%.
- **dual_momentum_adaptive**: OK -- expectancy 1.76R over 9 trades, max daily DD 0.68%, max weekly DD 1.76%.
