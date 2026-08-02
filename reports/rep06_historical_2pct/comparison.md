# Backtest Comparison Report: historical_2022_2024_2pct

| Strategy | Total Return | CAGR (equiv) | Sharpe | Sortino | Max DD | Max Daily DD | Max Weekly DD | CB Trips | Win Rate | Avg R | Expectancy (R) | Max Consec Loss | # Trades | Final Equity |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ema_atr_trend | 111.47% | 54.43% | 6.82 | 8.00 | 4.18% | 1.20% | 2.62% | 0 | 66.67% | 6.44 | 6.44 | 1 | 9 | $21,147.13 |
| donchian_breakout | 257.38% | 109.40% | 7.61 | 12.03 | 8.11% | 1.27% | 4.10% | 0 | 83.33% | 5.23 | 5.23 | 2 | 18 | $35,738.35 |
| momentum_regime | 234.66% | 101.57% | 9.15 | 16.35 | 2.78% | 1.13% | 2.49% | 0 | 78.57% | 2.96 | 2.96 | 3 | 28 | $33,466.15 |
| dual_momentum_adaptive | 23.64% | 13.10% | 3.53 | 1.99 | 2.77% | 1.17% | 2.77% | 0 | 55.56% | 1.76 | 1.76 | 3 | 9 | $12,363.61 |

## Per-Regime Breakdown (mean daily return %)

| Strategy | choppy | bull | bear | crash | high_vol_cluster |
|---|---|---|---|---|---|
| ema_atr_trend | -0.001% | 0.323% | 0.000% | 0.006% | -0.030% |
| donchian_breakout | -0.015% | 0.448% | -0.014% | 0.073% | 0.343% |
| momentum_regime | 0.004% | 0.388% | 0.002% | 0.000% | 0.460% |
| dual_momentum_adaptive | 0.004% | 0.096% | 0.000% | 0.000% | -0.036% |

## Circuit Breaker Trips by Regime

| Strategy | choppy | bull | bear | crash | high_vol_cluster | Total |
|---|---|---|---|---|---|---|
| ema_atr_trend | 0 | 0 | 0 | 0 | 0 | 0 |
| donchian_breakout | 0 | 0 | 0 | 0 | 0 | 0 |
| momentum_regime | 0 | 0 | 0 | 0 | 0 | 0 |
| dual_momentum_adaptive | 0 | 0 | 0 | 0 | 0 | 0 |

## Verdict

Single-bar drawdowns can briefly exceed the configured limit on daily bars (overnight gaps / jump moves) -- the breaker still halts further entries for the rest of that day/week. The check below flags strategies with **negative expectancy** or **zero trade activity**, which matter more than a one-bar overshoot for daily data.

- **ema_atr_trend**: OK -- expectancy 6.44R over 9 trades, max daily DD 1.20%, max weekly DD 2.62%.
- **donchian_breakout**: OK -- expectancy 5.23R over 18 trades, max daily DD 1.27%, max weekly DD 4.10%.
- **momentum_regime**: OK -- expectancy 2.96R over 28 trades, max daily DD 1.13%, max weekly DD 2.49%.
- **dual_momentum_adaptive**: OK -- expectancy 1.76R over 9 trades, max daily DD 1.17%, max weekly DD 2.77%.
