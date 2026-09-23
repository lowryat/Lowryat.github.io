import { randomUUID } from "crypto";
import {
  type AlertRecipient,
  type AlertSettings,
  type DeliveryRecord,
  type RollingMetric,
  type TradingViewEvent,
} from "@shared/alerts";
import {
  configureLegacyAlertPersistence,
  getAlertOwnerScopeId,
  getTradingViewWebhookToken,
} from "./analysis-alerts";
import { getPool } from "./db";
import { isPushConfigured } from "./push";
import { isSmsProviderConfigured } from "./sms";

type StoredRecipient = AlertRecipient;

type Observation = {
  timestamp: number;
  rewardRisk: number;
};

const MAX_DELIVERIES = 30;
const MAX_OBSERVATIONS = 60;
const observationsByOwner = new Map<string, Map<string, Observation[]>>();

type AlertOwnerState = {
  recipients: StoredRecipient[];
  settings: AlertSettings;
  deliveries: DeliveryRecord[];
  dedupe: Map<string, number>;
  hydrated: boolean;
  dirty: boolean;
  writeTail: Promise<void>;
};

const ownerStates = new Map<string, AlertOwnerState>();
const MAX_DEDUPE_KEYS = 500;

function createOwnerState(): AlertOwnerState {
  return {
    recipients: [],
    settings: {
      insightAlertsEnabled: false,
      tradingviewAlertsEnabled: false,
      cooldownSeconds: 300,
    },
    deliveries: [],
    dedupe: new Map(),
    hydrated: false,
    dirty: false,
    writeTail: Promise.resolve(),
  };
}

function stateFor(ownerId: string): AlertOwnerState {
  let state = ownerStates.get(ownerId);
  if (!state) {
    state = createOwnerState();
    ownerStates.set(ownerId, state);
  }
  return state;
}

/**
 * A request owner is supplied by analysisAlertOwnerScopeMiddleware. Calls from
 * TradingView intentionally have no request scope and use the isolated system
 * owner; recipients/settings can therefore never bleed into user requests.
 */
function currentState(): AlertOwnerState {
  return stateFor(getAlertOwnerScopeId());
}

function currentObservations(): Map<string, Observation[]> {
  const ownerId = getAlertOwnerScopeId();
  let observations = observationsByOwner.get(ownerId);
  if (!observations) {
    observations = new Map();
    observationsByOwner.set(ownerId, observations);
  }
  return observations;
}

function markDirty(state = currentState()) {
  state.dirty = true;
}

type OwnerRow = {
  insight_alerts_enabled: boolean;
  tradingview_alerts_enabled: boolean;
  cooldown_seconds: number;
};

type RecipientRow = {
  id: string;
  name: string;
  phone: string;
  display_phone: string;
  enabled: boolean;
  created_at: Date | string;
};

type DeliveryRow = {
  id: string;
  recipient_id: string;
  recipient_name: string;
  display_phone: string;
  preview: string;
  status: DeliveryRecord["status"];
  error: string | null;
  created_at: Date | string;
};

type DedupeRow = { dedupe_key: string; sent_at: Date | string };
type ObservationRow = { symbol: string; observed_at: Date | string; reward_risk: number };

/**
 * Hydrate exactly once per owner before a legacy alert request. A configured
 * database error is surfaced to middleware instead of replacing state with an
 * empty in-memory fallback.
 */
