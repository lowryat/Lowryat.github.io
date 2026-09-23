import type { Express } from "express";
import type { Server } from "http";
import { timingSafeEqual } from "crypto";
import { api } from "@shared/routes";
import {
  addRecipientSchema,
  deleteRecipientSchema,
  sendAlertSchema,
  testPushSchema,
  tradingViewEventSchema,
  updateAlertSettingsSchema,
  updateRecipientSchema,
} from "@shared/alerts";
import {
  addDelivery,
  addRecipient,
  deleteRecipient,
  formatTradingViewMessage,
  getAlertStatus,
  getEnabledRecipients,
  getMetrics,
  getSettings,
  isCoolingDown,
  markSent,
  recordTradingViewEvent,
  updateDeliveryStatus,
  updateRecipient,
  updateSettings,
} from "./alerts";
import { diagnoseSmsProvider, sendSms, trackSmsDelivery, type SmsResult } from "./sms";
import { getPushStats, mirrorToPush, sendPush } from "./push";
import { generateAiExplanation, getHistory } from "./history";
import { getIntelligence } from "./intelligence";
import { getCachedMarketSnapshot, getMarketOperationsProgress, getMarketSourceHealth, startMarketCollection } from "./market";
import { getMarketBriefing, startBriefingCollection } from "./briefing";
import { getCoinbaseOperationsProgress, registerCoinbaseRoutes, startCoinbaseFeed } from "./coinbase";
import { registerCoinGlassRoutes, startCoinGlassCollection } from "./coinglass";
import { analysisAlertOwnerScopeMiddleware, confirmRecipientAnalysisImpact, getAlertOwnerScopeId, getAnalysisAlertOperationsProgress, isSameOriginMutation, registerAnalysisAlertRoutes, registerAnalysisAlertSourceAdapter, resolveTradingViewWebhookOwner, runWithAlertOwnerScopeAsync, startAnalysisAlertEvaluation } from "./analysis-alerts";
import { createCoinGlassAnalysisAlertAdapter } from "./coinglass-analysis";
import { registerQuantRoutes, startDailyHistoryCollection } from "./quant-routes";
import { getPipelineHealth } from "./pipeline-health";

const processStartedAt = Date.now();
const OPERATIONS_THRESHOLDS_MS = {
  marketCollection: 3 * 60_000,
  coinbaseWebSocket: 30_000,
  retention: 26 * 60 * 60_000,
  analysisAlertEvaluation: 3 * 60_000,
} as const;

type OperationsProcessStatus = {
  state: "healthy" | "unhealthy" | "starting" | "disabled";
  lastSuccessAt: string | null;
  ageMs: number | null;
  staleAfterMs: number;
  idle: boolean;
};

function operationsStatus(
  lastSuccessAt: number | null,
  staleAfterMs: number,
  options: { enabled?: boolean; idle?: boolean } = {},
): OperationsProcessStatus {
  const enabled = options.enabled ?? true;
  const now = Date.now();
  const ageMs = lastSuccessAt == null ? null : Math.max(0, now - lastSuccessAt);
  const state = !enabled
    ? "disabled"
    : lastSuccessAt == null
      ? now - processStartedAt <= staleAfterMs ? "starting" : "unhealthy"
      : ageMs! <= staleAfterMs ? "healthy" : "unhealthy";
  return {
    state,
    lastSuccessAt: lastSuccessAt == null ? null : new Date(lastSuccessAt).toISOString(),
    ageMs,
    staleAfterMs,
    idle: options.idle ?? false,
  };
}

