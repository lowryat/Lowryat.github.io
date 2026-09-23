import type { Express } from "express";
import type { Pool } from "pg";
import WebSocket from "ws";
import type {
  CoinbaseBookMetrics,
  CoinbaseFeedResponse,
  ExecutedCandle,
  FeedStatus,
} from "@shared/feed-types";
import { getPool } from "./db";
import { pruneFeedSeries, upsertFeedSeries, type FeedSeriesRow } from "./feed-series";

const COINBASE_WS_URL = "wss://advanced-trade-ws.coinbase.com";
const STALE_AFTER_MS = 20_000;
const MAX_TRADES = 10_000;
const MAX_CANDLES = 1_440;
const MAX_BOOK_LEVELS = 200;
const SLIPPAGE_NOTIONAL_USD = 10_000;
const CANDLE_PERSIST_DEBOUNCE_MS = 5_000;
const FEED_PROVIDER = "coinbase_advanced_trade";
let lastFeedSeriesRetentionAt = 0;
const PRODUCTS: Record<string, string> = {
  BTC: "BTC-USD",
  ETH: "ETH-USD",
  SOL: "SOL-USD",
  AVAX: "AVAX-USD",
  LINK: "LINK-USD",
};

type Trade = {
  id: string;
  time: number;
  price: number;
  size: number;
};

type CandleState = {
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  baseVolume: number;
  quoteVolume: number;
  tradeCount: number;
};

type L2Update = {
  side?: string;
  price_level?: string | number;
  new_quantity?: string | number;
  size?: string | number;
};

export type CoinbaseMarketFeedOptions = {
  products?: string[];
  connect?: boolean;
  now?: () => number;
  /** Optional durable feed-series writer; omitted in fixture-only instances. */
  pool?: Pool | null;
};

function asNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function iso(time: number | null): string | null {
  return time == null ? null : new Date(time).toISOString();
}

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, maximum: number): void {
  map.set(key, value);
  while (map.size > maximum) map.delete(map.keys().next().value as K);
}

/** Calculates market-impact estimates from the currently displayed L2 levels. */
export function estimateSlippageBps(
  levels: Iterable<[number, number]>,
  notionalUsd: number,
  referencePrice: number | null,
): number | null {
  if (!referencePrice || referencePrice <= 0 || notionalUsd <= 0) return null;
  let remaining = notionalUsd;
  let spent = 0;
  let acquired = 0;
  for (const [price, baseSize] of Array.from(levels)) {
    if (remaining <= 0) break;
    const levelNotional = price * baseSize;
    if (!Number.isFinite(levelNotional) || levelNotional <= 0) continue;
    const takeNotional = Math.min(levelNotional, remaining);
    spent += takeNotional;
    acquired += takeNotional / price;
    remaining -= takeNotional;
  }
  if (remaining > 0 || acquired === 0) return null;
  const averagePrice = spent / acquired;
  return ((averagePrice - referencePrice) / referencePrice) * 10_000;
}

export class CoinbaseMarketFeed {
  private readonly now: () => number;
  private readonly products: Set<string>;
  private readonly trades = new Map<string, Trade[]>();
  private readonly tradeIds = new Map<string, Set<string>>();
  private readonly candles = new Map<string, Map<number, CandleState>>();
  private readonly bids = new Map<string, Map<number, number>>();
  private readonly asks = new Map<string, Map<number, number>>();
  private readonly lastTradeAt = new Map<string, number>();
  private readonly lastBookAt = new Map<string, number>();
  private readonly pool: Pool | null;
  private dirtyCandles = new Map<string, Set<number>>();
  private socket: WebSocket | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private persistInFlight = false;
  private reconnectAttempt = 0;
  private stopped = false;
  private lastMessageAt: number | null = null;
  private lastSequence: number | null = null;
  private connectedAt: number | null = null;
  private state: FeedStatus["state"] = "idle";
  private error: FeedStatus["error"] = null;

