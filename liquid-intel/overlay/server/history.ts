import type { DashboardData } from "@shared/schema";
import type { HistoryMetric, HistoryRange, HistoryResponse } from "@shared/history";
import { startCoinbaseFeed } from "./coinbase";
import { getPool } from "./db";
import { TtlCache } from "./resilience";

const METRIC_LABELS: Record<HistoryMetric, string> = {
  price: "price (USD)",
  marketCap: "market cap (USD)",
  stablecoinMcap: "stablecoin market cap (USD)",
  tvl: "DeFi TVL (USD)",
  volume: "24h trading volume (USD)",
  dexVolume: "DEX volume (USD)",
  snapshotVwap: "snapshot-weighted average price (USD)",
  flowMomentum: "flow momentum score (−100 to +100)",
};

/** Bounded in-memory cache: key → { text, expiresAt }. */
const interpretationCache = new Map<string, { text: string; expiresAt: number }>();
const deterministicHistoryContext = new Map<string, {
  formula: string;
  source: string;
  observedAt: string | null;
  summary: string;
  expiresAt: number;
}>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_INTERPRETATION_CACHE_ENTRIES = 300;
/** Rows change once per minute; readers within this window share one query. */
const ROW_CACHE_TTL_MS = 20_000;
/** Rows per multi-row upsert statement. */
const UPSERT_CHUNK_SIZE = 500;

/** Token-bucket rate limiter: max AI calls per minute across all requests. */
let rateBucket = 20;
let rateBucketResetAt = Date.now() + 60_000;
const RATE_LIMIT = 20;

function consumeRateToken(): boolean {
  const now = Date.now();
  if (now >= rateBucketResetAt) {
    rateBucket = RATE_LIMIT;
    rateBucketResetAt = now + 60_000;
  }
  if (rateBucket <= 0) return false;
  rateBucket -= 1;
  return true;
}

/** Bucket changePercent into coarse steps so near-identical windows share a cache entry. */
function bucketChange(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return "null";
  return (Math.round(pct / 0.5) * 0.5).toFixed(1);
}

function interpretationContextKey(symbol: string, metric: HistoryMetric, range: HistoryRange): string {
  return `${symbol.toUpperCase()}:${metric}:${range}`;
}

function pruneAiCaches(now = Date.now()): void {
  for (const [key, value] of Array.from(interpretationCache.entries())) {
    if (value.expiresAt <= now) interpretationCache.delete(key);
  }
  for (const [key, value] of Array.from(deterministicHistoryContext.entries())) {
    if (value.expiresAt <= now) deterministicHistoryContext.delete(key);
  }
  while (interpretationCache.size > MAX_INTERPRETATION_CACHE_ENTRIES) {
    const oldest = interpretationCache.keys().next().value;
    if (!oldest) break;
    interpretationCache.delete(oldest);
  }
  while (deterministicHistoryContext.size > MAX_INTERPRETATION_CACHE_ENTRIES) {
    const oldest = deterministicHistoryContext.keys().next().value;
    if (!oldest) break;
    deterministicHistoryContext.delete(oldest);
  }
}

export type AiExplanationCtx = {
  symbol: string;
  metric: HistoryMetric;
  range: HistoryRange;
  currentValue: number | null;
  changePercent: number | null;
  confidence: number;
  dataPoints: number;
  /** Optional explicit metadata; getHistory also supplies it through a bounded server cache. */
  formula?: string;
  source?: string;
  observedAt?: string | null;
  deterministicSummary?: string;
};

