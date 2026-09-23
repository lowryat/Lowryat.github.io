import { Pool, type PoolConfig } from "pg";

/**
 * One shared, hardened Postgres pool for the whole server.
 *
 * Before this module every feature created its own `new Pool()` with no
 * connection or query timeouts and no "error" listener. With a serverless
 * Postgres (Replit/Neon) that suspends idle computes, a dropped idle client
 * emitted an unhandled "error" event (crashing the process), and a stalled
 * query or connect held a market sweep's single-flight lock forever.
 */

const DEFAULT_CONFIG: PoolConfig = {
  max: Number(process.env.PG_POOL_MAX) || 10,
  // Waiting for a free client or a new connection fails fast instead of hanging.
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS) || 10_000,
  idleTimeoutMillis: 30_000,
  // Server-side cap on any statement, plus a client-side cap if the server never answers.
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS) || 30_000,
  query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS) || 35_000,
  idle_in_transaction_session_timeout: 60_000,
  keepAlive: true,
  // Idle clients never keep a finished test or CLI process alive; the HTTP server does in production.
  allowExitOnIdle: true,
  application_name: "liq-intel",
};

let sharedPool: Pool | null | undefined;
const health = {
  errors: 0,
  lastError: null as string | null,
  lastErrorAt: null as string | null,
  connects: 0,
};

/** Attach the listeners every pool must have so idle-client errors never crash the process. */
export function hardenPool(pool: Pool, label = "pool"): Pool {
  pool.on("error", (error) => {
    health.errors += 1;
    health.lastError = `${label}: ${error.message}`;
    health.lastErrorAt = new Date().toISOString();
    console.warn(`[db] idle client error on ${label} (recovered): ${error.message}`);
  });
  pool.on("connect", () => {
    health.connects += 1;
  });
  return pool;
}

/** Shared pool, or null when DATABASE_URL is not configured (in-memory mode). */
export function getPool(): Pool | null {
  if (sharedPool !== undefined) return sharedPool;
  const connectionString = process.env.DATABASE_URL;
  sharedPool = connectionString ? hardenPool(new Pool({ ...DEFAULT_CONFIG, connectionString }), "shared") : null;
  return sharedPool;
}

export function getDatabaseHealth() {
  const pool = sharedPool ?? null;
  return {
    configured: Boolean(process.env.DATABASE_URL),
    totalClients: pool?.totalCount ?? 0,
    idleClients: pool?.idleCount ?? 0,
    waitingRequests: pool?.waitingCount ?? 0,
    maxClients: DEFAULT_CONFIG.max ?? null,
    connectTimeoutMs: DEFAULT_CONFIG.connectionTimeoutMillis ?? null,
    statementTimeoutMs: DEFAULT_CONFIG.statement_timeout ?? null,
    ...health,
  };
}

/** Test helper: close and forget the shared pool. */
export async function resetPoolForTests(): Promise<void> {
  const pool = sharedPool;
  sharedPool = undefined;
  if (pool) await pool.end().catch(() => undefined);
}
