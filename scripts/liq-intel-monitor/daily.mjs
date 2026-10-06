import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { probeBrowser } from "./browser.mjs";

export const REQUEST_TIMEOUT_MS = 10_000;
export const RETRY_DELAY_MS = 60_000;
const AREAS = new Set(["market", "database", "daily-history", "notifications", "sms"]);
const ACTIONS = {
  "access-denied": "Check the external access token and access policy in GitHub secrets; do not paste credentials into reports.",
  "rate-limited": "Respect the rate limit/cooldown. Review request pacing before another check; do not add rapid retries.",
  "endpoint-timeout": "Inspect server latency and provider deadlines before increasing the timeout.",
  "endpoint-unavailable": "Check hosting availability, DNS/TLS, and whether the development preview is running.",
  "endpoint-http-error": "Inspect server logs and routing for the failing health request.",
  "endpoint-redirect": "Check private-app access and the configured URL; a login/redirect is not a successful app check.",
  "invalid-pipeline-response": "Check the health response contract and proxy/access page; raw response contents were not retained.",
  "browser-runtime-error": "Reproduce the page in the affected environment and inspect browser errors/source maps; dismissing the overlay alone is not a fix.",
  "browser-unavailable": "Check the runner's Playwright/Chromium installation; browser coverage did not run.",
  "app-content-missing": "Check whether the URL shows the actual app rather than a login, placeholder, or failed startup.",
  "page-timeout": "Inspect startup latency; the browser visit timed out and was not repeated.",
  "page-unavailable": "Inspect app startup and network availability; the browser visit failed and was not repeated.",
  "page-http-error": "Check the page's routing, deployment, and server logs.",
  market: "Review market sweep health and deadlines; do not increase collection frequency to compensate.",
  sources: "Check source availability and provider limits; respect configured cooldowns.",
  providers: "Check provider rate limits/timeouts and circuit cooldowns before retrying.",
  database: "Check database connectivity and latency before changing retries or concurrency.",
  "daily-history": "Review daily-history source coverage and backfill progress.",
  notifications: "Review Alerts diagnostics and notification configuration.",
  sms: "Review Alerts diagnostics and carrier delivery status.",
  other: "Inspect the app's Data Health panel for the full issue; this report intentionally omits private details.",
};

function baseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Invalid monitor URL");
  }
  return url.href;
}

export function validateConfig(env) {
  if (!env.MONITOR_DEV_URL || !env.MONITOR_PROD_URL || !env.MONITOR_PROD_EXTERNAL_ACCESS_TOKEN || !env.NTFY_TOPIC) {
    throw new Error("Missing monitor configuration");
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(env.NTFY_TOPIC)) throw new Error("Invalid ntfy topic");
  return {
    environments: [
      { name: "Development", url: baseUrl(env.MONITOR_DEV_URL), token: env.MONITOR_DEV_EXTERNAL_ACCESS_TOKEN || "" },
      { name: "Published", url: baseUrl(env.MONITOR_PROD_URL), token: env.MONITOR_PROD_EXTERNAL_ACCESS_TOKEN },
    ],
    topic: env.NTFY_TOPIC,
    ntfyToken: env.NTFY_TOKEN || "",
  };
}

function safeArea(area) {
  if (area.startsWith("source:")) return "sources";
  if (area.startsWith("host:")) return "providers";
  return AREAS.has(area) ? area : "other";
}