  constructor(options: CoinbaseMarketFeedOptions = {}) {
    this.now = options.now ?? Date.now;
    this.pool = options.pool ?? null;
    const products = (options.products?.length ? options.products : ["BTC-USD"])
      .map((product) => product.toUpperCase())
      .slice(0, 5);
    this.products = new Set(products);
    for (const product of products) {
      this.trades.set(product, []);
      this.tradeIds.set(product, new Set());
      this.candles.set(product, new Map());
      this.bids.set(product, new Map());
      this.asks.set(product, new Map());
    }
    if (options.connect) this.start();
  }

  start(): void {
    if (!this.staleTimer) {
      this.staleTimer = setInterval(() => this.refreshStaleness(), 5_000);
      this.staleTimer.unref();
    }
    this.stopped = false;
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.staleTimer = null;
    this.reconnectTimer = null;
    this.persistTimer = null;
    this.socket?.close();
    this.socket = null;
    this.state = "idle";
  }

  private open(): void {
    this.state = "connecting";
    this.socket = new WebSocket(COINBASE_WS_URL);
    this.socket.on("open", () => {
      this.connectedAt = this.now();
      this.reconnectAttempt = 0;
      // Coinbase requires a subscription promptly after connect. Heartbeats make
      // a silent socket detectable; market_trades and level2 are public channels.
      for (const channel of ["heartbeats", "market_trades", "level2"]) {
        this.socket?.send(JSON.stringify({ type: "subscribe", channel, product_ids: Array.from(this.products) }));
      }
    });
    this.socket.on("message", (raw) => this.ingest(String(raw)));
    this.socket.on("error", (error) => {
      this.state = "degraded";
      this.error = { code: "UPSTREAM_ERROR", message: error.message };
    });
    this.socket.on("close", () => {
      this.socket = null;
      if (!this.stopped) {
        this.state = "degraded";
        this.error = { code: "UPSTREAM_ERROR", message: "Coinbase WebSocket disconnected; reconnecting." };
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, delay);
    this.reconnectTimer.unref();
  }

  /**
   * Ingests a raw Coinbase Advanced Trade message. Public to make provider
   * fixtures testable without opening a socket.
   */
  ingest(raw: string | Record<string, unknown>): void {
    let message: Record<string, any>;
    try {
      message = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      this.state = "degraded";
      this.error = { code: "UPSTREAM_ERROR", message: "Coinbase sent invalid JSON." };
      return;
    }
    const receivedAt = this.now();
    this.lastMessageAt = receivedAt;
    this.observeSequence(asNumber(message.sequence_num));

    const channel = message.channel;
    const events = Array.isArray(message.events) ? message.events : [];
    if (channel === "market_trades") {
      for (const event of events) {
        for (const sourceTrade of Array.isArray(event.trades) ? event.trades : []) this.ingestTrade(sourceTrade);
      }
    } else if (channel === "l2_data") {
      for (const event of events) this.ingestBookEvent(event);
    }

    // A detected L2 gap stays explicit until a fresh level-2 snapshot arrives.
    if (this.error?.code !== "SEQUENCE_GAP") {
      this.state = "live";
      this.error = null;
    }
  }

  private observeSequence(sequence: number | null): void {
    if (sequence == null) return;
    if (this.lastSequence != null && sequence > this.lastSequence + 1) {
      this.state = "degraded";
      this.error = {
        code: "SEQUENCE_GAP",
        message: `Coinbase sequence gap: expected ${this.lastSequence + 1}, received ${sequence}. Waiting for an L2 snapshot.`,
      };
    }
    if (this.lastSequence == null || sequence > this.lastSequence) this.lastSequence = sequence;
  }

  private ingestTrade(source: Record<string, unknown>): void {
    const product = typeof source.product_id === "string" ? source.product_id.toUpperCase() : "";
    const price = asNumber(source.price);
    const size = asNumber(source.size);
    const timestamp = typeof source.time === "string" ? Date.parse(source.time) : this.now();
    const id = String(source.trade_id ?? `${timestamp}:${price}:${size}`);
    if (!this.products.has(product) || price == null || price <= 0 || size == null || size <= 0 || !Number.isFinite(timestamp)) return;
    const seen = this.tradeIds.get(product)!;
    if (seen.has(id)) return;
    seen.add(id);
    const trades = this.trades.get(product)!;
    trades.push({ id, time: timestamp, price, size });
    while (trades.length > MAX_TRADES) {
      const discarded = trades.shift();
      if (discarded) seen.delete(discarded.id);
    }
    this.lastTradeAt.set(product, timestamp);

    const start = Math.floor(timestamp / 60_000) * 60_000;
    const candles = this.candles.get(product)!;
    const existing = candles.get(start);
    if (existing) {
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
      existing.baseVolume += size;
      existing.quoteVolume += price * size;
      existing.tradeCount += 1;
    } else {
      boundedSet(candles, start, {
        start, open: price, high: price, low: price, close: price,
        baseVolume: size, quoteVolume: price * size, tradeCount: 1,
      }, MAX_CANDLES);
    }
    this.markCandleDirty(product, start);
  }

  private markCandleDirty(product: string, start: number): void {
    if (!this.pool) return;
    const starts = this.dirtyCandles.get(product) ?? new Set<number>();
    starts.add(start);
    this.dirtyCandles.set(product, starts);
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flushCandles();
    }, CANDLE_PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref();
  }

  /** Persists session-generated one-minute OHLC/VWAP only; it never backfills a 7d Coinbase history. */
  private async flushCandles(): Promise<void> {
    if (!this.pool) return;
    // One flush at a time: a slow database defers work instead of stacking writes.
    if (this.persistInFlight) {
      if (!this.persistTimer) {
        this.persistTimer = setTimeout(() => {
          this.persistTimer = null;
          void this.flushCandles();
        }, CANDLE_PERSIST_DEBOUNCE_MS);
        this.persistTimer.unref();
      }
      return;
    }
    const pending = this.dirtyCandles;
    this.dirtyCandles = new Map();
    const candleRows: Array<{ product: string; candle: CandleState }> = [];
    for (const [product, starts] of Array.from(pending.entries())) {
      const candles = this.candles.get(product);
      for (const start of Array.from(starts)) {
        const candle = candles?.get(start);
        if (candle) candleRows.push({ product, candle });
      }
    }
    if (!candleRows.length) return;
    const metadata = JSON.stringify({
      provider: FEED_PROVIDER,
      venue: "Coinbase Advanced Trade",
      coverage: "Session-generated public Coinbase spot trades; not historical backfill.",
      interval: "1m",
    });
    const metrics = (candle: CandleState): Array<[string, number]> => [
      ["open", candle.open],
      ["high", candle.high],
      ["low", candle.low],
      ["close", candle.close],
      ["executed_vwap", candle.quoteVolume / candle.baseVolume],
      ["executed_base_volume", candle.baseVolume],
      ["executed_quote_volume", candle.quoteVolume],
      ["trade_count", candle.tradeCount],
    ];
    const rows: FeedSeriesRow[] = candleRows.flatMap(({ product, candle }) => {
      const symbol = product.split("-")[0];
      return metrics(candle).map(([metric, value]) => ({
        provider: FEED_PROVIDER, symbol, metric, interval: "1m", observedAt: new Date(candle.start), value, metadata,
      }));
    });
    this.persistInFlight = true;
    try {
      await upsertFeedSeries(this.pool, rows);
      const now = this.now();
      if (now - lastFeedSeriesRetentionAt >= 24 * 60 * 60_000 || lastFeedSeriesRetentionAt === 0) {
        lastFeedSeriesRetentionAt = now;
        await pruneFeedSeries(this.pool, FEED_PROVIDER, new Date(now - 90 * 24 * 60 * 60_000));
      }
    } catch {
      // In-memory session metrics remain valid if durable storage is briefly unavailable.
    } finally {
      this.persistInFlight = false;
    }
  }

  private ingestBookEvent(event: Record<string, unknown>): void {
    const product = typeof event.product_id === "string" ? event.product_id.toUpperCase() : "";
    if (!this.products.has(product)) return;
    const isSnapshot = event.type === "snapshot";
    if (isSnapshot) {
      this.bids.get(product)!.clear();
      this.asks.get(product)!.clear();
      // A snapshot is the only safe point to clear a reported sequence gap.
      if (this.error?.code === "SEQUENCE_GAP") {
        this.error = null;
        this.state = "live";
      }
    }
    for (const update of Array.isArray(event.updates) ? event.updates as L2Update[] : []) {
      const price = asNumber(update.price_level);
      const size = asNumber(update.new_quantity ?? update.size);
      const side = update.side?.toLowerCase();
      if (price == null || price <= 0 || size == null || (side !== "bid" && side !== "offer" && side !== "ask")) continue;
      const book = side === "bid" ? this.bids.get(product)! : this.asks.get(product)!;
      if (size === 0) book.delete(price);
      else book.set(price, size);
      while (book.size > MAX_BOOK_LEVELS) {
        const worst = Array.from(book.keys()).sort(side === "bid" ? (a, b) => a - b : (a, b) => b - a)[0];
        book.delete(worst);
      }
    }
    this.lastBookAt.set(product, this.now());
  }

  private refreshStaleness(): void {
    if (this.lastMessageAt == null || this.error?.code === "SEQUENCE_GAP") return;
    if (this.now() - this.lastMessageAt > STALE_AFTER_MS) {
      this.state = "stale";
      this.error = { code: "STALE", message: "No Coinbase heartbeat or market-data message arrived before the stale threshold." };
    }
  }

  snapshot(symbol: string): CoinbaseFeedResponse {
    const normalizedSymbol = symbol.toUpperCase();
    const productId = PRODUCTS[normalizedSymbol] ?? `${normalizedSymbol}-USD`;
    const now = this.now();
    if (!this.products.has(productId)) {
      return this.emptySnapshot(normalizedSymbol, productId, {
        code: "INVALID_SYMBOL",
        message: `${normalizedSymbol} is not in the server Coinbase watchlist.`,
      });
    }
    this.refreshStaleness();
    const trades = this.trades.get(productId) ?? [];
    const baseVolume = trades.reduce((sum, trade) => sum + trade.size, 0);
    const quoteVolume = trades.reduce((sum, trade) => sum + trade.price * trade.size, 0);
    const candles = Array.from(this.candles.get(productId)?.values() ?? [])
      .sort((a, b) => a.start - b.start)
      .map((candle): ExecutedCandle => ({
        startTime: new Date(candle.start).toISOString(),
        endTime: new Date(candle.start + 60_000).toISOString(),
        interval: "1m",
        open: candle.open, high: candle.high, low: candle.low, close: candle.close,
        baseVolume: candle.baseVolume, quoteVolume: candle.quoteVolume,
        tradeCount: candle.tradeCount, vwap: candle.quoteVolume / candle.baseVolume,
      }));
    const bids = Array.from(this.bids.get(productId)?.entries() ?? []).sort((a, b) => b[0] - a[0]);
    const asks = Array.from(this.asks.get(productId)?.entries() ?? []).sort((a, b) => a[0] - b[0]);
    const bestBid = bids[0]?.[0] ?? null;
    const bestAsk = asks[0]?.[0] ?? null;
    const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
    const book: CoinbaseBookMetrics = {
      bestBid, bestAsk, mid,
      spread: bestBid != null && bestAsk != null ? bestAsk - bestBid : null,
      spreadBps: bestBid != null && bestAsk != null && mid ? ((bestAsk - bestBid) / mid) * 10_000 : null,
      bidDepthUsd: bids.reduce((sum, [price, size]) => sum + price * size, 0),
      askDepthUsd: asks.reduce((sum, [price, size]) => sum + price * size, 0),
      estimatedBuySlippageBps: estimateSlippageBps(asks, SLIPPAGE_NOTIONAL_USD, bestAsk),
      // A lower sale price is adverse. Convert the signed calculation to a positive cost.
      estimatedSellSlippageBps: bestBid == null
        ? null
        : (() => {
          const result = estimateSlippageBps(bids, SLIPPAGE_NOTIONAL_USD, bestBid);
          return result == null ? null : Math.abs(result);
        })(),
      slippageNotionalUsd: SLIPPAGE_NOTIONAL_USD,
    };
    const lastUpdatedAt = Math.max(this.lastMessageAt ?? 0, this.lastTradeAt.get(productId) ?? 0, this.lastBookAt.get(productId) ?? 0) || null;
    return {
      symbol: normalizedSymbol,
      productId,
      status: {
        state: this.state,
        lastUpdatedAt: iso(lastUpdatedAt),
        ageMs: lastUpdatedAt == null ? null : now - lastUpdatedAt,
        staleAfterMs: STALE_AFTER_MS,
        error: this.error,
      },
      metadata: {
        provider: "coinbase_advanced_trade",
        venue: "Coinbase Advanced Trade",
        coverage: `Single spot venue (${productId}); not a consolidated market feed.`,
        interval: "1m",
        units: { price: "USD", baseVolume: normalizedSymbol, quoteVolume: "USD", spread: "USD", slippage: "bps" },
        sourceUpdatedAt: iso(lastUpdatedAt),
        collectedAt: new Date(now).toISOString(),
      },
      executedVwap: baseVolume ? quoteVolume / baseVolume : null,
      executedBaseVolume: baseVolume,
      executedQuoteVolume: quoteVolume,
      tradeCount: trades.length,
      book,
      candles,
    };
  }

  operationsProgress(): {
    started: boolean;
    lastSuccessAt: number | null;
  } {
    return {
      started: !this.stopped && this.staleTimer !== null,
      lastSuccessAt: this.lastMessageAt,
    };
  }

  private emptySnapshot(symbol: string, productId: string, error: NonNullable<FeedStatus["error"]>): CoinbaseFeedResponse {
    const now = this.now();
    return {
      symbol, productId,
      status: { state: "unavailable", lastUpdatedAt: null, ageMs: null, staleAfterMs: STALE_AFTER_MS, error },
      metadata: {
        provider: "coinbase_advanced_trade", venue: "Coinbase Advanced Trade",
        coverage: "No data: symbol is outside the server watchlist.", interval: "1m",
        units: { price: "USD", baseVolume: symbol, quoteVolume: "USD", spread: "USD", slippage: "bps" },
        sourceUpdatedAt: null, collectedAt: new Date(now).toISOString(),
      },
      executedVwap: null, executedBaseVolume: 0, executedQuoteVolume: 0, tradeCount: 0,
      book: {
        bestBid: null, bestAsk: null, mid: null, spread: null, spreadBps: null,
        bidDepthUsd: 0, askDepthUsd: 0, estimatedBuySlippageBps: null,
        estimatedSellSlippageBps: null, slippageNotionalUsd: SLIPPAGE_NOTIONAL_USD,
      },
      candles: [],
    };
  }
}

let sharedFeed: CoinbaseMarketFeed | null = null;

/** Starts the singleton public Coinbase feed; call once during server bootstrap. */
export function startCoinbaseFeed(): CoinbaseMarketFeed {
  if (!sharedFeed) {
    const configured = process.env.COINBASE_WATCHLIST?.split(",").map((symbol) => {
      const normalized = symbol.trim().toUpperCase();
      return normalized.includes("-") ? normalized : `${normalized}-USD`;
    });
    sharedFeed = new CoinbaseMarketFeed({
      products: configured,
      connect: true,
      pool: getPool(),
    });
  }
  return sharedFeed;
}

export function getCoinbaseOperationsProgress(): {
  started: boolean;
  lastSuccessAt: number | null;
} {
  return sharedFeed?.operationsProgress() ?? { started: false, lastSuccessAt: null };
}

/** Registers the server-only normalized Coinbase snapshot endpoint. */
export function registerCoinbaseRoutes(app: Express): void {
  app.get("/api/coinbase", (req, res) => {
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : "";
    if (!/^[A-Z0-9]{2,15}$/.test(symbol)) {
      return res.status(400).json({ message: "symbol must be an uppercase asset ticker, for example BTC" });
    }
    const feed = sharedFeed ?? (sharedFeed = new CoinbaseMarketFeed());
    return res.json(feed.snapshot(symbol));
  });
}