/** Send only normalized, non-sensitive context to the model. Returns null on failure or rate limit. */
export async function generateAiExplanation(ctx: AiExplanationCtx): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (
    !apiKey ||
    ctx.currentValue == null ||
    !Number.isFinite(ctx.currentValue) ||
    Math.abs(ctx.currentValue) > 1e18 ||
    (ctx.changePercent != null && !Number.isFinite(ctx.changePercent)) ||
    (ctx.changePercent != null && Math.abs(ctx.changePercent) > 1e6) ||
    !Number.isFinite(ctx.confidence) ||
    !Number.isSafeInteger(ctx.dataPoints) ||
    ctx.dataPoints < 2 ||
    ctx.dataPoints > 100_000
  ) return null;

  const now = Date.now();
  pruneAiCaches(now);
  const remembered = deterministicHistoryContext.get(interpretationContextKey(ctx.symbol, ctx.metric, ctx.range));
  const formula = (ctx.formula ?? remembered?.formula ?? "stored normalized market observation").slice(0, 500);
  const source = (ctx.source ?? remembered?.source ?? "normalized server history").slice(0, 200);
  const observedAt = ctx.observedAt ?? remembered?.observedAt ?? null;
  const deterministicSummary = (ctx.deterministicSummary ?? remembered?.summary ?? "No deterministic summary is available.").slice(0, 500);

  // A changed observed timestamp, formula, source, or deterministic summary
  // deliberately invalidates prose instead of reusing a stale interpretation.
  const cacheKey = JSON.stringify([
    ctx.symbol.toUpperCase(), ctx.metric, ctx.range, bucketChange(ctx.changePercent),
    Number(ctx.currentValue.toPrecision(12)), formula, source, observedAt, deterministicSummary,
  ]);
  const cached = interpretationCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.text;

  if (!consumeRateToken()) return null;

  const metricLabel = METRIC_LABELS[ctx.metric];
  const changeDesc = ctx.changePercent != null
    ? `${ctx.changePercent >= 0 ? "+" : ""}${ctx.changePercent.toFixed(2)}% over the ${ctx.range} window`
    : "with insufficient change data";
  const boundedConfidence = clamp(ctx.confidence, 0, 1);
  const confidenceDesc = boundedConfidence >= 0.8 ? "high" : boundedConfidence >= 0.4 ? "moderate" : "low";

  const userContent = [
    `Asset: ${ctx.symbol}`,
    `Metric: ${metricLabel}`,
    `Current value: ${ctx.currentValue.toLocaleString("en-US", { maximumFractionDigits: 4 })}`,
    `Change: ${changeDesc}`,
    `Data confidence: ${confidenceDesc} (${ctx.dataPoints} snapshots)`,
    `Source: ${source}`,
    `Formula: ${formula}`,
    `Oldest latest required observation: ${observedAt ?? "unavailable"}`,
    `Deterministic summary: ${deterministicSummary}`,
  ].join("\n");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 120,
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content:
              "You are a concise market data interpreter. Given normalized crypto metric context, write 1–2 sentences describing what the data pattern suggests. " +
               "Use only the supplied normalized context. Do not invent values, freshness, coverage, or causes. Do not give financial advice or predictions. Do not mention confidence scores or raw numbers unless they are notable. " +
              "Label your output as interpretation only.",
          },
          { role: "user", content: userContent },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = json.choices?.[0]?.message?.content?.trim().slice(0, 1_000);
    if (!text) return null;
    interpretationCache.set(cacheKey, { text, expiresAt: Date.now() + CACHE_TTL_MS });
    pruneAiCaches();
    return text;
  } catch {
    return null;
  }
}

export type SnapshotRow = {
  captured_at: string | Date;
  symbol: string;
  price: number | null;
  market_cap: number | null;
  stablecoin_mcap: number | null;
  volume_24h: number | null;
  tvl: number | null;
  dex_volume: number | null;
};

type HistoryQuery = {
  symbol: string;
  metric: HistoryMetric;
  range: HistoryRange;
};

const rangeMs: Record<HistoryRange, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export type HistoricalMarketRow = {
  capturedAt: Date;
  symbol: string;
  price?: number | null;
  marketCap?: number | null;
  stablecoinMcap?: number | null;
  volume24h?: number | null;
  tvl?: number | null;
  dexVolume?: number | null;
};

/** Which upstream fields were observed in the current collection tick. */
export type SnapshotFieldFreshness = {
  coingecko: boolean;
  stablecoins: boolean;
  tvl: boolean;
  dexGlobal: boolean;
  dexBySymbol: Record<string, boolean>;
};

export function hasHistoryDatabase(): boolean {
  return getPool() !== null;
}

