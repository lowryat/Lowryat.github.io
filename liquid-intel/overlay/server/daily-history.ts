import type { DailyPanel } from "@shared/quant/structure";
import { getPool } from "./db";
import { pruneFeedSeries, upsertFeedSeries, type FeedSeriesRow } from "./feed-series";
import { coinGeckoEndpoint, describeFailure, marketHttp, type FetchOutcome } from "./http-client";
import { COIN_IDS, ID_TO_SYMBOL, extractStablecoinChartTotal } from "./market";
import { GuardedTask, mapWithConcurrency, type GuardedTaskContext } from "./resilience";

/**
 * Daily history for the risk engine and market-structure signals.
 *
 * Each asset walks a provider chain (Coinbase Exchange daily candles, then
 * CoinGecko, then Kraken) and keeps the first series that passes validation.
 * Global liquidity series come from DefiLlama and alternative.me. Every good
 * series is persisted, loaded back on restart, and kept when a later refresh
 * fails (stale-while-error), so one provider outage never blanks the charts.
 */

const PROVIDER = "daily_history";
const INTERVAL = "1d";
const HISTORY_DAYS = 420;
const PANEL_DAYS = 400;
const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const REFRESH_DEADLINE_MS = 12 * 60 * 1000;
const RETENTION_DAYS = 800;
const MIN_POINTS = 60;
const MAX_FILL_GAP_DAYS = 3;
const DAY_MS = 86_400_000;

export const GLOBAL_SYMBOL = "__GLOBAL__";
export const DAILY_SYMBOLS = COIN_IDS.map((id) => ID_TO_SYMBOL[id]);
const SYMBOL_TO_COIN_ID = Object.fromEntries(COIN_IDS.map((id) => [ID_TO_SYMBOL[id], id])) as Record<string, string>;

type AssetSource = "coinbase" | "coingecko" | "kraken" | "database";
type GlobalMetric = "stablecoin_supply" | "tvl" | "dex_volume" | "fear_greed";
const GLOBAL_METRICS: GlobalMetric[] = ["stablecoin_supply", "tvl", "dex_volume", "fear_greed"];

export type DailyPoint = { date: string; close: number; volumeUsd: number | null };
type AssetSeries = { points: DailyPoint[]; source: AssetSource; refreshedAt: number };
type GlobalSeries = { points: Array<{ date: string; value: number }>; source: string; refreshedAt: number };

const assets = new Map<string, AssetSeries>();
const globals = new Map<GlobalMetric, GlobalSeries>();
const lastErrors = new Map<string, string>();
let version = 0;
let loadedFromDatabase = false;
let lastAttemptAt: number | null = null;
let lastRefreshAt: number | null = null;
let nextRefreshAt = 0;
let timer: NodeJS.Timeout | null = null;
let panelCache: { version: number; panel: DailyPanel } | null = null;

export function dateKey(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

function finite(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

function epochMs(value: unknown): number | null {
  const number = finite(value);
  if (number == null) return null;
  return number < 10_000_000_000 ? number * 1000 : number;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Sorts, de-duplicates (last write per date wins), drops non-positive prices,
 * and removes single-day spikes that fully revert the next day (bad ticks).
 * Returns a reason when the series is unusable.
 */
export function cleanDailySeries(input: DailyPoint[], now = Date.now()): { points: DailyPoint[]; error: string | null } {
  const byDate = new Map<string, DailyPoint>();
  for (const point of input) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(point.date) || !(point.close > 0) || !Number.isFinite(point.close)) continue;
    byDate.set(point.date, { ...point, volumeUsd: point.volumeUsd != null && point.volumeUsd >= 0 && Number.isFinite(point.volumeUsd) ? point.volumeUsd : null });
  }
  const points = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  const cleaned: DailyPoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const previous = cleaned[cleaned.length - 1];
    const next = points[index + 1];
    if (previous && next) {
      const up = Math.log(points[index].close / previous.close);
      const back = Math.log(next.close / points[index].close);
      // A >50% one-day jump that reverses within a day is a data error, not a market move.
      if (Math.abs(up) > 0.4 && Math.abs(up + back) < 0.05) continue;
    }
    cleaned.push(points[index]);
  }
  if (cleaned.length < MIN_POINTS) return { points: cleaned, error: `only ${cleaned.length} valid daily closes` };
  const lagDays = (now - Date.parse(`${cleaned[cleaned.length - 1].date}T00:00:00Z`)) / DAY_MS;
  if (lagDays > 4) return { points: cleaned, error: `latest close is ${Math.floor(lagDays)} days old` };
  return { points: cleaned, error: null };
}

