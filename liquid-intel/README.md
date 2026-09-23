# LIQ-INTEL upgrade

An upgrade for the **Liquid Intel** Replit app (https://liquid-intel.replit.app). It fixes the stalled and gappy market sweeps, repairs SMS and notification delivery, and adds three trader-facing tabs: **Signals**, **Risk Lab**, and **Health**.

Everything the Repl needs is in [`overlay/`](overlay), laid out exactly like the Repl. [`sync-to-replit.sh`](sync-to-replit.sh) applies it with a backup and a one-command undo.

## Apply it

In the Repl's **Shell** tab:

```bash
curl -fsSL https://raw.githubusercontent.com/lowryat/Lowryat.github.io/claude/replit-finance-api-pipeline-45hfde/liquid-intel/sync-to-replit.sh | bash
```

Then press **Stop** and **Run**, open the app, and check the **HEALTH** tab.

- **Undo:** the script prints `bash .liq-backup/<time>/restore.sh`. It restores every replaced file and deletes every added one. This was tested to leave the workspace byte-identical.
- **Safety check:** if a file changed in the Repl after this upgrade was prepared, for example through the Replit Agent, the script stops and lists it. Nothing is touched until you rerun with `--force`, and your version is still backed up.
- **Verify:** add `--verify` to typecheck and run the fast tests after applying.
- **No schema migration** is needed. The new delivery statuses fit the existing text columns.

## Why sweeps stalled and data went missing

| Symptom | Root cause | Fix |
|---|---|---|
| Sweeps stop for good | Each sweep awaited database writes with no deadline, so one hung write held the single-flight lock forever | Sweeps run under a hard 45 s deadline with cancellation. Writes go to a bounded background queue |
| Unexplained process restarts | Six separate Postgres pools with no timeouts and no `error` listener. A dropped idle connection threw an unhandled error | One shared, hardened pool with connect, statement, and idle timeouts |
| Gaps after bursts | Unpaced calls from several modules hit CoinGecko's free rate limit, and nothing coordinated them per host | One HTTP client per host with concurrency caps, spacing, Retry-After cooldowns, a circuit breaker, and fail-fast during cooldown |
| History backfill never worked | It requested `interval=hourly`, which CoinGecko restricts to Enterprise plans, and it waited 24 h after a failure | Correct endpoint, paced requests, and a 30-minute retry when incomplete |
| Old data vanished | Coinbase and CoinGlass cleanup deleted every provider's rows older than 90 days | Retention is scoped to each provider |
| Slow database | Up to 840 single-row inserts per poll | Multi-row upserts |
| Alerts silently skipped | The evaluator had no deadline and ran up to 500 rules at once | 50 s deadline, 8 rules at a time, per-rule error isolation |

## Why SMS and notifications failed

- **"Sent" was not delivered.** Twilio's "201 accepted" only means queued, so the app now polls the carrier receipt and shows *delivered* or *not delivered*, with the reason.
- **The wrong credentials were used first.** The Replit connector was tried before your own `TWILIO_*` secrets. Explicit secrets now go first.
- **Failures blocked retries.** A failed text counted toward the cooldown, so a manual retry was always rate-limited. Only accepted or delivered messages count now.
- **Cost tripled.** Characters like `·` and `—` force UCS-2 encoding, which cuts each segment from 160 to 70 characters. Alerts are now normalized to GSM-7.
- **Webhooks timed out.** TradingView waits about 3 s, but the webhook waited for Twilio before replying. It now acknowledges immediately.
- **Error messages were generic.** Over 20 common Twilio error codes now have plain-language fixes, including trial accounts, STOP opt-outs, A2P 10DLC, and landlines.
- **No backup channel.** Push notifications through the free ntfy app now mirror every alert.
- **Diagnostics.** ALERTS → "Check SMS setup" tests the account, sender, and registration without sending a text.
- **Python bot.** The trading bot's ntfy alerts crashed on emoji titles, such as the HALTED report. This was fixed in [`tradingbot/notify.py`](../tradingbot/notify.py).

## New tabs

- **Signals.** Trend strength from −100 to +100 for 22 assets, using volatility-normalized distance from the 50- and 200-day averages, risk-adjusted momentum, strength versus BTC, and volume confirmation. It also shows regime, breadth, correlation, stablecoin liquidity impulse, TVL, DEX activity, and Fear and Greed. A walk-forward test reports whether the score has predicted returns, and it says so plainly when it has not.
- **Risk Lab.** Everything runs in the browser, and no portfolio data leaves the device.
  - **Monte Carlo:** thousands of correlated, fat-tailed paths, with a fan chart, return histogram, 90% and 95% intervals, VaR and CVaR in dollars, and drawdown odds.
  - **Scenario planning:** four environments with editable probabilities and a probability-weighted expected value, re-centered on the simulation's BTC assumption.
  - **Strategic alternatives:** de-risk 50%, BTC/ETH only, inverse-volatility, and equal weight, compared under the same scenarios.
  - **Sensitivity:** a tornado chart with critical value drivers, plus a two-variable data table.
  - **Diagnostics:** correlation heatmap, risk contributions, and a Kupiec backtest of the VaR model.
- **Health.** Shows every sweep, provider host, rate limit, database connection, daily-history source, and notification channel, with plain-language issues.

Daily history uses Coinbase first, then CoinGecko, then Kraken, plus DefiLlama and alternative.me. It is stored in Postgres and reloaded on restart, so a provider outage never blanks the charts.

## Optional secrets

Set these in Replit under **Tools → Secrets**:

| Secret | Why |
|---|---|
| `NTFY_TOPIC` | Free push alerts. Pick a long random topic name and subscribe to it in the ntfy app on iOS or Android. |
| `TWILIO_MESSAGING_SERVICE_SID` | Recommended for US numbers. It works with A2P 10DLC registration. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Explicit credentials, used before the Replit connector. |
| `COINGECKO_API_KEY` | A free demo key, which loads history about three times faster. |
| `SESSION_SECRET` | Keeps alert ownership stable across restarts. |
| `PUBLIC_APP_URL` | Adds a link to the app in alert texts. |

**US SMS checklist:** register a Brand and Campaign for A2P 10DLC, or verify a toll-free number. Upgrade from a Twilio trial, which only texts verified numbers. If a recipient replied STOP, they must text START before messages resume.

## Tests

Run from the Repl root:

```bash
npx tsc --noEmit
npx tsx --test server/*.test.ts shared/quant/*.test.ts client/src/components/AnalysisAlerts.test.ts   # 70 tests
npx vitest run client/src/components/AlertsPanel.test.tsx
```

The database tests create and drop a temporary database on the server `DATABASE_URL` points at. Run them against a development database, not production. Without `DATABASE_URL` they skip.

The temporary-database test wrapper previously reported a pass even when its worker tests failed, because the worker inherited `NODE_TEST_CONTEXT`. That is fixed, and a planted failure is now caught.

## Screenshots

[`docs/screenshots/`](docs/screenshots) shows the production build running locally against **synthetic** data. The sandbox that built this blocks market APIs, which also exercised the stale-while-error path you can see on the Health tab.

## Limits

These analytics describe risk and trend from recent history. They are not forecasts or investment advice. Fees, slippage, and liquidity are not modeled. Keep the deployment on a Reserved VM, as it is now, for 24/7 alert evaluation. Autoscale deployments sleep.