const VALUE_FIELDS = ["price", "marketCap", "stablecoinMcap", "volume24h", "tvl", "dexVolume"] as const;

/**
 * Combine rows that share (symbol, capturedAt). Historical backfills observe
 * TVL, DEX volume, and stablecoin supply for the same global day separately;
 * a single multi-row upsert cannot touch one key twice, so they are merged
 * field-by-field first (the latest non-null value wins).
 */
export function mergeHistoricalRows(rows: HistoricalMarketRow[]): HistoricalMarketRow[] {
  const merged = new Map<string, HistoricalMarketRow>();
  for (const row of rows) {
    const time = row.capturedAt instanceof Date ? row.capturedAt.getTime() : new Date(row.capturedAt).getTime();
    if (!Number.isFinite(time) || !row.symbol) continue;
    const key = `${row.symbol}\u0000${time}`;
    const existing = merged.get(key) ?? { capturedAt: new Date(time), symbol: row.symbol };
    for (const field of VALUE_FIELDS) {
      const value = row[field];
      if (value != null && Number.isFinite(value)) existing[field] = value;
    }
    merged.set(key, existing);
  }
  return Array.from(merged.values());
}

/**
 * Multi-row upsert: one statement per 500 rows instead of one query per row.
 * Previously each snapshot issued ~23 separate queries and a backfill several
 * thousand, all queued behind a three-connection pool, which starved the
 * minute sweep and every history read. Errors propagate to the caller (the
 * write queue or backfill), which records them in pipeline health.
 */
async function upsertMarketRows(rows: HistoricalMarketRow[]): Promise<void> {
  const pool = getPool();
  if (!pool || !rows.length) return;
  const merged = mergeHistoricalRows(rows);
  for (let offset = 0; offset < merged.length; offset += UPSERT_CHUNK_SIZE) {
    const chunk = merged.slice(offset, offset + UPSERT_CHUNK_SIZE);
    await pool.query(
      `INSERT INTO market_snapshots
        (captured_at, symbol, price, market_cap, stablecoin_mcap, volume_24h, tvl, dex_volume)
       SELECT * FROM UNNEST(
         $1::timestamptz[], $2::varchar[], $3::float8[], $4::float8[],
         $5::float8[], $6::float8[], $7::float8[], $8::float8[]
       )
       ON CONFLICT (symbol, captured_at) DO UPDATE SET
         price = COALESCE(EXCLUDED.price, market_snapshots.price),
         market_cap = COALESCE(EXCLUDED.market_cap, market_snapshots.market_cap),
         stablecoin_mcap = COALESCE(EXCLUDED.stablecoin_mcap, market_snapshots.stablecoin_mcap),
         volume_24h = COALESCE(EXCLUDED.volume_24h, market_snapshots.volume_24h),
         tvl = COALESCE(EXCLUDED.tvl, market_snapshots.tvl),
         dex_volume = COALESCE(EXCLUDED.dex_volume, market_snapshots.dex_volume)`,
      [
        chunk.map((row) => row.capturedAt.toISOString()),
        chunk.map((row) => row.symbol),
        chunk.map((row) => row.price ?? null),
        chunk.map((row) => row.marketCap ?? null),
        chunk.map((row) => row.stablecoinMcap ?? null),
        chunk.map((row) => row.volume24h ?? null),
        chunk.map((row) => row.tvl ?? null),
        chunk.map((row) => row.dexVolume ?? null),
      ],
    );
  }
  rowCache.clear();
}

