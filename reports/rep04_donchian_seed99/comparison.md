# Backtest Comparison Report: 4 seed99 donchian risk1pct

| Strategy | Total Return | CAGR (equiv) | Sharpe | Sortino | Max DD | Max Daily DD | Max Weekly DD | CB Trips | Win Rate | Avg R | Expectancy (R) | Max Consec Loss | # Trades | Final Equity |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| donchian_breakout | 15.25% | 7.36% | 1.15 | 1.42 | 8.91% | 1.50% | 3.41% | 0 | 41.82% | 0.24 | 0.24 | 4 | 55 | $11,524.86 |

## Per-Regime Breakdown (mean daily return %)

| Strategy | bull | choppy | high_vol_cluster | crash | bear | recovery |
|---|---|---|---|---|---|---|
| donchian_breakout | 0.018% | 0.092% | -0.068% | -0.054% | -0.029% | 0.027% |

## Circuit Breaker Trips by Regime

| Strategy | bull | choppy | high_vol_cluster | crash | bear | recovery | Total |
|---|---|---|---|---|---|---|---|
| donchian_breakout | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Verdict

Single-bar drawdowns can briefly exceed the configured limit on daily bars (overnight gaps / jump moves) -- the breaker still halts further entries for the rest of that day/week. The check below flags strategies with **negative expectancy** or **zero trade activity**, which matter more than a one-bar overshoot for daily data.

- **donchian_breakout**: OK -- expectancy 0.24R over 55 trades, max daily DD 1.50%, max weekly DD 3.41%.