// ---------------------------------------------------------------------------
// Provider parsers (exported for tests)
// ---------------------------------------------------------------------------

/** Coinbase Exchange candles: [time, low, high, open, close, volume(base)], newest first. */
export function parseCoinbaseCandles(raw: unknown): DailyPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row): DailyPoint[] => {
    if (!Array.isArray(row) || row.length < 6) return [];
    const time = epochMs(row[0]);
    const close = finite(row[4]);
    const volume = finite(row[5]);
    if (time == null || close == null) return [];
    return [{ date: dateKey(time), close, volumeUsd: volume != null ? volume * close : null }];
  });
}

/** CoinGecko market_chart (days > 90 returns one point per day plus a live point). */
export function parseCoinGeckoChart(raw: unknown): DailyPoint[] {
  const body = raw as { prices?: unknown; total_volumes?: unknown } | null;
  const volumes = new Map<string, number>();
  if (Array.isArray(body?.total_volumes)) {
    for (const point of body.total_volumes) {
      const time = Array.isArray(point) ? epochMs(point[0]) : null;
      const value = Array.isArray(point) ? finite(point[1]) : null;
      if (time != null && value != null) volumes.set(dateKey(time), value);
    }
  }
  if (!Array.isArray(body?.prices)) return [];
  return body.prices.flatMap((point): DailyPoint[] => {
    const time = Array.isArray(point) ? epochMs(point[0]) : null;
    const close = Array.isArray(point) ? finite(point[1]) : null;
    if (time == null || close == null) return [];
    const date = dateKey(time);
    return [{ date, close, volumeUsd: volumes.get(date) ?? null }];
  });
}

/** Kraken OHLC: { error: [], result: { PAIR: [[time, o, h, l, c, vwap, volume, count]], last } }. */
export function parseKrakenOhlc(raw: unknown): { points: DailyPoint[]; error: string | null } {
  const body = raw as { error?: unknown; result?: Record<string, unknown> } | null;
  if (Array.isArray(body?.error) && body.error.length) return { points: [], error: String(body.error[0]) };
  const key = body?.result ? Object.keys(body.result).find((name) => name !== "last") : undefined;
  const rows = key ? body!.result![key] : null;
  if (!Array.isArray(rows)) return { points: [], error: "missing OHLC rows" };
  const points = rows.flatMap((row): DailyPoint[] => {
    if (!Array.isArray(row) || row.length < 7) return [];
    const time = epochMs(row[0]);
    const close = finite(row[4]);
    const vwap = finite(row[5]);
    const volume = finite(row[6]);
    if (time == null || close == null) return [];
    return [{ date: dateKey(time), close, volumeUsd: volume != null ? volume * (vwap ?? close) : null }];
  });
  return { points, error: null };
}

export function parseGlobalSeries(metric: GlobalMetric, raw: unknown): Array<{ date: string; value: number }> {
  const out = new Map<string, number>();
  const push = (time: number | null, value: number | null) => {
    if (time != null && value != null && value >= 0) out.set(dateKey(time), value);
  };
  if (metric === "stablecoin_supply") {
    const rows = Array.isArray(raw) ? raw : (raw as { data?: unknown } | null)?.data;
    if (Array.isArray(rows)) for (const row of rows) push(epochMs((row as { date?: unknown })?.date), extractStablecoinChartTotal(row));
  } else if (metric === "tvl") {
    if (Array.isArray(raw)) for (const row of raw) push(epochMs((row as { date?: unknown })?.date), finite((row as { tvl?: unknown })?.tvl));
  } else if (metric === "dex_volume") {
    const rows = (raw as { totalDataChart?: unknown } | null)?.totalDataChart;
    if (Array.isArray(rows)) for (const row of rows) if (Array.isArray(row)) push(epochMs(row[0]), finite(row[1]));
  } else {
    const rows = (raw as { data?: unknown } | null)?.data;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const value = finite((row as { value?: unknown })?.value);
        push(epochMs((row as { timestamp?: unknown })?.timestamp), value != null && value <= 100 ? value : null);
      }
    }
  }
  return Array.from(out.entries()).map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const COINBASE_PRODUCT: Record<string, string | null> = { BNB: null, TON: null, FTM: null };
