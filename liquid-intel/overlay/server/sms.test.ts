import assert from "node:assert/strict";
import test from "node:test";
import { explainTwilioCode, normalizeSmsFailure, normalizeSmsText, sendSms, smsProviderPlan, trackSmsDelivery, type SmsDeliveryUpdate } from "./sms";
import { buildPushPayload, sendPush } from "./push";

const TWILIO_KEYS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "TWILIO_MESSAGING_SERVICE_SID", "REPLIT_CONNECTORS_HOSTNAME", "REPL_IDENTITY", "NTFY_TOPIC"];

async function withEnv(values: Record<string, string | undefined>, fetcher: typeof fetch | null, run: () => Promise<void>) {
  const previous = Object.fromEntries(TWILIO_KEYS.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  try {
    for (const key of TWILIO_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value;
    if (fetcher) globalThis.fetch = fetcher;
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of TWILIO_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

const LEGACY = { TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "token", TWILIO_FROM_NUMBER: "+14155550000" };

test("alerts are normalized to GSM-7 so one symbol cannot triple the SMS cost", () => {
  const text = normalizeSmsText("LIQ·INTEL — BTC ↑ 5% “breakout” … ≥ 60k 🚀");
  assert.equal(text, "LIQ-INTEL - BTC up 5% \"breakout\" ... >= 60k");
  assert.ok(/^[\x20-\x7E]*$/.test(text));
});

test("explicit Twilio secrets are tried before the managed connector", async () => {
  await withEnv({ ...LEGACY, REPLIT_CONNECTORS_HOSTNAME: "connectors.test", REPL_IDENTITY: "id" }, null, async () => {
    assert.deepEqual(smsProviderPlan(), ["legacy", "managed"]);
  });
  await withEnv({ REPLIT_CONNECTORS_HOSTNAME: "connectors.test", REPL_IDENTITY: "id" }, null, async () => {
    assert.deepEqual(smsProviderPlan(), ["managed"]);
  });
  await withEnv({}, null, async () => assert.deepEqual(smsProviderPlan(), []));
});

test("the common Twilio error codes produce specific, actionable guidance", () => {
  assert.equal(explainTwilioCode(21610)?.category, "recipient_rejected");
  assert.match(explainTwilioCode(21610)!.recoveryAction, /START/);
  assert.match(explainTwilioCode(30034)!.message, /10DLC/);
  assert.match(explainTwilioCode(21608)!.message, /trial/);
  assert.equal(explainTwilioCode(99999), null);
  // A persisted message keeps its code, so it can be re-explained later.
  assert.equal(normalizeSmsFailure("The recipient replied STOP and has opted out (21610).")?.category, "recipient_rejected");
});

test("a Messaging Service SID replaces the From number when configured", async () => {
  let body = "";
  await withEnv({ ...LEGACY, TWILIO_FROM_NUMBER: undefined, TWILIO_MESSAGING_SERVICE_SID: "MGtest" }, (async (_url: unknown, init?: RequestInit) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ sid: "SM1", status: "queued" }), { status: 201 });
  }) as typeof fetch, async () => {
    const result = await sendSms("+14155550171", "hello");
    assert.deepEqual(result, { sent: true, sid: "SM1" });
  });
  assert.match(body, /MessagingServiceSid=MGtest/);
  assert.doesNotMatch(body, /From=/);
});

test("a Twilio 400 with a known code returns the specific explanation", async () => {
  await withEnv(LEGACY, (async () => new Response(JSON.stringify({ code: 21610, message: "raw provider text" }), { status: 400 })) as typeof fetch, async () => {
    const result = await sendSms("+14155550171", "hello");
    assert.equal(result.sent, false);
    assert.match(result.error ?? "", /opted out \(21610\)/);
    assert.doesNotMatch(JSON.stringify(result), /raw provider text/);
  });
});

test("delivery tracking reports the carrier's final status, not just Twilio's acceptance", async () => {
  const statuses = ["queued", "sent", "undelivered"];
  let poll = 0;
  const updates: SmsDeliveryUpdate[] = [];
  await withEnv(LEGACY, (async () => {
    const status = statuses[Math.min(poll, statuses.length - 1)];
    poll += 1;
    return new Response(JSON.stringify({ sid: "SM2", status, error_code: status === "undelivered" ? 30034 : null }), { status: 200 });
  }) as typeof fetch, async () => {
    // Tracking timers are unref'd so they never hold a server or CLI open; keep this test alive.
    const keepAlive = setInterval(() => undefined, 1_000);
    try {
      await new Promise<void>((resolve) => {
        trackSmsDelivery("SM2", (update) => {
          updates.push(update);
          if (update.final) resolve();
        }, [1, 2, 3, 4]);
      });
    } finally {
      clearInterval(keepAlive);
    }
  });
  assert.deepEqual(updates.map((update) => update.status), ["sent", "undelivered"]);
  assert.equal(updates[1].errorCode, 30034);
  assert.match(updates[1].error ?? "", /10DLC/);
});

test("push payloads are JSON so emoji and symbols in titles are safe", () => {
  const payload = buildPushPayload("topic", "LIQ·INTEL 🚨 BTC", "crossed 60k", { priority: "high", tags: ["chart"] });
  assert.equal(payload.title, "LIQ·INTEL 🚨 BTC");
  assert.equal(payload.priority, 4);
  assert.doesNotThrow(() => JSON.stringify(payload));
});

test("push is a no-op without a topic and reports HTTP failures", async () => {
  await withEnv({}, null, async () => {
    assert.equal((await sendPush("t", "m")).sent, false);
  });
  await withEnv({ NTFY_TOPIC: "liq-test" }, null, async () => {
    const failed = await sendPush("t", "m", { fetcher: (async () => new Response("no", { status: 500 })) as typeof fetch });
    assert.deepEqual(failed, { sent: false, error: "ntfy returned HTTP 500" });
    let sentBody = "";
    const sent = await sendPush("Title ✓", "Body", { fetcher: (async (_url: unknown, init?: RequestInit) => { sentBody = String(init?.body); return new Response("{}", { status: 200 }); }) as typeof fetch });
    assert.equal(sent.sent, true);
    assert.equal(JSON.parse(sentBody).title, "Title ✓");
  });
});
