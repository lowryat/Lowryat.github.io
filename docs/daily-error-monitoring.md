# LIQ-INTEL external daily error monitor

## Status and activation

Prepared workflow: `.github/workflows/liq-intel-daily-monitor.yml`. It is **not active** until installed on the chosen GitHub repository's default branch and its secrets are configured. Local tests do not prove real browser access or ntfy delivery. This does not publish or redeploy the Replit app.

The chosen repository is `lowryat/Lowryat.github.io`, whose homepage matches the website supplied by the user. Add only these monitoring files; do not replace its website or copy the LIQ-INTEL app into it. Review the isolated monitor branch/PR before merging.

### Remaining setup (checked October 6, 2026)

GitHub's connection still denies workflow-file access after reconnecting. The upload was retried once and denied; no further workflow uploads were attempted. The monitor branch contains the scripts, but the repository's active workflows do not include this monitor. The 14 local tests pass; no real external run or report delivery has been verified.

The repository already has a secret named `NTFY_TOPIC`; verify it points to the intended report destination without sharing its value. The monitor URL and access-token secrets listed below are missing from GitHub Actions.

1. Open [GitHub's new-file editor on the monitor branch](https://github.com/lowryat/Lowryat.github.io/new/liq-intel-daily-monitor?filename=.github%2Fworkflows%2Fliq-intel-daily-monitor.yml).
2. Paste the workflow below and commit it **to the monitor branch**, not directly to the default branch.
3. Add the missing secrets in [GitHub Actions secrets](https://github.com/lowryat/Lowryat.github.io/settings/secrets/actions). Create separate Development and Production external access tokens in Replit Publishing → Adjust settings → Security → External access tokens.
4. Review the monitor branch and existing repository automation before merging. Creating a pull request or merging can trigger existing GitHub/Vercel automation for the portfolio repository; this monitor does not deploy LIQ-INTEL.
5. After the workflow is on the default branch, run the authorized trial described below. Until the trial verifies both environments and ntfy delivery, do not describe monitoring as active.

Copy this complete workflow, including indentation:

```yaml
name: LIQ-INTEL daily error monitor

on:
  schedule:
    - cron: '0 8 * * *'
      timezone: America/Los_Angeles
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: liq-intel-daily-monitor
  cancel-in-progress: false

jobs:
  monitor:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Check monitor logic
        run: node --test scripts/liq-intel-monitor/*.test.mjs
      - name: Install isolated browser tooling
        run: |
          npm install --prefix "$RUNNER_TEMP/liq-intel-monitor" --no-save --no-package-lock playwright@1.62.1
          "$RUNNER_TEMP/liq-intel-monitor/node_modules/.bin/playwright" install --with-deps chromium
      - name: Check both environments and send one daily report
        env:
          PLAYWRIGHT_MODULE_PATH: ${{ runner.temp }}/liq-intel-monitor/node_modules/playwright/index.mjs
          MONITOR_DEV_URL: ${{ secrets.MONITOR_DEV_URL }}
          MONITOR_PROD_URL: ${{ secrets.MONITOR_PROD_URL }}
          MONITOR_DEV_EXTERNAL_ACCESS_TOKEN: ${{ secrets.MONITOR_DEV_EXTERNAL_ACCESS_TOKEN }}
          MONITOR_PROD_EXTERNAL_ACCESS_TOKEN: ${{ secrets.MONITOR_PROD_EXTERNAL_ACCESS_TOKEN }}
          NTFY_TOPIC: ${{ secrets.NTFY_TOPIC }}
          NTFY_TOKEN: ${{ secrets.NTFY_TOKEN }}
        run: node scripts/liq-intel-monitor/daily.mjs
```

In GitHub repository Settings → Secrets and variables → Actions:

| Type | Name | Purpose |
| --- | --- | --- |
| Secret | `MONITOR_DEV_URL` | HTTPS development preview origin, no path/query/token; masked in runner environment logs |
| Secret | `MONITOR_PROD_URL` | Actual published Replit origin, not the Vercel portfolio site; masked in runner environment logs |
| Secret | `MONITOR_PROD_EXTERNAL_ACCESS_TOKEN` | Private deployment external access token from Replit Publishing settings |
| Secret | `NTFY_TOPIC` | Existing private ntfy topic; Replit secrets are not automatically shared with GitHub |
| Optional secret | `NTFY_TOKEN` | ntfy authentication, if the topic requires it |
| Secret for a private preview | `MONITOR_DEV_EXTERNAL_ACCESS_TOKEN` | Separate Development external access token; do not reuse the Production token |

Never put values in chat, repository files, URLs, workflow commands, or logs. Do not copy `SESSION_SECRET` into this runner. Replit documents external access tokens for private deployments; do not assume a production token grants access to the development preview. Preview URLs are temporary, must be running, and may require a supported external access setup. If a preview is inaccessible, the report must say so rather than claim coverage.

The current [Replit token documentation](https://docs.replit.com/features/deployment-customization/external-access-tokens) distinguishes Development and Production tokens and states that Production tokens survive ordinary republishing. Unpublishing, deleting a deployment, changing private access to public, expiration, revocation, and some access-membership changes can invalidate access; verify the monitor again after relevant changes.

1. Configure the secrets securely in GitHub.
2. Merge the reviewed monitor files onto the default branch when ready. GitHub may also trigger existing repository/Vercel workflows on a merge; review those before merging.
3. Use Actions → LIQ-INTEL daily error monitor → Run workflow for a trial.
4. Confirm the report reaches ntfy and both app pages (not login/interstitials) were checked. Exercise a controlled invalid-token test, verify the report, then restore the token. Do not rely on the schedule before this trial succeeds.

## Behavior and limits

- Schedule: 8:00 AM `America/Los_Angeles`, including daylight saving changes, using GitHub's timezone-aware schedule. GitHub can delay scheduled jobs; this is not an exact-time guarantee.
- Sequential checks of development and published environments. Each makes one `/api/health/pipeline` request and, when that succeeds, one short browser visit to the home page. Normal startup assets/API requests still occur. No force-refresh endpoints, operations-status polling, alerts test sends, or collector cadence changes.
- Requests time out after 10 seconds. Network/timeouts and server 5xx get at most one retry after 60 seconds. Unauthorized, redirects, and 429 get no retries; browser visits are not retried. Browser navigation is limited to 20 seconds plus a short observation; the complete job is capped at 10 minutes.
- Checks the actual market-posture page marker, browser runtime exceptions and Vite error overlays. It does not test all tabs, keyboard interactions, SMS delivery, or every feature.
- Sends one ntfy report per run, including healthy checks and focused investigation steps. Reports summarize only safe issue categories/severity, not private response details. Failures and notification failures exit nonzero. No notification retry (to avoid duplicates).
- Never saves raw console messages, exceptions, page content, URLs, screenshots, cookies, or network traces. The Replit access token is attached only to same-origin browser requests. Logs contain fixed event/state fields.
- This is a daily smoke check, not 24-hour error collection. It does not replace the existing external operations checker and never edits or publishes the app automatically.

Local validation: `node --test scripts/liq-intel-monitor/*.test.mjs`. Browser tests use an injected fake driver locally; the GitHub trial is required to prove actual browser access and report delivery.