const KRAKEN_PAIR: Record<string, string> = { BTC: "XBTUSD", ETH: "ETHUSD" };
const GLOBAL_URL: Record<GlobalMetric, string> = {
  stablecoin_supply: "https://stablecoins.llama.fi/stablecoincharts/all",
  tvl: "https://api.llama.fi/v2/historicalChainTvl",
  dex_volume: "https://api.llama.fi/overview/dexs?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=true&dataType=dailyVolume",
  fear_greed: "https://api.alternative.me/fng/?limit=450&format=json",
};
const GLOBAL_SOURCE: Record<GlobalMetric, string> = {
  stablecoin_supply: "defillama", tvl: "defillama", dex_volume: "defillama", fear_greed: "alternative.me",
};

type Attempt = { points: DailyPoint[]; error: string | null };

function failure(outcome: FetchOutcome<unknown>): string {
  return outcome.ok ? "unknown error" : describeFailure(outcome);
}

async function fromCoinbase(symbol: string, context: GuardedTaskContext): Promise<Attempt> {
  const product = symbol in COINBASE_PRODUCT ? COINBASE_PRODUCT[symbol] : `${symbol}-USD`;
  if (!product) return { points: [], error: "not listed" };
  const now = Date.now();
  // The endpoint returns at most 300 candles, so the history is read in two windows.
  const windows = [
    [now - 299 * DAY_MS, now],
    [now - (HISTORY_DAYS - 1) * DAY_MS, now - 300 * DAY_MS],
  ];
  const points: DailyPoint[] = [];
  for (const [start, end] of windows) {
    const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles?granularity=86400&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    const outcome = await marketHttp.getJson<unknown>(url, {
      signal: context.signal,
      headers: { "User-Agent": "liq-intel/2.0", Accept: "application/json" },
      validate: (value) => (Array.isArray(value) ? null : "candles payload is not an array"),
    });
    if (!outcome.ok) {
      // The recent window is required; an older-window failure only shortens history.
      if (points.length === 0) return { points: [], error: `coinbase ${failure(outcome)}` };
      break;
    }
    points.push(...parseCoinbaseCandles(outcome.value));
  }
  return { points, error: null };
}

async function fromCoinGecko(symbol: string, context: GuardedTaskContext): Promise<Attempt> {
  const id = SYMBOL_TO_COIN_ID[symbol];
  if (!id) return { points: [], error: "no CoinGecko id" };
  const endpoint = coinGeckoEndpoint();
  const outcome = await marketHttp.getJson<unknown>(
    `${endpoint.base}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=365`,
    { signal: context.signal, headers: endpoint.headers, priority: "normal" },
  );
  return outcome.ok ? { points: parseCoinGeckoChart(outcome.value), error: null } : { points: [], error: `coingecko ${failure(outcome)}` };
}

async function fromKraken(symbol: string, context: GuardedTaskContext): Promise<Attempt> {
  const pair = KRAKEN_PAIR[symbol] ?? `${symbol}USD`;
  const since = Math.floor((Date.now() - HISTORY_DAYS * DAY_MS) / 1000);
  const outcome = await marketHttp.getJson<unknown>(`https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=1440&since=${since}`, { signal: context.signal });
  if (!outcome.ok) return { points: [], error: `kraken ${failure(outcome)}` };
  const parsed = parseKrakenOhlc(outcome.value);
  return parsed.error ? { points: [], error: `kraken ${parsed.error}` } : parsed;
}

const PROVIDERS: Array<[Exclude<AssetSource, "database">, (symbol: string, context: GuardedTaskContext) => Promise<Attempt>]> = [
  ["coinbase", fromCoinbase],
  ["coingecko", fromCoinGecko],
  ["kraken", fromKraken],
];

