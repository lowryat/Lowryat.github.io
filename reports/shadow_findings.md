# Live-Data Findings & Recommendations

**Data:** 250 real daily bars, 2026-01-30 → 2026-10-06, BTC/ETH/SOL/AVAX.
Simulated execution, 30bp/side costs. Three experiment rounds, 38 variant-runs.
Source data: `reports/shadow/`, `reports/shadow_experiments/`, `reports/shadow_safety/`.

---

## Read this before any number below

**One trade is 72–80% of total P&L.**

| | momentum_2pct_max2 | momentum_2pct |
|---|---|---|
| Net P&L | +$352.26 | +$286.60 |
| Best single trade | +$254.69 (SOL, Sep 6) | +$228.49 (SOL, Aug 28) |
| Share of total | **72%** | **80%** |
| P&L without it | +$97.57 | +$58.11 |
| Top 3 winners | 118% of total | 134% of total |

Top-3 exceeding 100% means every other trade is collectively negative. Both
variants' big winner is the same SOL move captured slightly differently — so the
entire 8-month result turns on **one market event**.

This is the expected shape of trend-following (a few large winners pay for many
small losses), so it is not evidence of a defect. But it does mean **this sample
cannot rank the variants.** The gap between +4.8% and +11.8% is one trade, not
skill. Treat every performance number below as a hypothesis, not a finding.

Drawdown is the exception: it is measured from hundreds of daily observations
rather than a handful of trades, so the risk findings are far more trustworthy
than the return findings. The recommendations are weighted accordingly.

---

## High confidence — act on these

### 1. Cap concurrent positions at 2 (currently 4)

| | max_positions=4 | max_positions=2 |
|---|---|---|
| Net | +8.46% | +11.81% |
| Profit factor | 2.21 | 3.63 |
| **Worst week** | **5.89% ✗ breach** | **3.87% ✓** |
| Trades | 26 | 18 |

Drawdown fell by a third and moved from breaching the 5% limit to comfortably
inside it. The return improvement is probably the SOL trade; **the drawdown
improvement is structural.**

Mechanism: BTC/ETH/SOL/AVAX are highly correlated. Holding four at once is not
diversification — it is 4× concentrated beta on one factor. Capping at two cuts
correlated exposure directly, and fewer trades means lower costs.

### 2. Drop to 1% risk per trade while gathering evidence

Halving risk halved drawdown, cleanly and predictably, across every variant —
confirming the ATR sizing math behaves as designed.

| Variant | 2% risk | 1% risk |
|---|---|---|
| momentum_regime | +8.46%, wk-DD 5.89% ✗ | +4.83%, wk-DD 3.18% ✓ |
| dual_momentum | +6.74%, wk-DD 3.56% | +6.12%, wk-DD 2.07% |

You are not trying to earn right now — you are trying to find out whether this
works. Halving risk buys a much larger safety margin for roughly half the return
on money that is not real anyway.

### 3. The 5% weekly limit is breached more often than the backtests implied

Of the 14 first-round variants, **7 breached** (5.22–6.11%). The circuit breaker
fired correctly every time; on daily bars it simply cannot act until after a gap.

The breaker is a backstop, not a guarantee. The controllable levers are position
size and concentration — recommendations 1 and 2 — not the breaker itself.
Combining them gets well clear: `dual_1pct_noeth` reached **2.07% worst week**,
under half the limit.

### 4. ETH is the weakest of the four

Only loss-making symbol: **−$86 over 14 trades**, against BTC +$367, SOL +$135,
AVAX +$28. Removing it improved drawdown in all three bots tested and improved
return in two. AVAX is nearly flat over 22 trades — a lot of churn and cost for
nothing; it is the next candidate to question.

---

## Rejected by the evidence

### Wider trailing stops do nothing

Only 4 of 77 trades exceeded +2R, so the asymmetric-payoff thesis looked
under-delivered. Widening the chandelier from 3× to 4× and 5× ATR produced:

