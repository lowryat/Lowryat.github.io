import type { Express } from "express";
import { computeMarketStructure, type DailyPanel, type MarketStructure } from "@shared/quant/structure";
import { stablecoinElasticity } from "@shared/quant/risk";
import { DAILY_SYMBOLS, getDailyHistoryStatus, getDailyHistoryVersion, getDailyPanel, startDailyHistory } from "./daily-history";

/**
 * Read-only analytics endpoints. The server prepares validated, aligned daily
 * data; the Monte Carlo, scenario, and sensitivity engines run in the browser
 * from the same shared code, so a heavy simulation never blocks the market
 * sweep or the alert evaluator on this process.
 */

export const DEFAULT_LOOKBACK_DAYS = 365;
const MIN_LOOKBACK_DAYS = 120;
const MAX_LOOKBACK_DAYS = 399;
const DEFAULT_PORTFOLIO: Record<string, number> = { BTC: 0.4, ETH: 0.25, SOL: 0.1, LINK: 0.05 };

let structureCache: { version: number; structure: MarketStructure } | null = null;
const modelCache = new Map<string, { version: number; body: RiskLabModel }>();

export type RiskLabModel = {
  asOf: string;
  lookbackDays: number;
  symbols: string[];
  /** Date of each return (the close it ends on). */
  dates: string[];
  /** Aligned daily log returns, one array per symbol, oldest first. */
  returns: number[][];
  prices: number[];
  excluded: Array<{ symbol: string; reason: string }>;
  defaultWeights: number[];
  regime: MarketStructure["regime"]["trend"];
  stablecoinElasticity: { slope: number; r2: number; tStat: number; n: number } | null;
  sources: Record<string, string | null>;
};

function trailingContiguous(series: Array<number | null>): number {
  let count = 0;
  for (let index = series.length - 1; index >= 0; index -= 1) {
    const value = series[index];
    if (value == null || !(value > 0)) break;
    count += 1;
  }
  return count;
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function getMarketStructure(panel = getDailyPanel()): MarketStructure | null {
  if (!panel) return null;
  const version = getDailyHistoryVersion();
  if (structureCache?.version === version) return structureCache.structure;
  const structure = computeMarketStructure(panel);
  structureCache = { version, structure };
  return structure;
}

/**
 * Aligns daily log returns across assets over a common window. Assets without
 * a complete window are excluded and reported, never silently padded.
 */
export function buildRiskLabModel(panel: DailyPanel, lookbackDays = DEFAULT_LOOKBACK_DAYS, requested?: string[], regime: RiskLabModel["regime"] = "unknown"): RiskLabModel | null {
  const lookback = Math.min(MAX_LOOKBACK_DAYS, Math.max(MIN_LOOKBACK_DAYS, Math.round(lookbackDays)));
  const universe = (requested?.length ? requested : DAILY_SYMBOLS).filter((symbol) => panel.closes[symbol]);
  // BTC is the benchmark for betas, scenarios, and sensitivity; keep it first.
  const ordered = ["BTC", ...universe.filter((symbol) => symbol !== "BTC")];
  const needed = lookback + 1;
  const symbols: string[] = [];
  const excluded: RiskLabModel["excluded"] = [];
  for (const symbol of ordered) {
    const series = panel.closes[symbol];
    if (!series) {
      excluded.push({ symbol, reason: "no daily history available" });
      continue;
    }
    const available = trailingContiguous(series);
    if (available < needed) excluded.push({ symbol, reason: `only ${Math.max(0, available - 1)} days of continuous history (need ${lookback})` });
    else symbols.push(symbol);
  }
  if (!symbols.includes("BTC")) return null;
  const end = panel.dates.length - 1;
  const start = end - lookback;
  const returns = symbols.map((symbol) => {
    const closes = panel.closes[symbol];
    const out: number[] = [];
    for (let index = start + 1; index <= end; index += 1) out.push(round(Math.log(closes[index]! / closes[index - 1]!)));
    return out;
  });
  const benchmark = returns[0];
  const supply = panel.stablecoinSupply.slice(start, end + 1);
  const elasticity = supply.filter((value) => value != null).length >= 120 ? stablecoinElasticity(benchmark, supply) : null;
  const status = getDailyHistoryStatus();
  const sourceBySymbol = new Map(status.assets.map((row) => [row.symbol, row.source]));
  return {
    asOf: panel.dates[end],
    lookbackDays: lookback,
    symbols,
    dates: panel.dates.slice(start + 1, end + 1),
    returns,
    prices: symbols.map((symbol) => panel.closes[symbol][end]!),
    excluded,
    defaultWeights: symbols.map((symbol) => DEFAULT_PORTFOLIO[symbol] ?? 0),
    regime,
    stablecoinElasticity: elasticity && Number.isFinite(elasticity.slope) ? elasticity : null,
    sources: Object.fromEntries(symbols.map((symbol) => [symbol, sourceBySymbol.get(symbol) ?? null])),
  };
}

function parseSymbols(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const symbols = value.split(",").map((item) => item.trim().toUpperCase()).filter((item) => /^[A-Z0-9]{2,10}$/.test(item));
  return symbols.length ? Array.from(new Set(symbols)).slice(0, 30) : undefined;
}

export function registerQuantRoutes(app: Express): void {
  app.get("/api/market-structure", (_req, res) => {
    const structure = getMarketStructure();
    const history = getDailyHistoryStatus();
    if (!structure) {
      return res.status(503).json({ message: "Daily history is still loading. Market structure appears once BTC history is available.", history });
    }
    res.set("Cache-Control", "public, max-age=300").json({ structure, history });
  });

  app.get("/api/risk-lab/model", (req, res) => {
    const panel = getDailyPanel();
    if (!panel) {
      return res.status(503).json({ message: "Daily history is still loading. The risk lab needs at least BTC history.", history: getDailyHistoryStatus() });
    }
    const lookbackRaw = Number(req.query.lookback);
    const lookback = Number.isFinite(lookbackRaw) && lookbackRaw > 0 ? lookbackRaw : DEFAULT_LOOKBACK_DAYS;
    const symbols = parseSymbols(req.query.symbols);
    const version = getDailyHistoryVersion();
    const key = `${Math.round(lookback)}|${symbols?.join(",") ?? "*"}`;
    const cached = modelCache.get(key);
    if (cached?.version === version) return res.set("Cache-Control", "public, max-age=300").json(cached.body);
    const regime = getMarketStructure(panel)?.regime.trend ?? "unknown";
    const model = buildRiskLabModel(panel, lookback, symbols, regime);
    if (!model) {
      return res.status(503).json({ message: "BTC does not yet have enough continuous daily history for the requested lookback.", history: getDailyHistoryStatus() });
    }
    if (modelCache.size > 20) modelCache.clear();
    modelCache.set(key, { version, body: model });
    res.set("Cache-Control", "public, max-age=300").json(model);
  });
}

export function startDailyHistoryCollection(): void {
  startDailyHistory();
}
