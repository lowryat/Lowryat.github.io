import type { DashboardData } from "@shared/schema";
import {
  hasHistoryDatabase,
  pruneMarketHistory,
  recordHistoricalRows,
  recordMarketSnapshot,
  type SnapshotFieldFreshness,
} from "./history";
import { coinGeckoEndpoint, describeFailure, marketHttp } from "./http-client";
import { GuardedTask, mapWithConcurrency, WriteQueue, type GuardedTaskContext } from "./resilience";

const COLLECTION_INTERVAL_MS = 60_000;
/** A sweep that has not finished in this time is aborted and its lock released. */
const COLLECTION_DEADLINE_MS = 45_000;
const HISTORY_BACKFILL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HISTORY_BACKFILL_RETRY_MS = 30 * 60 * 1000;
const HISTORY_BACKFILL_DEADLINE_MS = 15 * 60 * 1000;
const DEX_CHAIN_REFRESH_MS = 5 * 60 * 1000;
const DEX_CHAIN_CONCURRENCY = 4;

export const COIN_IDS = [
  "bitcoin", "ethereum", "solana", "avalanche-2", "binancecoin", "near",
  "cosmos", "celestia", "polkadot", "aptos", "sui", "sei-network",
  "ripple", "litecoin", "arbitrum", "optimism", "injective-protocol",
  "the-open-network", "chainlink", "uniswap", "aave", "fantom",
] as const;

export const ID_TO_SYMBOL: Record<(typeof COIN_IDS)[number], string> = {
  bitcoin: "BTC", ethereum: "ETH", solana: "SOL", "avalanche-2": "AVAX",
  binancecoin: "BNB", near: "NEAR", cosmos: "ATOM", celestia: "TIA",
  polkadot: "DOT", aptos: "APT", sui: "SUI", "sei-network": "SEI",
  ripple: "XRP", litecoin: "LTC", arbitrum: "ARB", optimism: "OP",
  "injective-protocol": "INJ", "the-open-network": "TON",
  chainlink: "LINK", uniswap: "UNI", aave: "AAVE", fantom: "FTM",
};

export const SYMBOL_TO_CHAIN: Record<string, string> = {
  ETH: "ethereum", SOL: "solana", AVAX: "avalanche", BNB: "bsc",
  NEAR: "near", ATOM: "cosmos", DOT: "polkadot", APT: "aptos",
  SUI: "sui", SEI: "sei", ARB: "arbitrum", OP: "optimism",
  FTM: "fantom", INJ: "injective", TON: "ton",
};
const DEX_CHAINS = Array.from(new Set(Object.values(SYMBOL_TO_CHAIN)));

type SourceName = "coingecko" | "stablecoins" | "tvl" | "dex";
export type MarketSourceHealth = {
  state: "ok" | "degraded" | "stale" | "unavailable";
  observedAt: string | null;
  lastSuccessAt: string | null;
  ageMs: number | null;
  latencyMs: number | null;
  completeness: number;
  error: string | null;
};

type FetchResult<T> =
  | { value: T; error: null; latencyMs: number }
  | { value: null; error: string; latencyMs: number };
type Coin = {
  id: string;
  current_price?: number | null;
  market_cap?: number | null;
  total_volume?: number | null;
  price_change_percentage_1h_in_currency?: number | null;
  price_change_percentage_24h_in_currency?: number | null;
  price_change_percentage_7d_in_currency?: number | null;
  price_change_percentage_30d_in_currency?: number | null;
  high_24h?: number | null;
  low_24h?: number | null;
  ath?: number | null;
  ath_date?: string | null;
  image?: string | null;
  market_cap_rank?: number | null;
};

type FetchOptions = {
  signal?: AbortSignal;
  deadlineAt?: number;
  headers?: Record<string, string>;
  priority?: "high" | "normal";
  validate?: (value: unknown) => string | null;
};

