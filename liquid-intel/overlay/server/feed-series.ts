import type { Pool } from "pg";

export type FeedSeriesRow = {
  provider: string;
  symbol: string;
  metric: string;
  interval: string;
  observedAt: Date;
  value: number;
  /** JSON string or object stored in the jsonb metadata column. */
  metadata: string | Record<string, unknown>;
};

const CHUNK = 1_000;

/**
 * Multi-row upsert into market_feed_series. Rows sharing a primary key are
 * collapsed first (last value wins) because one INSERT ... ON CONFLICT cannot
 * update the same row twice.
 */
export async function upsertFeedSeries(pool: Pool, rows: FeedSeriesRow[]): Promise<number> {
  const unique = new Map<string, FeedSeriesRow>();
  for (const row of rows) {
    const time = row.observedAt.getTime();
    if (!Number.isFinite(time) || !Number.isFinite(row.value)) continue;
    unique.set(`${row.provider}\u0000${row.symbol}\u0000${row.metric}\u0000${row.interval}\u0000${time}`, row);
  }
  const values = Array.from(unique.values());
  for (let offset = 0; offset < values.length; offset += CHUNK) {
    const chunk = values.slice(offset, offset + CHUNK);
    await pool.query(
      `INSERT INTO market_feed_series (provider, symbol, metric, interval, observed_at, value, metadata)
       SELECT provider, symbol, metric, interval, observed_at, value, metadata::jsonb
         FROM UNNEST($1::varchar[], $2::varchar[], $3::varchar[], $4::varchar[], $5::timestamptz[], $6::float8[], $7::text[])
           AS input(provider, symbol, metric, interval, observed_at, value, metadata)
       ON CONFLICT (provider, symbol, metric, interval, observed_at)
       DO UPDATE SET value = EXCLUDED.value, metadata = EXCLUDED.metadata`,
      [
        chunk.map((row) => row.provider),
        chunk.map((row) => row.symbol),
        chunk.map((row) => row.metric),
        chunk.map((row) => row.interval),
        chunk.map((row) => row.observedAt.toISOString()),
        chunk.map((row) => row.value),
        chunk.map((row) => typeof row.metadata === "string" ? row.metadata : JSON.stringify(row.metadata)),
      ],
    );
  }
  return values.length;
}

/**
 * Provider-scoped retention. The previous Coinbase and CoinGlass retention jobs
 * deleted every provider's rows older than 90 days, which would erase any
 * longer-horizon series (such as the daily price history used for risk).
 */
export async function pruneFeedSeries(pool: Pool, provider: string, olderThan: Date): Promise<void> {
  await pool.query(
    "DELETE FROM market_feed_series WHERE provider = $1 AND observed_at < $2",
    [provider, olderThan],
  );
}
