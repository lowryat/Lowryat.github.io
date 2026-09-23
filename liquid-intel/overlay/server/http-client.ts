import { backoffDelay, sleep } from "./resilience";

/**
 * One defensive HTTP consumer for every market-data provider.
 *
 * Per host it enforces a concurrency cap, a minimum spacing between requests,
 * a Retry-After cooldown after HTTP 429, and a circuit breaker after repeated
 * failures. Per request it enforces a timeout that also covers reading the
 * body, a response-size cap, bounded retries with jittered backoff, an optional
 * caller deadline, and validation. Nothing here throws: every call returns a
 * typed outcome so a failed source becomes an explicit "stale/unavailable"
 * state instead of a silent gap.
 */

export type HostPolicy = {
  maxConcurrent: number;
  minIntervalMs: number;
  timeoutMs: number;
  retries: number;
  failureThreshold: number;
  openMs: number;
  maxBytes: number;
  /** Longest provider Retry-After we are willing to wait inside one request. */
  maxRetryAfterWaitMs: number;
  /** Cooldown applied after a 429 that has no Retry-After header. */
  defaultRateLimitCooldownMs: number;
};

export const DEFAULT_HOST_POLICY: HostPolicy = {
  maxConcurrent: 4,
  minIntervalMs: 0,
  timeoutMs: 10_000,
  retries: 2,
  failureThreshold: 5,
  openMs: 60_000,
  maxBytes: 8_000_000,
  maxRetryAfterWaitMs: 5_000,
  defaultRateLimitCooldownMs: 30_000,
};

export type FetchFailureKind =
  | "timeout"
  | "network"
  | "http"
  | "rate_limited"
  | "circuit_open"
  | "parse"
  | "invalid"
  | "aborted"
  | "deadline"
  | "too_large";

export type FetchOutcome<T> =
  | { ok: true; value: T; status: number; latencyMs: number; attempts: number }
  | {
    ok: false;
    kind: FetchFailureKind;
    error: string;
    status?: number;
    latencyMs: number;
    attempts: number;
    retryAfterMs?: number;
  };

export type RequestOptions<T> = {
  headers?: Record<string, string>;
  /** External cancellation (for example a sweep deadline). */
  signal?: AbortSignal;
  /** Absolute epoch-ms deadline; queueing and retries stop before it. */
  deadlineAt?: number;
  /** Return null when valid, or a reason string when the payload is unusable. */
  validate?: (value: unknown) => string | null;
  /** Override the host policy's retry count for this call. */
  retries?: number;
  /** Map parsed JSON to the value returned to the caller. */
  transform?: (value: unknown) => T;
  /** High-priority calls (the live sweep) jump ahead of queued background backfills. */
  priority?: "high" | "normal";
};

export type HostStats = {
  host: string;
  requests: number;
  successes: number;
  failures: number;
  retries: number;
  rateLimited: number;
  timeouts: number;
  circuitOpens: number;
  queued: number;
  active: number;
  circuit: "closed" | "open" | "half_open";
  openUntil: string | null;
  cooldownUntil: string | null;
  consecutiveFailures: number;
  lastStatus: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
};

type HostState = {
  policy: HostPolicy;
  active: number;
  queue: object[];
  nextAllowedAt: number;
  cooldownUntil: number;
  openUntil: number;
  halfOpenInFlight: boolean;
  consecutiveFailures: number;
  latencies: number[];
  counters: { requests: number; successes: number; failures: number; retries: number; rateLimited: number; timeouts: number; circuitOpens: number };
  lastStatus: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
};

type AttemptResult =
  | { ok: true; status: number; body: string }
  | { ok: false; kind: FetchFailureKind; error: string; status?: number; retryAfterMs?: number; retryable: boolean };

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

