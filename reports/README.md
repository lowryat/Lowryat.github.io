# Backtest Reports

This directory contains the iterative "rep" (repetition/iteration) reports
produced while developing and tuning the strategies in `tradingbot/`.

## Layout

- `repNN/` (and `repNN_<label>/`) -- one backtest run's output:
  - `comparison.md` -- per-strategy metrics table, per-regime breakdown, and
    circuit-breaker trip log with a verdict for each strategy.
  - `equity_<strategy>.csv` -- daily equity curve (equity, drawdowns, regime,
    halted flags, position count) for that strategy.
  - `trades_<strategy>.csv` -- closed-trade log (entry/exit price, qty,
    R-multiple, P&L, exit reason) for that strategy.
- `final/summary.md` -- the consolidated conclusion across all reps: which
  strategy and risk settings were selected as the default, and why.

## Reproducing a rep

```bash
# Generate synthetic OHLCV data for a given seed
python -m tradingbot.gendata --symbols BTC,ETH,SOL,AVAX --days 730 --seed 42 --out data/synthetic/repNN

# Run all strategies against it
python -m tradingbot.backtest --strategy all --data data/synthetic/repNN --rep N --out reports/repNN
```

Pass `--risk-per-trade-pct` and/or `--params '{"strategy_name": {...}}'` to
override `RiskConfig` defaults or per-strategy parameters for a given run.

## Rep history

- **Rep 0**: framework + unit tests (`pytest tests/ -v`), including explicit
  tests that the 3% daily / 5% weekly circuit breakers trip and reset
  correctly.
- **Rep 1** (`rep01/`): baseline run, seed 42, default risk config (1% risk
  per trade).
- **Rep 2** (`rep02/`): parameter tuning experiments for `donchian_breakout`
  and `momentum_regime`.
- **Rep 3** (`rep03_seed*/`): all four strategies re-run across seeds 42, 7,
  99 at 2% risk per trade to check robustness to the random seed.
- **Rep 4** (`rep04_*`): focused robustness checks on `ema_atr_trend` (2%
  risk) and `donchian_breakout` (reduced to 1% risk after a weekly
  drawdown-limit breach was found at 2%).

See `final/summary.md` for the full writeup and the strategy/config that was
ultimately selected as the default for `tradingbot.live`.

## Disclaimer

This is a **research and educational framework**, not financial advice.

- All backtests in this directory use **synthetic** data
  (`tradingbot.data.synthetic`), generated from seeded random walks with
  multiple market "regimes" (bull/choppy/high-vol/crash/bear/recovery). It is
  designed to be representative but is **not real market history**.
- **No real funds are at risk** from this code as committed. `tradingbot.live`
  defaults to an in-memory `PaperSimBroker`. The Alpaca paper-trading path
  (`--broker alpaca-paper`) requires the user to supply their own *paper*
  trading API keys (`ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY`) as repo
  secrets -- still simulated money, not real money.
- **Real-money live trading is intentionally not wired up anywhere in this
  repo.** Going from "paper trading works" to trading with real funds is a
  separate, deliberate step that the user must take themselves (different API
  keys, different broker configuration, careful review of live results
  first).
- **Past or synthetic backtest performance does not guarantee future
  results.** Markets change; strategies that worked on synthetic or
  historical data can fail on new data.
- **Cryptocurrency markets carry substantial risk of loss**, including total
  loss of capital, due to volatility, leverage, exchange/custody risk, and
  regulatory uncertainty. Never trade with money you cannot afford to lose,
  and never bypass the circuit breakers or risk limits in `RiskConfig`
  without understanding the consequences.