async function refreshAsset(symbol: string, context: GuardedTaskContext): Promise<FeedSeriesRow[]> {
  const errors: string[] = [];
  for (const [source, fetcher] of PROVIDERS) {
    if (context.isStale()) break;
    const attempt = await fetcher(symbol, context);
    if (attempt.error) {
      if (attempt.error !== "not listed") errors.push(attempt.error);
      continue;
    }
    const cleaned = cleanDailySeries(attempt.points);
    if (cleaned.error) {
      errors.push(`${source} ${cleaned.error}`);
      continue;
    }
    assets.set(symbol, { points: cleaned.points, source, refreshedAt: Date.now() });
    lastErrors.delete(symbol);
    return cleaned.points.flatMap((point) => {
      const observedAt = new Date(`${point.date}T00:00:00Z`);
      const rows: FeedSeriesRow[] = [{ provider: PROVIDER, symbol, metric: "close", interval: INTERVAL, observedAt, value: point.close, metadata: { source } }];
      if (point.volumeUsd != null) rows.push({ provider: PROVIDER, symbol, metric: "volume_usd", interval: INTERVAL, observedAt, value: point.volumeUsd, metadata: { source } });
      return rows;
    });
  }
  // Keep the previous good series; only record why this refresh failed.
  lastErrors.set(symbol, errors.join("; ") || "no provider returned data");
  return [];
}

async function refreshGlobal(metric: GlobalMetric, context: GuardedTaskContext): Promise<FeedSeriesRow[]> {
  const outcome = await marketHttp.getJson<unknown>(GLOBAL_URL[metric], { signal: context.signal });
  if (!outcome.ok) {
    lastErrors.set(metric, failure(outcome));
    return [];
  }
  const points = parseGlobalSeries(metric, outcome.value).slice(-HISTORY_DAYS);
  if (points.length < MIN_POINTS) {
    lastErrors.set(metric, `only ${points.length} daily points`);
    return [];
  }
  globals.set(metric, { points, source: GLOBAL_SOURCE[metric], refreshedAt: Date.now() });
  lastErrors.delete(metric);
  return points.map((point) => ({
    provider: PROVIDER, symbol: GLOBAL_SYMBOL, metric, interval: INTERVAL,
    observedAt: new Date(`${point.date}T00:00:00Z`), value: point.value, metadata: { source: GLOBAL_SOURCE[metric] },
  }));
}

async function runRefresh(context: GuardedTaskContext): Promise<{ assetsOk: number; globalsOk: number; rows: number }> {
  if (!loadedFromDatabase) await loadFromDatabase();
  const [assetRows, globalRows] = await Promise.all([
    mapWithConcurrency(DAILY_SYMBOLS, 3, (symbol) => refreshAsset(symbol, context).catch((error) => {
      lastErrors.set(symbol, error instanceof Error ? error.message : String(error));
      return [] as FeedSeriesRow[];
    })),
    mapWithConcurrency(GLOBAL_METRICS, 2, (metric) => refreshGlobal(metric, context).catch((error) => {
      lastErrors.set(metric, error instanceof Error ? error.message : String(error));
      return [] as FeedSeriesRow[];
    })),
  ]);
  if (context.isStale()) throw new Error("Daily history refresh superseded");
  version += 1;
  panelCache = null;
  const rows = [...assetRows.flat(), ...globalRows.flat()];
  const pool = getPool();
  if (pool && rows.length) {
    try {
      await upsertFeedSeries(pool, rows);
      await pruneFeedSeries(pool, PROVIDER, new Date(Date.now() - RETENTION_DAYS * DAY_MS));
    } catch (error) {
      // Persistence is a cache; the in-memory series still serve requests.
      lastErrors.set("database", error instanceof Error ? error.message : String(error));
    }
  }
  return {
    assetsOk: assetRows.filter((item) => item.length > 0).length,
    globalsOk: globalRows.filter((item) => item.length > 0).length,
    rows: rows.length,
  };
}

const refreshTask = new GuardedTask("daily-history", runRefresh, REFRESH_DEADLINE_MS);

