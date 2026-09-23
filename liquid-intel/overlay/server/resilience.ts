/**
 * Defensive primitives for the market-data pipeline.
 *
 * Every repeating sweep in this server follows the same rules:
 *  - a run can never hold its lock forever (hard deadline + abort signal),
 *  - an overlapping tick is skipped and counted instead of queueing behind a hung run,
 *  - slow side effects (database writes) never block the sweep that produced them,
 *  - every outcome is counted so /api/health/pipeline can show what is happening.
 */

export class DeadlineError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} exceeded its ${Math.round(ms / 1000)}s deadline`);
    this.name = "DeadlineError";
  }
}

/** Reject after `ms` without leaving timers behind. The wrapped work is not cancelled; pass a signal for that. */
export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "Operation aborted");
  error.name = "AbortError";
  return error;
}

/** Full-jitter exponential backoff (AWS architecture blog), bounded. */
export function backoffDelay(attempt: number, baseMs = 500, maxMs = 8_000, random = Math.random): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(random() * ceiling);
}

/** Map with a fixed number of in-flight workers; results keep input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

export type GuardedRunStatus = "ok" | "skipped" | "timeout" | "error";

export type GuardedRunResult<T> = {
  status: GuardedRunStatus;
  value?: T;
  error?: string;
  durationMs: number;
};

export type GuardedTaskStats = {
  name: string;
  running: boolean;
  runs: number;
  ok: number;
  skippedOverlaps: number;
  timeouts: number;
  errors: number;
  deadlineMs: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSuccessAt: string | null;
  lastDurationMs: number | null;
  lastStatus: GuardedRunStatus | null;
  lastError: string | null;
};

export type GuardedTaskContext = {
  /** Aborted when the deadline passes; pass it to fetches so they stop too. */
  signal: AbortSignal;
  /** Monotonic run number; compare before publishing results. */
  generation: number;
  /** True once this run has been superseded or timed out. Never publish then. */
  isStale(): boolean;
};

/**
 * Single-flight task with a hard deadline. A tick that arrives while a run is
 * active is skipped (and counted) instead of awaiting it, and a run that
 * exceeds its deadline releases the lock and is aborted, so one hung upstream
 * or database call can never freeze every future sweep.
 */
export class GuardedTask<T> {
  private running: { generation: number; controller: AbortController } | null = null;
  private generation = 0;
  private readonly counters = {
    runs: 0, ok: 0, skippedOverlaps: 0, timeouts: 0, errors: 0,
  };
  private lastStartedAt: number | null = null;
  private lastFinishedAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastDurationMs: number | null = null;
  private lastStatus: GuardedRunStatus | null = null;
  private lastError: string | null = null;

  constructor(
    readonly name: string,
    private readonly work: (context: GuardedTaskContext) => Promise<T>,
    private readonly deadlineMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  isRunning(): boolean {
    return this.running !== null;
  }

  async run(): Promise<GuardedRunResult<T>> {
    if (this.running) {
      this.counters.skippedOverlaps += 1;
      return { status: "skipped", durationMs: 0 };
    }
    const generation = ++this.generation;
    const controller = new AbortController();
    this.running = { generation, controller };
    this.counters.runs += 1;
    const startedAt = this.now();
    this.lastStartedAt = startedAt;
    const context: GuardedTaskContext = {
      signal: controller.signal,
      generation,
      isStale: () => controller.signal.aborted || this.running?.generation !== generation,
    };

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.deadlineMs);
    });

    let result: GuardedRunResult<T>;
    try {
      const outcome = await Promise.race([
        this.work(context).then((value) => ({ value })),
        deadline,
      ]);
      if (outcome === "timeout") {
        controller.abort(new DeadlineError(this.name, this.deadlineMs));
        this.counters.timeouts += 1;
        result = { status: "timeout", error: new DeadlineError(this.name, this.deadlineMs).message, durationMs: this.now() - startedAt };
      } else {
        this.counters.ok += 1;
        this.lastSuccessAt = this.now();
        result = { status: "ok", value: outcome.value, durationMs: this.now() - startedAt };
      }
    } catch (error) {
      this.counters.errors += 1;
      result = { status: "error", error: error instanceof Error ? error.message : String(error), durationMs: this.now() - startedAt };
    } finally {
      if (timer) clearTimeout(timer);
      if (this.running?.generation === generation) this.running = null;
    }
    this.lastFinishedAt = this.now();
    this.lastDurationMs = result.durationMs;
    this.lastStatus = result.status;
    this.lastError = result.error ?? null;
    return result;
  }

  stats(): GuardedTaskStats {
    const iso = (value: number | null) => (value == null ? null : new Date(value).toISOString());
    return {
      name: this.name,
      running: this.running !== null,
      ...this.counters,
      deadlineMs: this.deadlineMs,
      lastStartedAt: iso(this.lastStartedAt),
      lastFinishedAt: iso(this.lastFinishedAt),
      lastSuccessAt: iso(this.lastSuccessAt),
      lastDurationMs: this.lastDurationMs,
      lastStatus: this.lastStatus,
      lastError: this.lastError,
    };
  }
}

export type WriteQueueStats = {
  name: string;
  pending: number;
  capacity: number;
  running: boolean;
  completed: number;
  failed: number;
  dropped: number;
  timedOut: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
};

type QueuedWrite = { label: string; run: () => Promise<void> };

/**
 * Serial, bounded, fire-and-forget queue for slow side effects. Callers never
 * await it. When the database is slow the oldest pending job is dropped (and
 * counted) rather than letting memory or latency grow without bound.
 */
export class WriteQueue {
  private readonly jobs: QueuedWrite[] = [];
  private running = false;
  private readonly counters = { completed: 0, failed: 0, dropped: 0, timedOut: 0 };
  private lastError: string | null = null;
  private lastErrorAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private idleWaiters: Array<() => void> = [];

  constructor(
    readonly name: string,
    private readonly capacity = 50,
    private readonly jobTimeoutMs = 30_000,
  ) {}

  enqueue(label: string, run: () => Promise<void>): boolean {
    let accepted = true;
    if (this.jobs.length >= this.capacity) {
      this.jobs.shift();
      this.counters.dropped += 1;
      accepted = false;
    }
    this.jobs.push({ label, run });
    void this.pump();
    return accepted;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs.shift()!;
        try {
          await withDeadline(job.run(), this.jobTimeoutMs, `${this.name}:${job.label}`);
          this.counters.completed += 1;
          this.lastSuccessAt = Date.now();
        } catch (error) {
          if (error instanceof DeadlineError) this.counters.timedOut += 1;
          else this.counters.failed += 1;
          this.lastError = `${job.label}: ${error instanceof Error ? error.message : String(error)}`;
          this.lastErrorAt = Date.now();
          console.warn(`[${this.name}] ${this.lastError}`);
        }
      }
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  /** Resolves when the queue is empty (tests and graceful shutdown). */
  drain(): Promise<void> {
    if (!this.running && !this.jobs.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  stats(): WriteQueueStats {
    const iso = (value: number | null) => (value == null ? null : new Date(value).toISOString());
    return {
      name: this.name,
      pending: this.jobs.length,
      capacity: this.capacity,
      running: this.running,
      ...this.counters,
      lastError: this.lastError,
      lastErrorAt: iso(this.lastErrorAt),
      lastSuccessAt: iso(this.lastSuccessAt),
    };
  }
}

/** Short-lived memo with single-flight: concurrent callers share one load. */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();
  private readonly inFlight = new Map<K, Promise<V>>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 100, private readonly now: () => number = Date.now) {}

  async get(key: K, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.value;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const request = load()
      .then((value) => {
        this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
        while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as K);
        return value;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  clear(): void {
    this.entries.clear();
  }
}
