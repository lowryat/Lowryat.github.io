import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import type { Express, Request, RequestHandler, Response } from "express";
import type { PoolClient } from "pg";
import {
  analysisAlertConditionSchema,
  createAnalysisAlertSchema,
  previewAnalysisAlertSchema,
  updateAnalysisAlertSchema,
  type AnalysisAlertCondition,
  type AnalysisAlertDeliveryAttempt,
  type AnalysisAlertDeliveryChannel,
  type AnalysisAlertDeliveryDiagnostic,
  type AnalysisAlertDeliveryStatus,
  type AnalysisAlertDestinationState,
  type AnalysisAlertMetric,
  type AnalysisAlertResult,
  type AnalysisAlertRule,
  type AnalysisAlertSource,
} from "@shared/analysis-alerts";
import type { HistoryMetric, HistoryRange } from "@shared/history";
import type { IntelligenceMetricKey } from "@shared/intelligence";
import { getHistory } from "./history";
import { startCoinGlassCollection } from "./coinglass";
import { getIntelligence } from "./intelligence";
import { normalizeSmsFailure, sendSms, trackSmsDelivery } from "./sms";
import { getPool } from "./db";
import { mirrorToPush } from "./push";
import { mapWithConcurrency, TtlCache, withDeadline } from "./resilience";

export type { AnalysisAlertMetric } from "@shared/analysis-alerts";

const OWNER_COOKIE = "analysis_alert_owner";
const COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 180;
const EVALUATION_INTERVAL_MS = 60_000;
const MAX_OBSERVATION_AGE_MS = 15 * 60_000;
const ephemeralSigningKey = randomBytes(32).toString("base64url");
const ownerScope = new AsyncLocalStorage<{ ownerId: string }>();
export const SYSTEM_ALERT_OWNER_ID = "__system_tradingview__";
type LegacyAlertPersistence = {
  hydrate(ownerId: string): Promise<void>;
  flush(ownerId: string): Promise<void>;
};
let legacyAlertPersistence: LegacyAlertPersistence | null = null;
let lastEvaluationSuccessAt: number | null = null;
let lastEvaluationWasIdle = true;

// Shared, hardened pool (connect/query timeouts, idle-error handler).
const pool = getPool();
/** Rules evaluated in parallel; a slow source can no longer fan out to 500 concurrent queries. */
const EVALUATION_CONCURRENCY = 8;
/** One evaluation pass always releases its in-flight flag within this window. */
const EVALUATION_DEADLINE_MS = 50_000;
/** A single source lookup that exceeds this is recorded as an evaluation error. */
const OBSERVATION_TIMEOUT_MS = 15_000;

