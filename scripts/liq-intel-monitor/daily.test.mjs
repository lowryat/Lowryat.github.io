import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runDailyMonitor, validateConfig, REQUEST_TIMEOUT_MS, RETRY_DELAY_MS } from "./daily.mjs";
import { probeBrowser } from "./browser.mjs";

const token = "test-private-access-token";
const topic = "test-private-topic";
const env = {
  MONITOR_DEV_URL: "https://development.example/",
  MONITOR_PROD_URL: "https://published.example/",
  MONITOR_PROD_EXTERNAL_ACCESS_TOKEN: token,
  MONITOR_DEV_EXTERNAL_ACCESS_TOKEN: "test-development-token",
  NTFY_TOPIC: topic,
};
const config = validateConfig(env);
const healthy = { status: "healthy", issues: [] };

async function scenario({ responses = [healthy, healthy], browser = [], notification = 200 } = {}) {
  const calls = [];
  const events = [];
  const waits = [];
  const logs = [];
  const result = await runDailyMonitor(config, {
    fetcher: async (url, options) => {
      calls.push({ url, options });
      events.push(url === "https://ntfy.sh/" ? "notification" : new URL(url).hostname);
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.redirect, "manual");
      if (url === "https://ntfy.sh/") {
        if (notification instanceof Error) throw notification;
        return { status: notification };
      }
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return typeof next === "number"
        ? { status: next }
        : { status: 200, json: async () => next };
    },
    browserProbe: async environment => {
      events.push(`browser:${environment.name}`);
      return typeof browser === "function" ? browser(environment) : browser;
    },
    sleep: async ms => waits.push(ms),
    log: message => logs.push(message),
  });
  const output = JSON.stringify({ logs, message: result.message });
  for (const privateValue of [token, topic, env.MONITOR_DEV_EXTERNAL_ACCESS_TOKEN, "sensitive-private-message", env.MONITOR_PROD_URL, env.MONITOR_DEV_URL]) {
    assert.equal(output.includes(privateValue), false);
  }
  return { ...result, calls, events, waits, logs };
}

test("healthy environments are sequential, use one health check each and one daily report", async () => {
  const result = await scenario();
  assert.equal(result.ok, true);
  assert.deepEqual(result.events, ["development.example", "browser:Development", "published.example", "browser:Published", "notification"]);
  assert.equal(result.calls.length, 3);
  assert.equal(result.waits.length, 0);
  assert.equal(result.calls[1].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(JSON.parse(result.calls.at(-1).options.body).topic, topic);
  assert.match(result.message, /not continuous monitoring/);
  assert.equal(REQUEST_TIMEOUT_MS, 10_000);
});

test("401, 403, 429, and redirects neither retry nor open a browser", async () => {
  for (const status of [401, 403, 429, 302]) {
    const result = await scenario({ responses: [status, healthy] });
    assert.equal(result.ok, false);
    assert.equal(result.results[0].browser, "skipped");
    assert.equal(result.waits.length, 0);
    assert.equal(result.calls.length, 3);
    assert.match(result.message, status === 429 ? /Respect the rate limit/ : status === 302 ? /login\/redirect/ : /access token/);
  }
});

test("5xx has at most one retry after a minute, including recovery", async () => {
  const recovered = await scenario({ responses: [503, healthy, healthy] });
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.waits, [RETRY_DELAY_MS]);
  assert.equal(RETRY_DELAY_MS, 60_000);
  const failed = await scenario({ responses: [503, 502, healthy] });
  assert.equal(failed.ok, false);
  assert.equal(failed.calls.length, 4);
  assert.deepEqual(failed.waits, [60_000]);
});

test("timeouts and unavailable preview get only one spaced retry and safe advice", async () => {
  for (const name of ["TimeoutError", "Error"]) {
    const error = Object.assign(new Error(`sensitive-private-message ${token}`), { name });
    const result = await scenario({ responses: [error, error, healthy] });
    assert.equal(result.ok, false);
    assert.equal(result.results[0].browser, "skipped");
    assert.deepEqual(result.waits, [60_000]);
    assert.match(result.message, name === "TimeoutError" ? /latency/ : /preview is running/);
  }
});

test("runtime exception yields a focused investigation, not an automatic fix", async () => {
  const result = await scenario({ browser: ["browser-runtime-error"] });
  assert.equal(result.ok, false);
  assert.match(result.message, /source maps/);
  assert.match(result.message, /No automatic fixes/);
});

test("pipeline issues retain only fixed categories and severity counts", async () => {
  const result = await scenario({ responses: [{
    status: "degraded",
    issues: [
      { area: `host:sensitive-private-message-${token}`, severity: "warning", message: token },
      { area: "database", severity: "warning", message: "sensitive-private-message" },
    ],
    privateMetadata: token,
  }, healthy] });
  assert.equal(result.results[0].state, "degraded");
  assert.deepEqual(result.results[0].pipeline.areas, ["providers", "database"]);
  assert.match(result.message, /2 warnings/);
  assert.match(result.message, /cooldowns/);
});

