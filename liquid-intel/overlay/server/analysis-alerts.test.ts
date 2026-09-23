import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";
import express from "express";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  isStaleAnalysisAlertObservation,
  matchesAnalysisAlertCondition,
  getAnalysisAlertDestinationState,
  mergeAnalysisAlertDeliveryConfig,
  countsTowardAnalysisAlertCooldown,
  evaluateAnalysisAlertRule,
  analysisAlertOwnerScopeMiddleware,
  confirmRecipientAnalysisImpact,
  registerAnalysisAlertRoutes,
  registerAnalysisAlertSourceAdapter,
} from "./analysis-alerts";
import { registerAnalysisAlertRecipientRoutes } from "./routes";
import {
  analysisAlertRuleSchema,
  createAnalysisAlertSchema,
} from "@shared/analysis-alerts";
import { runInTemporaryDatabase } from "./test-database";
import { normalizeSmsFailure, sendSms } from "./sms";

const WORKER_ENV = "ANALYSIS_ALERT_TEST_WORKER";
const isWorker = process.env[WORKER_ENV] === "1";
const databasePool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

if (!isWorker) {
  test("analysis alert tests run against the current schema in a temporary database", async (t) => {
    if (!process.env.DATABASE_URL) {
      t.skip("DATABASE_URL is not configured");
      return;
    }
    await runInTemporaryDatabase("server/analysis-alerts.test.ts", WORKER_ENV);
  });
} else {
  after(async () => {
    await databasePool.end();
  });

test("analysis alert predicate supports thresholds and directional crossovers", () => {
  assert.equal(matchesAnalysisAlertCondition({ condition: "above", threshold: 10, currentValue: 11 }), true);
  assert.equal(matchesAnalysisAlertCondition({ condition: "below", threshold: 10, currentValue: 10 }), false);
  assert.equal(matchesAnalysisAlertCondition({ condition: "crossAbove", threshold: 10, previousValue: 10, currentValue: 11 }), true);
  assert.equal(matchesAnalysisAlertCondition({ condition: "crossAbove", threshold: 10, previousValue: 11, currentValue: 12 }), false);
  assert.equal(matchesAnalysisAlertCondition({ condition: "crossBelow", threshold: 10, previousValue: 10, currentValue: 9 }), true);
});


test("analysis alert freshness skips missing and stale observations", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(isStaleAnalysisAlertObservation(null, now), true);
  assert.equal(isStaleAnalysisAlertObservation(new Date("2025-12-31T23:44:59.999Z"), now), true);
  assert.equal(isStaleAnalysisAlertObservation(new Date("2025-12-31T23:45:00.000Z"), now), false);
});

test("analysis alert delivery is opt-in and SMS rules require a recipient ID", () => {
  const base = {
    source: "history",
    symbol: "BTC",
    metric: "price",
    window: "24h",
    condition: "above",
    threshold: 100,
    cooldownSeconds: 300,
    enabled: true,
  };
  assert.equal(createAnalysisAlertSchema.safeParse({ ...base, deliveryChannel: "in_app" }).success, true);
  assert.equal(createAnalysisAlertSchema.safeParse({ ...base, deliveryChannel: "sms" }).success, false);
  assert.equal(createAnalysisAlertSchema.safeParse({
    ...base,
    deliveryChannel: "sms",
    deliveryRecipientId: "22222222-2222-4222-8222-222222222222",
  }).success, true);
  assert.equal(createAnalysisAlertSchema.safeParse({
    ...base,
    deliveryChannel: "in_app",
    deliveryRecipientId: "22222222-2222-4222-8222-222222222222",
  }).success, false);
});

test("analysis alert rule responses only expose a masked delivery destination", () => {
  const parsed = analysisAlertRuleSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    source: "history",
    symbol: "BTC",
    metric: "price",
    window: "24h",
    condition: "above",
    threshold: 100,
    cooldownSeconds: 300,
    enabled: true,
    deliveryChannel: "sms",
    deliveryRecipientId: "22222222-2222-4222-8222-222222222222",
    deliveryPhoneDisplay: "+14••••71",
    deliveryDestinationState: "configured",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastValue: null,
    lastObservedAt: null,
    lastEvaluatedAt: null,
    lastTriggeredAt: null,
    lastResult: "not_evaluated",
    lastResultDetail: "Awaiting first evaluation.",
  });
  assert.equal(parsed.deliveryPhoneDisplay, "+14••••71");
  assert.equal("deliveryPhone" in parsed, false);
});

test("analysis rules expose explicit unavailable recipient states", () => {
  assert.equal(getAnalysisAlertDestinationState({
    deliveryChannel: "sms",
    deliveryRecipientId: null,
    recipientExists: false,
    recipientEnabled: false,
  }), "unconfigured");
  assert.equal(getAnalysisAlertDestinationState({
    deliveryChannel: "sms",
    deliveryRecipientId: "22222222-2222-4222-8222-222222222222",
    recipientExists: false,
    recipientEnabled: false,
  }), "deleted");
  assert.equal(getAnalysisAlertDestinationState({
    deliveryChannel: "sms",
    deliveryRecipientId: "22222222-2222-4222-8222-222222222222",
    recipientExists: true,
    recipientEnabled: false,
  }), "disabled");
});

test("switching an SMS rule to in-app clears its recipient before validation", () => {
  assert.deepEqual(mergeAnalysisAlertDeliveryConfig(
    {
      deliveryChannel: "sms",
      deliveryRecipientId: "22222222-2222-4222-8222-222222222222",
    },
    { deliveryChannel: "in_app" },
  ), {
    deliveryChannel: "in_app",
    deliveryRecipientId: undefined,
  });
});

