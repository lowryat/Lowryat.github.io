import assert from "node:assert/strict";
import test, { after } from "node:test";
import { getPool, resetPoolForTests } from "./db";
import { pruneFeedSeries, upsertFeedSeries } from "./feed-series";
import { mergeHistoricalRows, recordHistoricalRows } from "./history";
import { runInTemporaryDatabase } from "./test-database";

const WORKER_ENV = "PERSISTENCE_TEST_WORKER";
const isWorker = process.env[WORKER_ENV] === "1";

test("historical rows for the same symbol and time merge field by field", () => {
  const at = new Date("2026-09-01T00:00:00Z");
  const merged = mergeHistoricalRows([
    { capturedAt: at, symbol: "__GLOBAL__", tvl: 1 },
    { capturedAt: new Date(at.getTime()), symbol: "__GLOBAL__", dexVolume: 2 },
    { capturedAt: at, symbol: "__GLOBAL__", stablecoinMcap: 3, tvl: null },
    { capturedAt: new Date("invalid"), symbol: "BTC", price: 1 },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual({ ...merged[0], capturedAt: merged[0].capturedAt.toISOString() }, {
    capturedAt: at.toISOString(), symbol: "__GLOBAL__", tvl: 1, dexVolume: 2, stablecoinMcap: 3,
  });
});

if (!isWorker) {
  test("persistence round-trips run against the current schema in a temporary database", async (t) => {
    if (!process.env.DATABASE_URL) {
      t.skip("DATABASE_URL is not configured");
      return;
    }
    await runInTemporaryDatabase("server/persistence.test.ts", WORKER_ENV);
  });
} else {
  after(resetPoolForTests);

  test("bulk market upserts write thousands of rows in one pass and merge on conflict", async () => {
    const pool = getPool()!;
    const start = Date.parse("2026-08-01T00:00:00Z");
    const rows = Array.from({ length: 2_400 }, (_, index) => ({
      capturedAt: new Date(start + Math.floor(index / 2) * 3_600_000),
      symbol: index % 2 ? "ETH" : "BTC",
      price: 100 + index,
    }));
    const started = Date.now();
    await recordHistoricalRows(rows);
    assert.ok(Date.now() - started < 10_000);
    const count = await pool.query<{ n: string }>("SELECT count(*) AS n FROM market_snapshots");
    assert.equal(Number(count.rows[0].n), 2_400);
    // A later backfill adds a field without erasing the price already stored.
    await recordHistoricalRows([{ capturedAt: new Date(start), symbol: "BTC", marketCap: 5 }]);
    const row = await pool.query<{ price: number; market_cap: number }>("SELECT price, market_cap FROM market_snapshots WHERE symbol = 'BTC' AND captured_at = $1", [new Date(start)]);
    assert.deepEqual(row.rows[0], { price: 100, market_cap: 5 });
  });

  test("feed-series upserts collapse duplicate keys and retention is scoped to one provider", async () => {
    const pool = getPool()!;
    const old = new Date("2025-01-01T00:00:00Z");
    const recent = new Date();
    const inserted = await upsertFeedSeries(pool, [
      { provider: "coinbase", symbol: "BTC", metric: "price", interval: "1m", observedAt: old, value: 1, metadata: {} },
      { provider: "coinbase", symbol: "BTC", metric: "price", interval: "1m", observedAt: old, value: 2, metadata: { note: "last wins" } },
      { provider: "coinbase", symbol: "BTC", metric: "price", interval: "1m", observedAt: recent, value: 3, metadata: {} },
      { provider: "daily_history", symbol: "BTC", metric: "close", interval: "1d", observedAt: old, value: 4, metadata: { source: "coinbase" } },
    ]);
    assert.equal(inserted, 3);
    const deduped = await pool.query<{ value: number; metadata: { note?: string } }>("SELECT value, metadata FROM market_feed_series WHERE provider = 'coinbase' AND observed_at = $1", [old]);
    assert.deepEqual(deduped.rows, [{ value: 2, metadata: { note: "last wins" } }]);
    await pruneFeedSeries(pool, "coinbase", new Date(Date.now() - 90 * 86_400_000));
    const remaining = await pool.query<{ provider: string; value: number }>("SELECT provider, value FROM market_feed_series ORDER BY value");
    // The 90-day Coinbase cleanup must not delete the long daily history used by the risk engine.
    assert.deepEqual(remaining.rows, [{ provider: "coinbase", value: 3 }, { provider: "daily_history", value: 4 }]);
  });
}
