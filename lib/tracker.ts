// Keeps every thread's status current. Any bb event about a thread only
// schedules a recompute; a recompute reads the thread log after its cursor,
// folds it into the facts (lib/facts.ts), reads bb's live state (status,
// queue, children when needed), derives the status (lib/status.ts) and the
// request on the Needs-you page (lib/requests.ts), and stores facts, status,
// request and topic in one transaction. Recomputes run one at a
// time per thread (a request during a run makes it run once more) and four
// at a time overall. A once-a-minute pass looks again at statuses that wait
// for a moment (a failed turn's retry window) and at threads shown running
// for a while; a pass at startup catches what happened while the plugin was
// not loaded.
import type { PluginBbSdk, PluginLogger } from "@get-bb/plugin-sdk";
import { FACT_EVENT_TYPES, emptyFacts, foldEvents, type Facts, type ReportFact } from "./facts.ts";
import { createLimiter } from "./helper.ts";
import { nextRequest, type RequestRecord } from "./requests.ts";
import { HELPER_TRIES, STATE_EMOJI, deriveStatus, meaningfulActivityAt, withChildren, type QueuedRow, type Report } from "./status.ts";
import type { StatusRecord, Store, TopicRecord } from "./store.ts";

const PARALLEL = 4;
const PAGE = 100;
/** Pages read per pass; a longer log continues in the next pass. */
const MAX_PAGES = 50;
/** The first look at a thread reads from the start of its last few turns. */
const BOOTSTRAP_TURNS = 3;
/** A thread shown running this long without a recompute is looked at again. */
const STALE_RUNNING_MS = 5 * 60_000;
/** The startup pass covers threads active in this window, and every tracked one. */
const SWEEP_WINDOW_MS = 14 * 86_400_000;
/** bb reports a busy thread's log once a second; its status is looked at this often at most. */
const NUDGE_MS = 3_000;

type ThreadDto = Awaited<ReturnType<PluginBbSdk["threads"]["get"]>>;
type ListedThread = Awaited<ReturnType<PluginBbSdk["threads"]["list"]>>[number];

/**
 * The agent's first report sets the topic; a later one (read in this pass,
 * `fresh`) changes it only with topicChanged.
 */
export function nextTopic(current: TopicRecord | null, report: ReportFact | null, fresh: boolean): TopicRecord | null {
  if (report === null) return null;
  if (current === null) return { topic: report.about, setBy: "agent", setAt: report.at };
  if (fresh && report.topicChanged && report.about !== current.topic) return { topic: report.about, setBy: "agent", setAt: report.at };
  return null;
}

