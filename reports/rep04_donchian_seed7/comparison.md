# Backtest Comparison Report: 4 seed7 donchian risk1pct

| Strategy | Total Return | CAGR (equiv) | Sharpe | Sortino | Max DD | Max Daily DD | Max Weekly DD | CB Trips | Win Rate | Avg R | Expectancy (R) | Max Consec Loss | # Trades | Final Equity |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| donchian_breakout | 29.46% | 13.80% | 1.18 | 2.06 | 7.73% | 4.06% | 4.06% | 1 | 37.50% | 0.60 | 0.60 | 6 | 48 | $12,946.17 |

## Per-Regime Breakdown (mean daily return %)

| Strategy | bull | choppy | high_vol_cluster | crash | bear | recovery |
|---|---|---|---|---|---|---|
| donchian_breakout | -0.039% | 0.132% | 0.715% | 0.000% | -0.009% | 0.013% |

## Circuit Breaker Trips by Regime

| Strategy | bull | choppy | high_vol_cluster | crash | bear | recovery | Total |
|---|---|---|---|---|---|---|---|
| donchian_breakout | 0 | 0 | 1 | 0 | 0 | 0 | 1 |

## Verdict

Single-bar drawdowns can briefly exceed the configured limit on daily bars (overnight gaps / jump moves) -- the breaker still halts further entries for the rest of that day/week. The check below flags strategies with **negative expectancy** or **zero trade activity**, which matter more than a one-bar overshoot for daily data.

- **donchian_breakout**: OK -- expectancy 0.60R over 48 trades, max daily DD 4.06%, max weekly DD 4.06%.