| Variant | Δ net | Δ drawdown |
|---|---|---|
| momentum_trail4 / trail5 | −0.47pp (identical to each other) | none |
| dual_trail5 | **0.00pp — byte-identical** | none |
| donchian_trail4 | −0.15pp | CB trips 3 → 4 |

4× and 5× giving identical results proves **the trail is not binding.** Positions
are exited by signal flips and circuit breakers before the trail is ever reached.

So winners are not being cut short by the trailing stop. If you want to extend
winners, the place to look is the **signal-exit logic** — see below.

---

## Low confidence — interesting, do not act yet

### ema_atr_trend's regime filter looks too restrictive

| Variant | Net | Trades | Profit factor |
|---|---|---|---|
| ema_atr_trend (regime=100) | −4.23% | 8 | 0.55 |
| ema_loose_regime (regime=50) | +6.81% | 11 | 2.05 |
| ema_fast (8/24, regime=50) | +5.18% | 12 | 2.39 |

An 11-point swing from one parameter. But n goes from 8 to 11 trades — far too
few to conclude anything, and subject to the same single-trade problem.

What it does justify: **ema_atr_trend should not remain the frozen default.** It
is the worst live performer at profit factor 0.55, and it was selected on
synthetic data that evidently did not represent this market.

### Circuit-breaker exits are systematically profitable

| Bot | CB exits | P&L | Avg R |
|---|---|---|---|
| dual_momentum_adaptive | 6 | **+$359.85** | +1.52 |
| momentum_regime | 8 | +$147.99 | +0.43 |
| donchian_breakout | 9 | −$57.08 | −0.11 |

The breaker flattens *everything*, so when portfolio drawdown is driven by losses
in one position it also liquidates the winners. Those winners exit at positive R —
which is why CB exits look good — but they were closed to solve a problem they
were not causing.

**Worth building:** a breaker that closes losing positions first, re-checks
drawdown, and only then closes winners. Same hard limits, less value destroyed.
This is a genuine design improvement and is testable with the existing harness.

### dual_momentum's signal exits destroy value

Signal exits: **−$205 over 18 trades.** Stop and CB exits: **+$445 over 7.**
Its exit rule appears to be actively harmful. Combined with the trail finding
above, the exit logic — not the trail — is where the upside is being lost.

---

## Priority order

| # | Action | Confidence | Effort |
|---|---|---|---|
| 1 | **Fix the Alpaca credentials** | — | Low |
| 2 | Cap `max_positions` at 2 | High | Trivial |
| 3 | Run at 1% risk while evaluating | High | Trivial |
| 4 | Retire `ema_atr_trend` as the default | High | Trivial |
| 5 | Drop ETH; watch AVAX | Medium | Trivial |
| 6 | Build the "close losers first" breaker | Medium | Medium |
| 7 | Investigate signal-exit logic | Medium | Medium |
| 8 | Keep collecting — target 100+ trades | High | None |

**Item 1 is the real blocker.** Shadow trading cannot model fill quality, partial
fills, or spread at the moment of execution. Everything here assumes you get the
close price, and you will not. Until orders actually execute against a paper
account, the slippage assumption is unvalidated.

**Item 8 matters most for honesty.** At 77 trades with one dominating, nothing
here separates skill from luck. A trend-following system needs *hundreds* of
trades before win rate and expectancy mean much. The shadow dashboard accrues
this automatically — the correct action is mostly to wait.

---

## Built as a result of this analysis

- **Concentration metric** — every variant now reports `top_trade_share` and
  return excluding its best trade. The dashboard shows an **Ex-best** column
  beside Net, and the verdict refuses to green-light any run where a variant
  draws over 50% of P&L from one trade. I nearly recommended
  `momentum_2pct_max2` on its headline before checking; this makes that error
  structurally hard to repeat.
- **Per-variant symbol selection** — so a weak asset can be excluded and measured
  against the full universe on identical bars.
- **Experiment harness** — `shadow_experiments.json`, `shadow_safety.json`, and
  workflow inputs for running either against live data without disturbing the
  daily dashboard.
