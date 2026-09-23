import type { Express } from "express";
import { createHash } from "crypto";
import type { Pool } from "pg";
import type {
  CoinGlassFeedResponse,
  DerivativesPoint,
  FeedErrorCode,
  FeedStatus,
} from "@shared/feed-types";
import { computeDerivativesAnalyses, type PriceHistoryPoint } from "./coinglass-analysis";
import { getPool } from "./db";
import { pruneFeedSeries, upsertFeedSeries, type FeedSeriesRow } from "./feed-series";

const BASE_URL = "https://open-api-v4.coinglass.com";
const CACHE_TTL_MS = 30_000;
const DEFAULT_POLL_MS = 60_000;
const MAX_WATCHLIST_SYMBOLS = 5;
const MAX_UPSTREAM_REQUESTS_PER_MINUTE = 12;
const ENTITLEMENT_CACHE_MS = 15 * 60_000;
const FEED_PROVIDER = "coinglass_v4";
const RANGES = ["1h", "6h", "24h", "7d"] as const;
type Range = typeof RANGES[number];

type EndpointResult = { data: unknown[]; sourceTime: number | null };
type AdapterError = Error & { code: FeedErrorCode; retryAfterMs?: number };
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type PersistedMetricRow = {
  metric: string;
  observed_at: string | Date;
  value: number | string;
  metadata: unknown;
};
type PersistedPriceRow = { captured_at: string | Date; price: number | string | null };

/**
 * These are process-wide intentionally: opening another range or creating a
 * second collection must not bypass an upstream plan denial or Retry-After.
 * The credential is represented only by its SHA-256 digest, never as a map
 * key, log value, URL value, or response field.
 */
const entitlementCache = new Map<string, { message: string; expiresAt: number }>();
let providerRetryUntil = 0;
let requestWindowStartedAt = 0;
let requestWindowCount = 0;
let lastFeedSeriesRetentionAt = 0;

const rangeConfig: Record<Range, { interval: string; limit: number; durationMs: number }> = {
  "1h": { interval: "1m", limit: 60, durationMs: 60 * 60_000 },
  "6h": { interval: "5m", limit: 72, durationMs: 6 * 60 * 60_000 },
  "24h": { interval: "1h", limit: 24, durationMs: 24 * 60 * 60_000 },
  "7d": { interval: "1h", limit: 168, durationMs: 7 * 24 * 60 * 60_000 },
};

function staleAfterForRange(range: Range): number {
  const interval = rangeConfig[range].interval;
  if (interval === "1m") return 2 * 60_000;
  if (interval === "5m") return 10 * 60_000;
  return 2 * 60 * 60_000;
}

function adapterError(code: FeedErrorCode, message: string, retryAfterMs?: number): AdapterError {
  return Object.assign(new Error(message), { code, retryAfterMs });
}

function credentialIdentity(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function normalizeSymbol(value: string): string | null {
  const symbol = value.trim().toUpperCase();
  return /^[A-Z0-9]{2,15}$/.test(symbol) ? symbol : null;
}

function asNumber(value: unknown): number | null {
  const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(result) ? result : null;
}

function timestamp(value: unknown): number | null {
  const parsed = asNumber(value);
  if (parsed != null) return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
  if (typeof value === "string") {
    const date = Date.parse(value);
    return Number.isFinite(date) ? date : null;
  }
  return null;
}

function firstNumber(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = asNumber(row[key]);
    if (value != null) return value;
  }
  return null;
}

function responseError(status: number, retryAfter: string | null): AdapterError {
  const retryAfterMs = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : 60_000;
  if (status === 429) return adapterError("RATE_LIMITED", "CoinGlass rate limit reached.", retryAfterMs);
  if (status === 401 || status === 403) return adapterError("NOT_ENTITLED", "CoinGlass rejected this endpoint for the configured subscription.");
  return adapterError("UPSTREAM_ERROR", `CoinGlass request failed with HTTP ${status}.`);
}

