# Getting the bot running

Three stages, each one safe on its own. Do them in order — don't skip to
stage 3.

---

## Stage 1 — Dry run (no money, no accounts, 2 minutes)

This already works. The daily GitHub Action runs at 00:05 UTC against an
in-memory simulated broker and commits its report to `reports/live/`.

To trigger it manually: **Actions → tradingbot-daily → Run workflow**.

Nothing to configure. This is where the repo sits right now.

---

## Stage 2 — Paper trading + phone notifications (fake money, real prices)

### 2a. Notifications (do this first — it's free and instant)

Easiest option is **ntfy**, a free push service with no signup:

1. Install the **ntfy** app ([iOS](https://apps.apple.com/us/app/ntfy/id1625396347) /
   [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)).
2. Pick an unguessable topic name, e.g. `lowryat-tradebot-k9x2mq`.
   Anyone who knows the topic can read your alerts, so don't use
   something guessable like `lowryat-trades`.
3. In the app: **+ → Subscribe to topic →** enter that name.
4. In GitHub: **Settings → Secrets and variables → Actions → New repository
   secret**, name `NTFY_TOPIC`, value = your topic name.

Test it right now from your terminal:
```bash
curl -d "Bot is wired up" ntfy.sh/YOUR-TOPIC-NAME
```
If your phone buzzes, you're done.

**SMS instead (optional, costs money):** set `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `TWILIO_TO` as secrets. Push is
recommended — SMS adds cost and delivery lag for no real benefit here.

### 2b. Alpaca paper trading

1. Sign up free at [alpaca.markets](https://alpaca.markets) → generate
   **paper** API keys (the dashboard has a paper/live toggle — stay on paper).
2. Add secrets `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY`.
3. Add repo **variable** (not secret) `TRADING_ENABLED` = `true`.
4. Optional: variable `TRADING_MODE` = `ensemble` to run all four bots at
   25% capital each — this was the Rep 8 tournament winner on risk-adjusted
   metrics (worst weekly drawdown 3.41% vs 4.65% for the single bot).

Run the workflow manually and check the report in `reports/live/`. **Let this
run for at least a few weeks** before even considering stage 3.

---

## Stage 3 — Robinhood (⚠️ REAL MONEY)

**Robinhood crypto has no paper mode.** Every order spends real dollars.
There is no undo.

Before you do this, you should have:
- Watched stage 2 run for several weeks with results you're comfortable with
- Decided on an amount you are fully prepared to lose entirely
- Read `reports/final/summary.md`, especially the caveats section

### Setup

1. In the Robinhood app: **Account → Crypto → API** — create an API key.
   If Robinhood offers a **dedicated agentic/crypto sub-account**, use it.
   Fund only that account, and only with your predetermined amount.
2. Add secrets:
   - `ROBINHOOD_API_KEY` — the API key string
   - `ROBINHOOD_PRIVATE_KEY` — base64 Ed25519 private key seed
   - `ROBINHOOD_LIVE_ACK` — literally `I_UNDERSTAND_THIS_TRADES_REAL_MONEY`
3. Add variable `TRADING_BROKER` = `robinhood`.

The `ROBINHOOD_LIVE_ACK` secret is a deliberate speed bump: the broker
refuses to construct without it, so no misconfiguration can accidentally
route real orders. **Delete that secret to instantly stop real-money
trading** — the next run fails loudly rather than trading.

Also set `--starting-equity` to match what you actually funded. The runner
caps its allocation at that value, so it won't try to trade a balance
you didn't intend to expose.

### Killing it

- **Stop everything:** Actions → tradingbot-daily → ⋯ → Disable workflow
- **Stop real money only:** delete the `ROBINHOOD_LIVE_ACK` secret
- **Back to paper:** set `TRADING_BROKER` = `alpaca-paper`

Positions are *not* auto-closed when you disable the workflow. If you're
holding and want out, close manually in the Robinhood app.

---

## What you'll see on your phone

```
Tradebot 2026-08-25: 2 trades
BUY BTC: 0.0403 @ $62,140.00 (stop $59,020.00)
SELL SOL (stop): P&L -$118.20 (-1.00R)
Equity: $10,512.34
DD day 1.20% / week 2.10%
```

If a circuit breaker fires, the title becomes `⛔ Tradebot ...: HALTED` and
the body says `⛔ CIRCUIT BREAKER HALT ACTIVE`. That means all positions were
flattened and no new ones open until the next day (3% limit) or next ISO week
(5% limit).

In ensemble mode `NOTIFY_ONLY_ON_ACTION=true` is set automatically, so you
only get pinged when a bot actually trades or halts — not four "no trades
today" messages every morning.

---

## Honest expectations

The backtests are on synthetic and interpolated-historical data, not real
tick data. Real trading adds slippage, spread, exchange outages, and gap
risk that the models understate. Rep 5 found 18/20 synthetic seeds positive
with a median of +8% over two years — a realistic hope, not a promise, and
2 of those 20 seeds lost money.

The circuit breakers bound *how fast* you can lose, not *whether* you lose.
A 3% daily / 5% weekly limit still compounds to a meaningful loss over a bad
month. Position sizing (2% risk per trade) is the real protection; the
breakers are the backstop.