export function buildMarketSnapshotRows(
  data: DashboardData,
  freshness: SnapshotFieldFreshness = {
    coingecko: true,
    stablecoins: true,
    tvl: true,
    dexGlobal: true,
    dexBySymbol: {},
  },
): HistoricalMarketRow[] {
  const capturedAt = new Date(data.timestamp);
  const assetRows = Object.entries(data.assets).map(([symbol, asset]) => ({
    symbol,
    price: freshness.coingecko ? asset.price : null,
    marketCap: freshness.coingecko ? asset.mcap : null,
    stablecoinMcap: null,
    volume24h: freshness.coingecko ? asset.vol24h : null,
    tvl: freshness.tvl ? asset.tvl : null,
    dexVolume: freshness.dexBySymbol[symbol] ? asset.dexVol : null,
  }));
  const trackedMarketCap = freshness.coingecko
    ? assetRows.reduce((sum, row) => sum + (row.marketCap || 0), 0)
    : null;
  const trackedVolume = freshness.coingecko
    ? assetRows.reduce((sum, row) => sum + (row.volume24h || 0), 0)
    : null;
  return [
    ...assetRows,
    {
      capturedAt,
      symbol: "__GLOBAL__",
      price: null,
      marketCap: trackedMarketCap,
      stablecoinMcap: freshness.stablecoins ? data.stablecoinMcap : null,
      volume24h: trackedVolume,
      tvl: freshness.tvl ? data.totalTvl : null,
      // This is the explicit all-DEX DefiLlama total, never a sum of selected
      // chains. A missing total remains null rather than becoming zero.
      dexVolume: freshness.dexGlobal ? (data.totalDexVolume ?? null) : null,
    },
  ].map((row) => ({ ...row, capturedAt }));
}

export async function recordMarketSnapshot(data: DashboardData, freshness?: SnapshotFieldFreshness): Promise<void> {
  await upsertMarketRows(buildMarketSnapshotRows(data, freshness));
}

/** Historical provider rows merge field-by-field at a timestamp. */
export async function recordHistoricalRows(rows: HistoricalMarketRow[]): Promise<void> {
  await upsertMarketRows(rows);
}

/**
 * Keep every minute-level point for the immediately useful seven-day window,
 * collapse older data to the latest point per symbol/hour, then enforce the
 * 90-day retention ceiling. Both deletes are naturally idempotent.
 */
export async function pruneMarketHistory(): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    await pool.query(
      `WITH hourly_duplicates AS (
         SELECT id,
                row_number() OVER (
                  PARTITION BY symbol, date_trunc('hour', captured_at)
                  ORDER BY captured_at DESC, id DESC
                ) AS duplicate_rank
         FROM market_snapshots
         WHERE captured_at < $1 AND captured_at >= $2
       )
       DELETE FROM market_snapshots AS snapshot
       USING hourly_duplicates
       WHERE snapshot.id = hourly_duplicates.id
         AND hourly_duplicates.duplicate_rank > 1`,
      [
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      ],
    );
    await pool.query(
      "DELETE FROM market_snapshots WHERE captured_at < $1",
      [new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)],
    );
    rowCache.clear();
    return true;
  } catch (error) {
    console.warn("[history] retention prune skipped:", error instanceof Error ? error.message : "unknown error");
    return false;
  }
}

function downsampleRows(rows: SnapshotRow[], maximum: number): SnapshotRow[] {
  if (rows.length <= maximum) return rows;
  const step = (rows.length - 1) / (maximum - 1);
  return Array.from({ length: maximum }, (_, index) => rows[Math.round(index * step)]);
}

/**
 * Every alert rule, UI panel, and intelligence request used to issue its own
 * full-range scan each minute. Identical reads now share one query per window.
 */
const rowCache = new TtlCache<string, SnapshotRow[]>(ROW_CACHE_TTL_MS, 200);

async function getRows(symbol: string, range: HistoryRange): Promise<SnapshotRow[]> {
  const pool = getPool();
  if (!pool) return [];
  return rowCache.get(`symbol:${symbol}:${range}`, async () => {
    const since = new Date(Date.now() - rangeMs[range]);
    const result = await pool.query<SnapshotRow>(
      `SELECT captured_at, symbol, price, market_cap, stablecoin_mcap, volume_24h, tvl, dex_volume
       FROM market_snapshots
       WHERE symbol = $1 AND captured_at >= $2
       ORDER BY captured_at ASC`,
      [symbol, since],
    );
    const maxPoints = range === "7d" ? 720 : range === "24h" ? 720 : 360;
    return downsampleRows(result.rows, maxPoints);
  });
}

