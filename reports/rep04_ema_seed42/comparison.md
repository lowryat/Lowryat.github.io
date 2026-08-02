# Backtest Comparison Report: 4 seed42 ema risk2.5pct

| Strategy | Total Return | CAGR (equiv) | Sharpe | Sortino | Max DD | Max Daily DD | Max Weekly DD | CB Trips | Win Rate | Avg R | Expectancy (R) | Max Consec Loss | # Trades | Final Equity |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ema_atr_trend | 7.04% | 3.46% | 0.62 | 0.62 | 7.57% | 1.42% | 2.53% | 0 | 25.93% | 0.19 | 0.19 | 5 | 27 | $10,703.89 |

## Per-Regime Breakdown (mean daily return %)

| Strategy | bull | choppy | high_vol_cluster | crash | bear | recovery |
|---|---|---|---|---|---|---|
| ema_atr_trend | 0.056% | -0.003% | -0.039% | 0.000% | 0.000% | -0.004% |

## Circuit Breaker Trips by Regime

| Strategy | bull | choppy | high_vol_cluster | crash | bear | recovery | Total |
|---|---|---|---|---|---|---|---|
| ema_atr_trend | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Verdict

Single-bar drawdowns can briefly exceed the configured limit on daily bars (overnight gaps / jump moves) -- the breaker still halts further entries for the rest of that day/week. The check below flags strategies with **negative expectancy** or **zero trade activity**, which matter more than a one-bar overshoot for daily data.

- **ema_atr_trend**: OK -- expectancy 0.19R over 27 trades, max daily DD 1.42%, max weekly DD 2.53%.