export async function hydrateLegacyAlertOwnerState(ownerId: string): Promise<void> {
  const state = stateFor(ownerId);
  if (state.hydrated) return;
  const pool = getPool();
  if (!pool) {
    // Preserve legacy in-memory behavior when no database is provisioned.
    state.hydrated = true;
    return;
  }
  const [owner, recipientResult, deliveryResult, dedupeResult, observationResult] = await Promise.all([
    pool.query<OwnerRow>("SELECT insight_alerts_enabled, tradingview_alerts_enabled, cooldown_seconds FROM legacy_alert_owners WHERE owner_id = $1", [ownerId]),
    pool.query<RecipientRow>("SELECT id, name, phone, display_phone, enabled, created_at FROM legacy_alert_recipients WHERE owner_id = $1 ORDER BY created_at DESC", [ownerId]),
    pool.query<DeliveryRow>("SELECT id, recipient_id, recipient_name, display_phone, preview, status, error, created_at FROM legacy_alert_deliveries WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2", [ownerId, MAX_DELIVERIES]),
    pool.query<DedupeRow>("SELECT dedupe_key, sent_at FROM legacy_alert_dedupe WHERE owner_id = $1 ORDER BY sent_at DESC LIMIT $2", [ownerId, MAX_DEDUPE_KEYS]),
    pool.query<ObservationRow>("SELECT symbol, observed_at, reward_risk FROM legacy_alert_observations WHERE owner_id = $1 ORDER BY symbol ASC, observed_at ASC", [ownerId]),
  ]);
  const ownerRow = owner.rows[0];
  if (ownerRow) {
    state.settings = {
      insightAlertsEnabled: ownerRow.insight_alerts_enabled,
      tradingviewAlertsEnabled: ownerRow.tradingview_alerts_enabled,
      cooldownSeconds: ownerRow.cooldown_seconds,
    };
  }
  state.recipients = recipientResult.rows.map((row) => ({
    id: row.id, name: row.name, phone: row.phone, displayPhone: row.display_phone,
    enabled: row.enabled, createdAt: new Date(row.created_at).toISOString(),
  }));
  state.deliveries = deliveryResult.rows.map((row) => ({
    id: row.id, recipientId: row.recipient_id, recipientName: row.recipient_name,
    displayPhone: row.display_phone, preview: row.preview, status: row.status,
    error: row.error, createdAt: new Date(row.created_at).toISOString(),
  }));
  state.dedupe = new Map(dedupeResult.rows.map((row) => [row.dedupe_key, new Date(row.sent_at).getTime()]));
  const ownerObservations = new Map<string, Observation[]>();
  for (const row of observationResult.rows) {
    const list = ownerObservations.get(row.symbol) ?? [];
    list.push({ timestamp: new Date(row.observed_at).getTime(), rewardRisk: Number(row.reward_risk) });
    ownerObservations.set(row.symbol, list.slice(-MAX_OBSERVATIONS));
  }
  observationsByOwner.set(ownerId, ownerObservations);
  state.hydrated = true;
}

function snapshotState(ownerId: string, state: AlertOwnerState) {
  return {
    recipients: state.recipients.map((recipient) => ({ ...recipient })),
    settings: { ...state.settings },
    deliveries: state.deliveries.map((delivery) => ({ ...delivery })),
    dedupe: Array.from(state.dedupe.entries()).sort(([, left], [, right]) => right - left).slice(0, MAX_DEDUPE_KEYS),
    observations: Array.from((observationsByOwner.get(ownerId) ?? new Map<string, Observation[]>()).entries())
      .flatMap(([symbol, list]) => list.map((observation) => ({ symbol, ...observation }))),
  };
}

