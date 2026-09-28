// When the helper runs on its own. The working agent reports its status at
// the end of each turn; a turn that ended without a report (the tracker marks
// it needHelper) gets the helper once the thread has been quiet for X minutes,
// at most once per Y minutes per thread and at most HELPER_TRIES times per
// turn. Only turns that ended after automatic updates were switched on, and
// in the last 14 days, are read. The collector starts no more helpers than
// there are free workers, newest turns first, so a backlog drains at the
// helpers' own pace instead of timing out in the queue. A new turn aborts a
// running helper: the thread is about to change.
import type { PluginKvStorage, PluginLogger } from "@get-bb/plugin-sdk";
import type { DescribeResult, Engine } from "./engine.ts";
import { HELPER_TRIES } from "./status.ts";
import type { Store } from "./store.ts";

export const COLLECTOR_CRON = "* * * * *";
/** When automatic updates were last switched on; survives reloads. */
const ARMED_AT_KEY = "armed-at";
const MINUTE = 60_000;
/** Turns older than this are not read on their own. */
const HELPER_WINDOW_MS = 14 * 86_400_000;

export interface TriggerSettings {
  enabled: boolean;
  idleMinutes: number;
  minIntervalMinutes: number;
  workers: number;
}

export function createTriggers(deps: {
  store: Store;
  engine: Engine;
  kv: PluginKvStorage;
  log: PluginLogger;
  settings: () => Promise<TriggerSettings>;
  /** The helper answered, skipped or failed: recompute the thread's status. */
  onAnswer: (threadId: string) => Promise<void>;
  now?: () => number;
}) {
  const { store, engine, log } = deps;
  const now = deps.now ?? (() => Date.now());
  /** Automatic runs in flight, so `thread.active` can abort them. */
  const running = new Map<string, AbortController>();
  /** Quiet turns that ended before automatic updates were switched on are not read. */
  let armedAt = Number.POSITIVE_INFINITY;

  function start(threadId: string, turnId: string, trigger: string): Promise<DescribeResult | null> {
    const controller = new AbortController();
    running.set(threadId, controller);
    const run = async () => {
      let result: DescribeResult | null = null;
      try {
        result = await engine.describe(threadId, { dryRun: false, signal: controller.signal, trigger });
        // Nothing to read counts as a try, so the thread is not picked every minute.
        if (result.status === "skipped" && result.turnId !== null) {
          store.saveHelperFailure(threadId, result.turnId, result.reason ?? "nothing to read", now());
        }
      } catch (error) {
        log.warn(`helper for ${threadId} (${trigger}) failed: ${String(error)}`);
        store.saveHelperFailure(threadId, turnId, String(error), now());
      }
      // An answer, a skip or the last failed try changes the status; an abort changes nothing.
      if (!(result?.status === "failed" && result.reason === "aborted")) await deps.onAnswer(threadId);
      return result;
    };
    return run()
      .catch((error: unknown) => {
        log.warn(`status of ${threadId} after its helper failed: ${String(error)}`);
        return null;
      })
      .finally(() => {
        if (running.get(threadId) === controller) running.delete(threadId);
      });
  }

  function onActive(thread: { id: string }): void {
    running.get(thread.id)?.abort();
  }

  /** Threads due for the helper now, and the turn to read, newest quiet turn first. */
  async function due(): Promise<{ threadId: string; turnId: string }[]> {
    const settings = await deps.settings();
    if (!settings.enabled) return [];
    const quietSince = now() - settings.idleMinutes * MINUTE;
    const oldest = Math.max(armedAt, now() - HELPER_WINDOW_MS);
    return store
      .needHelper(quietSince)
      .filter((status) => status.since >= oldest && status.turnId !== null && !running.has(status.threadId))
      .filter((status) => {
        const helper = store.getHelper(status.threadId);
        if (helper === null || helper.tryTurnId !== status.turnId) return true;
        if (helper.tries >= HELPER_TRIES) return false;
        return helper.triedAt === null || now() - helper.triedAt >= settings.minIntervalMinutes * MINUTE;
      })
      .sort((a, b) => b.since - a.since)
      .map((status) => ({ threadId: status.threadId, turnId: status.turnId as string }));
  }

  /** The once-a-minute pass: start helpers on free workers. */
  async function collect(): Promise<string[]> {
    const settings = await deps.settings();
    const free = Math.max(0, settings.workers - running.size);
    if (free === 0) return [];
    const started = (await due()).slice(0, free);
    for (const item of started) void start(item.threadId, item.turnId, "idle");
    return started.map((item) => item.threadId);
  }

  /**
   * Automatic updates were switched on (or the plugin loaded with them on).
   * The first time ever, fix the baseline of every existing thread: legacy
   * threads whose title bb did not generate keep their words.
   */
  async function arm(): Promise<void> {
    // A reload keeps the quiet turns that ended while updates were on.
    const stored = await deps.kv.get<number>(ARMED_AT_KEY);
    armedAt = typeof stored === "number" ? stored : now();
    if (typeof stored !== "number") await deps.kv.set(ARMED_AT_KEY, armedAt);
    const firstEnable = (await engine.enabledAt()) === null;
    await engine.markEnabled();
    if (!firstEnable) return;
    const threads = await engine.allRootThreads();
    let observed = 0;
    let locked = 0;
    for (let i = 0; i < threads.length; i += 4) {
      await Promise.all(
        threads.slice(i, i + 4).map(async (thread) => {
          if (store.getState(thread.id).baselineAt !== null) return;
          const state = await engine.observe(thread, true);
          observed += 1;
          if (state.locked) locked += 1;
        }),
      );
    }
    log.info(`first enable: baseline titles for ${observed} threads, ${locked} kept as set by a person or dispatcher`);
  }

  /** `switchedOff`: the owner turned updates off (not a reload or shutdown). */
  async function disarm(switchedOff: boolean): Promise<void> {
    armedAt = Number.POSITIVE_INFINITY;
    for (const controller of running.values()) controller.abort();
    if (switchedOff) await deps.kv.delete(ARMED_AT_KEY);
  }

  return {
    onActive,
    collect,
    due,
    arm,
    disarm,
    isRunning: (threadId: string) => running.has(threadId),
  };
}

export type Triggers = ReturnType<typeof createTriggers>;