test("only accepted or delivered messages extend delivery cooldown", () => {
  assert.equal(countsTowardAnalysisAlertCooldown({ status: "failed", destination: "disabled" }), false);
  assert.equal(countsTowardAnalysisAlertCooldown({ status: "failed", destination: "deleted" }), false);
  assert.equal(countsTowardAnalysisAlertCooldown({ status: "rate_limited", destination: "+14••••71" }), false);
  // A failed or undelivered text never reached the trader, so it must not block the retry.
  assert.equal(countsTowardAnalysisAlertCooldown({ status: "failed", destination: "+14••••71" }), false);
  assert.equal(countsTowardAnalysisAlertCooldown({ status: "undelivered", destination: "+14••••71" }), false);
  assert.equal(countsTowardAnalysisAlertCooldown({ status: "pending", destination: "+14••••71" }), true);
  assert.equal(countsTowardAnalysisAlertCooldown({ status: "sent", destination: "+14••••71" }), true);
  assert.equal(countsTowardAnalysisAlertCooldown({ status: "delivered", destination: "+14••••71" }), true);
});

test("SMS provider timeouts use the safe delivery-error path without waiting for a network timeout", async () => {
  const previousProviderConfig = {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_FROM_NUMBER,
  };
  const previousFetch = globalThis.fetch;

  try {
    process.env.TWILIO_ACCOUNT_SID = "AC-timeout-test";
    process.env.TWILIO_AUTH_TOKEN = "timeout-test-token";
    process.env.TWILIO_FROM_NUMBER = "+14155550000";
    globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      }, { once: true });
    });

    const result = await sendSms("+14155550171", "timeout test", { timeoutMs: 10 });

    assert.deepEqual(result, {
      sent: false,
      error: "Twilio is unavailable right now.",
      failure: {
        category: "provider_unavailable",
        message: "Twilio is unavailable right now.",
        recoveryAction: "Reconnect Twilio or try again later.",
      },
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProviderConfig.accountSid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
    else process.env.TWILIO_ACCOUNT_SID = previousProviderConfig.accountSid;
    if (previousProviderConfig.authToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = previousProviderConfig.authToken;
    if (previousProviderConfig.from === undefined) delete process.env.TWILIO_FROM_NUMBER;
    else process.env.TWILIO_FROM_NUMBER = previousProviderConfig.from;
  }
});

test("SMS failures normalize into safe recipient and sender diagnostics", () => {
  assert.deepEqual(normalizeSmsFailure("This destination has opted out of SMS messages."), {
    category: "recipient_rejected",
    message: "Twilio rejected the recipient.",
    recoveryAction: "Check the recipient number, country access, and SMS opt-in.",
  });
  assert.deepEqual(normalizeSmsFailure("Twilio rejected the message. Check the connected sender number."), {
    category: "sender_rejected",
    message: "Twilio rejected the configured sender.",
    recoveryAction: "Check the Twilio sender number and account permissions.",
  });
});

