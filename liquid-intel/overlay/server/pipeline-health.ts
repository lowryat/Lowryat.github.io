import { getAnalysisAlertOperationsProgress } from "./analysis-alerts";
import { getCoinbaseOperationsProgress } from "./coinbase";
import { getDailyHistoryStatus } from "./daily-history";
import { getDatabaseHealth } from "./db";
import { marketHttp } from "./http-client";
import { getCachedMarketSnapshot, getMarketPipelineStats, getMarketSourceHealth } from "./market";
import { getPushStats } from "./push";
import { getSmsStats } from "./sms";

/**
 * Secret-free view of every moving part: sweeps, provider hosts, the database,
 * daily history, alert evaluation, and notification channels. It lists
 * plain-language issues so the Data Health tab can say what is wrong and why.
 */

export type PipelineIssue = { severity: "warning" | "critical"; area: string; message: string };

export function getPipelineHealth() {
  const now = Date.now();
  const market = getMarketPipelineStats();
  const sources = getMarketSourceHealth();
  const hosts = marketHttp.hostStats();
  const database = getDatabaseHealth();
  const dailyHistory = getDailyHistoryStatus();
  const alerts = getAnalysisAlertOperationsProgress();
  const coinbase = getCoinbaseOperationsProgress();
  const sms = getSmsStats();
  const push = getPushStats();
  const snapshot = getCachedMarketSnapshot();
  const issues: PipelineIssue[] = [];

  const lastSweep = market.collection.lastSuccessAt ? Date.parse(market.collection.lastSuccessAt) : null;
  if (!snapshot) {
    issues.push({ severity: "critical", area: "market", message: "No complete market snapshot yet. Prices and signals are unavailable until the first sweep succeeds." });
  } else if (lastSweep != null && now - lastSweep > market.intervalMs * 5) {
    issues.push({ severity: "critical", area: "market", message: `The last successful market sweep was ${Math.round((now - lastSweep) / 60_000)} minutes ago.` });
  }
  if (market.collection.timeouts > 0 && market.collection.lastStatus === "timeout") {
    issues.push({ severity: "warning", area: "market", message: "The most recent sweep hit its deadline and was aborted; the next sweep starts on schedule." });
  }
  for (const [name, source] of Object.entries(sources)) {
    if (name.startsWith("dex:")) continue;
    if (source.state === "unavailable" || source.state === "stale") {
      issues.push({ severity: "warning", area: `source:${name}`, message: `${name} is ${source.state}${source.error ? `: ${source.error}` : ""}.` });
    }
  }
  for (const host of hosts) {
    if (host.circuit === "open") {
      issues.push({ severity: "warning", area: `host:${host.host}`, message: `${host.host} is paused after ${host.consecutiveFailures} consecutive failures${host.lastError ? ` (${host.lastError})` : ""}.` });
    } else if (host.cooldownUntil && Date.parse(host.cooldownUntil) > now) {
      issues.push({ severity: "warning", area: `host:${host.host}`, message: `${host.host} rate-limited this app; requests resume at ${host.cooldownUntil}.` });
    }
  }
  if (market.persistence.dropped > 0) {
    issues.push({ severity: "warning", area: "database", message: `${market.persistence.dropped} snapshot write(s) were dropped because the database was slower than the sweep.` });
  }
  if (database.configured && database.lastErrorAt && now - Date.parse(database.lastErrorAt) < 15 * 60_000) {
    issues.push({ severity: "warning", area: "database", message: `Database connection error in the last 15 minutes: ${database.lastError}` });
  }
  if (!database.configured) {
    issues.push({ severity: "warning", area: "database", message: "DATABASE_URL is not set, so history, alerts, and daily data are not persisted across restarts." });
  }
  if (dailyHistory.state === "unavailable" || dailyHistory.state === "partial") {
    const missing = dailyHistory.assets.filter((row) => row.points === 0).map((row) => row.symbol);
    issues.push({
      severity: dailyHistory.state === "unavailable" ? "critical" : "warning",
      area: "daily-history",
      message: dailyHistory.state === "unavailable"
        ? "No daily history is available, so the risk lab and signals cannot run."
        : `Daily history is partial${missing.length ? `; missing ${missing.join(", ")}` : ""}.`,
    });
  }
  if (!sms.configured && !push.configured) {
    issues.push({ severity: "warning", area: "notifications", message: "Neither SMS nor push notifications are configured, so alerts can only be seen in the app." });
  }
  if (sms.undelivered > 0 && sms.delivered === 0) {
    issues.push({ severity: "warning", area: "sms", message: "Twilio accepted messages but carriers did not deliver them. Open Alerts, then Diagnostics, for the cause." });
  }

  const status = issues.some((issue) => issue.severity === "critical") ? "down" : issues.length ? "degraded" : "healthy";
  return {
    status,
    checkedAt: new Date(now).toISOString(),
    issues,
    market: { ...market, snapshotAvailable: Boolean(snapshot) },
    sources,
    hosts,
    database,
    dailyHistory,
    alerts: {
      enabled: alerts.enabled,
      idle: alerts.idle,
      lastSuccessAt: alerts.lastSuccessAt ? new Date(alerts.lastSuccessAt).toISOString() : null,
    },
    coinbase: {
      started: coinbase.started,
      lastSuccessAt: coinbase.lastSuccessAt ? new Date(coinbase.lastSuccessAt).toISOString() : null,
    },
    notifications: { sms, push },
  };
}

export type PipelineHealth = ReturnType<typeof getPipelineHealth>;
