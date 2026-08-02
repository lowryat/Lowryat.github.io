# Backtest Comparison Report: 4 seed42 donchian risk1pct

| Strategy | Total Return | CAGR (equiv) | Sharpe | Sortino | Max DD | Max Daily DD | Max Weekly DD | CB Trips | Win Rate | Avg R | Expectancy (R) | Max Consec Loss | # Trades | Final Equity |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| donchian_breakout | -2.95% | -1.49% | -0.25 | -0.29 | 9.61% | 1.43% | 2.47% | 0 | 35.85% | -0.05 | -0.05 | 6 | 53 | $9,704.77 |

## Per-Regime Breakdown (mean daily return %)

| Strategy | bull | choppy | high_vol_cluster | crash | bear | recovery |
|---|---|---|---|---|---|---|
| donchian_breakout | 0.011% | -0.015% | -0.040% | 0.000% | 0.019% | -0.010% |

## Circuit Breaker Trips by Regime

| Strategy | bull | choppy | high_vol_cluster | crash | bear | recovery | Total |
|---|---|---|---|---|---|---|---|
| donchian_breakout | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Verdict

Single-bar drawdowns can briefly exceed the configured limit on daily bars (overnight gaps / jump moves) -- the breaker still halts further entries for the rest of that day/week. The check below flags strategies with **negative expectancy** or **zero trade activity**, which matter more than a one-bar overshoot for daily data.

- **donchian_breakout**: ⚠ non-positive expectancy.