/** Test-only reset for process-wide provider protections. */
export function resetCoinGlassRequestCachesForTests(): void {
  entitlementCache.clear();
  providerRetryUntil = 0;
  requestWindowStartedAt = 0;
  requestWindowCount = 0;
}

function statusFromError(error: unknown): NonNullable<FeedStatus["error"]> {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const typed = error as AdapterError;
    return { code: typed.code, message: typed.message, ...(typed.retryAfterMs ? { retryAfterMs: typed.retryAfterMs } : {}) };
  }
  return { code: "UPSTREAM_ERROR", message: error instanceof Error ? error.message : "CoinGlass collection failed." };
}

function stateFromError(error: NonNullable<FeedStatus["error"]>): FeedStatus["state"] {
  if (error.code === "MISSING_CREDENTIALS") return "missing_credentials";
  if (error.code === "NOT_ENTITLED") return "not_entitled";
  if (error.code === "RATE_LIMITED") return "rate_limited";
  if (error.code === "INVALID_SYMBOL") return "unavailable";
  return "degraded";
}

function iso(time: number | null): string | null {
  return time == null ? null : new Date(time).toISOString();
}

function makeEmptyResponse(
  symbol: string,
  range: Range,
  now: number,
  error: NonNullable<FeedStatus["error"]>,
): CoinGlassFeedResponse {
  return {
    symbol,
    range,
    status: { state: stateFromError(error), lastUpdatedAt: null, ageMs: null, staleAfterMs: staleAfterForRange(range), error },
    metadata: {
      provider: "coinglass_v4",
      venue: "Binance futures",
      coverage: "No derivative values are available for this request.",
      interval: rangeConfig[range].interval,
      units: {
        fundingRate: "decimal rate", openInterestUsd: "USD",
        longLiquidationsUsd: "USD", shortLiquidationsUsd: "USD", longShortAccountRatio: "ratio",
      },
      sourceUpdatedAt: null,
      collectedAt: new Date(now).toISOString(),
    },
    current: {
      time: null, fundingRate: null, openInterestUsd: null, longLiquidationsUsd: null,
      shortLiquidationsUsd: null, longShortAccountRatio: null,
    },
    series: [],
    analyses: computeDerivativesAnalyses([], []),
  };
}

/**
 * CoinGlass V4 server adapter. The documented endpoints used here are:
 * funding-rate/history, open-interest/aggregated-history, liquidation/history,
 * and global-long-short-account-ratio/history. The latter three exchange
 * endpoints are explicitly labelled Binance/BTCUSDT rather than aggregated.
 */