export async function getSnapshotRowsForIntelligence(range: HistoryRange): Promise<SnapshotRow[]> {
  const pool = getPool();
  if (!pool) return [];
  return rowCache.get(`intelligence:${range}`, async () => {
    const since = new Date(Date.now() - rangeMs[range]);
    const result = await pool.query<SnapshotRow>(
      `SELECT captured_at, symbol, price, market_cap, stablecoin_mcap, volume_24h, tvl, dex_volume
       FROM market_snapshots
       WHERE captured_at >= $1
       ORDER BY symbol ASC, captured_at ASC`,
      [since],
    );
    const bySymbol = new Map<string, SnapshotRow[]>();
    for (const row of result.rows) {
      const rows = bySymbol.get(row.symbol) ?? [];
      rows.push(row);
      bySymbol.set(row.symbol, rows);
    }
    return Array.from(bySymbol.values()).flatMap((rows) => downsampleRows(rows, range === "7d" ? 720 : 360));
  });
}

function metricValue(row: SnapshotRow, metric: Exclude<HistoryMetric, "snapshotVwap" | "flowMomentum">): number | null {
  const values: Record<typeof metric, number | null> = {
    price: row.price,
    marketCap: row.market_cap,
    stablecoinMcap: row.stablecoin_mcap,
    tvl: row.tvl,
    volume: row.volume_24h,
    dexVolume: row.dex_volume,
  };
  return values[metric];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function flowScore(rows: SnapshotRow[], globalRows: SnapshotRow[]): { value: number; confidence: number } | null {
  const globalByTime = new Map(globalRows.map((row) => [new Date(row.captured_at).toISOString(), row.market_cap || 0]));
  const points = rows
    .filter((row) => row.market_cap != null && row.market_cap > 0)
    .filter((row) => (globalByTime.get(new Date(row.captured_at).toISOString()) || 0) > 0)
    .map((row) => ({
      time: new Date(row.captured_at).toISOString(),
      share: (row.market_cap || 0) / (globalByTime.get(new Date(row.captured_at).toISOString()) || 1),
    }));
  if (points.length < 2) return null;
  const first = points[0];
  const last = points.at(-1)!;
  const midpoint = points[Math.floor(points.length / 2)];
  const velocity = last.share - first.share;
  const earlyVelocity = midpoint.share - first.share;
  const recentVelocity = last.share - midpoint.share;
  const acceleration = recentVelocity - earlyVelocity;
  const confidence = clamp(points.length / 12, 0, 1);
  const score = clamp(
    (velocity * 10000) * (1 + Math.sign(velocity) * acceleration * 10) * confidence,
    -100,
    100,
  );
  return { value: score, confidence };
}

function emptyResponse({ symbol, metric, range }: HistoryQuery): HistoryResponse {
  const formula = metric === "flowMomentum"
    ? "bounded(share velocity × acceleration confirmation × data confidence)"
    : metric === "snapshotVwap"
      ? "Unavailable: requires exchange-executed trades and sizes from a venue feed"
      : "stored market snapshot value";
  return {
    symbol,
    metric,
    range,
    points: [],
    summary: {
      metric,
      symbol,
      currentValue: null,
      change: null,
      changePercent: null,
      confidence: 0,
      explanation: metric === "snapshotVwap"
        ? "VWAP is unavailable until an exchange trade feed supplies executed prices and sizes."
        : "History is backfilled server-side and will appear after the next successful collection.",
      formula,
      dataPoints: 0,
      source: "CoinGecko / DefiLlama snapshots",
    },
  };
}

function rememberHistoryResponse(response: HistoryResponse): HistoryResponse {
  const observedAt = response.points.at(-1)?.timestamp ?? null;
  deterministicHistoryContext.set(
    interpretationContextKey(response.symbol, response.metric, response.range),
    {
      formula: response.summary.formula,
      source: response.summary.source,
      observedAt,
      summary: response.summary.explanation,
      expiresAt: Date.now() + CACHE_TTL_MS,
    },
  );
  pruneAiCaches();
  return response;
}

function executedVwapResponse(query: HistoryQuery): HistoryResponse {
  const feed = startCoinbaseFeed().snapshot(query.symbol);
  const since = Date.now() - rangeMs[query.range];
  const points = feed.candles
    .filter((candle) => Date.parse(candle.endTime) >= since && Number.isFinite(candle.vwap))
    .map((candle) => ({ timestamp: candle.endTime, value: candle.vwap }));
  const first = points[0]?.value ?? null;
  const currentValue = points.at(-1)?.value ?? null;
  const change = first != null && currentValue != null ? currentValue - first : null;
  const changePercent = first && change != null ? (change / Math.abs(first)) * 100 : null;
  const usable = feed.status.state === "live" && points.length > 0;
  return {
    symbol: query.symbol,
    metric: query.metric,
    range: query.range,
    points,
    summary: {
      metric: query.metric,
      symbol: query.symbol,
      currentValue,
      change,
      changePercent,
      confidence: usable ? clamp(points.length / Math.max(1, rangeMs[query.range] / 60_000), 0, 1) : 0,
      explanation: usable
        ? "VWAP is calculated from executed Coinbase Advanced Trade prices and base sizes for this venue only."
        : feed.status.error?.message ?? "Coinbase executed-trade VWAP is not available yet; no snapshot-volume proxy is used.",
      formula: "Σ(executed price × executed base size) / Σ(executed base size), grouped into 1-minute Coinbase candles",
      dataPoints: points.length,
      source: "Coinbase Advanced Trade executed trades (single venue)",
    },
  };
}

export async function getHistory(query: HistoryQuery): Promise<HistoryResponse> {
  if (query.metric === "snapshotVwap") return rememberHistoryResponse(executedVwapResponse(query));
  const rows = await getRows(query.symbol, query.range);
  if (!rows.length) return rememberHistoryResponse(emptyResponse(query));

  let points: Array<{ timestamp: string; value: number }> = [];
  let confidence = 1;
  let formula = "stored market snapshot value";

  if (query.metric === "flowMomentum") {
    formula = "bounded(share velocity × acceleration confirmation × data confidence)";
    const globalRows = await getRows("__GLOBAL__", query.range);
    const assetRows = rows;
    for (let i = 1; i <= assetRows.length; i += 1) {
      const score = flowScore(assetRows.slice(0, i), globalRows);
      if (score) {
        points.push({ timestamp: new Date(assetRows[i - 1].captured_at).toISOString(), value: score.value });
        confidence = score.confidence;
      }
    }
  } else {
    points = rows.flatMap((row) => {
      const value = metricValue(row, query.metric as Exclude<HistoryMetric, "snapshotVwap" | "flowMomentum">);
      return value == null ? [] : [{ timestamp: new Date(row.captured_at).toISOString(), value }];
    });
  }

  const first = points[0]?.value ?? null;
  const currentValue = points.at(-1)?.value ?? null;
  const change = first != null && currentValue != null ? currentValue - first : null;
  const changePercent = first && change != null ? (change / Math.abs(first)) * 100 : null;
  let explanation = "The selected metric is stable across this window.";
  if (currentValue == null || points.length < 2) {
    explanation = "Not enough observations for a reliable timeline yet.";
    confidence = Math.min(confidence, points.length / 2);
  } else if (query.metric === "flowMomentum") {
    explanation = currentValue > 1
      ? "The asset is gaining tracked market share faster than its recent baseline."
      : currentValue < -1
        ? "The asset is losing tracked market share relative to the selected window."
        : "Tracked market share is stable relative to the selected window.";
  } else if (changePercent != null) {
    explanation = changePercent >= 0
      ? `The metric increased ${Math.abs(changePercent).toFixed(1)}% across this window.`
      : `The metric decreased ${Math.abs(changePercent).toFixed(1)}% across this window.`;
  }

  return rememberHistoryResponse({
    symbol: query.symbol,
    metric: query.metric,
    range: query.range,
    points,
    summary: {
      metric: query.metric,
      symbol: query.symbol,
      currentValue,
      change,
      changePercent,
      confidence: clamp(confidence, 0, 1),
      explanation,
      formula,
      dataPoints: points.length,
      source: "CoinGecko / DefiLlama snapshots",
    },
  });
}
