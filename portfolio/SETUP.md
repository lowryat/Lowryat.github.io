# Portfolio analytics — setup

A read-only dashboard at **https://lowryat.github.io/portfolio/** that pulls
your crypto tax lots from Awaken, your holdings and fills from Robinhood,
and tells you when to harvest losses, when a winner is about to go
long-term, and when a position is worth trimming. A GitHub Action refreshes
it daily and pushes an alert to your phone when something is actionable.

**Nothing in this app can place a trade.** The Robinhood client only makes
GET requests, and the Awaken client only runs queries. Decisions stay yours.

Until you add credentials the site shows a clearly labeled demo dataset, so
you can explore the layout first.

---

## 1. Awaken (tax lots, realized gains, harvestable losses) — 5 minutes

1. In Awaken go to **Settings → API Keys → New key**. Choose **Read**.
   Copy the key now; it is shown once.
2. In this repo: **Settings → Secrets and variables → Actions → New
   repository secret**
   - `AWAKEN_API_KEY` = the key (starts with `awaken_`)
   - `AWAKEN_CLIENT_ID` — optional. Leave it out; the job discovers it.
3. Make sure your Robinhood account is imported into Awaken (Awaken →
   Accounts → Add → Robinhood). That is what lets the app show *lot-level*
   detail for Robinhood positions and reconcile quantities.

The API key requires Awaken's whale plan. If you can't create one, the app
still works from Robinhood alone (section 2) with FIFO lots rebuilt from
your order history.

## 2. Robinhood (holdings, buying power, fills) — 5 minutes

1. In the Robinhood app: **Account → Crypto → API** (or
   robinhood.com/account/crypto → API trading). Generate an Ed25519 key
   pair. Robinhood's docs show a short Python snippet that prints the
   base64 private key and public key; paste the public key into Robinhood.
2. When choosing permissions, grant **read-only** scopes (account,
   holdings, orders read). Do not grant order placement — this app never
   needs it, and the trading bot in `tradingbot/` uses its own key.
3. Add secrets:
   - `ROBINHOOD_API_KEY` = the API key string
   - `ROBINHOOD_PRIVATE_KEY` = the base64 private key seed

If you already set these secrets for the trading bot you can reuse them, but
a separate read-only key is safer.

## 3. Phone alerts — 2 minutes

Same plumbing as the trading bot. If `NTFY_TOPIC` is already a repo secret
you are done. Otherwise: install the **ntfy** app, subscribe to an
unguessable topic name, and add it as the `NTFY_TOPIC` secret.

Optional repo **variables** (not secrets):

| Variable | Default | Meaning |
|---|---|---|
| `PORTFOLIO_ALERT_MIN_USD` | `250` | Only alert on insights whose estimated tax effect is at least this |
| `PORTFOLIO_ALERT_COOLDOWN_DAYS` | `7` | Don't repeat the same alert within this many days |

Alerts fire for: harvestable losses worth ≥ the threshold, short-term
winners that go long-term soon (a "hold" alert), concentration over your
ceiling, and transactions missing cost basis in Awaken.

## 4. Run it

**Actions → portfolio-daily → Run workflow.** The job:

1. verifies credentials (`python -m portfolio_analytics check`)
2. pulls Awaken + Robinhood + 180 days of prices (CoinGecko, no key)
3. computes insights and writes `reports/portfolio/latest.json` plus a
   dated copy in `reports/portfolio/history/` (that history becomes the
   value chart when Awaken's chart isn't available)
4. sends alerts, then commits the snapshot

It then runs daily at 13:10 UTC. GitHub Pages serves the dashboard from
`/portfolio/`; it loads the latest snapshot on every page view.

## 5. Tune the math

Edit **`portfolio/settings.json`** (used by the daily job and alerts):

| Key | Default | What it does |
|---|---|---|
| `short_term_rate` | 0.35 | Federal marginal rate on short-term gains |
| `long_term_rate` | 0.20 | Federal long-term capital-gains rate |
| `state_rate` | 0.0 | Your state's rate on capital gains |
| `niit_rate` | 0.038 | Net investment income tax |
| `min_harvest_loss` / `min_harvest_loss_pct` | 250 / 0.05 | Ignore smaller losses |
| `profit_take_gain_pct` | 0.5 | Flag positions up ≥ 50% vs. basis |
| `max_weight` / `target_weight` | 0.35 / 0.25 | Concentration ceiling and trim target |
| `trailing_dd_pct` | 0.15 | "Fading" when ≥ 15% below the 90-day high |
| `long_term_wait_days` | 45 | Suggest holding if a lot goes long-term within N days |
| `wash_sale_conservative` | false | Add a 31-day re-buy wait to harvest suggestions |

The dashboard's **Settings** sheet (gear icon) changes the same numbers in
your browser only, so you can play with rates without editing the file.

## Local preview

```bash
pip install -r requirements-dev.txt
python -m portfolio_analytics snapshot --demo      # or drop --demo with env vars set
python -m http.server 8000                        # then open http://localhost:8000/portfolio/
pytest tests/test_portfolio_*.py
```

To run live locally: `export AWAKEN_API_KEY=... ROBINHOOD_API_KEY=... ROBINHOOD_PRIVATE_KEY=...`
then `python -m portfolio_analytics snapshot --dry-run`.

## How the signals are computed

- **Lot term**: a lot is long-term once held *more than* 365 days.
- **Harvest**: any lot at a loss above the threshold; savings = loss ×
  (short or long rate). The year-end plan nets losses against your realized
  gains from Awaken in IRS order (short vs. short, long vs. long, then
  cross), applies the $3,000 ordinary-income deduction, and reports any
  carryforward.
- **Profit-take**: a position is flagged if it exceeds the weight ceiling,
  is up ≥ the winner threshold, or is fading from its 90-day high while
  still profitable. The trim amount and its tax cost are computed with your
  Awaken cost-basis method (HIFO by default — it sells the highest-basis
  lots first, which minimizes the tax bill).
- **Hold**: if a flagged position has short-term lots that go long-term
  within `long_term_wait_days`, the app estimates how much waiting saves.
- **Risk**: annualized return/volatility, Sharpe, Sortino, max and current
  drawdown, and concentration (HHI / effective number of assets).

These are estimates for planning, not tax advice. Confirm with your CPA
before acting; Awaken's 8949 export is the authoritative number.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Dashboard says "Demo data" | No credentials, or the last job failed before writing. Check the workflow log's "Verify credentials" step. |
| `awaken · unavailable` pill with a 401 | Key revoked or expired — make a new one in Awaken. |
| `awaken` 403 on every client | The key belongs to a different Awaken workspace; set `AWAKEN_CLIENT_ID` explicitly. |
| "Robinhood quantities don't match the tax ledger" | Awaken hasn't imported a recent trade. Sync the Robinhood account in Awaken. |
| Lots show "unknown" purchase date | Awaken returned a balance without lot detail (often exchange imports mid-sync). Treated as long-term; basis is still correct. |
| No price sparkline for an asset | CoinGecko has no id mapped for that symbol; add it to `COINGECKO_IDS` in `portfolio_analytics/prices.py`. |