type RuleRow = {
  id: string;
  owner_id: string;
  source: AnalysisAlertSource;
  symbol: string;
  metric: AnalysisAlertMetric;
  window: HistoryRange;
  condition: AnalysisAlertCondition;
  threshold: number;
  cooldown_seconds: number;
  enabled: boolean;
  last_value: number | null;
  last_observed_at: Date | string | null;
  last_evaluated_at: Date | string | null;
  last_triggered_at: Date | string | null;
  last_result: AnalysisAlertResult | null;
  last_result_detail: string | null;
  delivery_channel: AnalysisAlertDeliveryChannel;
  delivery_recipient_id: string | null;
  recipient_id?: string | null;
  recipient_phone?: string | null;
  recipient_enabled?: boolean | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type AnalysisAlertDeliveryRow = {
  id: string;
  event_id: string;
  status: AnalysisAlertDeliveryStatus;
  error: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
};

function publicDeliveryError(status: AnalysisAlertDeliveryStatus, error: string | null): string | null {
  if (status === "failed" || status === "undelivered") {
    return normalizeSmsFailure(error)?.message ?? "SMS delivery could not be completed.";
  }
  if (status === "rate_limited") return "SMS delivery was rate limited by the rule cooldown.";
  return null;
}

function publicDeliveryDiagnostic(
  status: AnalysisAlertDeliveryStatus,
  error: string | null,
): AnalysisAlertDeliveryDiagnostic | null {
  if (status !== "failed" && status !== "undelivered") return null;
  const failure = normalizeSmsFailure(error);
  return failure
    ? {
      category: failure.category,
      message: failure.message,
      recoveryAction: failure.recoveryAction,
    }
    : null;
}

type SourceObservation = {
  currentValue: number | null;
  previousValue: number | null;
  observedAt: Date | null;
  detail?: string;
};

export type AnalysisAlertSourceAdapter = {
  getObservation(input: {
    symbol: string;
    metric: AnalysisAlertMetric;
    window: HistoryRange;
  }): Promise<SourceObservation>;
};

const sourceAdapters = new Map<AnalysisAlertSource, AnalysisAlertSourceAdapter>();

/**
 * Lets a CoinGlass integration register its adapter without coupling this
 * module to an optional provider. Until registered, CoinGlass rules record an
 * explicit skipped_source_unavailable result rather than falling back silently.
 */
export function registerAnalysisAlertSourceAdapter(source: AnalysisAlertSource, adapter: AnalysisAlertSourceAdapter) {
  sourceAdapters.set(source, adapter);
}

const historyAdapter: AnalysisAlertSourceAdapter = {
  async getObservation({ symbol, metric, window }) {
    const history = await getHistory({ symbol, metric: metric as HistoryMetric, range: window });
    const points = history.points;
    const current = points.at(-1);
    const previous = points.length > 1 ? points.at(-2) : null;
    return {
      currentValue: current?.value ?? null,
      previousValue: previous?.value ?? null,
      observedAt: current ? new Date(current.timestamp) : null,
      detail: history.summary.explanation,
    };
  },
};
sourceAdapters.set("history", historyAdapter);

/** Rules on the same symbol/window share one intelligence computation per 30 seconds. */
const intelligenceCache = new TtlCache<string, Awaited<ReturnType<typeof getIntelligence>>>(30_000, 200);

const intelligenceAdapter: AnalysisAlertSourceAdapter = {
  async getObservation({ symbol, metric, window }) {
    const intelligence = await intelligenceCache.get(`${symbol}:${window}`, () => getIntelligence(symbol, window));
    const selected = intelligence.metrics.find((item) => item.key === metric as IntelligenceMetricKey);
    const observedAt = selected?.observedAt ? new Date(selected.observedAt) : null;
    return {
      currentValue: selected?.value ?? null,
      previousValue: null,
      observedAt,
      detail: selected?.gaps.join(" ") || intelligence.gaps.join(" ") || undefined,
    };
  },
};
sourceAdapters.set("intelligence", intelligenceAdapter);

const coinGlassAdapter: AnalysisAlertSourceAdapter = {
  async getObservation({ symbol, metric, window }) {
    const key = metric as "fundingRate" | "openInterestUsd" | "longLiquidationsUsd" | "shortLiquidationsUsd" | "longShortAccountRatio";
    const response = await startCoinGlassCollection().get(symbol, window);
    const usable = response.series
      .map((point) => ({ value: point[key], observedAt: new Date(point.time) }))
      .filter((point): point is { value: number; observedAt: Date } => point.value != null && Number.isFinite(point.value) && Number.isFinite(point.observedAt.getTime()));
    const current = usable.at(-1);
    const previous = usable.length > 1 ? usable.at(-2) : null;
    return {
      currentValue: current?.value ?? null,
      previousValue: previous?.value ?? null,
      observedAt: current?.observedAt ?? null,
      detail: response.status.error?.message,
    };
  },
};
sourceAdapters.set("coinglass", coinGlassAdapter);

function iso(value: Date | string | null): string | null {
  return value == null ? null : new Date(value).toISOString();
}

export function getAnalysisAlertDestinationState(input: {
  deliveryChannel: AnalysisAlertDeliveryChannel;
  deliveryRecipientId: string | null;
  recipientExists: boolean;
  recipientEnabled: boolean;
}): AnalysisAlertDestinationState {
  if (input.deliveryChannel !== "sms") return "not_applicable";
  if (!input.deliveryRecipientId) return "unconfigured";
  if (!input.recipientExists) return "deleted";
  return input.recipientEnabled ? "configured" : "disabled";
}

export function mergeAnalysisAlertDeliveryConfig(
  existing: {
    deliveryChannel: AnalysisAlertDeliveryChannel;
    deliveryRecipientId: string | null;
  },
  update: {
    deliveryChannel?: AnalysisAlertDeliveryChannel;
    deliveryRecipientId?: string;
  },
) {
  const deliveryChannel = update.deliveryChannel ?? existing.deliveryChannel;
  return {
    deliveryChannel,
    deliveryRecipientId: deliveryChannel === "in_app"
      ? undefined
      : update.deliveryRecipientId ?? existing.deliveryRecipientId ?? undefined,
  };
}

export function countsTowardAnalysisAlertCooldown(input: {
  status: AnalysisAlertDeliveryStatus;
  destination: string;
}): boolean {
  // A failed or undelivered attempt never reached the phone, so it must not
  // suppress the next delivery (or a manual retry) for the cooldown window.
  return ["pending", "sent", "delivered"].includes(input.status)
    && !["unconfigured", "disabled", "deleted"].includes(input.destination);
}

function ruleFromRow(row: RuleRow): AnalysisAlertRule {
  const deliveryDestinationState = getAnalysisAlertDestinationState({
    deliveryChannel: row.delivery_channel,
    deliveryRecipientId: row.delivery_recipient_id,
    recipientExists: Boolean(row.recipient_id),
    recipientEnabled: Boolean(row.recipient_enabled),
  });
  return {
    id: row.id,
    source: row.source,
    symbol: row.symbol,
    metric: row.metric,
    window: row.window,
    condition: row.condition,
    threshold: Number(row.threshold),
    cooldownSeconds: row.cooldown_seconds,
    enabled: row.enabled,
    lastValue: row.last_value == null ? null : Number(row.last_value),
    lastObservedAt: iso(row.last_observed_at),
    lastEvaluatedAt: iso(row.last_evaluated_at),
    lastTriggeredAt: iso(row.last_triggered_at),
    lastResult: row.last_result,
    lastResultDetail: row.last_result_detail,
    deliveryChannel: row.delivery_channel,
    deliveryRecipientId: row.delivery_recipient_id ?? undefined,
    deliveryPhoneDisplay: row.recipient_phone ? maskDeliveryPhone(row.recipient_phone) : null,
    deliveryDestinationState,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function maskDeliveryPhone(phone: string): string {
  return phone.length < 8 ? "••••" : `${phone.slice(0, 3)}••••${phone.slice(-2)}`;
}

type AnalysisAlertRecipient = {
  id: string;
  phone: string;
  enabled: boolean;
};

type AnalysisAlertQuery = Pick<PoolClient, "query">;

export async function withAnalysisAlertOwnerMutation<T>(
  ownerId: string,
  callback: (query: AnalysisAlertQuery) => Promise<T>,
): Promise<T> {
  if (!pool) throw new Error("Analysis alert storage is unavailable.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [ownerId]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function findAnalysisAlertRecipient(
  ownerId: string,
  recipientId: string,
  query: AnalysisAlertQuery = pool!,
): Promise<AnalysisAlertRecipient | null> {
  if (!pool) return null;
  const result = await query.query<AnalysisAlertRecipient>(
    `SELECT id, phone, enabled
       FROM legacy_alert_recipients
      WHERE id = $1 AND owner_id = $2`,
    [recipientId, ownerId],
  );
  return result.rows[0] ?? null;
}

export async function countEnabledSmsAnalysisRulesForRecipient(
  recipientId: string,
  ownerId = getAlertOwnerScopeId(),
  query: AnalysisAlertQuery = pool!,
): Promise<number> {
  if (!pool) return 0;
  const result = await query.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM analysis_alert_rules
      WHERE owner_id = $1
        AND delivery_recipient_id = $2
        AND delivery_channel = 'sms'
        AND enabled = true`,
    [ownerId, recipientId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function confirmRecipientAnalysisImpact(input: {
  ownerId: string;
  recipientId: string;
  action: "disable" | "delete";
  confirmedRuleCount?: number;
  replacementRecipientId?: string;
}): Promise<
  | { outcome: "allowed"; affectedAnalysisRuleCount: number; reassignedAnalysisRuleCount: number }
  | { outcome: "warning"; affectedAnalysisRuleCount: number }
  | { outcome: "not_found"; affectedAnalysisRuleCount: 0 }
  | { outcome: "invalid_replacement"; affectedAnalysisRuleCount: number }
> {
  if (!pool) return { outcome: "allowed", affectedAnalysisRuleCount: 0, reassignedAnalysisRuleCount: 0 };
  return withAnalysisAlertOwnerMutation(input.ownerId, async (query) => {
    const recipient = await query.query<{ id: string }>(
      `SELECT id FROM legacy_alert_recipients
        WHERE id = $1 AND owner_id = $2
        FOR UPDATE`,
      [input.recipientId, input.ownerId],
    );
    if (!recipient.rows[0]) return { outcome: "not_found", affectedAnalysisRuleCount: 0 };

    const affectedAnalysisRuleCount = await countEnabledSmsAnalysisRulesForRecipient(
      input.recipientId,
      input.ownerId,
      query,
    );
    if (
      affectedAnalysisRuleCount > 0
      && input.confirmedRuleCount !== affectedAnalysisRuleCount
    ) {
      return { outcome: "warning", affectedAnalysisRuleCount };
    }

    let reassignedAnalysisRuleCount = 0;
    if (input.replacementRecipientId) {
      if (input.replacementRecipientId === input.recipientId) {
        return { outcome: "invalid_replacement", affectedAnalysisRuleCount };
      }
      const replacement = await query.query<{ id: string }>(
        `SELECT id FROM legacy_alert_recipients
          WHERE id = $1 AND owner_id = $2 AND enabled = true
          FOR UPDATE`,
        [input.replacementRecipientId, input.ownerId],
      );
      if (!replacement.rows[0]) {
        return { outcome: "invalid_replacement", affectedAnalysisRuleCount };
      }
      const reassigned = await query.query(
        `UPDATE analysis_alert_rules
            SET delivery_recipient_id = $1,
                updated_at = NOW()
          WHERE owner_id = $2
            AND delivery_recipient_id = $3
            AND delivery_channel = 'sms'
            AND enabled = true`,
        [input.replacementRecipientId, input.ownerId, input.recipientId],
      );
      reassignedAnalysisRuleCount = reassigned.rowCount ?? 0;
    }

    if (input.action === "disable") {
      await query.query(
        `UPDATE legacy_alert_recipients
            SET enabled = false
          WHERE id = $1 AND owner_id = $2`,
        [input.recipientId, input.ownerId],
      );
    } else {
      await query.query(
        "DELETE FROM legacy_alert_recipients WHERE id = $1 AND owner_id = $2",
        [input.recipientId, input.ownerId],
      );
    }
    return { outcome: "allowed", affectedAnalysisRuleCount, reassignedAnalysisRuleCount };
  });
}

async function requireEnabledAnalysisAlertRecipient(
  ownerId: string,
  recipientId: string,
  query: AnalysisAlertQuery = pool!,
): Promise<AnalysisAlertRecipient> {
  const recipient = await findAnalysisAlertRecipient(ownerId, recipientId, query);
  if (!recipient) throw new Error("Selected SMS recipient was not found.");
  if (!recipient.enabled) throw new Error("Selected SMS recipient is disabled.");
  return recipient;
}

const RULE_WITH_RECIPIENT_SELECT = `
  SELECT rule.*,
         recipient.id AS recipient_id,
         recipient.phone AS recipient_phone,
         recipient.enabled AS recipient_enabled
    FROM analysis_alert_rules rule
    LEFT JOIN legacy_alert_recipients recipient
      ON recipient.id = rule.delivery_recipient_id
     AND recipient.owner_id = rule.owner_id`;

async function findRuleForOwner(
  ruleId: string,
  ownerId: string,
  query: AnalysisAlertQuery = pool!,
): Promise<RuleRow | null> {
  if (!pool) return null;
  const result = await query.query<RuleRow>(
    `${RULE_WITH_RECIPIENT_SELECT} WHERE rule.id = $1 AND rule.owner_id = $2`,
    [ruleId, ownerId],
  );
  return result.rows[0] ?? null;
}

function cookieValue(req: Request, name: string): string | null {
  const target = `${name}=`;
  const part = (req.headers.cookie || "").split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(target));
  if (!part) return null;
  try {
    return decodeURIComponent(part.slice(target.length));
  } catch {
    return null;
  }
}

function signingKey(): string {
  // A deployment should set SESSION_SECRET. The process-local fallback remains
  // unguessable, but intentionally invalidates anonymous owners on restart.
  return process.env.SESSION_SECRET || process.env.ANALYSIS_ALERT_COOKIE_SECRET || ephemeralSigningKey;
}

function signOwner(ownerId: string): string {
  return createHmac("sha256", signingKey()).update(ownerId).digest("base64url");
}

function signTradingViewOwner(ownerId: string): string {
  return createHmac("sha256", signingKey()).update(`tradingview-owner:${ownerId}`).digest("base64url");
}

function validOwnerToken(token: string | null): string | null {
  if (!token) return null;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  const ownerId = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!/^[0-9a-f-]{36}$/i.test(ownerId)) return null;
  const expected = signOwner(ownerId);
  const given = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return given.length === expectedBuffer.length && timingSafeEqual(given, expectedBuffer) ? ownerId : null;
}

function issueOwner(res: Response): string {
  const ownerId = randomUUID();
  res.cookie(OWNER_COOKIE, `${ownerId}.${signOwner(ownerId)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    // Shared with the legacy /api/alerts control plane, never readable by JS.
    path: "/",
    maxAge: COOKIE_MAX_AGE_MS,
  });
  return ownerId;
}

function ownerForRead(req: Request, res: Response): string {
  return validOwnerToken(cookieValue(req, OWNER_COOKIE)) || issueOwner(res);
}

function ownerForMutation(req: Request): string | null {
  return validOwnerToken(cookieValue(req, OWNER_COOKIE));
}

/** Reject cross-origin state changes even if a browser happens to send cookies. */
export function isSameOriginMutation(req: Request): boolean {
  const fetchSite = req.header("sec-fetch-site");
  if (fetchSite === "same-origin") return true;
  const origin = req.header("origin");
  const host = req.header("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Current owner for the legacy in-memory SMS control plane. */
export function getAlertOwnerScopeId(): string {
  return ownerScope.getStore()?.ownerId ?? SYSTEM_ALERT_OWNER_ID;
}

/** Test/helper boundary for code that needs a deliberate non-request owner. */
export function runWithAlertOwnerScope<T>(ownerId: string, callback: () => T): T {
  return ownerScope.run({ ownerId }, callback);
}

/** Async variant used by the authenticated TradingView route after token lookup. */
export async function runWithAlertOwnerScopeAsync<T>(ownerId: string, callback: () => Promise<T>): Promise<T> {
  await legacyAlertPersistence?.hydrate(ownerId);
  try {
    return await ownerScope.run({ ownerId }, callback);
  } finally {
    await legacyAlertPersistence?.flush(ownerId);
  }
}

/** Registers durable legacy-SMS state hooks without a module import cycle. */
export function configureLegacyAlertPersistence(persistence: LegacyAlertPersistence): void {
  legacyAlertPersistence = persistence;
}

/**
 * Opaque, signed capability for a user's Pine payload. It does not reveal the
 * configured TradingView environment secret and is never issued for system
 * scope. The webhook route must still enforce its environment-secret check.
 */
export function getTradingViewWebhookToken(): string | null {
  const ownerId = getAlertOwnerScopeId();
  return ownerId === SYSTEM_ALERT_OWNER_ID ? null : `v1.${ownerId}.${signTradingViewOwner(ownerId)}`;
}

/** Verify a user capability carried in the authenticated TradingView payload. */
export function resolveTradingViewWebhookOwner(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^[0-9a-f-]{36}$/i.test(parts[1])) return null;
  const expected = Buffer.from(signTradingViewOwner(parts[1]));
  const received = Buffer.from(parts[2]);
  return expected.length === received.length && timingSafeEqual(expected, received) ? parts[1] : null;
}

/**
 * Apply this before legacy `/api/alerts` routes. Reads issue the same signed
 * HttpOnly owner cookie as analysis alerts; mutations additionally require a
 * same-origin request and an already-issued owner cookie.
 *
 * Do not apply it to `/api/webhooks/tradingview`: calls outside this middleware
 * deliberately resolve to SYSTEM_ALERT_OWNER_ID.
 */
export const analysisAlertOwnerScopeMiddleware: RequestHandler = (req, res, next) => {
  const mutation = req.method === "POST" || req.method === "PATCH" || req.method === "PUT" || req.method === "DELETE";
  if (mutation) {
    if (!isSameOriginMutation(req)) {
      res.status(403).json({ message: "Alert requests must originate from this application." });
      return;
    }
    const ownerId = ownerForMutation(req);
    if (!ownerId) {
      res.status(401).json({ message: "Open alerts before changing alert settings." });
      return;
    }
    void enterLegacyScope(ownerId, req, res, next, true);
    return;
  }
  void enterLegacyScope(ownerForRead(req, res), req, res, next, false);
};

async function enterLegacyScope(ownerId: string, req: Request, res: Response, next: () => void, flushBeforeResponse: boolean) {
  try {
    await legacyAlertPersistence?.hydrate(ownerId);
  } catch (error) {
    res.status(503).json({ message: `Alert storage is unavailable: ${error instanceof Error ? error.message : "unknown error"}` });
    return;
  }
  ownerScope.run({ ownerId }, () => {
    if (flushBeforeResponse && legacyAlertPersistence) deferResponseUntilFlushed(res, ownerId, legacyAlertPersistence);
    next();
  });
}

/** Serialize the durable owner snapshot before a successful mutation response. */
function deferResponseUntilFlushed(res: Response, ownerId: string, persistence: LegacyAlertPersistence) {
  const originalJson = res.json.bind(res);
  const originalEnd = res.end.bind(res);
  let deferred = false;
  const afterFlush = (send: () => void) => {
    if (deferred) return;
    deferred = true;
    void persistence.flush(ownerId).then(() => {
      res.json = originalJson;
      res.end = originalEnd;
      send();
    }).catch((error) => {
      res.json = originalJson;
      res.end = originalEnd;
      if (!res.headersSent) {
        res.status(503);
        originalJson({ message: `Alert storage write failed: ${error instanceof Error ? error.message : "unknown error"}` });
      }
    });
  };
  res.json = ((body: unknown) => {
    afterFlush(() => originalJson(body));
    return res;
  }) as Response["json"];
  res.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
    afterFlush(() => originalEnd(chunk as never, encoding as never, callback as never));
    return res;
  }) as Response["end"];
}

function databaseUnavailable(res: Response) {
  return res.status(503).json({ message: "Analysis alert storage is unavailable: DATABASE_URL is not configured." });
}

function predicate(condition: AnalysisAlertCondition, threshold: number, currentValue: number, previousValue?: number | null): boolean {
  switch (condition) {
    case "above":
      return currentValue > threshold;
    case "below":
      return currentValue < threshold;
    case "crossAbove":
      return previousValue != null && previousValue <= threshold && currentValue > threshold;
    case "crossBelow":
      return previousValue != null && previousValue >= threshold && currentValue < threshold;
  }
}

/** Pure predicate exported for focused threshold/crossover unit tests. */
export function matchesAnalysisAlertCondition(input: {
  condition: AnalysisAlertCondition;
  threshold: number;
  currentValue: number;
  previousValue?: number | null;
}): boolean {
  return predicate(input.condition, input.threshold, input.currentValue, input.previousValue);
}

/** Pure freshness guard exported for focused stale-observation unit tests. */
export function isStaleAnalysisAlertObservation(observedAt: Date | null, now = new Date()): boolean {
  return !observedAt || !Number.isFinite(observedAt.getTime()) || now.getTime() - observedAt.getTime() > MAX_OBSERVATION_AGE_MS;
}

async function updateEvaluation(
  rule: RuleRow,
  result: AnalysisAlertResult,
  detail: string,
  observation?: SourceObservation,
  triggered = false,
) {
  if (!pool) return;
  const now = new Date();
  await pool.query(
    `UPDATE analysis_alert_rules
       SET last_value = COALESCE($2, last_value),
           last_observed_at = COALESCE($3, last_observed_at),
           last_evaluated_at = $4,
           last_triggered_at = CASE WHEN $5 THEN $4 ELSE last_triggered_at END,
           last_result = $6,
           last_result_detail = $7,
           updated_at = $4
     WHERE id = $1`,
    [
      rule.id,
      observation?.currentValue ?? null,
      observation?.observedAt ?? null,
      now,
      triggered,
      result,
      detail.slice(0, 240),
    ],
  );
}

/** Compact, human-scale numbers for a text message (no 17-digit floats). */
export function formatAlertValue(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const magnitude = Math.abs(value);
  if (magnitude >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (magnitude >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (magnitude >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (magnitude >= 1e4) return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (magnitude >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (magnitude === 0) return "0";
  return value.toPrecision(3);
}

function analysisAlertMessage(rule: RuleRow, value: number, previousValue: number | null): string {
  const threshold = formatAlertValue(Number(rule.threshold));
  const comparison = rule.condition === "above"
    ? `above ${threshold}`
    : rule.condition === "below"
      ? `below ${threshold}`
      : rule.condition === "crossAbove"
        ? `crossed above ${threshold}`
        : `crossed below ${threshold}`;
  const previous = previousValue == null ? "" : ` (was ${formatAlertValue(previousValue)})`;
  const link = process.env.PUBLIC_APP_URL ? ` ${process.env.PUBLIC_APP_URL.replace(/\/+$/, "")}/?tab=alerts` : "";
  return `LIQ-INTEL alert: ${rule.symbol} ${rule.metric} ${comparison} [${rule.window}]. Now ${formatAlertValue(value)}${previous}.${link}`;
}

/**
 * Persist the delivery attempt before calling the provider. Provider failures
 * are recorded and intentionally swallowed so one unavailable SMS channel
 * cannot stop the evaluator from processing future observations.
 */
async function deliverAnalysisAlert(
  rule: RuleRow,
  eventId: string,
  value: number,
  previousValue: number | null,
  now: Date,
): Promise<AnalysisAlertDeliveryStatus | null> {
  if (!pool || rule.delivery_channel !== "sms") return null;

  const message = analysisAlertMessage(rule, value, previousValue);
  const attemptId = randomUUID();
  try {
    if (!rule.delivery_recipient_id) {
      await pool.query(
        `INSERT INTO analysis_alert_deliveries
          (id, owner_id, rule_id, event_id, channel, destination, status, error, created_at, completed_at)
         VALUES ($1, $2, $3, $4, 'sms', 'unconfigured', 'failed', $5, $6, $6)`,
         [attemptId, rule.owner_id, rule.id, eventId, "SMS delivery is enabled but no recipient is configured.", now],
      );
      return "failed";
    }
    const recipient = await findAnalysisAlertRecipient(rule.owner_id, rule.delivery_recipient_id);
    if (!recipient || !recipient.enabled) {
      const state = recipient ? "disabled" : "deleted";
      await pool.query(
        `INSERT INTO analysis_alert_deliveries
          (id, owner_id, rule_id, event_id, channel, destination, status, error, created_at, completed_at)
         VALUES ($1, $2, $3, $4, 'sms', $5, 'failed', $6, $7, $7)`,
        [
          attemptId,
          rule.owner_id,
          rule.id,
          eventId,
          state,
          `SMS recipient is ${state}. Select an enabled recipient before retrying.`,
          now,
        ],
      );
      return "failed";
    }
    const destination = recipient.phone;
    const recent = await pool.query<{ created_at: Date | string }>(
      `SELECT created_at
         FROM analysis_alert_deliveries
        WHERE rule_id = $1 AND channel = 'sms'
          AND status IN ('pending', 'sent', 'delivered')
          AND destination NOT IN ('unconfigured', 'disabled', 'deleted')
          AND created_at > $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [rule.id, new Date(now.getTime() - rule.cooldown_seconds * 1000)],
    );
    if (recent.rows[0]) {
      await pool.query(
        `INSERT INTO analysis_alert_deliveries
          (id, owner_id, rule_id, event_id, channel, destination, status, error, created_at, completed_at)
         VALUES ($1, $2, $3, $4, 'sms', $5, 'rate_limited', $6, $7, $7)`,
        [
          attemptId,
          rule.owner_id,
          rule.id,
          eventId,
          maskDeliveryPhone(destination),
          `SMS delivery rate limited by the ${rule.cooldown_seconds}-second rule cooldown.`,
          now,
        ],
      );
      return "rate_limited";
    }

    await pool.query(
      `INSERT INTO analysis_alert_deliveries
        (id, owner_id, rule_id, event_id, channel, destination, status, created_at)
       VALUES ($1, $2, $3, $4, 'sms', $5, 'pending', $6)`,
      [attemptId, rule.owner_id, rule.id, eventId, maskDeliveryPhone(destination), now],
    );

    const result = await sendSms(destination, message);
    const status = result.sent ? "sent" satisfies AnalysisAlertDeliveryStatus : "failed" satisfies AnalysisAlertDeliveryStatus;
    await pool.query(
      `UPDATE analysis_alert_deliveries
          SET status = $2, error = $3, completed_at = $4
        WHERE id = $1`,
      [
        attemptId,
        status,
        result.error || null,
        new Date(),
      ],
    );
    if (result.sent && result.sid) {
      // "sent" only means Twilio queued it. Record the carrier's receipt so an
      // unregistered-sender block (30034) or opt-out shows up as undelivered.
      const trackedPool = pool;
      trackSmsDelivery(result.sid, async (update) => {
        await trackedPool.query(
          `UPDATE analysis_alert_deliveries
              SET status = $2, error = $3, completed_at = $4
            WHERE id = $1 AND status IN ('sent', 'delivered')`,
          [attemptId, update.status, update.error, new Date()],
        );
      });
    }
    return status;
  } catch (error) {
    await pool.query(
      `UPDATE analysis_alert_deliveries
          SET status = 'failed', error = $2, completed_at = $3
        WHERE id = $1`,
      [attemptId, "SMS delivery could not be completed. Try again later.", new Date()],
    ).catch(() => undefined);
    return "failed";
  }
}

/**
 * Evaluate one persisted rule. Missing, stale, repeated, unavailable, and
 * cooldown states are persisted as explicit results; none can create a trigger.
 */
export async function evaluateAnalysisAlertRule(rule: RuleRow, now = new Date()): Promise<AnalysisAlertResult> {
  const adapter = sourceAdapters.get(rule.source);
  if (!adapter) {
    await updateEvaluation(rule, "skipped_source_unavailable", `No ${rule.source} analysis source is registered.`);
    return "skipped_source_unavailable";
  }

  let observation: SourceObservation;
  try {
    observation = await withDeadline(
      adapter.getObservation({ symbol: rule.symbol, metric: rule.metric, window: rule.window }),
      OBSERVATION_TIMEOUT_MS,
      `${rule.source} source lookup`,
    );
  } catch (error) {
    await updateEvaluation(rule, "evaluation_error", error instanceof Error ? error.message : "Unable to load analysis source.");
    return "evaluation_error";
  }

  if (observation.currentValue == null || !Number.isFinite(observation.currentValue)) {
    await updateEvaluation(rule, "skipped_missing", "The selected analysis source has no finite current value.", observation);
    return "skipped_missing";
  }
  if (isStaleAnalysisAlertObservation(observation.observedAt, now)) {
    await updateEvaluation(rule, "skipped_stale", "The latest observation is older than 15 minutes.", observation);
    return "skipped_stale";
  }

  const observedMs = observation.observedAt!.getTime();
  const previouslyObservedMs = rule.last_observed_at ? new Date(rule.last_observed_at).getTime() : null;
  if (previouslyObservedMs != null && Number.isFinite(previouslyObservedMs) && observedMs <= previouslyObservedMs) {
    await updateEvaluation(rule, "skipped_unchanged", "The latest observation was already evaluated.", observation);
    return "skipped_unchanged";
  }

  // Intelligence responses are a current computed value rather than a series;
  // its durable prior value supplies crossover comparison on a new observation.
  const previousValue = observation.previousValue ?? rule.last_value;
  if (!predicate(rule.condition, Number(rule.threshold), observation.currentValue, previousValue)) {
    await updateEvaluation(rule, "not_triggered", observation.detail || "Rule condition is not met.", observation);
    return "not_triggered";
  }

  const lastTriggerMs = rule.last_triggered_at ? new Date(rule.last_triggered_at).getTime() : 0;
  if (lastTriggerMs && now.getTime() - lastTriggerMs < rule.cooldown_seconds * 1000) {
    await updateEvaluation(rule, "cooldown", `Condition met; cooldown remains for ${Math.ceil((rule.cooldown_seconds * 1000 - (now.getTime() - lastTriggerMs)) / 1000)} seconds.`, observation);
    return "cooldown";
  }

  if (!pool) return "evaluation_error";
  try {
    const eventId = randomUUID();
    await pool.query(
      `INSERT INTO analysis_alert_events
        (id, owner_id, rule_id, source, symbol, metric, "window", condition, threshold, value, previous_value, channel, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        eventId, rule.owner_id, rule.id, rule.source, rule.symbol, rule.metric, rule.window,
        rule.condition, rule.threshold, observation.currentValue, previousValue, rule.delivery_channel, now,
      ],
    );
    await updateEvaluation(
      rule,
      "triggered",
      rule.delivery_channel === "sms"
        ? "Condition met. Added to the in-app trigger log and SMS delivery queue."
        : "Condition met. Added to the in-app trigger log.",
      observation,
      true,
    );
    mirrorToPush(
      `LIQ-INTEL: ${rule.symbol} ${rule.metric}`,
      analysisAlertMessage(rule, observation.currentValue, previousValue),
    );
    await deliverAnalysisAlert(rule, eventId, observation.currentValue, previousValue, now);
    return "triggered";
  } catch (error) {
    await updateEvaluation(rule, "evaluation_error", error instanceof Error ? error.message : "Unable to persist trigger.", observation);
    return "evaluation_error";
  }
}

export async function evaluateAnalysisAlerts(): Promise<void> {
  if (!pool || evaluationInFlight) return;
  evaluationInFlight = true;
  const activePool = pool;
  try {
    // The in-flight flag is always released: previously one hung source or
    // database call left it set forever and silently stopped every alert.
    await withDeadline((async () => {
      const { rows } = await activePool.query<RuleRow>(
        `SELECT * FROM analysis_alert_rules WHERE enabled = true ORDER BY updated_at ASC LIMIT 500`,
      );
      const now = new Date();
      await mapWithConcurrency(rows, EVALUATION_CONCURRENCY, (rule) =>
        evaluateAnalysisAlertRule(rule, now).catch((error) => {
          console.warn(`[analysis-alerts] rule ${rule.id} failed: ${error instanceof Error ? error.message : "unknown error"}`);
          return "evaluation_error" as const;
        }));
      lastEvaluationWasIdle = rows.length === 0;
      lastEvaluationSuccessAt = Date.now();
    })(), EVALUATION_DEADLINE_MS, "analysis alert evaluation");
  } finally {
    evaluationInFlight = false;
  }
}

export function getAnalysisAlertOperationsProgress(): {
  enabled: boolean;
  lastSuccessAt: number | null;
  idle: boolean;
} {
  return {
    enabled: pool !== null,
    lastSuccessAt: lastEvaluationSuccessAt,
    idle: lastEvaluationWasIdle,
  };
}

let evaluationTimer: NodeJS.Timeout | null = null;
let evaluationInFlight = false;

/** Starts one unref'd evaluator. The app bootstrap intentionally opts in. */
export function startAnalysisAlertEvaluation(): () => void {
  if (!evaluationTimer) {
    void evaluateAnalysisAlerts().catch(() => undefined);
    evaluationTimer = setInterval(() => void evaluateAnalysisAlerts().catch(() => undefined), EVALUATION_INTERVAL_MS);
    evaluationTimer.unref();
  }
  return () => {
    if (evaluationTimer) clearInterval(evaluationTimer);
    evaluationTimer = null;
  };
}

export function registerAnalysisAlertRoutes(app: Express) {
  app.get("/api/analysis-alerts", async (req, res) => {
    if (!pool) return databaseUnavailable(res);
    const ownerId = ownerForRead(req, res);
    try {
      const [ruleResult, eventResult] = await Promise.all([
        pool.query<RuleRow>(`${RULE_WITH_RECIPIENT_SELECT} WHERE rule.owner_id = $1 ORDER BY rule.created_at DESC`, [ownerId]),
        pool.query<{
          id: string;
          rule_id: string;
          source: AnalysisAlertSource;
          symbol: string;
          metric: AnalysisAlertMetric;
          window: HistoryRange;
          condition: AnalysisAlertCondition;
          threshold: number | string;
          value: number | string;
          previous_value: number | string | null;
          channel: AnalysisAlertDeliveryChannel;
          created_at: Date | string;
          delivery_status: AnalysisAlertDeliveryStatus;
          delivery_error: string | null;
          has_failed_delivery: boolean;
          has_successful_delivery: boolean;
        }>(
          `SELECT event.id, event.rule_id, event.source, event.symbol, event.metric, event."window",
                  event.condition, event.threshold, event.value, event.previous_value, event.channel, event.created_at,
                  COALESCE(delivery.status, CASE WHEN event.channel = 'in_app' THEN 'sent' ELSE 'pending' END) AS delivery_status,
                  delivery.error AS delivery_error,
                  EXISTS (
                    SELECT 1
                      FROM analysis_alert_deliveries failed_delivery
                     WHERE failed_delivery.event_id = event.id
                       AND failed_delivery.status IN ('failed', 'undelivered')
                  ) AS has_failed_delivery,
                  EXISTS (
                    SELECT 1
                      FROM analysis_alert_deliveries successful_delivery
                     WHERE successful_delivery.event_id = event.id
                       AND successful_delivery.status IN ('sent', 'delivered')
                  ) AS has_successful_delivery
             FROM analysis_alert_events event
             LEFT JOIN LATERAL (
               SELECT status, error
                 FROM analysis_alert_deliveries
                WHERE event_id = event.id
                ORDER BY created_at DESC
                LIMIT 1
             ) delivery ON true
            WHERE event.owner_id = $1
            ORDER BY event.created_at DESC
            LIMIT 50`,
          [ownerId],
        ),
      ]);
      const deliveryResult = eventResult.rows.length
        ? await pool.query<AnalysisAlertDeliveryRow>(
          `SELECT id, event_id, status, error, created_at, completed_at
             FROM analysis_alert_deliveries
            WHERE owner_id = $1
              AND event_id = ANY($2::uuid[])
            ORDER BY event_id, created_at, id`,
          [ownerId, eventResult.rows.map((event) => event.id)],
        )
        : { rows: [] as AnalysisAlertDeliveryRow[] };
      const deliveriesByEvent = new Map<string, AnalysisAlertDeliveryAttempt[]>();
      for (const delivery of deliveryResult.rows) {
        const attempts = deliveriesByEvent.get(delivery.event_id) || [];
        attempts.push({
          id: delivery.id,
          attemptNumber: attempts.length + 1,
          status: delivery.status,
          error: publicDeliveryError(delivery.status, delivery.error),
          diagnostic: publicDeliveryDiagnostic(delivery.status, delivery.error),
          createdAt: iso(delivery.created_at)!,
          completedAt: iso(delivery.completed_at),
        });
        deliveriesByEvent.set(delivery.event_id, attempts);
      }
      res.json({
        rules: ruleResult.rows.map(ruleFromRow),
        events: eventResult.rows.map((event) => ({
          id: event.id,
          ruleId: event.rule_id,
          source: event.source,
          symbol: event.symbol,
          metric: event.metric,
          window: event.window,
          condition: event.condition,
          threshold: Number(event.threshold),
          value: Number(event.value),
          previousValue: event.previous_value == null ? null : Number(event.previous_value),
          channel: event.channel,
          deliveryStatus: event.delivery_status,
          deliveryError: publicDeliveryError(event.delivery_status, event.delivery_error),
          deliveryDiagnostic: publicDeliveryDiagnostic(event.delivery_status, event.delivery_error),
          deliveryAttempts: deliveriesByEvent.get(event.id) || [],
          retryable: event.channel === "sms" && event.has_failed_delivery && !event.has_successful_delivery,
          createdAt: iso(event.created_at)!,
        })),
      });
    } catch (error) {
      res.status(503).json({ message: `Analysis alert storage is unavailable: ${error instanceof Error ? error.message : "unknown error"}` });
    }
  });

  app.post("/api/analysis-alerts/events/:id/retry", async (req, res) => {
    if (!pool) return databaseUnavailable(res);
    if (!isSameOriginMutation(req)) return res.status(403).json({ message: "Analysis alert requests must originate from this application." });
    const ownerId = ownerForMutation(req);
    if (!ownerId) return res.status(401).json({ message: "Open analysis alerts before retrying a delivery." });
    if (!zUuid(req.params.id)) return res.status(400).json({ message: "Invalid analysis alert event ID." });

    try {
      const eventResult = await pool.query<{
        id: string;
        rule_id: string;
        channel: AnalysisAlertDeliveryChannel;
        value: number | string;
        previous_value: number | string | null;
        delivery_status: AnalysisAlertDeliveryStatus | null;
        has_failed_delivery: boolean;
        has_successful_delivery: boolean;
      }>(
        `SELECT event.id, event.rule_id, event.channel, event.value, event.previous_value,
                delivery.status AS delivery_status,
                EXISTS (
                  SELECT 1
                    FROM analysis_alert_deliveries failed_delivery
                   WHERE failed_delivery.event_id = event.id
                     AND failed_delivery.status IN ('failed', 'undelivered')
                ) AS has_failed_delivery,
                EXISTS (
                  SELECT 1
                    FROM analysis_alert_deliveries successful_delivery
                   WHERE successful_delivery.event_id = event.id
                     AND successful_delivery.status IN ('sent', 'delivered')
                ) AS has_successful_delivery
           FROM analysis_alert_events event
           LEFT JOIN LATERAL (
             SELECT status
               FROM analysis_alert_deliveries
              WHERE event_id = event.id
              ORDER BY created_at DESC
              LIMIT 1
           ) delivery ON true
          WHERE event.id = $1 AND event.owner_id = $2`,
        [req.params.id, ownerId],
      );
      const event = eventResult.rows[0];
      if (!event) return res.status(404).json({ message: "Analysis alert event not found." });
      if (event.channel !== "sms") return res.status(400).json({ message: "Only SMS deliveries can be retried." });
      if (
        !event.has_failed_delivery
        || event.has_successful_delivery
        || !["failed", "rate_limited", "undelivered"].includes(event.delivery_status || "")
      ) {
        return res.status(409).json({ message: "Only failed SMS deliveries can be retried." });
      }

      const rule = await findRuleForOwner(event.rule_id, ownerId);
      if (!rule) return res.status(404).json({ message: "Analysis alert rule not found." });

      const deliveryStatus = await deliverAnalysisAlert(
        rule,
        event.id,
        Number(event.value),
        event.previous_value == null ? null : Number(event.previous_value),
        new Date(),
      );
      if (!deliveryStatus) return res.status(503).json({ message: "SMS delivery is unavailable." });
      res.json({ deliveryStatus });
    } catch (error) {
      res.status(503).json({ message: `Unable to retry SMS delivery: ${error instanceof Error ? error.message : "unknown error"}` });
    }
  });

  app.post("/api/analysis-alerts/preview", (req, res) => {
    if (!isSameOriginMutation(req) || !ownerForMutation(req)) {
      return res.status(403).json({ message: "Analysis alert requests must originate from this application." });
    }
    const parsed = previewAnalysisAlertSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid alert preview." });
    const { currentValue, previousValue, condition, threshold } = parsed.data;
    res.json({
      matched: predicate(condition, threshold, currentValue, previousValue),
      message: `Current value ${currentValue} ${predicate(condition, threshold, currentValue, previousValue) ? "matches" : "does not match"} this rule.`,
    });
  });

  app.post("/api/analysis-alerts", async (req, res) => {
    if (!pool) return databaseUnavailable(res);
    if (!isSameOriginMutation(req)) return res.status(403).json({ message: "Analysis alert requests must originate from this application." });
    const ownerId = ownerForMutation(req);
    if (!ownerId) return res.status(401).json({ message: "Open analysis alerts before creating a rule." });
    const parsed = createAnalysisAlertSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid analysis alert." });
    const input = parsed.data;
    try {
      const row = await withAnalysisAlertOwnerMutation(ownerId, async (query) => {
        const recipient = input.deliveryChannel === "sms"
          ? await requireEnabledAnalysisAlertRecipient(ownerId, input.deliveryRecipientId!, query)
          : null;
        const now = new Date();
        const next: RuleRow = {
          id: randomUUID(),
          owner_id: ownerId,
          source: input.source,
          symbol: input.symbol,
          metric: input.metric,
          window: input.window,
          condition: input.condition,
          threshold: input.threshold,
          cooldown_seconds: input.cooldownSeconds,
          delivery_channel: input.deliveryChannel,
          delivery_recipient_id: input.deliveryChannel === "sms" ? input.deliveryRecipientId! : null,
          recipient_id: recipient?.id ?? null,
          recipient_phone: recipient?.phone ?? null,
          recipient_enabled: recipient?.enabled ?? null,
          enabled: input.enabled,
          last_value: null, last_observed_at: null, last_evaluated_at: null, last_triggered_at: null,
          last_result: "not_evaluated", last_result_detail: "Awaiting first evaluation.", created_at: now, updated_at: now,
        };
        await query.query(
          `INSERT INTO analysis_alert_rules
            (id, owner_id, source, symbol, metric, "window", condition, threshold, cooldown_seconds, enabled, delivery_channel, delivery_recipient_id, last_result, last_result_detail, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
          [
            next.id, next.owner_id, next.source, next.symbol, next.metric, next.window, next.condition,
            next.threshold, next.cooldown_seconds, next.enabled, next.delivery_channel, next.delivery_recipient_id,
            next.last_result, next.last_result_detail, now,
          ],
        );
        return next;
      });
      res.status(201).json({ rule: ruleFromRow(row) });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Selected SMS recipient")) {
        return res.status(400).json({ message: error.message });
      }
      res.status(503).json({ message: `Unable to save analysis alert: ${error instanceof Error ? error.message : "unknown error"}` });
    }
  });

  app.patch("/api/analysis-alerts/:id", async (req, res) => {
    if (!pool) return databaseUnavailable(res);
    if (!isSameOriginMutation(req)) return res.status(403).json({ message: "Analysis alert requests must originate from this application." });
    const ownerId = ownerForMutation(req);
    if (!ownerId) return res.status(401).json({ message: "Open analysis alerts before editing a rule." });
    if (!zUuid(req.params.id)) return res.status(400).json({ message: "Invalid analysis alert ID." });
    const parsed = updateAnalysisAlertSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid analysis alert update." });
    const input = parsed.data;
    const fields: Array<[string, unknown]> = [];
    const normalizedInput = input.deliveryChannel === "in_app"
      ? { ...input, deliveryRecipientId: null }
      : input;
    const columnMap: Record<string, string> = { cooldownSeconds: "cooldown_seconds" };
    for (const [key, value] of Object.entries(normalizedInput)) fields.push([columnMap[key] || key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value]);
    const values = fields.map(([, value]) => value);
    values.push(new Date(), req.params.id, ownerId);
    try {
      const saved = await withAnalysisAlertOwnerMutation(ownerId, async (query) => {
        const existing = await findRuleForOwner(req.params.id, ownerId, query);
        if (!existing) return null;
        const deliveryConfig = mergeAnalysisAlertDeliveryConfig(
          {
            deliveryChannel: existing.delivery_channel,
            deliveryRecipientId: existing.delivery_recipient_id,
          },
          {
            deliveryChannel: input.deliveryChannel,
            deliveryRecipientId: input.deliveryRecipientId,
          },
        );
        const merged = createAnalysisAlertSchema.safeParse({
          source: existing.source,
          symbol: existing.symbol,
          metric: existing.metric,
          window: existing.window,
          condition: existing.condition,
          threshold: existing.threshold,
          cooldownSeconds: existing.cooldown_seconds,
          enabled: existing.enabled,
          ...input,
          ...deliveryConfig,
        });
        if (!merged.success) throw new Error(merged.error.issues[0]?.message || "Invalid analysis alert update.");
        if (merged.data.deliveryChannel === "sms") {
          await requireEnabledAnalysisAlertRecipient(ownerId, merged.data.deliveryRecipientId!, query);
        }
        const set = fields.map(([column], index) => `${column} = $${index + 1}`).join(", ");
        const result = await query.query<{ id: string }>(
          `UPDATE analysis_alert_rules SET ${set}, updated_at = $${fields.length + 1}
            WHERE id = $${fields.length + 2} AND owner_id = $${fields.length + 3} RETURNING id`,
          values,
        );
        return result.rows[0] ? findRuleForOwner(result.rows[0].id, ownerId, query) : null;
      });
      if (!saved) return res.status(404).json({ message: "Analysis alert not found." });
      res.json({ rule: ruleFromRow(saved) });
    } catch (error) {
      if (error instanceof Error && (
        error.message.startsWith("Selected SMS recipient")
        || error.message.startsWith("Invalid")
      )) {
        return res.status(400).json({ message: error.message });
      }
      res.status(503).json({ message: `Unable to update analysis alert: ${error instanceof Error ? error.message : "unknown error"}` });
    }
  });

  app.delete("/api/analysis-alerts/:id", async (req, res) => {
    if (!pool) return databaseUnavailable(res);
    if (!isSameOriginMutation(req)) return res.status(403).json({ message: "Analysis alert requests must originate from this application." });
    const ownerId = ownerForMutation(req);
    if (!ownerId) return res.status(401).json({ message: "Open analysis alerts before deleting a rule." });
    if (!zUuid(req.params.id)) return res.status(400).json({ message: "Invalid analysis alert ID." });
    try {
      const result = await withAnalysisAlertOwnerMutation(
        ownerId,
        (query) => query.query("DELETE FROM analysis_alert_rules WHERE id = $1 AND owner_id = $2 RETURNING id", [req.params.id, ownerId]),
      );
      if (!result.rowCount) return res.status(404).json({ message: "Analysis alert not found." });
      res.status(204).end();
    } catch (error) {
      res.status(503).json({ message: `Unable to delete analysis alert: ${error instanceof Error ? error.message : "unknown error"}` });
    }
  });
}

function zUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}