test("recipient API changes keep SMS analysis rules and delivery destinations consistent", async () => {
  let ownerId = randomUUID();
  const foreignOwnerId = randomUUID();
  let ruleId: string | null = null;
  const originalPhone = "+14155550171";
  const updatedPhone = "+14155550172";
  const app = express();
  app.use(express.json());
  app.use("/api/alerts", analysisAlertOwnerScopeMiddleware);
  registerAnalysisAlertRecipientRoutes(app);
  registerAnalysisAlertRoutes(app);
  const server = createServer(app);
  const listen = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    await listen;
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const initialResponse = await fetch(`${baseUrl}/api/analysis-alerts`);
    assert.equal(initialResponse.status, 200);
    const setCookie = initialResponse.headers.get("set-cookie");
    assert.ok(setCookie);
    const ownerCookie = setCookie.split(";")[0];
    ownerId = decodeURIComponent(ownerCookie.split("=")[1]).split(".")[0];
    const mutationHeaders = {
      cookie: ownerCookie,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    };

    const recipientResponse = await fetch(`${baseUrl}/api/alerts/recipients`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ name: "Analysis lifecycle", phone: originalPhone }),
    });
    assert.equal(recipientResponse.status, 201);
    const recipientBody = await recipientResponse.json() as {
      recipients: Array<{ id: string; displayPhone: string; enabled: boolean }>;
    };
    const recipient = recipientBody.recipients[0];
    assert.ok(recipient);
    assert.equal(recipient.displayPhone, "+14••••71");

    const ruleResponse = await fetch(`${baseUrl}/api/analysis-alerts`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        source: "history",
        symbol: "BTC",
        metric: "price",
        window: "24h",
        condition: "above",
        threshold: 100,
        cooldownSeconds: 60,
        enabled: true,
        deliveryChannel: "sms",
        deliveryRecipientId: recipient.id,
      }),
    });
    assert.equal(ruleResponse.status, 201);
    const created = await ruleResponse.json() as {
      rule: { id: string; deliveryPhoneDisplay: string; deliveryDestinationState: string };
    };
    ruleId = created.rule.id;
    assert.equal(created.rule.deliveryPhoneDisplay, "+14••••71");
    assert.equal(created.rule.deliveryDestinationState, "configured");

    await databasePool.query(
      `INSERT INTO analysis_alert_rules
        (id, owner_id, source, symbol, metric, "window", condition, threshold, cooldown_seconds,
         enabled, delivery_channel, delivery_recipient_id, last_result, last_result_detail, created_at, updated_at)
       VALUES ($1, $2, 'history', 'SOL', 'price', '24h', 'above', 100, 60,
               true, 'sms', $3, 'not_evaluated', 'Foreign owner isolation test.', NOW(), NOW())`,
      [randomUUID(), foreignOwnerId, recipient.id],
    );

    const phoneUpdateResponse = await fetch(`${baseUrl}/api/alerts/recipients/${recipient.id}`, {
      method: "PATCH",
      headers: mutationHeaders,
      body: JSON.stringify({ phone: updatedPhone }),
    });
    assert.equal(phoneUpdateResponse.status, 200);

    const afterPhoneUpdate = await fetch(`${baseUrl}/api/analysis-alerts`, {
      headers: { cookie: ownerCookie },
    });
    const afterPhoneBody = await afterPhoneUpdate.json() as {
      rules: Array<{ id: string; deliveryPhoneDisplay: string; deliveryDestinationState: string }>;
    };
    assert.equal(afterPhoneBody.rules[0]?.id, ruleId);
    assert.equal(afterPhoneBody.rules[0]?.deliveryPhoneDisplay, "+14••••72");
    assert.equal(afterPhoneBody.rules[0]?.deliveryDestinationState, "configured");

    registerAnalysisAlertSourceAdapter("history", {
      async getObservation() {
        return { currentValue: 101, previousValue: null, observedAt: new Date() };
      },
    });
    const persistedRule = await databasePool.query(
      `SELECT rule.*, recipient.id AS recipient_id, recipient.phone AS recipient_phone,
              recipient.enabled AS recipient_enabled
         FROM analysis_alert_rules rule
         LEFT JOIN legacy_alert_recipients recipient
           ON recipient.id = rule.delivery_recipient_id
          AND recipient.owner_id = rule.owner_id
        WHERE rule.id = $1 AND rule.owner_id = $2`,
      [ruleId, ownerId],
    );
    assert.equal(await evaluateAnalysisAlertRule(persistedRule.rows[0], new Date()), "triggered");
    const delivery = await databasePool.query(
      `SELECT destination FROM analysis_alert_deliveries
        WHERE owner_id = $1 AND rule_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [ownerId, ruleId],
    );
    assert.equal(delivery.rows[0]?.destination, "+14••••72");

    const disableWarningResponse = await fetch(`${baseUrl}/api/alerts/recipients/${recipient.id}`, {
      method: "PATCH",
      headers: mutationHeaders,
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disableWarningResponse.status, 409);
    const disableWarning = await disableWarningResponse.json() as {
      confirmationRequired: boolean;
      affectedAnalysisRuleCount: number;
      message: string;
    };
    assert.equal(disableWarning.confirmationRequired, true);
    assert.equal(disableWarning.affectedAnalysisRuleCount, 1);
    assert.equal(disableWarning.message.includes(originalPhone), false);
    assert.equal(disableWarning.message.includes(updatedPhone), false);

    const secondRuleResponse = await fetch(`${baseUrl}/api/analysis-alerts`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        source: "history",
        symbol: "ETH",
        metric: "price",
        window: "24h",
        condition: "below",
        threshold: 100,
        cooldownSeconds: 60,
        enabled: true,
        deliveryChannel: "sms",
        deliveryRecipientId: recipient.id,
      }),
    });
    assert.equal(secondRuleResponse.status, 201);
    const secondRule = await secondRuleResponse.json() as { rule: { id: string } };

    const staleConfirmationResponse = await fetch(`${baseUrl}/api/alerts/recipients/${recipient.id}`, {
      method: "PATCH",
      headers: mutationHeaders,
      body: JSON.stringify({ enabled: false, confirmedAnalysisAlertRuleCount: 1 }),
    });
    assert.equal(staleConfirmationResponse.status, 409);
    const staleConfirmation = await staleConfirmationResponse.json() as {
      affectedAnalysisRuleCount: number;
    };
    assert.equal(staleConfirmation.affectedAnalysisRuleCount, 2);

    const removeSecondRuleResponse = await fetch(`${baseUrl}/api/analysis-alerts/${secondRule.rule.id}`, {
      method: "DELETE",
      headers: mutationHeaders,
    });
    assert.equal(removeSecondRuleResponse.status, 204);

    const disableResponse = await fetch(`${baseUrl}/api/alerts/recipients/${recipient.id}`, {
      method: "PATCH",
      headers: mutationHeaders,
      body: JSON.stringify({ enabled: false, confirmedAnalysisAlertRuleCount: 1 }),
    });
    assert.equal(disableResponse.status, 200);
    const disabledRules = await (await fetch(`${baseUrl}/api/analysis-alerts`, {
      headers: { cookie: ownerCookie },
    })).json() as { rules: Array<{ deliveryDestinationState: string }> };
    assert.equal(disabledRules.rules[0]?.deliveryDestinationState, "disabled");
    assert.equal((await databasePool.query(
      "SELECT count(*)::int AS count FROM analysis_alert_rules WHERE id = $1 AND owner_id = $2",
      [ruleId, ownerId],
    )).rows[0]?.count, 1);

    const deleteWarningResponse = await fetch(`${baseUrl}/api/alerts/recipients/${recipient.id}`, {
      method: "DELETE",
      headers: mutationHeaders,
    });
    assert.equal(deleteWarningResponse.status, 409);
    const deleteWarning = await deleteWarningResponse.json() as {
      confirmationRequired: boolean;
      affectedAnalysisRuleCount: number;
      message: string;
    };
    assert.equal(deleteWarning.confirmationRequired, true);
    assert.equal(deleteWarning.affectedAnalysisRuleCount, 1);
    assert.equal(deleteWarning.message.includes(originalPhone), false);
    assert.equal(deleteWarning.message.includes(updatedPhone), false);

    const deleteResponse = await fetch(`${baseUrl}/api/alerts/recipients/${recipient.id}`, {
      method: "DELETE",
      headers: mutationHeaders,
      body: JSON.stringify({ confirmedAnalysisAlertRuleCount: 1 }),
    });
    assert.equal(deleteResponse.status, 200);
    const deleteBody = await deleteResponse.json() as { affectedAnalysisRuleCount: number };
    assert.equal(deleteBody.affectedAnalysisRuleCount, 1);
    const deletedRules = await (await fetch(`${baseUrl}/api/analysis-alerts`, {
      headers: { cookie: ownerCookie },
    })).json() as { rules: Array<{ deliveryDestinationState: string }> };
    assert.equal(deletedRules.rules[0]?.deliveryDestinationState, "deleted");
    assert.equal((await databasePool.query(
      "SELECT count(*)::int AS count FROM analysis_alert_rules WHERE id = $1 AND owner_id = $2",
      [ruleId, ownerId],
    )).rows[0]?.count, 1);

    const inAppResponse = await fetch(`${baseUrl}/api/analysis-alerts/${ruleId}`, {
      method: "PATCH",
      headers: mutationHeaders,
      body: JSON.stringify({ deliveryChannel: "in_app" }),
    });
    assert.equal(inAppResponse.status, 200);
    const inAppBody = await inAppResponse.json() as {
      rule: { deliveryChannel: string; deliveryRecipientId?: string };
    };
    assert.equal(inAppBody.rule.deliveryChannel, "in_app");
    assert.equal(inAppBody.rule.deliveryRecipientId, undefined);
    assert.equal((await databasePool.query(
      "SELECT delivery_recipient_id FROM analysis_alert_rules WHERE id = $1 AND owner_id = $2",
      [ruleId, ownerId],
    )).rows[0]?.delivery_recipient_id, null);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await databasePool.query("DELETE FROM analysis_alert_deliveries WHERE owner_id = $1", [ownerId]);
    await databasePool.query("DELETE FROM analysis_alert_events WHERE owner_id = $1", [ownerId]);
    await databasePool.query("DELETE FROM analysis_alert_rules WHERE owner_id = $1", [ownerId]);
    await databasePool.query("DELETE FROM analysis_alert_rules WHERE owner_id = $1", [foreignOwnerId]);
    await databasePool.query("DELETE FROM legacy_alert_deliveries WHERE owner_id = $1", [ownerId]);
    await databasePool.query("DELETE FROM legacy_alert_dedupe WHERE owner_id = $1", [ownerId]);
    await databasePool.query("DELETE FROM legacy_alert_observations WHERE owner_id = $1", [ownerId]);
    await databasePool.query("DELETE FROM legacy_alert_recipients WHERE owner_id = $1", [ownerId]);
    await databasePool.query("DELETE FROM legacy_alert_owners WHERE owner_id = $1", [ownerId]);
  }
});

test("recipient retirement reassigns only the owner's enabled SMS rules atomically", async () => {
  const ownerId = randomUUID();
  const foreignOwnerId = randomUUID();
  const sourceRecipientId = randomUUID();
  const replacementRecipientId = randomUUID();
  const foreignReplacementRecipientId = randomUUID();
  const enabledRuleId = randomUUID();
  const disabledRuleId = randomUUID();
  const foreignRuleId = randomUUID();

  try {
    await databasePool.query(
      `INSERT INTO legacy_alert_recipients
        (id, owner_id, name, phone, display_phone, enabled, created_at)
       VALUES
        ($1, $2, 'Source', '+14155550181', '+14••••81', true, NOW()),
        ($3, $2, 'Replacement', '+14155550182', '+14••••82', true, NOW()),
        ($4, $5, 'Foreign', '+14155550183', '+14••••83', true, NOW())`,
      [sourceRecipientId, ownerId, replacementRecipientId, foreignReplacementRecipientId, foreignOwnerId],
    );
    await databasePool.query(
      `INSERT INTO analysis_alert_rules
        (id, owner_id, source, symbol, metric, "window", condition, threshold, cooldown_seconds,
         enabled, delivery_channel, delivery_recipient_id, last_result, last_result_detail, created_at, updated_at)
       VALUES
        ($1, $2, 'history', 'BTC', 'price', '24h', 'above', 100, 60,
         true, 'sms', $3, 'not_evaluated', 'Owner enabled rule.', NOW(), NOW()),
        ($4, $2, 'history', 'ETH', 'price', '24h', 'above', 100, 60,
         false, 'sms', $3, 'not_evaluated', 'Owner disabled rule.', NOW(), NOW()),
        ($5, $6, 'history', 'SOL', 'price', '24h', 'above', 100, 60,
         true, 'sms', $3, 'not_evaluated', 'Foreign owner rule.', NOW(), NOW())`,
      [enabledRuleId, ownerId, sourceRecipientId, disabledRuleId, foreignRuleId, foreignOwnerId],
    );

    const rejected = await confirmRecipientAnalysisImpact({
      ownerId,
      recipientId: sourceRecipientId,
      action: "disable",
      confirmedRuleCount: 1,
      replacementRecipientId: foreignReplacementRecipientId,
    });
    assert.deepEqual(rejected, { outcome: "invalid_replacement", affectedAnalysisRuleCount: 1 });
    assert.equal((await databasePool.query(
      "SELECT enabled FROM legacy_alert_recipients WHERE id = $1",
      [sourceRecipientId],
    )).rows[0]?.enabled, true);
    assert.equal((await databasePool.query(
      "SELECT delivery_recipient_id FROM analysis_alert_rules WHERE id = $1",
      [enabledRuleId],
    )).rows[0]?.delivery_recipient_id, sourceRecipientId);

    const completed = await confirmRecipientAnalysisImpact({
      ownerId,
      recipientId: sourceRecipientId,
      action: "disable",
      confirmedRuleCount: 1,
      replacementRecipientId,
    });
    assert.deepEqual(completed, {
      outcome: "allowed",
      affectedAnalysisRuleCount: 1,
      reassignedAnalysisRuleCount: 1,
    });
    assert.equal((await databasePool.query(
      "SELECT enabled FROM legacy_alert_recipients WHERE id = $1",
      [sourceRecipientId],
    )).rows[0]?.enabled, false);
    const assignments = await databasePool.query<{ id: string; delivery_recipient_id: string }>(
      "SELECT id, delivery_recipient_id FROM analysis_alert_rules WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[enabledRuleId, disabledRuleId, foreignRuleId]],
    );
    const assignmentById = new Map(assignments.rows.map((row) => [row.id, row.delivery_recipient_id]));
    assert.equal(assignmentById.get(enabledRuleId), replacementRecipientId);
    assert.equal(assignmentById.get(disabledRuleId), sourceRecipientId);
    assert.equal(assignmentById.get(foreignRuleId), sourceRecipientId);
  } finally {
    await databasePool.query(
      "DELETE FROM analysis_alert_rules WHERE owner_id IN ($1, $2)",
      [ownerId, foreignOwnerId],
    );
    await databasePool.query(
      "DELETE FROM legacy_alert_recipients WHERE owner_id IN ($1, $2)",
      [ownerId, foreignOwnerId],
    );
  }
});

test("analysis alert retries stay owner-scoped, reject non-failed events, and honor cooldowns", async () => {
  let ownerId = randomUUID();
  const foreignOwnerId = randomUUID();
  const currentRuleId = randomUUID();
  const foreignRuleId = randomUUID();
  const recipientId = randomUUID();
  const foreignEventId = randomUUID();
  const foreignRuleEventId = randomUUID();
  const inAppEventId = randomUUID();
  const sentEventId = randomUUID();
  const pendingEventId = randomUUID();
  const cooldownEventId = randomUUID();
  const now = new Date();
  const phone = "+14155550173";
  let providerAttempt = 0;
  const previousProviderConfig = {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_FROM_NUMBER,
  };
  const previousFetch = globalThis.fetch;
  const app = express();
  registerAnalysisAlertRoutes(app);
  const server = createServer(app);
  const listen = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    process.env.TWILIO_ACCOUNT_SID = "AC-retry-isolation-test";
    process.env.TWILIO_AUTH_TOKEN = "retry-isolation-test-token";
    process.env.TWILIO_FROM_NUMBER = "+14155550000";
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("api.twilio.com")) {
        providerAttempt += 1;
        return new Response(JSON.stringify({ sid: "SM-retry-isolation-test" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return previousFetch(input, init);
    };

    await listen;
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const initialResponse = await fetch(`${baseUrl}/api/analysis-alerts`);
    assert.equal(initialResponse.status, 200);
    const setCookie = initialResponse.headers.get("set-cookie");
    assert.ok(setCookie);
    const ownerCookie = setCookie.split(";")[0];
    ownerId = decodeURIComponent(ownerCookie.split("=")[1]).split(".")[0];
    assert.match(ownerId, /^[0-9a-f-]{36}$/i);
    const retryHeaders = { cookie: ownerCookie, "sec-fetch-site": "same-origin" };

    await databasePool.query(
      `INSERT INTO legacy_alert_recipients (id, owner_id, name, phone, display_phone, enabled, created_at)
       VALUES ($1, $2, 'Retry isolation test', $3, $3, true, $4)`,
      [recipientId, ownerId, phone, now],
    );
    await databasePool.query(
      `INSERT INTO analysis_alert_rules
        (id, owner_id, source, symbol, metric, "window", condition, threshold, cooldown_seconds,
         enabled, last_result, last_result_detail, delivery_channel, delivery_recipient_id, created_at, updated_at)
       VALUES
        ($1, $2, 'history', 'BTC', 'price', '24h', 'above', 100, 300,
         true, 'not_evaluated', 'Retry isolation test.', 'sms', $3, $4, $4),
        ($5, $6, 'history', 'ETH', 'price', '24h', 'above', 100, 300,
         true, 'not_evaluated', 'Foreign retry isolation test.', 'sms', $3, $4, $4)`,
      [currentRuleId, ownerId, recipientId, now, foreignRuleId, foreignOwnerId],
    );

    const insertEvent = async (
      eventId: string,
      eventOwnerId: string,
      ruleId: string,
      channel: "in_app" | "sms",
    ) => {
      await databasePool.query(
        `INSERT INTO analysis_alert_events
          (id, owner_id, rule_id, source, symbol, metric, "window", condition, threshold, value, previous_value, channel, created_at)
         VALUES ($1, $2, $3, 'history', 'BTC', 'price', '24h', 'above', 100, 101, NULL, $4, $5)`,
        [eventId, eventOwnerId, ruleId, channel, now],
      );
    };
    const insertDelivery = async (
      deliveryEventId: string,
      deliveryOwnerId: string,
      ruleId: string,
      status: "failed" | "pending" | "sent",
    ) => {
      await databasePool.query(
        `INSERT INTO analysis_alert_deliveries
          (id, owner_id, rule_id, event_id, channel, destination, status, error, created_at, completed_at)
         VALUES ($1, $2, $3, $4, 'sms', '+14••••73', $5, $6, $7, $7)`,
        [
          randomUUID(),
          deliveryOwnerId,
          ruleId,
          deliveryEventId,
          status,
          status === "failed" ? "Provider rejected this attempt." : null,
          now,
        ],
      );
    };

    await insertEvent(foreignEventId, foreignOwnerId, foreignRuleId, "sms");
    await insertDelivery(foreignEventId, foreignOwnerId, foreignRuleId, "failed");
    await insertEvent(foreignRuleEventId, ownerId, foreignRuleId, "sms");
    await insertDelivery(foreignRuleEventId, ownerId, foreignRuleId, "failed");
    await insertEvent(inAppEventId, ownerId, currentRuleId, "in_app");
    await insertEvent(sentEventId, ownerId, currentRuleId, "sms");
    await insertDelivery(sentEventId, ownerId, currentRuleId, "sent");
    await insertEvent(pendingEventId, ownerId, currentRuleId, "sms");
    await insertDelivery(pendingEventId, ownerId, currentRuleId, "pending");
    await insertEvent(cooldownEventId, ownerId, currentRuleId, "sms");
    await insertDelivery(cooldownEventId, ownerId, currentRuleId, "failed");

    const foreignEventRetry = await fetch(`${baseUrl}/api/analysis-alerts/events/${foreignEventId}/retry`, {
      method: "POST",
      headers: retryHeaders,
    });
    assert.equal(foreignEventRetry.status, 404);

    const foreignRuleRetry = await fetch(`${baseUrl}/api/analysis-alerts/events/${foreignRuleEventId}/retry`, {
      method: "POST",
      headers: retryHeaders,
    });
    assert.equal(foreignRuleRetry.status, 404);

    const inAppRetry = await fetch(`${baseUrl}/api/analysis-alerts/events/${inAppEventId}/retry`, {
      method: "POST",
      headers: retryHeaders,
    });
    assert.equal(inAppRetry.status, 400);
    assert.deepEqual(await inAppRetry.json(), { message: "Only SMS deliveries can be retried." });

    const sentRetry = await fetch(`${baseUrl}/api/analysis-alerts/events/${sentEventId}/retry`, {
      method: "POST",
      headers: retryHeaders,
    });
    assert.equal(sentRetry.status, 409);
    assert.deepEqual(await sentRetry.json(), { message: "Only failed SMS deliveries can be retried." });

    const pendingRetry = await fetch(`${baseUrl}/api/analysis-alerts/events/${pendingEventId}/retry`, {
      method: "POST",
      headers: retryHeaders,
    });
    assert.equal(pendingRetry.status, 409);
    assert.deepEqual(await pendingRetry.json(), { message: "Only failed SMS deliveries can be retried." });

    const cooldownRetry = await fetch(`${baseUrl}/api/analysis-alerts/events/${cooldownEventId}/retry`, {
      method: "POST",
      headers: retryHeaders,
    });
    assert.equal(cooldownRetry.status, 200);
    assert.deepEqual(await cooldownRetry.json(), { deliveryStatus: "rate_limited" });
    assert.equal(providerAttempt, 0);

    const cooldownAttempts = await databasePool.query(
      `SELECT owner_id, rule_id, status, destination, error
         FROM analysis_alert_deliveries
        WHERE event_id = $1
        ORDER BY created_at`,
      [cooldownEventId],
    );
    assert.equal(cooldownAttempts.rows.length, 2);
    assert.equal(cooldownAttempts.rows.filter((attempt) => attempt.status === "failed").length, 1);
    const rateLimitedAttempt = cooldownAttempts.rows.find((attempt) => attempt.status === "rate_limited");
    assert.ok(rateLimitedAttempt);
    assert.equal(rateLimitedAttempt.owner_id, ownerId);
    assert.equal(rateLimitedAttempt.rule_id, currentRuleId);
    assert.equal(rateLimitedAttempt.destination, "+14••••73");
    assert.equal(rateLimitedAttempt.error, "SMS delivery rate limited by the 300-second rule cooldown.");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProviderConfig.accountSid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
    else process.env.TWILIO_ACCOUNT_SID = previousProviderConfig.accountSid;
    if (previousProviderConfig.authToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = previousProviderConfig.authToken;
    if (previousProviderConfig.from === undefined) delete process.env.TWILIO_FROM_NUMBER;
    else process.env.TWILIO_FROM_NUMBER = previousProviderConfig.from;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await databasePool.query("DELETE FROM analysis_alert_deliveries WHERE owner_id IN ($1, $2)", [ownerId, foreignOwnerId]);
    await databasePool.query("DELETE FROM analysis_alert_events WHERE owner_id IN ($1, $2)", [ownerId, foreignOwnerId]);
    await databasePool.query("DELETE FROM analysis_alert_rules WHERE owner_id IN ($1, $2)", [ownerId, foreignOwnerId]);
    await databasePool.query("DELETE FROM legacy_alert_recipients WHERE owner_id IN ($1, $2)", [ownerId, foreignOwnerId]);
  }
});


test("SMS provider failures preserve the trigger, failed attempt, masked response, and later evaluation", async () => {
  let ownerId = randomUUID();
  const ruleId = randomUUID();
  const recipientId = randomUUID();
  const phone = "+14155550171";
  const firstNow = new Date();
  const secondNow = new Date(firstNow.getTime() + 61_000);
  const firstObservedAt = new Date(firstNow.getTime() - 30_000);
  const secondObservedAt = new Date(firstNow.getTime() + 30_000);
  let observationCount = 0;
  const previousProviderConfig = {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_FROM_NUMBER,
  };
  const app = express();
  registerAnalysisAlertRoutes(app);
  const server = createServer(app);

  registerAnalysisAlertSourceAdapter("history", {
    async getObservation() {
      observationCount += 1;
      return {
        currentValue: 101,
        previousValue: null,
        observedAt: observationCount === 1 ? firstObservedAt : secondObservedAt,
      };
    },
  });

  const listen = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    // Use the provider's explicit unavailable response rather than making a
    // real network request or sending a message to the test destination.
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;

    await listen;
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const initialResponse = await fetch(`${baseUrl}/api/analysis-alerts`);
    assert.equal(initialResponse.status, 200);
    const setCookie = initialResponse.headers.get("set-cookie");
    assert.ok(setCookie);
    const ownerCookie = setCookie.split(";")[0];
    ownerId = decodeURIComponent(ownerCookie.split("=")[1]).split(".")[0];
    assert.match(ownerId, /^[0-9a-f-]{36}$/i);

    await databasePool.query(
      `INSERT INTO legacy_alert_recipients (id, owner_id, name, phone, display_phone, enabled, created_at)
       VALUES ($1, $2, 'Provider outage test', $3, $3, true, $4)`,
      [recipientId, ownerId, phone, firstNow],
    );
    await databasePool.query(
      `INSERT INTO analysis_alert_rules
        (id, owner_id, source, symbol, metric, "window", condition, threshold, cooldown_seconds,
         enabled, last_value, last_observed_at, last_evaluated_at, last_triggered_at, last_result,
         last_result_detail, delivery_channel, delivery_recipient_id, created_at, updated_at)
       VALUES ($1, $2, 'history', 'BTC', 'price', '24h', 'above', 100, 60,
         true, NULL, NULL, NULL, NULL, 'not_evaluated', 'Awaiting first evaluation.',
         'sms', $3, $4, $4)`,
      [ruleId, ownerId, recipientId, firstNow],
    );

    const ruleResult = await databasePool.query(
      `SELECT rule.*, recipient.id AS recipient_id, recipient.phone AS recipient_phone,
              recipient.enabled AS recipient_enabled
         FROM analysis_alert_rules rule
         JOIN legacy_alert_recipients recipient
           ON recipient.id = rule.delivery_recipient_id
          AND recipient.owner_id = rule.owner_id
        WHERE rule.id = $1 AND rule.owner_id = $2`,
      [ruleId, ownerId],
    );
    assert.equal(ruleResult.rows.length, 1);

    assert.equal(await evaluateAnalysisAlertRule(ruleResult.rows[0], firstNow), "triggered");

    const persistedRuleResult = await databasePool.query(
      `SELECT rule.*, recipient.id AS recipient_id, recipient.phone AS recipient_phone,
              recipient.enabled AS recipient_enabled
         FROM analysis_alert_rules rule
         JOIN legacy_alert_recipients recipient
           ON recipient.id = rule.delivery_recipient_id
          AND recipient.owner_id = rule.owner_id
        WHERE rule.id = $1 AND rule.owner_id = $2`,
      [ruleId, ownerId],
    );
    assert.equal(persistedRuleResult.rows.length, 1);
    assert.equal(await evaluateAnalysisAlertRule(persistedRuleResult.rows[0], secondNow), "triggered");

    const events = await databasePool.query(
      `SELECT id, created_at
         FROM analysis_alert_events
        WHERE owner_id = $1 AND rule_id = $2
        ORDER BY created_at`,
      [ownerId, ruleId],
    );
    assert.equal(events.rows.length, 2);

    const deliveries = await databasePool.query(
      `SELECT event_id, destination, status, error
         FROM analysis_alert_deliveries
        WHERE owner_id = $1 AND rule_id = $2
        ORDER BY created_at`,
      [ownerId, ruleId],
    );
    assert.equal(deliveries.rows.length, 2);
    assert.deepEqual(deliveries.rows.map((delivery) => delivery.status), ["failed", "failed"]);
    assert.deepEqual(deliveries.rows.map((delivery) => delivery.destination), ["+14••••71", "+14••••71"]);
    assert.deepEqual(
      deliveries.rows.map((delivery) => delivery.error),
      [
        "Twilio is unavailable right now.",
        "Twilio is unavailable right now.",
      ],
    );
    assert.ok(deliveries.rows.every((delivery) => !delivery.destination.includes(phone)));

    const retryResponse = await fetch(`${baseUrl}/api/analysis-alerts/events/${events.rows[0].id}/retry`, {
      method: "POST",
      headers: { cookie: ownerCookie, "sec-fetch-site": "same-origin" },
    });
    assert.equal(retryResponse.status, 200);
    assert.deepEqual(await retryResponse.json(), { deliveryStatus: "failed" });

    const response = await fetch(`${baseUrl}/api/analysis-alerts`, {
      headers: { cookie: ownerCookie },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      rules: Array<{ deliveryPhoneDisplay: string | null }>;
      events: Array<{
        id: string;
        deliveryStatus: string;
        deliveryError: string | null;
        deliveryDiagnostic: { category: string; message: string; recoveryAction: string } | null;
        retryable: boolean;
        deliveryAttempts: Array<{
          attemptNumber: number;
          status: string;
          error: string | null;
        }>;
      }>;
    };
    assert.equal(body.rules.length, 1);
    assert.equal(body.rules[0]?.deliveryPhoneDisplay, "+14••••71");
    assert.ok(!JSON.stringify(body).includes(phone));
    assert.deepEqual(body.events.map((event) => event.deliveryStatus), ["failed", "failed"]);
    assert.deepEqual(
      body.events.map((event) => event.deliveryError),
      [
        "Twilio is unavailable right now.",
        "Twilio is unavailable right now.",
      ],
    );
    assert.deepEqual(body.events.map((event) => event.deliveryDiagnostic), [
      {
        category: "provider_unavailable",
        message: "Twilio is unavailable right now.",
        recoveryAction: "Reconnect Twilio or try again later.",
      },
      {
        category: "provider_unavailable",
        message: "Twilio is unavailable right now.",
        recoveryAction: "Reconnect Twilio or try again later.",
      },
    ]);
    const retriedEvent = body.events.find((event) => event.id === events.rows[0]?.id);
    assert.ok(retriedEvent);
    assert.equal(retriedEvent.retryable, true);
    assert.deepEqual(retriedEvent.deliveryAttempts.map((delivery) => delivery.attemptNumber), [1, 2]);
    assert.deepEqual(retriedEvent.deliveryAttempts.map((delivery) => delivery.status), ["failed", "failed"]);
    assert.deepEqual(
      retriedEvent.deliveryAttempts.map((delivery) => delivery.error),
      [
        "Twilio is unavailable right now.",
        "Twilio is unavailable right now.",
      ],
    );
  } finally {
    if (previousProviderConfig.accountSid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
    else process.env.TWILIO_ACCOUNT_SID = previousProviderConfig.accountSid;
    if (previousProviderConfig.authToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = previousProviderConfig.authToken;
    if (previousProviderConfig.from === undefined) delete process.env.TWILIO_FROM_NUMBER;
    else process.env.TWILIO_FROM_NUMBER = previousProviderConfig.from;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await databasePool.query("DELETE FROM analysis_alert_deliveries WHERE owner_id = $1", [ownerId]);
    await databasePool.query("DELETE FROM analysis_alert_events WHERE owner_id = $1", [ownerId]);
    await databasePool.query("DELETE FROM analysis_alert_rules WHERE owner_id = $1", [ownerId]);
    await databasePool.query("DELETE FROM legacy_alert_recipients WHERE owner_id = $1", [ownerId]);
  }
});

test("SMS provider recovery persists the later sent attempt and keeps the original failure visible", async () => {
  let ownerId = randomUUID();
  const ruleId = randomUUID();
  const recipientId = randomUUID();
  const phone = "+14155550172";
  const firstNow = new Date();
  const secondNow = new Date(firstNow.getTime() + 61_000);
  const firstObservedAt = new Date(firstNow.getTime() - 30_000);
  const secondObservedAt = new Date(firstNow.getTime() + 30_000);
  let observationCount = 0;
  let providerAttempt = 0;
  const previousProviderConfig = {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_FROM_NUMBER,
  };
  const previousFetch = globalThis.fetch;
  const app = express();
  registerAnalysisAlertRoutes(app);
  const server = createServer(app);

  registerAnalysisAlertSourceAdapter("history", {
    async getObservation() {
      observationCount += 1;
      return {
        currentValue: 101,
        previousValue: null,
        observedAt: observationCount === 1 ? firstObservedAt : secondObservedAt,
      };
    },
  });

  const listen = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    process.env.TWILIO_ACCOUNT_SID = "AC-recovery-test";
    process.env.TWILIO_AUTH_TOKEN = "recovery-test-token";
    process.env.TWILIO_FROM_NUMBER = "+14155550000";
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("api.twilio.com")) {
        providerAttempt += 1;
        return new Response(
          providerAttempt === 1 ? JSON.stringify({ code: 30003 }) : JSON.stringify({ sid: "SM-recovery-test" }),
          { status: providerAttempt === 1 ? 500 : 201, headers: { "content-type": "application/json" } },
        );
      }
      return previousFetch(input, init);
    };

    await listen;
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const initialResponse = await fetch(`${baseUrl}/api/analysis-alerts`);
    assert.equal(initialResponse.status, 200);
    const setCookie = initialResponse.headers.get("set-cookie");
    assert.ok(setCookie);
    const ownerCookie = setCookie.split(";")[0];
    ownerId = decodeURIComponent(ownerCookie.split("=")[1]).split(".")[0];
    assert.match(ownerId, /^[0-9a-f-]{36}$/i);

    await databasePool.query(
      `INSERT INTO legacy_alert_recipients (id, owner_id, name, phone, display_phone, enabled, created_at)
       VALUES ($1, $2, 'Provider recovery test', $3, $3, true, $4)`,
      [recipientId, ownerId, phone, firstNow],
    );
    await databasePool.query(
      `INSERT INTO analysis_alert_rules
        (id, owner_id, source, symbol, metric, "window", condition, threshold, cooldown_seconds,
         enabled, last_value, last_observed_at, last_evaluated_at, last_triggered_at, last_result,
         last_result_detail, delivery_channel, delivery_recipient_id, created_at, updated_at)
       VALUES ($1, $2, 'history', 'BTC', 'price', '24h', 'above', 100, 60,
         true, NULL, NULL, NULL, NULL, 'not_evaluated', 'Awaiting first evaluation.',
         'sms', $3, $4, $4)`,
      [ruleId, ownerId, recipientId, firstNow],
    );

    const ruleResult = await databasePool.query(
      `SELECT rule.*, recipient.id AS recipient_id, recipient.phone AS recipient_phone,
              recipient.enabled AS recipient_enabled
         FROM analysis_alert_rules rule
         JOIN legacy_alert_recipients recipient
           ON recipient.id = rule.delivery_recipient_id
          AND recipient.owner_id = rule.owner_id
        WHERE rule.id = $1 AND rule.owner_id = $2`,
      [ruleId, ownerId],
    );
    assert.equal(ruleResult.rows.length, 1);
    assert.equal(await evaluateAnalysisAlertRule(ruleResult.rows[0], firstNow), "triggered");

    const persistedRuleResult = await databasePool.query(
      `SELECT rule.*, recipient.id AS recipient_id, recipient.phone AS recipient_phone,
              recipient.enabled AS recipient_enabled
         FROM analysis_alert_rules rule
         JOIN legacy_alert_recipients recipient
           ON recipient.id = rule.delivery_recipient_id
          AND recipient.owner_id = rule.owner_id
        WHERE rule.id = $1 AND rule.owner_id = $2`,
      [ruleId, ownerId],
    );
    assert.equal(persistedRuleResult.rows.length, 1);
    assert.equal(await evaluateAnalysisAlertRule(persistedRuleResult.rows[0], secondNow), "triggered");
    assert.equal(providerAttempt, 2);

    const deliveries = await databasePool.query(
      `SELECT destination, status, error
         FROM analysis_alert_deliveries
        WHERE owner_id = $1 AND rule_id = $2
        ORDER BY created_at`,
      [ownerId, ruleId],
    );
    assert.equal(deliveries.rows.length, 2);
    assert.deepEqual(deliveries.rows.map((delivery) => delivery.status), ["failed", "sent"]);
    assert.deepEqual(deliveries.rows.map((delivery) => delivery.destination), ["+14••••72", "+14••••72"]);
    assert.equal(deliveries.rows[0]?.error, "Twilio rejected the configured sender.");
    assert.equal(deliveries.rows[1]?.error, null);
    assert.ok(deliveries.rows.every((delivery) => !delivery.destination.includes(phone)));

    const response = await fetch(`${baseUrl}/api/analysis-alerts`, {
      headers: { cookie: ownerCookie },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      rules: Array<{ deliveryPhoneDisplay: string | null }>;
      events: Array<{
        deliveryStatus: string;
        deliveryError: string | null;
        deliveryDiagnostic: { category: string; message: string; recoveryAction: string } | null;
        retryable: boolean;
      }>;
    };
    assert.equal(body.rules[0]?.deliveryPhoneDisplay, "+14••••72");
    assert.ok(!JSON.stringify(body).includes(phone));
    assert.deepEqual(body.events.map((event) => event.deliveryStatus), ["sent", "failed"]);
    assert.deepEqual(body.events.map((event) => event.deliveryError), [
      null,
      "Twilio rejected the configured sender.",
    ]);
    assert.deepEqual(body.events.map((event) => event.deliveryDiagnostic), [
      null,
      {
        category: "sender_rejected",
        message: "Twilio rejected the configured sender.",
        recoveryAction: "Check the Twilio sender number and account permissions.",
      },
    ]);
    assert.deepEqual(body.events.map((event) => event.retryable), [false, true]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProviderConfig.accountSid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
    else process.env.TWILIO_ACCOUNT_SID = previousProviderConfig.accountSid;
    if (previousProviderConfig.authToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = previousProviderConfig.authToken;
    if (previousProviderConfig.from === undefined) delete process.env.TWILIO_FROM_NUMBER;
    else process.env.TWILIO_FROM_NUMBER = previousProviderConfig.from;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await databasePool.query("DELETE FROM analysis_alert_deliveries WHERE owner_id = $1", [ownerId]);
    await databasePool.query("DELETE FROM analysis_alert_events WHERE owner_id = $1", [ownerId]);
    await databasePool.query("DELETE FROM analysis_alert_rules WHERE owner_id = $1", [ownerId]);
    await databasePool.query("DELETE FROM legacy_alert_recipients WHERE owner_id = $1", [ownerId]);
  }
});
}