async function readBodyLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw Object.assign(new Error(`Response declared ${declared} bytes (limit ${maxBytes}).`), { kind: "too_large" as const });
  }
  if (!response.body) return await response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw Object.assign(new Error(`Response exceeded ${maxBytes} bytes.`), { kind: "too_large" as const });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export class HttpClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly policies: Record<string, Partial<HostPolicy>>;
  private readonly hosts = new Map<string, HostState>();
  private readonly userAgent: string;
  private readonly highPriority = new WeakSet<object>();

  constructor(options: {
    fetcher?: typeof fetch;
    now?: () => number;
    policies?: Record<string, Partial<HostPolicy>>;
    userAgent?: string;
  } = {}) {
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.policies = options.policies ?? {};
    this.userAgent = options.userAgent ?? "LIQ-INTEL/2.0 market-data collector";
  }

  private state(host: string): HostState {
    let state = this.hosts.get(host);
    if (!state) {
      state = {
        policy: { ...DEFAULT_HOST_POLICY, ...(this.policies[host] ?? {}) },
        active: 0,
        queue: [],
        nextAllowedAt: 0,
        cooldownUntil: 0,
        openUntil: 0,
        halfOpenInFlight: false,
        consecutiveFailures: 0,
        latencies: [],
        counters: { requests: 0, successes: 0, failures: 0, retries: 0, rateLimited: 0, timeouts: 0, circuitOpens: 0 },
        lastStatus: null,
        lastError: null,
        lastErrorAt: null,
        lastSuccessAt: null,
      };
      this.hosts.set(host, state);
    }
    return state;
  }

  async getJson<T = unknown>(url: string, options: RequestOptions<T> = {}): Promise<FetchOutcome<T>> {
    return this.request<T>(url, options, "json");
  }

  async getText(url: string, options: RequestOptions<string> = {}): Promise<FetchOutcome<string>> {
    return this.request<string>(url, options, "text");
  }

  private async request<T>(url: string, options: RequestOptions<T>, mode: "json" | "text"): Promise<FetchOutcome<T>> {
    const startedAt = this.now();
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return { ok: false, kind: "invalid", error: "Invalid URL", latencyMs: 0, attempts: 0 };
    }
    const state = this.state(host);
    const policy = state.policy;
    const maxAttempts = 1 + Math.max(0, options.retries ?? policy.retries);
    let attempts = 0;
    let last: Extract<AttemptResult, { ok: false }> | null = null;

    while (attempts < maxAttempts) {
      if (options.signal?.aborted) return this.fail(state, "aborted", "Request cancelled", startedAt, attempts, undefined, false);
      if (options.deadlineAt != null && this.now() >= options.deadlineAt) {
        return this.fail(state, "deadline", "Caller deadline reached before the request could start", startedAt, attempts, undefined, false);
      }
      const circuit = this.circuitState(state);
      if (circuit === "open") {
        return this.fail(state, "circuit_open", `Circuit open for ${host} after ${state.consecutiveFailures} consecutive failures`, startedAt, attempts, undefined, false);
      }

      const acquired = await this.acquire(state, options.signal, options.deadlineAt, options.priority ?? "normal");
      if (acquired !== "ok") {
        return this.fail(state, acquired, acquired === "deadline" ? "Caller deadline reached while waiting for the host rate limit" : "Request cancelled", startedAt, attempts, undefined, false);
      }
      const halfOpenProbe = circuit === "half_open";
      if (halfOpenProbe) state.halfOpenInFlight = true;
      attempts += 1;
      state.counters.requests += 1;
      if (attempts > 1) state.counters.retries += 1;
      const attemptStartedAt = this.now();
      let result: AttemptResult;
      try {
        result = await this.attempt(url, options, policy);
      } finally {
        state.active -= 1;
        if (halfOpenProbe) state.halfOpenInFlight = false;
      }
      const latency = this.now() - attemptStartedAt;
      state.latencies.push(latency);
      if (state.latencies.length > 200) state.latencies.shift();

      if (result.ok) {
        let value: T;
        try {
          const parsed = mode === "json" ? JSON.parse(result.body) as unknown : result.body;
          const reason = options.validate?.(parsed) ?? null;
          if (reason) {
            // A structurally invalid payload is a provider problem, but retrying
            // immediately rarely helps; surface it without tripping the breaker.
            return this.fail(state, "invalid", `Validation failed: ${reason}`, startedAt, attempts, result.status, false, true);
          }
          value = options.transform ? options.transform(parsed) : parsed as T;
        } catch (error) {
          return this.fail(state, "parse", `Unparseable response: ${error instanceof Error ? error.message : "unknown"}`, startedAt, attempts, result.status, false, true);
        }
        state.consecutiveFailures = 0;
        state.openUntil = 0;
        state.counters.successes += 1;
        state.lastStatus = result.status;
        state.lastSuccessAt = this.now();
        return { ok: true, value, status: result.status, latencyMs: this.now() - startedAt, attempts };
      }

      last = result;
      state.lastStatus = result.status ?? null;
      if (result.kind === "rate_limited") {
        state.counters.rateLimited += 1;
        const cooldown = result.retryAfterMs ?? policy.defaultRateLimitCooldownMs;
        state.cooldownUntil = Math.max(state.cooldownUntil, this.now() + cooldown);
      }
      if (result.kind === "timeout") state.counters.timeouts += 1;
      if (result.retryable) this.recordHostFailure(state, result.error);
      else {
        state.lastError = result.error;
        state.lastErrorAt = this.now();
      }

      const moreAttempts = attempts < maxAttempts && result.retryable;
      if (!moreAttempts) break;
      let wait = backoffDelay(attempts - 1, 500, 8_000);
      if (result.kind === "rate_limited") {
        const retryAfter = result.retryAfterMs ?? policy.defaultRateLimitCooldownMs;
        if (retryAfter > policy.maxRetryAfterWaitMs) break;
        wait = Math.max(wait, retryAfter);
      }
      if (options.deadlineAt != null && this.now() + wait >= options.deadlineAt) break;
      try {
        await sleep(wait, options.signal);
      } catch {
        return this.fail(state, "aborted", "Request cancelled during backoff", startedAt, attempts, undefined, false);
      }
    }

    const failure = last ?? { kind: "network" as const, error: "Request failed", retryable: false };
    state.counters.failures += 1;
    return {
      ok: false,
      kind: failure.kind,
      error: failure.error,
      status: failure.status,
      latencyMs: this.now() - startedAt,
      attempts,
      retryAfterMs: failure.retryAfterMs,
    };
  }

  private fail<T>(
    state: HostState,
    kind: FetchFailureKind,
    error: string,
    startedAt: number,
    attempts: number,
    status: number | undefined,
    countHostFailure: boolean,
    countAsFailure = true,
  ): FetchOutcome<T> {
    if (countAsFailure) state.counters.failures += 1;
    if (countHostFailure) this.recordHostFailure(state, error);
    state.lastError = error;
    state.lastErrorAt = this.now();
    return { ok: false, kind, error, status, latencyMs: this.now() - startedAt, attempts };
  }

  private recordHostFailure(state: HostState, error: string) {
    state.consecutiveFailures += 1;
    state.lastError = error;
    state.lastErrorAt = this.now();
    if (state.consecutiveFailures >= state.policy.failureThreshold && state.openUntil <= this.now()) {
      state.openUntil = this.now() + state.policy.openMs;
      state.counters.circuitOpens += 1;
    }
  }

  private circuitState(state: HostState): "closed" | "open" | "half_open" {
    if (state.consecutiveFailures < state.policy.failureThreshold) return "closed";
    if (this.now() < state.openUntil) return "open";
    // After the open window one probe is allowed; concurrent callers still fail fast.
    return state.halfOpenInFlight ? "open" : "half_open";
  }

  private async acquire(
    state: HostState,
    signal: AbortSignal | undefined,
    deadlineAt: number | undefined,
    priority: "high" | "normal",
  ): Promise<"ok" | "deadline" | "aborted"> {
    const ticket = {};
    if (priority === "high") {
      // Behind other high-priority tickets, ahead of every normal one.
      const firstNormal = state.queue.findIndex((queued) => !this.highPriority.has(queued));
      if (firstNormal < 0) state.queue.push(ticket);
      else state.queue.splice(firstNormal, 0, ticket);
      this.highPriority.add(ticket);
    } else {
      state.queue.push(ticket);
    }
    try {
      for (;;) {
        if (signal?.aborted) return "aborted";
        const now = this.now();
        if (deadlineAt != null && now >= deadlineAt) return "deadline";
        const atHead = state.queue[0] === ticket;
        const readyAt = Math.max(state.nextAllowedAt, state.cooldownUntil);
        if (atHead && state.active < state.policy.maxConcurrent && now >= readyAt) {
          state.queue.shift();
          state.active += 1;
          state.nextAllowedAt = now + state.policy.minIntervalMs;
          return "ok";
        }
        const untilReady = atHead && state.active < state.policy.maxConcurrent ? readyAt - now : 25;
        const untilDeadline = deadlineAt != null ? deadlineAt - now : Number.POSITIVE_INFINITY;
        try {
          await sleep(Math.max(5, Math.min(untilReady, untilDeadline, 1_000)), signal);
        } catch {
          return "aborted";
        }
      }
    } finally {
      const index = state.queue.indexOf(ticket);
      if (index >= 0) state.queue.splice(index, 1);
      this.highPriority.delete(ticket);
    }
  }

  private async attempt<T>(url: string, options: RequestOptions<T>, policy: HostPolicy): Promise<AttemptResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), policy.timeoutMs);
    timer.unref?.();
    const onExternalAbort = () => controller.abort(options.signal?.reason ?? new Error("aborted"));
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      const response = await this.fetcher(url, {
        headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.1", "User-Agent": this.userAgent, ...(options.headers ?? {}) },
        signal: controller.signal,
      });
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), this.now());
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, kind: "rate_limited", error: `HTTP 429 rate limited${retryAfterMs != null ? ` (retry after ${Math.ceil(retryAfterMs / 1000)}s)` : ""}`, status: 429, retryAfterMs, retryable: true };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const retryable = response.status >= 500 || response.status === 408;
        return { ok: false, kind: "http", error: `HTTP ${response.status}`, status: response.status, retryable };
      }
      const body = await readBodyLimited(response, policy.maxBytes);
      return { ok: true, status: response.status, body };
    } catch (error) {
      if (options.signal?.aborted) return { ok: false, kind: "aborted", error: "Request cancelled", retryable: false };
      if (controller.signal.aborted) return { ok: false, kind: "timeout", error: `Request timed out after ${Math.round(policy.timeoutMs / 1000)}s`, retryable: true };
      if (error && typeof error === "object" && (error as { kind?: string }).kind === "too_large") {
        return { ok: false, kind: "too_large", error: (error as Error).message, retryable: false };
      }
      return { ok: false, kind: "network", error: `Network error: ${error instanceof Error ? error.message : "request failed"}`, retryable: true };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  hostStats(): HostStats[] {
    const iso = (value: number | null) => (value == null || value === 0 ? null : new Date(value).toISOString());
    return Array.from(this.hosts.entries()).map(([host, state]) => ({
      host,
      ...state.counters,
      queued: state.queue.length,
      active: state.active,
      circuit: this.circuitState(state),
      openUntil: state.openUntil > this.now() ? iso(state.openUntil) : null,
      cooldownUntil: state.cooldownUntil > this.now() ? iso(state.cooldownUntil) : null,
      consecutiveFailures: state.consecutiveFailures,
      lastStatus: state.lastStatus,
      lastError: state.lastError,
      lastErrorAt: iso(state.lastErrorAt),
      lastSuccessAt: iso(state.lastSuccessAt),
      p50LatencyMs: percentile(state.latencies, 0.5),
      p95LatencyMs: percentile(state.latencies, 0.95),
    })).sort((a, b) => a.host.localeCompare(b.host));
  }
}