let snapshot: DashboardData | null = null;
let lastCollectionSuccessAt: number | null = null;
let lastRetentionSuccessAt: number | null = null;
let timer: NodeJS.Timeout | null = null;
let nextBackfillAt = 0;
let lastBackfillReport: { at: string; coinsOk: number; coinsTotal: number; rows: number; globalSeriesOk: number } | null = null;
let dexChainCollection: Promise<DexChainCollection> | null = null;
let dexChainCollectedAt = 0;
let cachedDexChainCollection: DexChainCollection | null = null;
const health: Record<SourceName, MarketSourceHealth> = {
  coingecko: unavailableHealth(),
  stablecoins: unavailableHealth(),
  tvl: unavailableHealth(),
  dex: unavailableHealth(),
};
const dexChainHealth = new Map<string, MarketSourceHealth>();

/** Database writes never run inside the sweep: they are queued and bounded. */
const persistQueue = new WriteQueue("market-persistence", 20, 30_000);

function unavailableHealth(): MarketSourceHealth {
  return { state: "unavailable", observedAt: null, lastSuccessAt: null, ageMs: null, latencyMs: null, completeness: 0, error: "No collection has completed." };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeChain(value: string): string {
  const chain = value.trim().toLowerCase();
  return ({ "binance smart chain": "bsc", binance: "bsc", "bnb chain": "bsc", avalanche: "avalanche" } as Record<string, string>)[chain] ?? chain;
}

/** Thin adapter from the shared defensive client to the legacy FetchResult shape. */
async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<FetchResult<T>> {
  const outcome = await marketHttp.getJson<T>(url, options);
  return outcome.ok
    ? { value: outcome.value, error: null, latencyMs: outcome.latencyMs }
    : { value: null, error: describeFailure(outcome), latencyMs: outcome.latencyMs };
}

function updateHealth(name: SourceName, result: FetchResult<unknown>, completeness: number): void {
  const now = new Date();
  const previous = health[name];
  const normalizedCompleteness = Math.max(0, Math.min(1, completeness));
  if (result.value !== null) {
    health[name] = {
      state: normalizedCompleteness === 1 ? "ok" : normalizedCompleteness > 0 ? "degraded" : "unavailable",
      observedAt: now.toISOString(),
      lastSuccessAt: normalizedCompleteness > 0 ? now.toISOString() : previous.lastSuccessAt,
      ageMs: 0,
      latencyMs: result.latencyMs,
      completeness: normalizedCompleteness,
      error: normalizedCompleteness > 0 ? null : "Response contained no usable records.",
    };
    return;
  }
  const lastSuccess = previous.lastSuccessAt;
  health[name] = {
    state: lastSuccess ? "stale" : "unavailable",
    observedAt: now.toISOString(),
    lastSuccessAt: lastSuccess,
    ageMs: lastSuccess ? now.getTime() - new Date(lastSuccess).getTime() : null,
    latencyMs: result.latencyMs,
    completeness: previous.completeness,
    error: result.error,
  };
}

function stablecoinTotal(raw: any): number | null {
  if (!Array.isArray(raw?.peggedAssets)) return null;
  const values: number[] = [];
  for (const asset of raw.peggedAssets as any[]) {
    const value = finiteOrNull(asset?.circulating?.peggedUSD);
    if (value != null) values.push(value);
  }
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function tvlByChain(raw: unknown): Record<string, number> {
  if (!Array.isArray(raw)) return {};
  return raw.reduce<Record<string, number>>((result, row: any) => {
    const name = typeof row?.name === "string" ? normalizeChain(row.name) : "";
    const tvl = finiteOrNull(row?.tvl);
    if (name && tvl != null) result[name] = tvl;
    return result;
  }, {});
}

/** Extract only the total returned by DefiLlama's chain-specific endpoint. */
export function extractDexChainVolume(raw: unknown): number | null {
  return finiteOrNull((raw as { total24h?: unknown } | null)?.total24h);
}

/** DefiLlama stablecoin chart totals are nested under a peg denomination. */
export function extractStablecoinChartTotal(point: unknown): number | null {
  const row = point as {
    totalCirculatingUSD?: unknown;
    totalCirculating?: { peggedUSD?: unknown } | unknown;
    circulating?: { peggedUSD?: unknown } | unknown;
  } | null;
  const totalCirculatingUsd = row?.totalCirculatingUSD;
  const nestedUsd = totalCirculatingUsd && typeof totalCirculatingUsd === "object"
    ? (totalCirculatingUsd as { peggedUSD?: unknown }).peggedUSD
    : totalCirculatingUsd;
  return finiteOrNull(
    nestedUsd ??
    (row?.totalCirculating && typeof row.totalCirculating === "object"
      ? (row.totalCirculating as { peggedUSD?: unknown }).peggedUSD
      : row?.totalCirculating) ??
    (row?.circulating && typeof row.circulating === "object"
      ? (row.circulating as { peggedUSD?: unknown }).peggedUSD
      : row?.circulating),
  );
}

export function dexChainOverviewUrl(chain: string): string {
  return `https://api.llama.fi/overview/dexs/${encodeURIComponent(chain)}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyVolume`;
}

/**
 * CoinGecko market_chart request used by the backfill. CoinGecko returns hourly
 * points automatically for 2-90 day windows; the explicit `interval=hourly`
 * parameter the previous version sent is restricted to Enterprise plans and
 * made every backfill request fail.
 */
export function coinGeckoMarketChartUrl(coinId: string, days: number, base = coinGeckoEndpoint().base): string {
  return `${base}/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${days}`;
}

type DexChainCollection = {
  values: Record<string, number | null>;
  available: number;
  fresh: boolean;
};

function sourceStaleAfterMs(name: string): number {
  return name === "dex" || name.startsWith("dex:")
    ? DEX_CHAIN_REFRESH_MS * 2
    : COLLECTION_INTERVAL_MS * 3;
}

async function collectDexChainVolumes(context: { signal?: AbortSignal; deadlineAt?: number }): Promise<DexChainCollection> {
  const now = Date.now();
  if (cachedDexChainCollection && now - dexChainCollectedAt < DEX_CHAIN_REFRESH_MS) {
    return { ...cachedDexChainCollection, values: { ...cachedDexChainCollection.values }, fresh: false };
  }
  if (dexChainCollection) return dexChainCollection;
  dexChainCollection = (async () => {
    // Bounded fan-out: at most four chain requests in flight, not fifteen at once.
    const results = await mapWithConcurrency(DEX_CHAINS, DEX_CHAIN_CONCURRENCY, (chain) =>
      fetchJson<unknown>(dexChainOverviewUrl(chain), { signal: context.signal, deadlineAt: context.deadlineAt }),
    );
    const values: Record<string, number | null> = {};
    let available = 0;
    results.forEach((result, index) => {
      const chain = DEX_CHAINS[index];
      const volume = result.value == null ? null : extractDexChainVolume(result.value);
      if (result.value != null && volume != null) available += 1;
      const prior = dexChainHealth.get(chain) ?? unavailableHealth();
      if (result.value != null && volume != null) {
        values[chain] = volume;
        dexChainHealth.set(chain, {
          state: "ok", observedAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(),
          ageMs: 0, latencyMs: result.latencyMs, completeness: 1, error: null,
        });
      } else {
        values[chain] = null;
        dexChainHealth.set(chain, {
          state: prior.lastSuccessAt ? "stale" : "unavailable",
          observedAt: new Date().toISOString(), lastSuccessAt: prior.lastSuccessAt,
          ageMs: prior.lastSuccessAt ? Date.now() - new Date(prior.lastSuccessAt).getTime() : null,
          latencyMs: result.latencyMs,
          completeness: 0,
          error: result.error ?? "Chain endpoint did not include total24h.",
        });
      }
    });
    const collected: DexChainCollection = { values, available, fresh: true };
    // Only cache a collection that produced data; a total outage retries next sweep.
    if (available > 0) {
      cachedDexChainCollection = collected;
      dexChainCollectedAt = Date.now();
    }
    return { ...collected, values: { ...values } };
  })().finally(() => { dexChainCollection = null; });
  return dexChainCollection;
}

function cloneHealth(): Record<string, MarketSourceHealth> {
  const now = Date.now();
  const entries: Array<[string, MarketSourceHealth]> = [
    ...Object.entries(health),
    ...Array.from(dexChainHealth.entries()).map(([chain, item]) => [`dex:${chain}`, item] as [string, MarketSourceHealth]),
  ];
  return Object.fromEntries(entries.map(([name, item]) => {
    const ageMs = item.lastSuccessAt ? now - new Date(item.lastSuccessAt).getTime() : null;
    const state = item.lastSuccessAt && ageMs != null && ageMs > sourceStaleAfterMs(name)
      ? "stale"
      : item.state;
    return [name, { ...item, state, ageMs }];
  }));
}

export function getMarketSourceHealth(): Record<string, MarketSourceHealth> {
  return cloneHealth();
}

export function getCachedMarketSnapshot(): DashboardData | null {
  if (!snapshot) return null;
  return {
    ...snapshot,
    source: { ...snapshot.source },
    sourceHealth: cloneHealth(),
    coverage: snapshot.coverage ? { ...snapshot.coverage } : undefined,
    assets: Object.fromEntries(Object.entries(snapshot.assets).map(([symbol, asset]) => [symbol, { ...asset }])),
  };
}

export function getMarketOperationsProgress(): {
  collectionLastSuccessAt: number | null;
  retentionLastSuccessAt: number | null;
  retentionEnabled: boolean;
} {
  return {
    collectionLastSuccessAt: lastCollectionSuccessAt,
    retentionLastSuccessAt: lastRetentionSuccessAt,
    retentionEnabled: hasHistoryDatabase(),
  };
}

function validateCoinsPayload(value: unknown): string | null {
  return Array.isArray(value) ? null : "CoinGecko markets payload was not an array";
}

async function runCollection(context: GuardedTaskContext): Promise<void> {
  const deadlineAt = Date.now() + COLLECTION_DEADLINE_MS - 2_000;
  const common = { signal: context.signal, deadlineAt, priority: "high" as const };
  const ids = COIN_IDS.join(",");
  const coingecko = coinGeckoEndpoint();
  const [coinsResult, stableResult, tvlResult, dexTotalResult, dex] = await Promise.all([
    fetchJson<Coin[]>(
      `${coingecko.base}/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=1h,24h,7d,30d`,
      { ...common, headers: coingecko.headers, validate: validateCoinsPayload },
    ),
    // includePrices=false keeps circulating.peggedUSD but drops a large price map.
    fetchJson<any>("https://stablecoins.llama.fi/stablecoins?includePrices=false", common),
    fetchJson<any[]>("https://api.llama.fi/v2/chains", common),
    fetchJson<unknown>("https://api.llama.fi/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyVolume", common),
    collectDexChainVolumes(common),
  ]);
  if (context.isStale()) return;

  const coins = Array.isArray(coinsResult.value)
    ? coinsResult.value.filter((coin): coin is Coin => Boolean(coin) && typeof coin.id === "string")
    : [];
  const chains = tvlByChain(tvlResult.value);
  const stablecoinMcap = stablecoinTotal(stableResult.value);
  const totalDexVolume = dexTotalResult.value == null ? null : extractDexChainVolume(dexTotalResult.value);
  updateHealth("coingecko", coinsResult, coins.length / COIN_IDS.length);
  updateHealth("stablecoins", stableResult, stablecoinMcap != null ? 1 : 0);
  updateHealth("tvl", tvlResult, Object.keys(chains).length ? 1 : 0);
  const dexCompleteness = (dex.available + (totalDexVolume != null ? 1 : 0)) / (DEX_CHAINS.length + 1);
  const dexHealthResult: FetchResult<unknown> = dex.available || totalDexVolume != null
    ? { value: { chains: dex.available, totalDexVolume }, error: null, latencyMs: dexTotalResult.latencyMs }
    : { value: null, error: dexTotalResult.error ?? "No chain-specific DEX volume endpoint returned a usable total24h value.", latencyMs: dexTotalResult.latencyMs };
  updateHealth("dex", dexHealthResult, dexCompleteness);
  const priorGlobalDex = dexChainHealth.get("global") ?? unavailableHealth();
  dexChainHealth.set("global", totalDexVolume != null
    ? { state: "ok", observedAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), ageMs: 0, latencyMs: dexTotalResult.latencyMs, completeness: 1, error: null }
    : {
        state: priorGlobalDex.lastSuccessAt ? "stale" : "unavailable",
        observedAt: new Date().toISOString(), lastSuccessAt: priorGlobalDex.lastSuccessAt,
        ageMs: priorGlobalDex.lastSuccessAt ? Date.now() - new Date(priorGlobalDex.lastSuccessAt).getTime() : null,
        latencyMs: dexTotalResult.latencyMs,
        completeness: 0, error: dexTotalResult.error ?? "Global DEX endpoint did not include total24h.",
      });

  const previous = snapshot;
  // Before the first complete snapshot, fail explicitly rather than publish
  // made-up zero totals for an upstream that did not respond.
  if (!previous && !coins.length) return;

  const nextAssets = { ...(snapshot?.assets ?? {}) };
  const hasChainTvl = Object.keys(chains).length > 0;
  const hasDexVolume = dex.available > 0;
  if (coins.length) {
    for (const coin of coins) {
      const symbol = ID_TO_SYMBOL[coin.id as keyof typeof ID_TO_SYMBOL];
      if (!symbol) continue;
      const chain = SYMBOL_TO_CHAIN[symbol];
      const priorAsset = previous?.assets[symbol];
      nextAssets[symbol] = {
        price: finiteOrNull(coin.current_price),
        mcap: finiteOrNull(coin.market_cap),
        vol24h: finiteOrNull(coin.total_volume),
        change1h: finiteOrNull(coin.price_change_percentage_1h_in_currency),
        change24h: finiteOrNull(coin.price_change_percentage_24h_in_currency),
        change7d: finiteOrNull(coin.price_change_percentage_7d_in_currency),
        change30d: finiteOrNull(coin.price_change_percentage_30d_in_currency),
        high24h: finiteOrNull(coin.high_24h),
        low24h: finiteOrNull(coin.low_24h),
        ath: finiteOrNull(coin.ath),
        athDate: typeof coin.ath_date === "string" ? coin.ath_date : null,
        tvl: chain ? (hasChainTvl ? (chains[chain] ?? null) : (priorAsset?.tvl ?? null)) : null,
        dexVol: chain ? (dex.values[chain] ?? (hasDexVolume ? null : (priorAsset?.dexVol ?? null))) : null,
        image: typeof coin.image === "string" ? coin.image : null,
        rank: finiteOrNull(coin.market_cap_rank),
      };
    }
  }

  // Do not replace a good cached field with a failure-shaped zero. A source
  // health record makes retained values visibly stale to API consumers.
  const result: DashboardData = {
    timestamp: new Date().toISOString(),
    stablecoinMcap: stablecoinMcap ?? previous?.stablecoinMcap ?? null,
    totalTvl: Object.keys(chains).length
      ? Object.values(chains).reduce((sum, value) => sum + value, 0)
      : previous?.totalTvl ?? null,
    totalDexVolume: totalDexVolume ?? previous?.totalDexVolume ?? null,
    assets: nextAssets,
    source: {
      coingecko: health.coingecko.state === "ok",
      stablecoins: health.stablecoins.state === "ok",
      tvl: health.tvl.state === "ok",
      dex: health.dex.state === "ok",
    },
    sourceHealth: cloneHealth(),
    coverage: {
      trackedAssets: COIN_IDS.length,
      pricedAssets: Object.values(nextAssets).filter((asset) => asset.price != null).length,
      dexProtocols: null,
      dexChainAllocations: null,
      dexChainsRequested: DEX_CHAINS.length,
      dexChainsAvailable: dex.available,
      dexCollection: "overview/dexs/{chain}",
      aggregateScope: {
        marketCap: "tracked-watchlist",
        volume: "tracked-watchlist",
        stablecoins: "all-defillama-pegged-assets",
        tvl: "all-defillama-chains",
        dex: "global DefiLlama total24h; asset rows use chain-specific totals",
      },
    },
  };
  if (context.isStale()) return;
  snapshot = result;
  lastCollectionSuccessAt = Date.now();

  // Write each independently observed field. Cached stale fields remain
  // visible to clients with health metadata, but become null in this new
  // timestamp so an outage can never look like a flat market series.
  const freshness: SnapshotFieldFreshness = {
    coingecko: health.coingecko.state === "ok",
    stablecoins: health.stablecoins.state === "ok",
    tvl: health.tvl.state === "ok",
    dexGlobal: totalDexVolume != null,
    dexBySymbol: Object.fromEntries(Object.entries(SYMBOL_TO_CHAIN).map(([symbol, chain]) => [
      symbol,
      dex.fresh && dexChainHealth.get(chain)?.state === "ok",
    ])),
  };
  if (hasHistoryDatabase()) {
    // Persistence happens off the sweep's critical path. A slow or unavailable
    // database can no longer hold the collection lock.
    persistQueue.enqueue("snapshot", () => recordMarketSnapshot(result, freshness));
  }
  maybeScheduleBackfill();
}

const collectionTask = new GuardedTask("market-collection", runCollection, COLLECTION_DEADLINE_MS);

/** Runs one sweep. Overlapping calls are skipped; a hung sweep is aborted at its deadline. */
export async function collectMarketSnapshot(): Promise<void> {
  const outcome = await collectionTask.run();
  if (outcome.status === "timeout" || outcome.status === "error") {
    console.warn(`[market] collection ${outcome.status}: ${outcome.error}`);
  }
}

type HistoricalRow = { capturedAt: Date; symbol: string; price?: number | null; marketCap?: number | null; volume24h?: number | null; stablecoinMcap?: number | null; tvl?: number | null; dexVolume?: number | null };

function pairs(values: unknown): Array<[number, number]> {
  if (!Array.isArray(values)) return [];
  return values.flatMap((point): Array<[number, number]> => {
    if (!Array.isArray(point) || point.length < 2) return [];
    const timestamp = finiteOrNull(point[0]);
    const value = finiteOrNull(point[1]);
    return timestamp != null && value != null ? [[timestamp, value]] : [];
  });
}

function chartRows(symbol: string, raw: any): HistoricalRow[] {
  const byTime = new Map<number, HistoricalRow>();
  for (const [timestamp, price] of pairs(raw?.prices)) {
    byTime.set(timestamp, { capturedAt: new Date(timestamp), symbol, price });
  }
  for (const [timestamp, marketCap] of pairs(raw?.market_caps)) {
    const row = byTime.get(timestamp) ?? { capturedAt: new Date(timestamp), symbol };
    row.marketCap = marketCap;
    byTime.set(timestamp, row);
  }
  for (const [timestamp, volume24h] of pairs(raw?.total_volumes)) {
    const row = byTime.get(timestamp) ?? { capturedAt: new Date(timestamp), symbol };
    row.volume24h = volume24h;
    byTime.set(timestamp, row);
  }
  return Array.from(byTime.values());
}

function epochMs(value: unknown): number | null {
  const numberValue = finiteOrNull(value);
  if (numberValue == null) return null;
  return numberValue < 10_000_000_000 ? numberValue * 1000 : numberValue;
}

function totalChartRows(raw: any, field: "stablecoinMcap" | "tvl" | "dexVolume"): HistoricalRow[] {
  const values = raw?.totalDataChart ?? raw?.data ?? raw;
  const tupleRows = pairs(values).map(([time, value]) => ({
    capturedAt: new Date(epochMs(time) ?? time),
    symbol: "__GLOBAL__",
    [field]: value,
  }));
  if (tupleRows.length || !Array.isArray(values)) return tupleRows;
  return values.flatMap((point): HistoricalRow[] => {
    const timestamp = epochMs(point?.date ?? point?.timestamp);
    const value = finiteOrNull(
      field === "tvl" ? (point?.tvl ?? point?.totalLiquidityUSD)
        : field === "dexVolume" ? (point?.dailyVolume ?? point?.totalVolumeUSD ?? point?.volume)
          : point?.totalCirculatingUSD,
    );
    return timestamp != null && value != null
      ? [{ capturedAt: new Date(timestamp), symbol: "__GLOBAL__", [field]: value }]
      : [];
  });
}

async function runBackfill(context: GuardedTaskContext): Promise<{ coinsOk: number; coinsTotal: number; rows: number; globalSeriesOk: number }> {
  const rows: HistoricalRow[] = [];
  const coingecko = coinGeckoEndpoint();
  // The shared host limiter paces CoinGecko; two lanes only keep the queue warm.
  const coinResults = await mapWithConcurrency(COIN_IDS, 2, async (id) => {
    if (context.isStale()) return false;
    const result = await fetchJson<any>(coinGeckoMarketChartUrl(id, 7, coingecko.base), {
      signal: context.signal,
      headers: coingecko.headers,
      priority: "normal",
    });
    if (!result.value) return false;
    const symbolRows = chartRows(ID_TO_SYMBOL[id], result.value);
    rows.push(...symbolRows);
    return symbolRows.length > 0;
  });
  const [tvl, dexChart, stable] = await Promise.all([
    fetchJson<any>("https://api.llama.fi/v2/historicalChainTvl", { signal: context.signal }),
    fetchJson<any>("https://api.llama.fi/overview/dexs?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=true&dataType=dailyVolume", { signal: context.signal }),
    fetchJson<any>("https://stablecoins.llama.fi/stablecoincharts/all", { signal: context.signal }),
  ]);
  let globalSeriesOk = 0;
  if (tvl.value) { const next = totalChartRows(tvl.value, "tvl"); if (next.length) globalSeriesOk += 1; rows.push(...next); }
  if (dexChart.value) { const next = totalChartRows(dexChart.value, "dexVolume"); if (next.length) globalSeriesOk += 1; rows.push(...next); }
  if (stable.value) {
    const stablePoints = Array.isArray(stable.value) ? stable.value : stable.value?.data;
    let count = 0;
    if (Array.isArray(stablePoints)) {
      for (const point of stablePoints) {
        const timestamp = epochMs(point?.date ?? point?.timestamp);
        const value = extractStablecoinChartTotal(point);
        if (timestamp != null && value != null) {
          rows.push({ capturedAt: new Date(timestamp), symbol: "__GLOBAL__", stablecoinMcap: value });
          count += 1;
        }
      }
    }
    if (count) globalSeriesOk += 1;
  }
  if (context.isStale()) throw new Error("Backfill superseded before write");
  if (rows.length) await recordHistoricalRows(rows);
  if (await pruneMarketHistory()) lastRetentionSuccessAt = Date.now();
  return { coinsOk: coinResults.filter(Boolean).length, coinsTotal: COIN_IDS.length, rows: rows.length, globalSeriesOk };
}

const backfillTask = new GuardedTask("history-backfill", runBackfill, HISTORY_BACKFILL_DEADLINE_MS);

/**
 * Backfill uses the providers' historical endpoints and writes into the
 * existing market_snapshots table. A partial run is retried in 30 minutes
 * instead of silently waiting a full day with gaps.
 */
export async function backfillHistoricalSeries(): Promise<void> {
  if (!hasHistoryDatabase()) return;
  const outcome = await backfillTask.run();
  if (outcome.status === "skipped") return;
  const report = outcome.value;
  if (report) lastBackfillReport = { at: new Date().toISOString(), ...report };
  const complete = outcome.status === "ok" && report != null
    && report.coinsOk >= Math.ceil(report.coinsTotal * 0.9) && report.globalSeriesOk >= 2;
  nextBackfillAt = Date.now() + (complete ? HISTORY_BACKFILL_INTERVAL_MS : HISTORY_BACKFILL_RETRY_MS);
  if (!complete) {
    console.warn(`[market] history backfill incomplete (${outcome.status}${report ? `, ${report.coinsOk}/${report.coinsTotal} assets` : ""}${outcome.error ? `: ${outcome.error}` : ""}); retrying in 30 minutes`);
  }
}

function maybeScheduleBackfill() {
  if (!hasHistoryDatabase() || backfillTask.isRunning() || Date.now() < nextBackfillAt) return;
  // Reserve the slot immediately so consecutive sweeps do not race to start it.
  nextBackfillAt = Date.now() + HISTORY_BACKFILL_RETRY_MS;
  void backfillHistoricalSeries().catch((error) => console.warn("[market] backfill failed:", error instanceof Error ? error.message : error));
}

export function getMarketPipelineStats() {
  return {
    collection: collectionTask.stats(),
    backfill: backfillTask.stats(),
    nextBackfillAt: nextBackfillAt ? new Date(nextBackfillAt).toISOString() : null,
    lastBackfill: lastBackfillReport,
    persistence: persistQueue.stats(),
    intervalMs: COLLECTION_INTERVAL_MS,
  };
}

/** Test and shutdown helper. */
export function drainMarketPersistence(): Promise<void> {
  return persistQueue.drain();
}

export function startMarketCollection(): void {
  if (timer) return;
  void collectMarketSnapshot().catch(() => undefined);
  timer = setInterval(() => { void collectMarketSnapshot().catch(() => undefined); }, COLLECTION_INTERVAL_MS);
  timer.unref();
}