/** Restores the last persisted series so the panel is available immediately after a restart. */
export async function loadFromDatabase(): Promise<number> {
  loadedFromDatabase = true;
  const pool = getPool();
  if (!pool) return 0;
  try {
    const result = await pool.query<{ symbol: string; metric: string; observed_at: Date; value: number; source: string | null }>(
      `SELECT symbol, metric, observed_at, value, metadata->>'source' AS source
         FROM market_feed_series
        WHERE provider = $1 AND interval = $2 AND observed_at >= $3
        ORDER BY observed_at`,
      [PROVIDER, INTERVAL, new Date(Date.now() - (HISTORY_DAYS + 5) * DAY_MS)],
    );
    const closes = new Map<string, Map<string, DailyPoint>>();
    const globalPoints = new Map<GlobalMetric, Array<{ date: string; value: number }>>();
    for (const row of result.rows) {
      const date = dateKey(new Date(row.observed_at).getTime());
      if (row.symbol === GLOBAL_SYMBOL) {
        const metric = row.metric as GlobalMetric;
        if (!GLOBAL_METRICS.includes(metric)) continue;
        const list = globalPoints.get(metric) ?? [];
        list.push({ date, value: Number(row.value) });
        globalPoints.set(metric, list);
        continue;
      }
      const byDate = closes.get(row.symbol) ?? new Map<string, DailyPoint>();
      const point = byDate.get(date) ?? { date, close: 0, volumeUsd: null };
      if (row.metric === "close") point.close = Number(row.value);
      if (row.metric === "volume_usd") point.volumeUsd = Number(row.value);
      byDate.set(date, point);
      closes.set(row.symbol, byDate);
    }
    let restored = 0;
    for (const [symbol, byDate] of Array.from(closes.entries())) {
      if (assets.has(symbol)) continue;
      const points = Array.from(byDate.values()).filter((point) => point.close > 0).sort((a, b) => a.date.localeCompare(b.date));
      if (points.length >= MIN_POINTS) {
        assets.set(symbol, { points, source: "database", refreshedAt: 0 });
        restored += 1;
      }
    }
    for (const [metric, points] of Array.from(globalPoints.entries())) {
      if (!globals.has(metric) && points.length >= MIN_POINTS) globals.set(metric, { points, source: "database", refreshedAt: 0 });
    }
    if (restored) {
      version += 1;
      panelCache = null;
    }
    return restored;
  } catch (error) {
    lastErrors.set("database", error instanceof Error ? error.message : String(error));
    return 0;
  }
}

export async function refreshDailyHistory(): Promise<void> {
  lastAttemptAt = Date.now();
  const outcome = await refreshTask.run();
  if (outcome.status === "skipped") return;
  const report = outcome.value;
  const complete = outcome.status === "ok" && report != null && report.assetsOk >= Math.ceil(DAILY_SYMBOLS.length * 0.8) && report.globalsOk >= 3;
  if (outcome.status === "ok") lastRefreshAt = Date.now();
  nextRefreshAt = Date.now() + (complete ? REFRESH_MS : RETRY_MS);
  if (!complete) {
    console.warn(`[daily-history] refresh ${outcome.status}${report ? ` (${report.assetsOk}/${DAILY_SYMBOLS.length} assets, ${report.globalsOk}/4 global series)` : ""}${outcome.error ? `: ${outcome.error}` : ""}; retrying in 30 minutes`);
  }
}

export function startDailyHistory(): void {
  if (timer) return;
  const tick = () => {
    if (Date.now() >= nextRefreshAt && !refreshTask.isRunning()) {
      nextRefreshAt = Date.now() + RETRY_MS;
      void refreshDailyHistory().catch((error) => console.warn("[daily-history] refresh failed:", error instanceof Error ? error.message : error));
    }
  };
  // Load persisted history first so a restart serves charts before any API call returns.
  void loadFromDatabase().finally(tick);
  timer = setInterval(tick, 60_000);
  timer.unref();
}