/**
 * Shared client for public market APIs. Limits are deliberately below each
 * provider's published free-tier limits because several modules share them.
 */
export const marketHttp = new HttpClient({
  policies: {
    // Keyless public API allows roughly 5-30 calls/minute depending on load.
    "api.coingecko.com": { maxConcurrent: 1, minIntervalMs: process.env.COINGECKO_API_KEY ? 2_100 : 6_500, timeoutMs: 15_000, retries: 1, defaultRateLimitCooldownMs: 60_000, maxRetryAfterWaitMs: 0 },
    "pro-api.coingecko.com": { maxConcurrent: 3, minIntervalMs: 150, timeoutMs: 15_000, retries: 2 },
    "api.llama.fi": { maxConcurrent: 4, minIntervalMs: 100, timeoutMs: 20_000, retries: 2 },
    "stablecoins.llama.fi": { maxConcurrent: 2, minIntervalMs: 250, timeoutMs: 20_000, retries: 2, maxBytes: 25_000_000 },
    "api.exchange.coinbase.com": { maxConcurrent: 3, minIntervalMs: 150, timeoutMs: 12_000, retries: 2 },
    "api.kraken.com": { maxConcurrent: 1, minIntervalMs: 1_100, timeoutMs: 12_000, retries: 1 },
    "api.alternative.me": { maxConcurrent: 1, minIntervalMs: 1_000, timeoutMs: 10_000, retries: 1 },
  },
});

/** CoinGecko base URL and headers, honoring an optional demo or pro key. */
export function coinGeckoEndpoint(): { base: string; headers: Record<string, string> } {
  const pro = process.env.COINGECKO_PRO_API_KEY?.trim();
  if (pro) return { base: "https://pro-api.coingecko.com/api/v3", headers: { "x-cg-pro-api-key": pro } };
  const demo = (process.env.COINGECKO_API_KEY || process.env.COINGECKO_DEMO_API_KEY)?.trim();
  return { base: "https://api.coingecko.com/api/v3", headers: demo ? { "x-cg-demo-api-key": demo } : {} };
}

/** Human-readable error string in the format existing source-health records use. */
export function describeFailure(outcome: Extract<FetchOutcome<unknown>, { ok: false }>): string {
  switch (outcome.kind) {
    case "timeout": return "Request timed out";
    case "rate_limited": return outcome.error;
    case "circuit_open": return outcome.error;
    case "deadline": return "Skipped: sweep deadline reached";
    case "http": return outcome.error;
    case "invalid": return outcome.error;
    case "parse": return outcome.error;
    case "too_large": return outcome.error;
    case "aborted": return "Request cancelled";
    default: return "Request failed";
  }
}