export class CoinGlassCollection {
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly watchlist: Set<string>;
  private readonly cache = new Map<string, { value: CoinGlassFeedResponse; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<CoinGlassFeedResponse>>();
  private readonly pool: Pool | null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollCursor = 0;

  constructor(options: {
    fetcher?: FetchLike;
    now?: () => number;
    watchlist?: string[];
    pool?: Pool | null;
  } = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    const requested = options.watchlist?.length ? options.watchlist : ["BTC", "ETH", "SOL"];
    this.watchlist = new Set(requested.map(normalizeSymbol).filter((symbol): symbol is string => symbol !== null).slice(0, MAX_WATCHLIST_SYMBOLS));
    // The shared, hardened pool; this class never ends it.
    this.pool = options.pool === undefined ? getPool() : options.pool;
  }

  start(): void {
    if (this.pollTimer) return;
    const configured = Number(process.env.COINGLASS_POLL_INTERVAL_MS);
    const period = Number.isFinite(configured) ? Math.max(DEFAULT_POLL_MS, configured) : DEFAULT_POLL_MS;
    void this.pollWatchlist();
    this.pollTimer = setInterval(() => void this.pollWatchlist(), period);
    this.pollTimer.unref();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async pollWatchlist(): Promise<void> {
    // Round-robin one symbol per interval: each live snapshot costs four V4
    // endpoints, so the scheduled baseline is 4/min rather than 4 × watchlist.
    const symbols = Array.from(this.watchlist);
    if (!symbols.length) return;
    const symbol = symbols[this.pollCursor++ % symbols.length];
    if (!symbol) return;
    await this.get(symbol, "24h", true).catch(() => undefined);
  }

  get(symbolInput: string, range: Range, forceRefresh = false): Promise<CoinGlassFeedResponse> {
    const symbol = normalizeSymbol(symbolInput);
    const now = this.now();
    if (!symbol) {
      return Promise.resolve(makeEmptyResponse(symbolInput.toUpperCase(), range, now, {
        code: "INVALID_SYMBOL", message: "symbol must be an uppercase asset ticker, for example BTC",
      }));
    }
    if (!this.watchlist.has(symbol)) {
      return Promise.resolve(makeEmptyResponse(symbol, range, now, {
        code: "INVALID_SYMBOL",
        message: `${symbol} is outside the bounded server CoinGlass watchlist.`,
      }));
    }
    const key = `${symbol}:${range}`;
    const cached = this.cache.get(key);
    if (!forceRefresh && cached && cached.expiresAt > now) return Promise.resolve(this.withFreshness(cached.value));
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const request = (forceRefresh ? Promise.resolve(null) : this.loadPersisted(symbol, range))
      .then((persisted) => persisted ?? this.collect(symbol, range))
      .then((value) => {
        this.cache.set(key, { value, expiresAt: this.now() + CACHE_TTL_MS });
        return value;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  private async collect(symbol: string, range: Range): Promise<CoinGlassFeedResponse> {
    const now = this.now();
    const key = process.env.COINGLASS_API_KEY;
    if (!key) {
      return makeEmptyResponse(symbol, range, now, {
        code: "MISSING_CREDENTIALS",
        message: "CoinGlass is not configured on this server (COINGLASS_API_KEY is missing).",
      });
    }
    const config = rangeConfig[range];
    const startTime = now - config.durationMs;
    const pair = `${symbol}USDT`;
    const endpointRequests: Array<[string, Record<string, string>]> = [
      ["/api/futures/funding-rate/history", { exchange: "Binance", symbol: pair, interval: config.interval, limit: String(config.limit), start_time: String(startTime), end_time: String(now) }],
      ["/api/futures/open-interest/aggregated-history", { symbol, interval: config.interval, unit: "usd", limit: String(config.limit), start_time: String(startTime), end_time: String(now) }],
      ["/api/futures/liquidation/history", { exchange: "Binance", symbol: pair, interval: config.interval, limit: String(config.limit), start_time: String(startTime), end_time: String(now) }],
      ["/api/futures/global-long-short-account-ratio/history", { exchange: "Binance", symbol: pair, interval: config.interval, limit: String(config.limit), start_time: String(startTime), end_time: String(now) }],
    ];
    const outcomes: PromiseSettledResult<EndpointResult>[] = [];
    for (const [path, query] of endpointRequests) {
      try {
        outcomes.push({ status: "fulfilled", value: await this.request(path, query, key) });
      } catch (reason) {
        outcomes.push({ status: "rejected", reason });
        const error = statusFromError(reason);
        // A plan denial and a Retry-After apply to all following requests in
        // this collection. Stop immediately instead of multiplying failures.
        if (error.code === "NOT_ENTITLED" || error.code === "RATE_LIMITED") break;
      }
    }
    const skipped = (): PromiseRejectedResult => ({
      status: "rejected",
      reason: adapterError("UPSTREAM_ERROR", "CoinGlass endpoint was not requested after an earlier provider failure."),
    });
    const [funding = skipped(), openInterest = skipped(), liquidations = skipped(), longShort = skipped()] = outcomes;
    const failures = [funding, openInterest, liquidations, longShort]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => statusFromError(result.reason));
    const successful = [funding, openInterest, liquidations, longShort]
      .filter((result): result is PromiseFulfilledResult<EndpointResult> => result.status === "fulfilled");
    if (!successful.length) return makeEmptyResponse(symbol, range, now, failures[0] ?? {
      code: "NO_DATA", message: "CoinGlass returned no usable endpoint data.",
    });

    const points = new Map<number, DerivativesPoint>();
    const addRows = (result: PromiseSettledResult<EndpointResult>, apply: (point: DerivativesPoint, row: Record<string, unknown>) => void) => {
      if (result.status !== "fulfilled") return;
      for (const raw of result.value.data) {
        if (!raw || typeof raw !== "object") continue;
        const row = raw as Record<string, unknown>;
        const time = timestamp(row.time ?? row.timestamp ?? row.create_time);
        if (time == null) continue;
        const existing = points.get(time) ?? {
          time: new Date(time).toISOString(), fundingRate: null, openInterestUsd: null,
          longLiquidationsUsd: null, shortLiquidationsUsd: null, longShortAccountRatio: null,
        };
        apply(existing, row);
        points.set(time, existing);
      }
    };
    addRows(funding, (point, row) => { point.fundingRate = firstNumber(row, ["close", "funding_rate", "fundingRate", "rate"]); });
    addRows(openInterest, (point, row) => { point.openInterestUsd = firstNumber(row, ["close", "open_interest", "openInterest", "value"]); });
    addRows(liquidations, (point, row) => {
      point.longLiquidationsUsd = firstNumber(row, ["long_liquidation_usd", "longLiquidationUsd", "long_liquidation", "long"]);
      point.shortLiquidationsUsd = firstNumber(row, ["short_liquidation_usd", "shortLiquidationUsd", "short_liquidation", "short"]);
    });
    addRows(longShort, (point, row) => {
      const direct = firstNumber(row, ["long_short_ratio", "longShortRatio", "long_short_account_ratio", "ratio"]);
      const long = firstNumber(row, ["long_account", "longAccount", "long"]);
      const short = firstNumber(row, ["short_account", "shortAccount", "short"]);
      point.longShortAccountRatio = direct ?? (long != null && short != null && short !== 0 ? long / short : null);
    });
    const series = Array.from(points.entries()).sort(([left], [right]) => left - right).map(([, point]) => point);
    if (!series.length) {
      return makeEmptyResponse(symbol, range, now, failures[0] ?? {
        code: "NO_DATA",
        message: "CoinGlass returned no timestamped values for this symbol and interval.",
      });
    }
    const sourceTime = Math.max(...successful.map((result) => result.value.sourceTime ?? 0)) || null;
    const partialError = failures[0] ?? null;
    const response: CoinGlassFeedResponse = {
      symbol,
      range,
      status: {
        state: partialError ? stateFromError(partialError) : "live",
        lastUpdatedAt: iso(sourceTime),
        ageMs: sourceTime == null ? null : now - sourceTime,
        staleAfterMs: staleAfterForRange(range),
        error: partialError,
      },
      metadata: {
        provider: "coinglass_v4",
        venue: "Binance futures",
        coverage: partialError
          ? `Partial CoinGlass V4 response; unavailable endpoint: ${partialError.code}. Funding, liquidations and long/short are Binance BTCUSDT-style exchange series; OI is CoinGlass aggregated USD OI.`
          : "Funding, liquidations and long/short are Binance futures pair series; open interest is CoinGlass aggregated USD open interest.",
        interval: config.interval,
        units: {
          fundingRate: "decimal rate", openInterestUsd: "USD",
          longLiquidationsUsd: "USD", shortLiquidationsUsd: "USD", longShortAccountRatio: "ratio",
        },
        sourceUpdatedAt: iso(sourceTime),
        collectedAt: new Date(now).toISOString(),
      },
      current: this.currentFrom(series),
      series,
      analyses: computeDerivativesAnalyses(series, await this.loadPriceHistory(symbol, startTime)),
    };
    await this.persist(response);
    return response;
  }

  private async request(path: string, query: Record<string, string>, apiKey: string): Promise<EndpointResult> {
    const now = this.now();
    const entitlementKey = `${path}:${credentialIdentity(apiKey)}`;
    const entitlement = entitlementCache.get(entitlementKey);
    if (entitlement && entitlement.expiresAt > now) {
      throw adapterError("NOT_ENTITLED", entitlement.message);
    }
    if (providerRetryUntil > now) {
      throw adapterError("RATE_LIMITED", "CoinGlass is honoring the provider Retry-After.", providerRetryUntil - now);
    }
    if (now - requestWindowStartedAt >= 60_000 || requestWindowStartedAt === 0) {
      requestWindowStartedAt = now;
      requestWindowCount = 0;
    }
    if (requestWindowCount >= MAX_UPSTREAM_REQUESTS_PER_MINUTE) {
      throw adapterError(
        "RATE_LIMITED",
        "CoinGlass server request budget is exhausted; serving cache/persisted history until it resets.",
        60_000 - (now - requestWindowStartedAt),
      );
    }
    requestWindowCount += 1;
    const url = new URL(path, BASE_URL);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.fetcher(url.toString(), {
        headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw responseError(response.status, response.headers.get("retry-after"));
      const payload = await response.json() as { code?: string | number; msg?: string; data?: unknown[] };
      if (String(payload.code ?? "0") !== "0") {
        const message = payload.msg || "CoinGlass reported an error.";
        const code: FeedErrorCode = /entitle|permission|plan|subscription/i.test(message) ? "NOT_ENTITLED" : "UPSTREAM_ERROR";
        throw adapterError(code, message);
      }
      if (!Array.isArray(payload.data)) throw adapterError("NO_DATA", "CoinGlass response did not include a data array.");
      let latest: number | null = null;
      for (const row of payload.data) {
        if (row && typeof row === "object") {
          const time = timestamp((row as Record<string, unknown>).time ?? (row as Record<string, unknown>).timestamp);
          if (time != null && (latest == null || time > latest)) latest = time;
        }
      }
      return { data: payload.data, sourceTime: latest };
    } catch (error) {
      const normalized = error instanceof Error && error.name === "AbortError"
        ? adapterError("UPSTREAM_ERROR", "CoinGlass request timed out.")
        : error;
      const providerError = statusFromError(normalized);
      if (providerError.code === "NOT_ENTITLED") {
        entitlementCache.set(entitlementKey, { message: providerError.message, expiresAt: now + ENTITLEMENT_CACHE_MS });
      } else if (providerError.code === "RATE_LIMITED") {
        providerRetryUntil = Math.max(providerRetryUntil, now + (providerError.retryAfterMs ?? 60_000));
      }
      throw normalized;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Serve normalized durable points to UI range requests. Scheduled forced
   * refreshes remain responsible for contacting the provider, so persisted
   * history reduces browser-driven request multiplication without hiding age.
   */
  private async loadPersisted(symbol: string, range: Range): Promise<CoinGlassFeedResponse | null> {
    if (!this.pool) return null;
    const now = this.now();
    const config = rangeConfig[range];
    try {
      const result = await this.pool.query<PersistedMetricRow>(
        `SELECT metric, observed_at, value, metadata
           FROM market_feed_series
          WHERE provider = $1
            AND symbol = $2
            AND interval = $3
            AND observed_at >= $4
          ORDER BY observed_at ASC`,
        [FEED_PROVIDER, symbol, config.interval, new Date(now - config.durationMs)],
      );
      if (!result.rows.length) return null;
      const points = new Map<number, DerivativesPoint>();
      for (const row of result.rows) {
        const observedAt = new Date(row.observed_at).getTime();
        const value = asNumber(row.value);
        if (!Number.isFinite(observedAt) || value == null) continue;
        const point = points.get(observedAt) ?? {
          time: new Date(observedAt).toISOString(), fundingRate: null, openInterestUsd: null,
          longLiquidationsUsd: null, shortLiquidationsUsd: null, longShortAccountRatio: null,
        };
        if (row.metric === "funding_rate") point.fundingRate = value;
        else if (row.metric === "open_interest_usd") point.openInterestUsd = value;
        else if (row.metric === "long_liquidations_usd") point.longLiquidationsUsd = value;
        else if (row.metric === "short_liquidations_usd") point.shortLiquidationsUsd = value;
        else if (row.metric === "long_short_account_ratio") point.longShortAccountRatio = value;
        points.set(observedAt, point);
      }
      const series = Array.from(points.entries()).sort(([left], [right]) => left - right).map(([, point]) => point);
      if (!series.length) return null;
      const sourceTime = new Date(series[series.length - 1].time).getTime();
      const ageMs = now - sourceTime;
      const staleAfterMs = staleAfterForRange(range);
      const stale = ageMs > staleAfterMs;
      return {
        symbol,
        range,
        status: {
          state: stale ? "stale" : "live",
          lastUpdatedAt: iso(sourceTime),
          ageMs,
          staleAfterMs,
          error: stale ? { code: "STALE", message: "CoinGlass data is served from persisted history and is beyond its freshness threshold." } : null,
        },
        metadata: {
          provider: "coinglass_v4",
          venue: "Binance futures",
          coverage: "Persisted CoinGlass V4 normalized history. Funding, liquidations and long/short are Binance futures pair series; open interest is CoinGlass aggregated USD open interest.",
          interval: config.interval,
          units: {
            fundingRate: "decimal rate", openInterestUsd: "USD",
            longLiquidationsUsd: "USD", shortLiquidationsUsd: "USD", longShortAccountRatio: "ratio",
          },
          sourceUpdatedAt: iso(sourceTime),
          collectedAt: new Date(now).toISOString(),
        },
        current: this.currentFrom(series),
        series,
        analyses: computeDerivativesAnalyses(series, await this.loadPriceHistory(symbol, now - config.durationMs)),
      };
    } catch {
      // Persistence is an optimization; lack of a readable series falls back
      // to the provider path, whose failures remain explicit to the caller.
      return null;
    }
  }

  private async loadPriceHistory(symbol: string, startTime: number): Promise<PriceHistoryPoint[]> {
    if (!this.pool) return [];
    try {
      const result = await this.pool.query<PersistedPriceRow>(
        `SELECT captured_at, price
           FROM market_snapshots
          WHERE symbol = $1 AND captured_at >= $2 AND price IS NOT NULL
          ORDER BY captured_at ASC`,
        [symbol, new Date(startTime)],
      );
      return result.rows.flatMap((row) => {
        const time = new Date(row.captured_at).getTime();
        const price = asNumber(row.price);
        return Number.isFinite(time) && price != null && price > 0
          ? [{ time: new Date(time).toISOString(), price }]
          : [];
      });
    } catch {
      // Price/OI divergence remains explicitly null while raw derivatives data
      // and its other deterministic studies remain usable.
      return [];
    }
  }

  private currentFrom(series: DerivativesPoint[]): CoinGlassFeedResponse["current"] {
    const latest = series.at(-1);
    if (!latest) return {
      time: null, fundingRate: null, openInterestUsd: null, longLiquidationsUsd: null,
      shortLiquidationsUsd: null, longShortAccountRatio: null,
    };
    const newest = <K extends keyof Omit<DerivativesPoint, "time">>(key: K): DerivativesPoint[K] => {
      for (let index = series.length - 1; index >= 0; index -= 1) {
        if (series[index][key] != null) return series[index][key];
      }
      return null;
    };
    return {
      time: latest.time,
      fundingRate: newest("fundingRate"),
      openInterestUsd: newest("openInterestUsd"),
      longLiquidationsUsd: newest("longLiquidationsUsd"),
      shortLiquidationsUsd: newest("shortLiquidationsUsd"),
      longShortAccountRatio: newest("longShortAccountRatio"),
    };
  }

  private withFreshness(response: CoinGlassFeedResponse): CoinGlassFeedResponse {
    const now = this.now();
    const sourceTime = response.metadata.sourceUpdatedAt ? Date.parse(response.metadata.sourceUpdatedAt) : null;
    const ageMs = sourceTime == null ? null : now - sourceTime;
    const stale = ageMs != null && ageMs > response.status.staleAfterMs;
    return {
      ...response,
      status: stale
        ? { ...response.status, state: "stale", ageMs, error: { code: "STALE", message: "CoinGlass cache is older than its freshness threshold." } }
        : { ...response.status, ageMs },
      metadata: { ...response.metadata, collectedAt: new Date(now).toISOString() },
    };
  }

  private async persist(response: CoinGlassFeedResponse): Promise<void> {
    if (!this.pool) return;
    const metrics: Array<[string, keyof Omit<DerivativesPoint, "time">]> = [
      ["funding_rate", "fundingRate"], ["open_interest_usd", "openInterestUsd"],
      ["long_liquidations_usd", "longLiquidationsUsd"], ["short_liquidations_usd", "shortLiquidationsUsd"],
      ["long_short_account_ratio", "longShortAccountRatio"],
    ];
    const metadata = JSON.stringify(response.metadata);
    const rows: FeedSeriesRow[] = response.series.flatMap((point) => metrics.flatMap(([metric, key]) => {
      const value = point[key];
      if (value == null) return [];
      return [{
        provider: FEED_PROVIDER, symbol: response.symbol, metric, interval: response.metadata.interval,
        observedAt: new Date(point.time), value, metadata,
      }];
    }));
    try {
      // One multi-row statement instead of up to 840 concurrent single-row queries.
      await upsertFeedSeries(this.pool, rows);
      const now = this.now();
      if (now - lastFeedSeriesRetentionAt >= 24 * 60 * 60_000 || lastFeedSeriesRetentionAt === 0) {
        lastFeedSeriesRetentionAt = now;
        await pruneFeedSeries(this.pool, FEED_PROVIDER, new Date(now - 90 * 24 * 60 * 60_000));
      }
    } catch {
      // A missing development migration must not turn valid provider data into a fabricated outage.
    }
  }
}

let sharedCollection: CoinGlassCollection | null = null;

/** Starts bounded, server-side CoinGlass polling. Credentials are read only from process.env. */
export function startCoinGlassCollection(): CoinGlassCollection {
  if (!sharedCollection) {
    const watchlist = process.env.COINGLASS_WATCHLIST?.split(",");
    sharedCollection = new CoinGlassCollection({ watchlist });
    sharedCollection.start();
  }
  return sharedCollection;
}

/** Registers GET /api/coinglass?symbol=BTC&range=24h. */
export function registerCoinGlassRoutes(app: Express): void {
  app.get("/api/coinglass", async (req, res) => {
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol : "";
    const range = typeof req.query.range === "string" && (RANGES as readonly string[]).includes(req.query.range)
      ? req.query.range as Range
      : null;
    if (!range) return res.status(400).json({ message: "range must be one of 1h, 6h, 24h, 7d" });
    const collection = sharedCollection ?? (sharedCollection = new CoinGlassCollection());
    const response = await collection.get(symbol, range);
    const statusCode = response.status.state === "missing_credentials" ? 503
      : response.status.state === "not_entitled" ? 200
      : response.status.state === "rate_limited" ? 429
      : response.status.error?.code === "INVALID_SYMBOL" ? 400
      : 200;
    return res.status(statusCode).json(response);
  });
}