async function persistLegacyAlertOwnerState(ownerId: string, state: AlertOwnerState): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  const snapshot = snapshotState(ownerId, state);
  const now = new Date();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO legacy_alert_owners
        (owner_id, insight_alerts_enabled, tradingview_alerts_enabled, cooldown_seconds, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (owner_id) DO UPDATE SET
         insight_alerts_enabled = EXCLUDED.insight_alerts_enabled,
         tradingview_alerts_enabled = EXCLUDED.tradingview_alerts_enabled,
         cooldown_seconds = EXCLUDED.cooldown_seconds,
         updated_at = EXCLUDED.updated_at`,
      [ownerId, snapshot.settings.insightAlertsEnabled, snapshot.settings.tradingviewAlertsEnabled, snapshot.settings.cooldownSeconds, now],
    );
    await client.query("DELETE FROM legacy_alert_recipients WHERE owner_id = $1", [ownerId]);
    for (const recipient of snapshot.recipients) {
      await client.query(
        `INSERT INTO legacy_alert_recipients (id, owner_id, name, phone, display_phone, enabled, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [recipient.id, ownerId, recipient.name, recipient.phone, recipient.displayPhone, recipient.enabled, recipient.createdAt],
      );
    }
    await client.query("DELETE FROM legacy_alert_deliveries WHERE owner_id = $1", [ownerId]);
    for (const delivery of snapshot.deliveries) {
      await client.query(
        `INSERT INTO legacy_alert_deliveries (id, owner_id, recipient_id, recipient_name, display_phone, preview, status, error, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [delivery.id, ownerId, delivery.recipientId, delivery.recipientName, delivery.displayPhone, delivery.preview, delivery.status, delivery.error, delivery.createdAt],
      );
    }
    await client.query("DELETE FROM legacy_alert_dedupe WHERE owner_id = $1", [ownerId]);
    for (const [dedupeKey, sentAt] of snapshot.dedupe) {
      await client.query(
        "INSERT INTO legacy_alert_dedupe (id, owner_id, dedupe_key, sent_at) VALUES ($1, $2, $3, $4)",
        [randomUUID(), ownerId, dedupeKey, new Date(sentAt)],
      );
    }
    await client.query("DELETE FROM legacy_alert_observations WHERE owner_id = $1", [ownerId]);
    for (const observation of snapshot.observations) {
      await client.query(
        "INSERT INTO legacy_alert_observations (id, owner_id, symbol, observed_at, reward_risk) VALUES ($1, $2, $3, $4, $5)",
        [randomUUID(), ownerId, observation.symbol, new Date(observation.timestamp), observation.rewardRisk],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Queue an awaited, per-owner snapshot write without interleaving requests. */
export async function flushLegacyAlertOwnerState(ownerId: string): Promise<void> {
  const state = stateFor(ownerId);
  if (!state.dirty) return;
  state.dirty = false;
  state.writeTail = state.writeTail.catch(() => undefined).then(() => persistLegacyAlertOwnerState(ownerId, state));
  try {
    await state.writeTail;
  } catch (error) {
    state.dirty = true;
    throw error;
  }
}

export function maskPhone(phone: string): string {
  return phone.length < 8 ? "••••" : `${phone.slice(0, 3)}••••${phone.slice(-2)}`;
}

export function isProviderConfigured(): boolean {
  return isSmsProviderConfigured();
}

export function getRecipients(): StoredRecipient[] {
  return currentState().recipients.map((recipient) => ({ ...recipient }));
}

export function addRecipient(name: string, phone: string): StoredRecipient {
  const recipient: StoredRecipient = {
    id: randomUUID(),
    name,
    phone,
    displayPhone: maskPhone(phone),
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  const state = currentState();
  state.recipients.unshift(recipient);
  markDirty(state);
  return { ...recipient };
}

export function updateRecipient(
  id: string,
  changes: Partial<Pick<StoredRecipient, "name" | "phone" | "enabled">>,
): StoredRecipient | undefined {
  const recipient = currentState().recipients.find((item) => item.id === id);
  if (!recipient) return undefined;
  Object.assign(recipient, changes);
  if (changes.phone) recipient.displayPhone = maskPhone(changes.phone);
  markDirty();
  return { ...recipient };
}

export function deleteRecipient(id: string): boolean {
  const recipients = currentState().recipients;
  const index = recipients.findIndex((item) => item.id === id);
  if (index < 0) return false;
  recipients.splice(index, 1);
  markDirty();
  return true;
}

export function getSettings(): AlertSettings {
  return { ...currentState().settings };
}

export function updateSettings(changes: Partial<AlertSettings>): AlertSettings {
  const state = currentState();
  state.settings = { ...state.settings, ...changes };
  markDirty(state);
  return getSettings();
}

export function getDeliveries(): DeliveryRecord[] {
  return currentState().deliveries.map((delivery) => ({ ...delivery }));
}

export function addDelivery(
  recipient: AlertRecipient,
  preview: string,
  status: DeliveryRecord["status"],
  error: string | null = null,
): DeliveryRecord {
  const delivery: DeliveryRecord = {
    id: randomUUID(),
    recipientId: recipient.id,
    recipientName: recipient.name,
    displayPhone: recipient.displayPhone,
    preview,
    status,
    error,
    createdAt: new Date().toISOString(),
  };
  const deliveries = currentState().deliveries;
  deliveries.unshift(delivery);
  deliveries.splice(MAX_DELIVERIES);
  markDirty();
  return { ...delivery };
}

/**
 * Apply a carrier delivery receipt to a recorded delivery. Runs outside any
 * request, so it addresses the owner explicitly and persists immediately.
 */
export async function updateDeliveryStatus(
  ownerId: string,
  deliveryId: string,
  status: DeliveryRecord["status"],
  error: string | null,
): Promise<boolean> {
  const state = stateFor(ownerId);
  const delivery = state.deliveries.find((item) => item.id === deliveryId);
  if (!delivery) return false;
  delivery.status = status;
  delivery.error = error;
  state.dirty = true;
  await flushLegacyAlertOwnerState(ownerId).catch((flushError) => {
    console.warn("[alerts] delivery receipt persistence deferred:", flushError instanceof Error ? flushError.message : flushError);
  });
  return true;
}

/**
 * Legacy check-and-mark: returns true and records the key when it is outside
 * the cooldown. Kept for compatibility; routes use isCoolingDown + markSent so
 * a failed attempt no longer consumes the cooldown and blocks the retry.
 */
export function canSend(dedupeKey?: string): boolean {
  if (!dedupeKey) return true;
  if (isCoolingDown(dedupeKey)) return false;
  markSent(dedupeKey);
  return true;
}

export function isCoolingDown(dedupeKey?: string): boolean {
  if (!dedupeKey) return false;
  const state = currentState();
  const lastSentAt = state.dedupe.get(dedupeKey);
  return Boolean(lastSentAt && Date.now() - lastSentAt < state.settings.cooldownSeconds * 1000);
}

export function markSent(dedupeKey?: string): void {
  if (!dedupeKey) return;
  const state = currentState();
  state.dedupe.set(dedupeKey, Date.now());
  markDirty(state);
}

export function calculateObservation(event: TradingViewEvent): Observation {
  const reward = Math.abs(event.target - event.entry);
  const risk = Math.abs(event.entry - event.stop);
  if (!Number.isFinite(reward) || !Number.isFinite(risk) || risk <= 0) {
    throw new Error("Entry and stop must define a non-zero risk");
  }
  return {
    timestamp: event.timestamp ? new Date(event.timestamp).getTime() : Date.now(),
    rewardRisk: reward / risk,
  };
}

export function recordTradingViewEvent(event: TradingViewEvent): RollingMetric {
  const symbol = event.symbol.toUpperCase();
  const observations = currentObservations();
  const list = observations.get(symbol) ?? [];
  const observation = calculateObservation(event);
  list.push(observation);
  list.sort((a, b) => a.timestamp - b.timestamp);
  observations.set(symbol, list.slice(-MAX_OBSERVATIONS));
  markDirty();
  return getMetric(symbol);
}

export function getMetric(symbol: string): RollingMetric {
  const normalizedSymbol = symbol.toUpperCase();
  const list = currentObservations().get(normalizedSymbol) ?? [];
  const last = list.at(-1);
  const first = list[0];
  const ready = list.length >= MAX_OBSERVATIONS && Boolean(first && last && last.timestamp > first.timestamp);
  const elapsedMinutes = first && last ? (last.timestamp - first.timestamp) / 60000 : 0;
  const rateOfIncreasePerMinute = ready && first && last && elapsedMinutes > 0
    ? (last.rewardRisk - first.rewardRisk) / elapsedMinutes
    : null;
  return {
    symbol: normalizedSymbol,
    observations: list.length,
    requiredObservations: MAX_OBSERVATIONS,
    rewardRisk: last?.rewardRisk ?? null,
    rateOfIncreasePerMinute,
    lastUpdatedAt: last ? new Date(last.timestamp).toISOString() : null,
    ready,
  };
}

export function getMetrics(): RollingMetric[] {
  return Array.from(currentObservations().keys()).sort().map(getMetric);
}

export function formatTradingViewMessage(event: TradingViewEvent, metric: RollingMetric): string {
  const side = event.side ? ` ${event.side.toUpperCase()}` : "";
  const rr = metric.rewardRisk == null ? "warming up" : metric.rewardRisk.toFixed(2);
  const rate = metric.rateOfIncreasePerMinute == null
    ? "warming up"
    : `${metric.rateOfIncreasePerMinute >= 0 ? "+" : ""}${metric.rateOfIncreasePerMinute.toFixed(3)}/min`;
  return `LIQ-INTEL ${event.symbol.toUpperCase()}${side}: ${event.event}. R/R ${rr}; rate ${rate}.`;
}

export function getEnabledRecipients(ids?: string[]): StoredRecipient[] {
  const selected = ids ? new Set(ids) : undefined;
  return currentState().recipients.filter((recipient) =>
    recipient.enabled && (!selected || selected.has(recipient.id)),
  );
}

export function getAlertStatus() {
  return {
    provider: "twilio" as const,
    providerConfigured: isProviderConfigured(),
    pushConfigured: isPushConfigured(),
    recipients: getRecipients().map((recipient) => ({
      ...recipient,
      phone: recipient.displayPhone,
    })),
    settings: getSettings(),
    deliveries: getDeliveries(),
    metrics: getMetrics(),
    ...(getTradingViewWebhookToken() ? { tradingViewWebhookToken: getTradingViewWebhookToken()! } : {}),
  };
}

configureLegacyAlertPersistence({
  hydrate: hydrateLegacyAlertOwnerState,
  flush: flushLegacyAlertOwnerState,
});