test("invalid pipeline shape fails explicitly without repeated requests", async () => {
  const result = await scenario({ responses: [{ status: "unknown", issues: [] }, healthy] });
  assert.equal(result.ok, false);
  assert.equal(result.waits.length, 0);
  assert.match(result.message, /response contract/);
});

test("untrusted browser adapter results cannot silently pass or leak details", async () => {
  const result = await scenario({ browser: [`sensitive-private-message ${token}`] });
  assert.equal(result.ok, false);
  assert.match(result.message, /coverage did not run/);
});

test("notification failures exit unsuccessfully and are not retried", async () => {
  for (const notification of [500, Object.assign(new Error(token), { name: "TimeoutError" })]) {
    const result = await scenario({ notification });
    assert.equal(result.ok, false);
    assert.equal(result.notified, false);
    assert.equal(result.calls.filter(call => call.url === "https://ntfy.sh/").length, 1);
  }
});

test("configuration rejects unsafe URLs and missing configuration without secret output", () => {
  for (const url of ["http://published.example/", "https://user:pass@published.example/", "https://published.example/?token=private", "https://published.example/other"]) {
    assert.throws(() => validateConfig({ ...env, MONITOR_PROD_URL: url }), /Invalid monitor URL/);
  }
  assert.throws(() => validateConfig({ ...env, NTFY_TOPIC: "" }), /Missing monitor configuration/);
  assert.equal(validateConfig({ ...env, MONITOR_DEV_EXTERNAL_ACCESS_TOKEN: "" }).environments[0].token, "");
});

function fakeChromium({ runtimeError = false, overlay = false, text = "Market posture", navigationError } = {}) {
  let handler;
  let pageError;
  let closed = 0;
  const page = {
    setDefaultTimeout() {},
    on: (event, callback) => { if (event === "pageerror") pageError = callback; },
    route: async (_pattern, callback) => { handler = callback; },
    goto: async (_url, options) => {
      assert.equal(options.waitUntil, "domcontentloaded");
      assert.equal(options.timeout, 20_000);
      if (navigationError) throw navigationError;
      if (runtimeError) pageError(new Error(token));
      return { status: () => 200 };
    },
    waitForTimeout: async ms => assert.equal(ms, 4_000),
    locator: selector => ({ innerText: async () => text, count: async () => selector === "vite-error-overlay" && overlay ? 1 : 0 }),
  };
  const context = { newPage: async () => page, close: async () => { closed++; } };
  return {
    chromium: { launch: async () => ({ newContext: async () => context, close: async () => { closed++; } }) },
    route: async url => {
      let continued;
      await handler({
        request: () => ({ url: () => url, headers: () => ({ authorization: `Bearer ${token}` }) }),
        continue: async options => { continued = options; },
      });
      return continued;
    },
    closed: () => closed,
  };
}

test("browser catches runtime errors/overlays and rejects login/interstitial content", async () => {
  for (const options of [{ runtimeError: true }, { overlay: true }, { text: "Sign in" }]) {
    const fake = fakeChromium(options);
    const failures = await probeBrowser(config.environments[1], { chromium: fake.chromium });
    assert.deepEqual(failures, [options.text ? "app-content-missing" : "browser-runtime-error"]);
    assert.equal(fake.closed(), 2);
  }
});

test("browser credential attaches only to same origin, including redirect protection", async () => {
  const fake = fakeChromium();
  assert.deepEqual(await probeBrowser(config.environments[1], { chromium: fake.chromium }), []);
  assert.equal((await fake.route("https://published.example/asset.js")).headers.authorization, `Bearer ${token}`);
  assert.equal((await fake.route("https://third-party.example/asset.js")).headers.authorization, undefined);
});

test("browser timeout closes resources, with no repeat navigation", async () => {
  const fake = fakeChromium({ navigationError: Object.assign(new Error(token), { name: "TimeoutError" }) });
  assert.deepEqual(await probeBrowser(config.environments[1], { chromium: fake.chromium }), ["page-timeout"]);
  assert.equal(fake.closed(), 2);
});

test("workflow uses Pacific schedule, bounded job and no app startup/build commands", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/liq-intel-daily-monitor.yml", import.meta.url), "utf8");
  assert.match(workflow, /cron: '0 8 \* \* \*'/);
  assert.match(workflow, /timezone: America\/Los_Angeles/);
  assert.match(workflow, /timeout-minutes: 10/);
  assert.doesNotMatch(workflow, /npm run (?:dev|start|build)|api\/operations\/status/);
});