async function checkPipeline(environment, fetcher, sleep) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let failure;
    try {
      const response = await fetcher(new URL("/api/health/pipeline", environment.url).href, {
        headers: { Accept: "application/json", "Cache-Control": "no-store", ...(environment.token ? { Authorization: `Bearer ${environment.token}` } : {}) },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200) {
        const body = await response.json().catch(() => null);
        if (!["healthy", "degraded", "down"].includes(body?.status) || !Array.isArray(body.issues) ||
            body.issues.some(issue => !["warning", "critical"].includes(issue?.severity) || typeof issue.area !== "string")) {
          return { failure: "invalid-pipeline-response" };
        }
        // Discard all issue messages, provider names, metadata, and other private body fields.
        return {
          status: body.status,
          warnings: body.issues.filter(issue => issue.severity === "warning").length,
          critical: body.issues.filter(issue => issue.severity === "critical").length,
          areas: [...new Set(body.issues.map(issue => safeArea(issue.area)))],
        };
      }
      if (response.status === 401 || response.status === 403) return { failure: "access-denied" };
      if (response.status === 429) return { failure: "rate-limited" };
      if (response.status >= 300 && response.status < 400) return { failure: "endpoint-redirect" };
      failure = "endpoint-http-error";
      if (response.status < 500) return { failure };
    } catch (error) {
      failure = ["TimeoutError", "AbortError"].includes(error?.name) ? "endpoint-timeout" : "endpoint-unavailable";
    }
    if (attempt === 1) return { failure };
    await sleep(RETRY_DELAY_MS);
  }
}

export async function runDailyMonitor(config, {
  fetcher = fetch,
  browserProbe = probeBrowser,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = console.log,
} = {}) {
  const runId = randomUUID();
  log(JSON.stringify({ event: "daily_monitor_started", runId }));
  const results = [];
  // Sequential environments: no overlapping visits, force refreshes, or collector calls.
  for (const environment of config.environments) {
    const pipeline = await checkPipeline(environment, fetcher, sleep);
    let browserFailures = [];
    if (!pipeline.failure) {
      try {
        const observed = await browserProbe(environment);
        browserFailures = Array.isArray(observed) && observed.every(code => Object.hasOwn(ACTIONS, code))
          ? observed : ["browser-unavailable"];
      }
      catch { browserFailures = ["browser-unavailable"]; }
    }
    // Only known codes can leave the runner, even if an adapter returns unexpected input.
    const failures = [pipeline.failure, ...browserFailures].filter(code => Object.hasOwn(ACTIONS, code));
    const healthy = !failures.length && pipeline.status === "healthy" && pipeline.warnings === 0 && pipeline.critical === 0;
    const state = healthy ? "healthy" : failures.length || pipeline.critical > 0 || pipeline.status === "down" ? "failed" : "degraded";
    const recommendations = [...new Set([...failures, ...(pipeline.areas || [])].map(code => ACTIONS[code]))].slice(0, 3);
    if (!healthy && !recommendations.length) recommendations.push(ACTIONS.other);
    results.push({ name: environment.name, state, pipeline, browser: pipeline.failure ? "skipped" : browserFailures.length ? "failed" : "passed", recommendations });
  }
  const message = results.map(result => {
    const pipeline = result.pipeline.failure ? "unavailable" : `${result.pipeline.status}; ${result.pipeline.critical} critical, ${result.pipeline.warnings} warnings`;
    return `${result.name}: ${result.state}. Page: ${result.browser}. Pipeline: ${pipeline}.\n${result.recommendations.map(action => `Next: ${action}`).join("\n")}`;
  }).join("\n\n") + "\n\nDaily startup smoke check only; not continuous monitoring or proof of every feature. No automatic fixes were applied.";
  log(JSON.stringify({ event: "daily_monitor_check", runId, results: results.map(({ name, state, browser }) => ({ name, state, browser })) }));
  let notified = false;
  try {
    const response = await fetcher("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(config.ntfyToken ? { Authorization: `Bearer ${config.ntfyToken}` } : {}) },
      body: JSON.stringify({ topic: config.topic, title: "LIQ-INTEL daily check", message, priority: results.some(result => result.state === "failed") ? 4 : 3 }),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    notified = response.status >= 200 && response.status < 300;
  } catch { /* Transport error text can contain credentials: never log it. */ }
  log(JSON.stringify({ event: "daily_monitor_notification", runId, state: notified ? "delivered" : "failed" }));
  return { ok: notified && results.every(result => result.state === "healthy"), notified, results, message };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (!(await runDailyMonitor(validateConfig(process.env))).ok) process.exitCode = 1;
  } catch {
    console.error("Daily monitor configuration missing or invalid. See docs/daily-error-monitoring.md; no secret values are printed.");
    process.exitCode = 1;
  }
}