export function createTracker(deps: {
  sdk: PluginBbSdk;
  store: Store;
  log: PluginLogger;
  /** Why the plugin leaves this thread alone, or null. */
  skip: (thread: ThreadDto) => Promise<string | null>;
  /** Visible root threads of every project, for the startup pass. */
  allThreads: () => Promise<ListedThread[]>;
  /** The status, its request or the topic changed (or tracking stopped). */
  onChange?: (threadId: string, what: { topic: boolean }) => void;
  now?: () => number;
}) {
  const { sdk, store, log } = deps;
  const now = deps.now ?? (() => Date.now());
  const limiter = createLimiter(PARALLEL);
  const runs = new Map<string, Promise<void>>();
  const again = new Set<string>();
  const nudges = new Map<string, ReturnType<typeof setTimeout>>();

  /** Where the first read starts: before the thread's last few own turns (subagent turns do not count). */
  async function bootstrapAfter(threadId: string): Promise<number> {
    let found = 0;
    let before: number | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const starts = await sdk.threads.events.list({
        threadId,
        types: ["turn/started"],
        order: "desc",
        limit: String(PAGE),
        ...(before !== null ? { beforeSeq: String(before) } : {}),
      });
      for (const start of starts) {
        const nested = (start as { data?: { parentToolCallId?: unknown } }).data?.parentToolCallId;
        if (typeof nested === "string") continue;
        found += 1;
        if (found === BOOTSTRAP_TURNS) return start.seq - 1;
      }
      if (starts.length < PAGE) return 0;
      before = starts[starts.length - 1]!.seq;
    }
    return 0;
  }

  /** New fact events after `afterSeq`, up to MAX_PAGES pages; `complete` once the end of the log was read. */
  async function readEvents(threadId: string, afterSeq: number): Promise<{ events: unknown[]; complete: boolean }> {
    const events: unknown[] = [];
    let cursor = afterSeq;
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await sdk.threads.events.list({
        threadId,
        types: FACT_EVENT_TYPES,
        order: "asc",
        afterSeq: String(cursor),
        limit: String(PAGE),
      });
      events.push(...batch);
      if (batch.length < PAGE) return { events, complete: true };
      cursor = batch[batch.length - 1]!.seq;
    }
    return { events, complete: false };
  }

  async function queueOf(threadId: string): Promise<QueuedRow[]> {
    const listed = (await sdk.threads.queuedMessages.list({ threadId })) as unknown;
    const rows = Array.isArray(listed) ? listed : ((listed as { queuedMessages?: unknown[] } | null)?.queuedMessages ?? []);
    return rows.map((raw) => {
      const row = raw as {
        id?: string;
        createdAt?: number;
        sendAt?: number | null;
        failureReason?: string | null;
        payload?: { kind?: string };
      };
      return {
        ...(typeof row.id === "string" ? { id: row.id } : {}),
        ...(typeof row.createdAt === "number" ? { createdAt: row.createdAt } : {}),
        sendAt: row.sendAt ?? null,
        failureReason: row.failureReason ?? null,
        retry: row.payload?.kind === "retry",
      };
    });
  }

  async function childrenOf(threadId: string): Promise<{ id: string; title: string | null; status: string }[]> {
    const children = await sdk.threads.list({ parentThreadId: threadId, archived: false, limit: 50 });
    return children.map((child) => ({ id: child.id, title: child.title ?? null, status: child.status }));
  }

  /** The helper's answer as a report, and the turn it gave up on. */
  function helperOf(threadId: string): { report: Report | null; gaveUpOn: string | null } {
    const helper = store.getHelper(threadId);
    if (helper === null) return { report: null, gaveUpOn: null };
    const answer = helper.report;
    const answered = answer !== null && answer.turnId === helper.tryTurnId;
    return {
      report: answer
        ? {
            state: answer.state,
            done: answer.done,
            stoppedAt: answer.stoppedAt,
            seq: answer.basisSeq,
            turnId: answer.turnId,
            at: answer.at,
            source: "helper",
            questionCount: answer.questionCount ?? null,
            waitingOnThreadIds: answer.waitingOnThreadIds ?? null,
          }
        : null,
      gaveUpOn: !answered && helper.tries >= HELPER_TRIES ? helper.tryTurnId : null,
    };
  }

  async function recomputeOnce(threadId: string): Promise<void> {
    const thread = await sdk.threads.get({ threadId });
    // An archived or skipped thread is not tracked; unarchived, it is read afresh.
    if (thread.archivedAt !== null || thread.deletedAt !== null || (await deps.skip(thread)) !== null) {
      forget(threadId);
      return;
    }

    const stored = store.getFacts(threadId);
    const start: Facts = stored ?? { ...emptyFacts(), processedSeq: await bootstrapAfter(threadId) };
    const read = await readEvents(threadId, start.processedSeq);
    const facts = foldEvents(start, read.events);
    // A long log (a Codex goal turn writes tens of thousands of items) is read
    // over several passes: keep the progress, leave the status, read on.
    if (!read.complete) {
      store.saveTracking(threadId, { facts, status: null, topic: null, at: now() });
      again.add(threadId);
      return;
    }
    const queue = thread.queuedMessageCount > 0 ? await queueOf(threadId) : [];
    const helper = helperOf(threadId);
    const live = { status: thread.status, queue };
    let derived = deriveStatus({
      facts,
      live,
      now: now(),
      reports: [helper.report],
      helperGaveUpOn: helper.gaveUpOn,
      threadId,
    });
    if (derived.checkChildren) derived = withChildren(derived, await childrenOf(threadId));

    const previous = store.getStatus(threadId);
    const previousRequest = store.getRequest(threadId);
    const at = now();
    const counts = { turns: facts.counts.turns, reported: facts.counts.reported };
    const held = derived.hold && previous !== null;
    const status: StatusRecord = held
      ? { ...previous, ...counts, projectId: thread.projectId, settleUntil: derived.settleUntil, freshness: "checking", updatedAt: at }
      : {
          threadId,
          projectId: thread.projectId,
          providerId: thread.providerId,
          state: derived.state,
          reason: derived.reason,
          since: derived.since,
          source: derived.source,
          turnId: derived.turnId,
          settleUntil: derived.settleUntil,
          needHelper: derived.needHelper,
          ...counts,
          updatedAt: at,
          view: derived.view,
          execution: derived.execution,
          freshness: derived.freshness,
          ask: derived.ask,
          sendAt: derived.sendAt,
          waitingOn: derived.waitingOn,
          activityAt: meaningfulActivityAt(facts, live) ?? previous?.activityAt ?? null,
        };
    // A held status keeps its request as it was: the facts are not final yet.
    const request: RequestRecord | null | undefined = held ? undefined : nextRequest(previousRequest, derived, threadId, at);
    const fresh = (facts.lastReport?.seq ?? 0) > start.processedSeq;
    const topic = nextTopic(store.getTopic(threadId), facts.lastReport, fresh);
    store.saveTracking(threadId, { facts, status, topic, at, request });
    const changed = previous?.state !== status.state || previous?.reason !== status.reason;
    if (changed) log.info(`status ${threadId}: ${STATE_EMOJI[status.state] || "·"} ${status.state} (${status.reason})`);
    // What the page shows moved even when the one-line reason did not: a new report, a new version, a new wait.
    const shown =
      changed ||
      fresh ||
      previous?.view !== status.view ||
      previous?.execution !== status.execution ||
      previous?.freshness !== status.freshness ||
      previous?.ask !== status.ask ||
      JSON.stringify(previous?.waitingOn ?? []) !== JSON.stringify(status.waitingOn) ||
      (request !== undefined && request !== previousRequest);
    if (shown || topic !== null) deps.onChange?.(threadId, { topic: topic !== null });
  }

  /** Stop tracking a thread (archived, deleted, skipped): its status and facts go, its topic stays. */
  function forget(threadId: string): void {
    if (store.getStatus(threadId) === null && store.getFacts(threadId) === null) return;
    store.dropTracking(threadId);
    deps.onChange?.(threadId, { topic: false });
  }

  /** Recompute a thread's status; resolves once no request for it is pending. */
  function schedule(threadId: string): Promise<void> {
    const running = runs.get(threadId);
    if (running) {
      again.add(threadId);
      return running;
    }
    const run = (async () => {
      do {
        again.delete(threadId);
        await limiter.acquire();
        try {
          await recomputeOnce(threadId);
        } catch (error) {
          log.warn(`status of ${threadId} failed: ${String(error)}`);
        } finally {
          limiter.release();
        }
      } while (again.has(threadId));
    })().finally(() => runs.delete(threadId));
    runs.set(threadId, run);
    return run;
  }

  /** New events in a thread's log: recompute a little later, once for the whole burst. */
  function nudge(threadId: string): void {
    if (nudges.has(threadId)) return;
    nudges.set(
      threadId,
      setTimeout(() => {
        nudges.delete(threadId);
        void schedule(threadId);
      }, NUDGE_MS),
    );
  }

  function dispose(): void {
    for (const timer of nudges.values()) clearTimeout(timer);
    nudges.clear();
  }

  /** The once-a-minute pass. */
  async function collect(): Promise<void> {
    const due = new Set([...store.settleDue(now()), ...store.staleRunning(now() - STALE_RUNNING_MS)]);
    await Promise.all([...due].map(schedule));
  }

  /** The startup pass: threads active lately and every thread already tracked. */
  async function sweep(): Promise<number> {
    const tracked = new Set(store.listStatuses().map((status) => status.threadId));
    const cutoff = now() - SWEEP_WINDOW_MS;
    const threads = (await deps.allThreads()).filter(
      (thread) => tracked.has(thread.id) || (thread.latestAttentionAt ?? thread.createdAt) >= cutoff,
    );
    await Promise.all(threads.map((thread) => schedule(thread.id)));
    return threads.length;
  }

  return { schedule, nudge, collect, sweep, forget, dispose };
}

export type Tracker = ReturnType<typeof createTracker>;
