import assert from "node:assert/strict";
import test from "node:test";
import { HttpClient, parseRetryAfter } from "./http-client";

type Handler = (url: string, init?: RequestInit) => Promise<Response>;

function client(handler: Handler, policy: Record<string, unknown> = {}) {
  let calls = 0;
  const http = new HttpClient({
    fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      return handler(String(input), init);
    }) as typeof fetch,
    policies: { "api.test": { retries: 0, timeoutMs: 200, minIntervalMs: 0, ...policy } },
  });
  return { http, calls: () => calls };
}

const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });

test("parseRetryAfter accepts seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("3"), 3_000);
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", now), 10_000);
  assert.equal(parseRetryAfter(null), undefined);
});

test("successful JSON requests return typed values and pass validation", async () => {
  const { http } = client(async () => json({ ok: 1 }));
  const outcome = await http.getJson<{ ok: number }>("https://api.test/a", { validate: (value) => ((value as { ok?: number }).ok === 1 ? null : "bad") });
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.deepEqual(outcome.value, { ok: 1 });
});

test("invalid payloads become explicit failures instead of silent gaps", async () => {
  const { http } = client(async () => json({ nope: true }));
  const outcome = await http.getJson("https://api.test/a", { validate: () => "missing field" });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.kind, "invalid");
});

test("a 429 puts the host into cooldown so later calls fail fast without hitting the API", async () => {
  const { http, calls } = client(async () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }), { maxRetryAfterWaitMs: 0 });
  const first = await http.getJson("https://api.test/a");
  assert.equal(first.ok, false);
  if (!first.ok) assert.equal(first.kind, "rate_limited");
  const second = await http.getJson("https://api.test/b");
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.kind, "rate_limited");
  assert.equal(calls(), 1);
  assert.ok(http.hostStats().find((host) => host.host === "api.test")?.cooldownUntil);
});

test("repeated server errors open the circuit and stop calling the host", async () => {
  const { http, calls } = client(async () => new Response("down", { status: 503 }), { failureThreshold: 3, openMs: 60_000 });
  for (let index = 0; index < 3; index += 1) await http.getJson("https://api.test/x");
  const blocked = await http.getJson("https://api.test/x");
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.kind, "circuit_open");
  assert.equal(calls(), 3);
});

test("a 404 does not count toward the circuit breaker", async () => {
  const { http } = client(async () => new Response("missing", { status: 404 }), { failureThreshold: 2 });
  for (let index = 0; index < 4; index += 1) await http.getJson("https://api.test/missing");
  assert.equal(http.hostStats().find((host) => host.host === "api.test")?.circuit, "closed");
});

test("a response that never finishes is cut off by the request timeout", async () => {
  const { http } = client(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }), { timeoutMs: 30 });
  const started = Date.now();
  const outcome = await http.getJson("https://api.test/hang");
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.kind, "timeout");
  assert.ok(Date.now() - started < 1_000);
});

test("oversized bodies are rejected", async () => {
  const { http } = client(async () => json({ data: "x".repeat(5_000) }), { maxBytes: 1_000 });
  const outcome = await http.getJson("https://api.test/big");
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.kind, "too_large");
});

test("the per-host concurrency cap holds under a burst", async () => {
  let active = 0;
  let peak = 0;
  const { http } = client(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return json({ ok: true });
  }, { maxConcurrent: 2 });
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => http.getJson(`https://api.test/${index}`)));
  assert.ok(results.every((result) => result.ok));
  assert.equal(peak, 2);
});

test("an external abort cancels the request", async () => {
  const { http } = client(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }), { timeoutMs: 5_000 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  const outcome = await http.getJson("https://api.test/cancel", { signal: controller.signal });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.kind, "aborted");
});