export function stopDailyHistory(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---------------------------------------------------------------------------
// Panel assembly
// ---------------------------------------------------------------------------

/** Aligns sparse dated values to a calendar, forward-filling gaps of up to three days. */
export function alignToCalendar(dates: string[], points: Array<{ date: string; value: number }>, fill = true): Array<number | null> {
  const byDay = new Map(points.map((point) => [dayNumber(point.date), point.value]));
  const out: Array<number | null> = [];
  let last: number | null = null;
  let lastDay = -Infinity;
  for (const date of dates) {
    const day = dayNumber(date);
    const value = byDay.get(day);
    if (value != null) {
      out.push(value);
      last = value;
      lastDay = day;
    } else if (fill && last != null && day - lastDay <= MAX_FILL_GAP_DAYS) {
      out.push(last);
    } else {
      out.push(null);
    }
  }
  return out;
}

export function buildPanelFrom(
  assetSeries: Map<string, { points: DailyPoint[] }>,
  globalSeries: Map<string, { points: Array<{ date: string; value: number }> }>,
  days = PANEL_DAYS,
): DailyPanel {
  let lastDay = -Infinity;
  for (const series of Array.from(assetSeries.values())) {
    const last = series.points[series.points.length - 1];
    if (last) lastDay = Math.max(lastDay, dayNumber(last.date));
  }
  const dates: string[] = [];
  if (Number.isFinite(lastDay)) for (let day = lastDay - days + 1; day <= lastDay; day += 1) dates.push(dateKey(day * DAY_MS));
  const closes: DailyPanel["closes"] = {};
  const volumes: DailyPanel["volumes"] = {};
  for (const [symbol, series] of Array.from(assetSeries.entries())) {
    closes[symbol] = alignToCalendar(dates, series.points.map((point) => ({ date: point.date, value: point.close })));
    volumes[symbol] = alignToCalendar(dates, series.points.filter((point) => point.volumeUsd != null).map((point) => ({ date: point.date, value: point.volumeUsd! })), false);
  }
  const global = (metric: GlobalMetric) => alignToCalendar(dates, globalSeries.get(metric)?.points ?? []);
  return {
    dates,
    closes,
    volumes,
    stablecoinSupply: global("stablecoin_supply"),
    totalTvl: global("tvl"),
    dexVolume: global("dex_volume"),
    fearGreed: global("fear_greed"),
  };
}

/** Current aligned panel, or null before any history is available. */
export function getDailyPanel(): DailyPanel | null {
  if (!assets.has("BTC")) return null;
  if (panelCache?.version === version) return panelCache.panel;
  const panel = buildPanelFrom(assets, globals);
  panelCache = { version, panel };
  return panel;
}

export function getDailyHistoryVersion(): number {
  return version;
}

export type DailyHistoryStatus = {
  state: "ready" | "partial" | "loading" | "unavailable";
  lastAttemptAt: string | null;
  lastRefreshAt: string | null;
  nextRefreshAt: string | null;
  task: ReturnType<typeof refreshTask.stats>;
  assets: Array<{ symbol: string; source: AssetSource | null; points: number; lastDate: string | null; error: string | null }>;
  globals: Array<{ metric: GlobalMetric; source: string | null; points: number; lastDate: string | null; error: string | null }>;
  databaseError: string | null;
};

export function getDailyHistoryStatus(): DailyHistoryStatus {
  const assetRows = DAILY_SYMBOLS.map((symbol) => {
    const series = assets.get(symbol);
    return {
      symbol,
      source: series?.source ?? null,
      points: series?.points.length ?? 0,
      lastDate: series?.points[series.points.length - 1]?.date ?? null,
      error: lastErrors.get(symbol) ?? null,
    };
  });
  const globalRows = GLOBAL_METRICS.map((metric) => {
    const series = globals.get(metric);
    return {
      metric,
      source: series?.source ?? null,
      points: series?.points.length ?? 0,
      lastDate: series?.points[series.points.length - 1]?.date ?? null,
      error: lastErrors.get(metric) ?? null,
    };
  });
  const available = assetRows.filter((row) => row.points > 0).length;
  const state: DailyHistoryStatus["state"] = available === 0
    ? (refreshTask.isRunning() || lastAttemptAt == null ? "loading" : "unavailable")
    : available >= Math.ceil(DAILY_SYMBOLS.length * 0.8) && globalRows.filter((row) => row.points > 0).length >= 3 ? "ready" : "partial";
  return {
    state,
    lastAttemptAt: lastAttemptAt ? new Date(lastAttemptAt).toISOString() : null,
    lastRefreshAt: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null,
    nextRefreshAt: nextRefreshAt ? new Date(nextRefreshAt).toISOString() : null,
    task: refreshTask.stats(),
    assets: assetRows,
    globals: globalRows,
    databaseError: lastErrors.get("database") ?? null,
  };
}

/** Test helper. */
export function resetDailyHistoryForTests(): void {
  assets.clear();
  globals.clear();
  lastErrors.clear();
  version = 0;
  loadedFromDatabase = false;
  lastAttemptAt = null;
  lastRefreshAt = null;
  nextRefreshAt = 0;
  panelCache = null;
  stopDailyHistory();
}

/** Test helper: seed series without network access. */
export function seedDailyHistoryForTests(assetSeries: Record<string, DailyPoint[]>, globalSeries: Partial<Record<GlobalMetric, Array<{ date: string; value: number }>>> = {}): void {
  for (const [symbol, points] of Object.entries(assetSeries)) assets.set(symbol, { points, source: "database", refreshedAt: Date.now() });
  for (const [metric, points] of Object.entries(globalSeries)) if (points) globals.set(metric as GlobalMetric, { points, source: "test", refreshedAt: Date.now() });
  version += 1;
  panelCache = null;
}