export function isOperationsStatusAuthorized(provided: string | undefined): boolean {
  const expected = process.env.OPERATIONS_STATUS_TOKEN || process.env.SESSION_SECRET;
  if (!expected || !provided) return false;
  const token = provided.startsWith("Bearer ") ? provided.slice(7) : provided;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(token);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

/**
 * Record a delivery and follow its carrier receipt. Twilio's success response
 * only means "queued"; the receipt later flips the record to delivered or
 * undelivered (with an explained reason such as unregistered 10DLC).
 */
function recordLegacyDelivery(
  recipient: Parameters<typeof addDelivery>[0],
  preview: string,
  result: SmsResult,
): void {
  const delivery = addDelivery(recipient, preview, result.sent ? "sent" : "failed", result.error || null);
  if (result.sent && result.sid) {
    const ownerId = getAlertOwnerScopeId();
    trackSmsDelivery(result.sid, async (update) => {
      await updateDeliveryStatus(ownerId, delivery.id, update.status, update.error);
    });
  }
}

export function registerAnalysisAlertRecipientRoutes(app: Express): void {
  app.post(api.alerts.addRecipient.path, (req, res) => {
    const parsed = addRecipientSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid recipient" });
    }
    addRecipient(parsed.data.name, parsed.data.phone);
    res.status(201).json(getAlertStatus());
  });

  app.patch(api.alerts.updateRecipient.path, async (req, res) => {
    const parsed = updateRecipientSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid recipient update" });
    }
    const { confirmedAnalysisAlertRuleCount, replacementRecipientId, ...changes } = parsed.data;
    const impact = changes.enabled === false
      ? await confirmRecipientAnalysisImpact({
          ownerId: getAlertOwnerScopeId(),
          recipientId: req.params.id,
          action: "disable",
          confirmedRuleCount: confirmedAnalysisAlertRuleCount,
          replacementRecipientId,
        })
      : { outcome: "allowed" as const, affectedAnalysisRuleCount: 0, reassignedAnalysisRuleCount: 0 };
    if (impact.outcome === "warning") {
      const affectedAnalysisRuleCount = impact.affectedAnalysisRuleCount;
      return res.status(409).json({
        message: `Disabling this recipient will interrupt ${affectedAnalysisRuleCount} enabled analysis ${affectedAnalysisRuleCount === 1 ? "rule" : "rules"}.`,
        confirmationRequired: true,
        affectedAnalysisRuleCount,
      });
    }
    if (impact.outcome === "invalid_replacement") {
      return res.status(400).json({ message: "Select another enabled recipient for these rules." });
    }
    if (impact.outcome === "not_found") return res.status(404).json({ message: "Recipient not found" });
    const recipient = updateRecipient(req.params.id, changes);
    if (!recipient) return res.status(404).json({ message: "Recipient not found" });
    res.json({
      ...getAlertStatus(),
      affectedAnalysisRuleCount: impact.affectedAnalysisRuleCount,
      reassignedAnalysisRuleCount: impact.reassignedAnalysisRuleCount,
    });
  });

  app.delete(api.alerts.deleteRecipient.path, async (req, res) => {
    const parsed = deleteRecipientSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid recipient deletion" });
    }
    const impact = await confirmRecipientAnalysisImpact({
      ownerId: getAlertOwnerScopeId(),
      recipientId: req.params.id,
      action: "delete",
      confirmedRuleCount: parsed.data.confirmedAnalysisAlertRuleCount,
      replacementRecipientId: parsed.data.replacementRecipientId,
    });
    if (impact.outcome === "warning") {
      const affectedAnalysisRuleCount = impact.affectedAnalysisRuleCount;
      return res.status(409).json({
        message: `Deleting this recipient will interrupt ${affectedAnalysisRuleCount} enabled analysis ${affectedAnalysisRuleCount === 1 ? "rule" : "rules"}.`,
        confirmationRequired: true,
        affectedAnalysisRuleCount,
      });
    }
    if (impact.outcome === "invalid_replacement") {
      return res.status(400).json({ message: "Select another enabled recipient for these rules." });
    }
    if (impact.outcome === "not_found") return res.status(404).json({ message: "Recipient not found" });
    if (!deleteRecipient(req.params.id)) {
      return res.status(404).json({ message: "Recipient not found" });
    }
    res.json({
      ...getAlertStatus(),
      affectedAnalysisRuleCount: impact.affectedAnalysisRuleCount,
      reassignedAnalysisRuleCount: impact.reassignedAnalysisRuleCount,
    });
  });
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.use("/api/alerts", analysisAlertOwnerScopeMiddleware);
  const eventCounts = new Map<string, number>();
  const allowedEvents = new Set(["analysis_open", "tab_change", "range_change", "compare_change", "retry", "alert_create"]);
  let telemetryWindow = Date.now();
  let telemetryRequests = 0;
  app.post("/api/telemetry", (req, res) => {
    if (!isSameOriginMutation(req)) return res.status(403).json({ message: "Same-origin request required" });
    if (Date.now() - telemetryWindow > 60_000) {
      telemetryWindow = Date.now();
      telemetryRequests = 0;
    }
    if (++telemetryRequests > 300) return res.status(429).end();
    const event = req.body?.event;
    if (typeof event !== "string" || !allowedEvents.has(event)) return res.status(400).end();
    // Aggregate event names only: never store IPs, cookies, symbols, URLs, or arbitrary metadata.
    eventCounts.set(event, (eventCounts.get(event) ?? 0) + 1);
    res.status(204).end();
  });
  startMarketCollection();
  startBriefingCollection();
  startDailyHistoryCollection();
  registerCoinbaseRoutes(app);
  startCoinbaseFeed();
  registerCoinGlassRoutes(app);
  if (process.env.COINGLASS_API_KEY) startCoinGlassCollection();
  registerAnalysisAlertRoutes(app);
  registerAnalysisAlertSourceAdapter("coinglass", createCoinGlassAnalysisAlertAdapter());
  startAnalysisAlertEvaluation();
  registerQuantRoutes(app);

  app.get("/api/operations/status", (req, res) => {
    const credential = req.header("authorization") || req.header("x-operations-token");
    if (!isOperationsStatusAuthorized(credential)) {
      return res.status(401).json({ message: "Operations status authentication failed" });
    }
    const market = getMarketOperationsProgress();
    const coinbase = getCoinbaseOperationsProgress();
    const alerts = getAnalysisAlertOperationsProgress();
    const processes = {
      marketCollection: operationsStatus(market.collectionLastSuccessAt, OPERATIONS_THRESHOLDS_MS.marketCollection),
      coinbaseWebSocket: operationsStatus(
        coinbase.lastSuccessAt,
        OPERATIONS_THRESHOLDS_MS.coinbaseWebSocket,
        { enabled: coinbase.started },
      ),
      retention: operationsStatus(
        market.retentionLastSuccessAt,
        OPERATIONS_THRESHOLDS_MS.retention,
        { enabled: market.retentionEnabled },
      ),
      analysisAlertEvaluation: operationsStatus(
        alerts.lastSuccessAt,
        OPERATIONS_THRESHOLDS_MS.analysisAlertEvaluation,
        { enabled: alerts.enabled, idle: alerts.idle },
      ),
    };
    const healthy = Object.values(processes).every((process) =>
      process.state === "healthy" || process.state === "starting" || process.state === "disabled",
    );
    res.status(healthy ? 200 : 503).json({
      status: healthy ? "healthy" : "unhealthy",
      checkedAt: new Date().toISOString(),
      processes,
    });
  });

  /** Public, secret-free pipeline view used by the Data Health panel. */
  app.get("/api/health/pipeline", (_req, res) => {
    res.set("Cache-Control", "no-store").json(getPipelineHealth());
  });

  app.get(api.data.get.path, async (req, res) => {
    const result = getCachedMarketSnapshot();
    if (!result) {
      return res.status(503).json({
        message: "Market collection has not produced a complete normalized snapshot yet.",
        sourceHealth: getMarketSourceHealth(),
      });
    }
    res.status(200).json(result);
  });

  app.get(api.briefing.get.path, (_req, res) => {
    const briefing = getMarketBriefing();
    if (!briefing) {
      return res.status(503).json({
        message: "Market collection has not produced a normalized snapshot yet.",
      });
    }
    res.status(200).json(briefing);
  });

  app.get(api.history.get.path, async (req, res) => {
    const parsed = api.history.get.query.safeParse({
      symbol: typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : req.query.symbol,
      metric: req.query.metric,
      range: req.query.range,
    });
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid history query" });
    }
    try {
      res.json(await getHistory(parsed.data));
    } catch (error) {
      res.status(500).json({
        message: error instanceof Error ? error.message : "Unable to load metric history",
      });
    }
  });

  app.get(api.intelligence.get.path, async (req, res) => {
    const parsed = api.intelligence.get.query.safeParse({
      symbol: typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : req.query.symbol,
      range: req.query.range ?? "24h",
    });
    if (!parsed.success) return res.status(400).json({ message: "Invalid intelligence query" });
    try {
      res.json(await getIntelligence(parsed.data.symbol, parsed.data.range));
    } catch (error) {
      res.status(500).json({
        message: error instanceof Error ? error.message : "Unable to calculate market intelligence",
      });
    }
  });

  /** Per-IP rate limit: max 5 AI interpretation calls per minute per client. */
  const ipBuckets = new Map<string, { count: number; resetAt: number }>();
  function consumeIpToken(ip: string): boolean {
    const now = Date.now();
    ipBuckets.forEach((value, key) => { if (value.resetAt <= now) ipBuckets.delete(key); });
    if (!ipBuckets.has(ip) && ipBuckets.size >= 10_000) return false;
    const bucket = ipBuckets.get(ip);
    if (!bucket || now >= bucket.resetAt) {
      ipBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (bucket.count >= 5) return false;
    bucket.count += 1;
    return true;
  }

  app.get(api.history.interpretation.path, async (req, res) => {
    const parsed = api.history.interpretation.query.safeParse({
      symbol: typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : req.query.symbol,
      metric: req.query.metric,
      range: req.query.range,
    });
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid interpretation query" });
    }

    const clientIp = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
      ?? req.socket.remoteAddress
      ?? "unknown";
    if (!consumeIpToken(clientIp)) {
      return res.status(429).json({ message: "Too many interpretation requests" });
    }

    const { symbol, metric, range } = parsed.data;
    try {
      // Derive all model context server-side from the trusted history result.
      const historyResult = await getHistory({ symbol, metric, range });
      const { currentValue, changePercent, confidence, dataPoints } = historyResult.summary;
      const interpretation = await generateAiExplanation({
        symbol,
        metric,
        range,
        currentValue,
        changePercent,
        confidence,
        dataPoints,
      });
      res.json({ interpretation });
    } catch {
      res.json({ interpretation: null });
    }
  });

  app.get(api.alerts.get.path, (_req, res) => {
    res.json(getAlertStatus());
  });

  // Twilio lookups cost API calls; a handful of manual checks per minute is plenty.
  let diagnosticsWindow = Date.now();
  let diagnosticsRequests = 0;
  app.get("/api/alerts/diagnostics", async (_req, res) => {
    if (Date.now() - diagnosticsWindow > 60_000) {
      diagnosticsWindow = Date.now();
      diagnosticsRequests = 0;
    }
    if (++diagnosticsRequests > 6) return res.status(429).json({ message: "Diagnostics were run recently; try again in a minute." });
    try {
      const checks = await diagnoseSmsProvider();
      const push = getPushStats();
      res.json({
        checkedAt: new Date().toISOString(),
        checks,
        push: { configured: push.configured, sent: push.sent, failed: push.failed, lastError: push.lastError, lastSentAt: push.lastSentAt },
      });
    } catch (error) {
      res.status(503).json({ message: `Diagnostics unavailable: ${error instanceof Error ? error.message : "unknown error"}` });
    }
  });

  let testPushWindow = Date.now();
  let testPushRequests = 0;
  app.post("/api/alerts/test-push", async (req, res) => {
    if (!isSameOriginMutation(req)) return res.status(403).json({ message: "Same-origin request required" });
    if (Date.now() - testPushWindow > 60_000) {
      testPushWindow = Date.now();
      testPushRequests = 0;
    }
    if (++testPushRequests > 3) return res.status(429).json({ message: "Test pushes are limited to three per minute." });
    const parsed = testPushSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid test message" });
    const result = await sendPush("LIQ-INTEL test", parsed.data.message || "Push notifications are working.", { priority: "default" });
    if (!result.sent) return res.status(503).json({ message: result.error || "Push notification failed." });
    res.json({ message: "Test push sent. Check the ntfy app on your phone." });
  });

  registerAnalysisAlertRecipientRoutes(app);

  app.patch(api.alerts.updateSettings.path, (req, res) => {
    const parsed = updateAlertSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid alert settings" });
    }
    updateSettings(parsed.data);
    res.json(getAlertStatus());
  });

  app.get(api.alerts.metrics.path, (_req, res) => {
    res.json(getMetrics());
  });

  app.post(api.alerts.send.path, async (req, res) => {
    const parsed = sendAlertSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid alert" });
    }

    const recipients = getEnabledRecipients(parsed.data.recipientIds);
    if (!recipients.length) {
      return res.status(400).json({ message: "Add or enable at least one recipient first." });
    }
    // Check the cooldown without consuming it: a failed attempt must stay retryable.
    if (isCoolingDown(parsed.data.dedupeKey)) {
      return res.status(429).json({ message: "This alert was already sent recently." });
    }

    const message = parsed.data.message ||
      `${parsed.data.insight!.headline}${parsed.data.insight!.detail ? ` — ${parsed.data.insight!.detail}` : ""}`;
    const preview = message.length > 96 ? `${message.slice(0, 93)}...` : message;
    const results = await Promise.all(recipients.map(async (recipient) => {
      const result = await sendSms(recipient.phone, message);
      recordLegacyDelivery(recipient, preview, result);
      return result;
    }));
    const sent = results.filter((result) => result.sent).length;
    const failed = results.length - sent;
    if (sent > 0) markSent(parsed.data.dedupeKey);
    mirrorToPush("LIQ-INTEL alert", message);
    const responseMessage = failed
      ? `${sent} accepted by Twilio, ${failed} failed. ${results.find((result) => !result.sent)?.error || ""}`.trim()
      : `${sent} message${sent === 1 ? "" : "s"} accepted by Twilio. Delivery receipts update in the log below.`;
    res.json({ status: getAlertStatus(), message: responseMessage });
  });

  app.post(api.webhooks.tradingview.path, async (req, res) => {
    const expectedSecret = process.env.TRADINGVIEW_WEBHOOK_SECRET || process.env.SESSION_SECRET;
    const providedSecret = req.header("x-webhook-secret");
    if (!expectedSecret || typeof providedSecret !== "string") {
      return res.status(401).json({ message: "Webhook authentication failed" });
    }
    const expected = Buffer.from(expectedSecret);
    const provided = Buffer.from(providedSecret);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      return res.status(401).json({ message: "Webhook authentication failed" });
    }
    const ownerId = resolveTradingViewWebhookOwner(req.body?.ownerToken);
    if (!ownerId) return res.status(401).json({ message: "Owner webhook token required" });

    const parsed = tradingViewEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid TradingView event" });
    }

    try {
      await runWithAlertOwnerScopeAsync(ownerId, async () => {
        const metric = recordTradingViewEvent(parsed.data);
        // TradingView gives webhooks about three seconds. Acknowledge first,
        // then send, so slow SMS delivery never looks like a failed webhook.
        res.status(202).json({ accepted: true, metric });
        const alertSettings = getSettings();
        const dedupeKey = `tradingview:${parsed.data.symbol}:${parsed.data.event}`;
        if (alertSettings.tradingviewAlertsEnabled && !isCoolingDown(dedupeKey)) {
          const recipients = getEnabledRecipients();
          const message = formatTradingViewMessage(parsed.data, metric);
          const results = await Promise.all(recipients.map(async (recipient) => {
            const result = await sendSms(recipient.phone, message);
            recordLegacyDelivery(recipient, message, result);
            return result;
          }));
          if (results.some((result) => result.sent)) markSent(dedupeKey);
          mirrorToPush(`LIQ-INTEL ${parsed.data.symbol.toUpperCase()}`, message);
        }
      });
    } catch (error) {
      if (!res.headersSent) {
        res.status(400).json({ message: error instanceof Error ? error.message : "Could not process event" });
      } else {
        console.warn("[tradingview] post-acknowledgement delivery failed:", error instanceof Error ? error.message : error);
      }
    }
  });

  return httpServer;
}

