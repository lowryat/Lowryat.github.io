import assert from "node:assert/strict";
import test from "node:test";
import { DeadlineError, GuardedTask, mapWithConcurrency, TtlCache, withDeadline, WriteQueue } from "./resilience";

const never = <T>() => new Promise<T>(() => undefined);
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("withDeadline rejects a hung promise with a DeadlineError", async () => {
  await assert.rejects(withDeadline(never(), 20, "hung call"), (error: unknown) => error instanceof DeadlineError);
  assert.equal(await withDeadline(Promise.resolve(7), 50, "fast call"), 7);
});

test("GuardedTask skips overlapping runs instead of queueing behind them", async () => {
  let release: () => void = () => undefined;
  let calls = 0;
  const task = new GuardedTask("overlap", async () => {
    calls += 1;
    await new Promise<void>((resolve) => { release = resolve; });
    return "done";
  }, 5_000);
  const first = task.run();
  const second = await task.run();
  assert.equal(second.status, "skipped");
  release();
  assert.equal((await first).status, "ok");
  assert.equal(calls, 1);
  assert.equal(task.stats().skippedOverlaps, 1);
});

test("GuardedTask releases its lock and aborts the work when the deadline passes", async () => {
  let aborted = false;
  const task = new GuardedTask("hung", async (context) => {
    context.signal.addEventListener("abort", () => { aborted = true; });
    await never();
  }, 25);
  const outcome = await task.run();
  assert.equal(outcome.status, "timeout");
  assert.equal(aborted, true);
  assert.equal(task.isRunning(), false);
  // The next sweep runs normally even though the first one never settled.
  const quick = new GuardedTask("after", async () => 1, 1_000);
  assert.equal((await quick.run()).status, "ok");
  assert.equal(task.stats().timeouts, 1);
});

test("GuardedTask marks a timed-out generation stale so it cannot publish late results", async () => {
  let staleAfterTimeout: boolean | null = null;
  let finish: () => void = () => undefined;
  const task = new GuardedTask("stale", async (context) => {
    await new Promise<void>((resolve) => { finish = resolve; });
    staleAfterTimeout = context.isStale();
  }, 20);
  assert.equal((await task.run()).status, "timeout");
  finish();
  await tick(5);
  assert.equal(staleAfterTimeout, true);
});

test("WriteQueue runs jobs serially, never blocks the caller, and drops the oldest when full", async () => {
  const queue = new WriteQueue("test", 2, 1_000);
  const order: string[] = [];
  let unblock: () => void = () => undefined;
  queue.enqueue("slow", () => new Promise<void>((resolve) => { unblock = () => { order.push("slow"); resolve(); }; }));
  await tick();
  queue.enqueue("a", async () => { order.push("a"); });
  queue.enqueue("b", async () => { order.push("b"); });
  queue.enqueue("c", async () => { order.push("c"); });
  assert.equal(queue.stats().dropped, 1);
  unblock();
  await queue.drain();
  assert.deepEqual(order, ["slow", "b", "c"]);
});

test("WriteQueue times out a hung job and keeps processing", async () => {
  const queue = new WriteQueue("timeouts", 5, 20);
  const done: string[] = [];
  queue.enqueue("hung", () => never());
  queue.enqueue("next", async () => { done.push("next"); });
  await queue.drain();
  assert.deepEqual(done, ["next"]);
  assert.equal(queue.stats().timedOut, 1);
});

test("TtlCache shares one in-flight load and expires entries", async () => {
  let now = 0;
  let loads = 0;
  const cache = new TtlCache<string, number>(100, 10, () => now);
  const load = async () => { loads += 1; await tick(5); return loads; };
  const [a, b] = await Promise.all([cache.get("k", load), cache.get("k", load)]);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(await cache.get("k", load), 1);
  now = 200;
  assert.equal(await cache.get("k", load), 2);
});

test("mapWithConcurrency preserves order and caps parallelism", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await tick(value);
    active -= 1;
    return value * 10;
  });
  assert.deepEqual(result, [50, 10, 40, 20, 30]);
  assert.equal(peak, 2);
});
