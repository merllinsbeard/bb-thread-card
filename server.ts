// bb-plugin-thread-card — the backend.
//
// The owner runs 150 threads and gets lost among them. For each thread the
// plugin keeps what it is about (the topic, which becomes its title), what is
// done, where it stopped and its status — who makes the next step: ⏳ the
// thread works, ❓ the owner, ⛔ someone else, ✅ nobody.
//
// The working agent reports all of it itself: the `report_thread_status`
// tool (lib/report.ts) is the last thing it calls in every turn. The plugin
// derives the status from that report and bb's own state (lib/facts.ts,
// lib/status.ts, lib/tracker.ts). A turn without a report gets a helper model
// that reads the thread once it is quiet (lib/engine.ts, lib/triggers.ts).
// The title is the topic; a title a person set keeps its words. The status
// shows as an icon on the sidebar row (app.tsx) or, with statusDisplay
// "title", as an emoji in front of the title. Threads in the sections named
// in `skipSections` (none by default) are left alone entirely.
//
// Surfaces: the sidebar row icon and the Needs-you page (app.tsx), the header
// button with the card popover and ⌘⌥R, and the `bb thread-card` CLI, all
// through the RPC contract below. The Needs-you page lists each thread that
// asks the owner something, waits on someone else or stopped, as one card
// per current request (lib/requests.ts, lib/queue.ts); snoozing, hiding and
// bringing a card back run through the same functions from the page and the
// CLI, and act only on the version of the request they name.
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginCliError, cliCommand, defineCli, defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { StatusDisplay } from "./lib/card.ts";
import { createEngine, skipReason, type DescribeResult, type EngineSettings } from "./lib/engine.ts";
import { cleanupOrphanHelpers, type ReasoningLevel } from "./lib/helper.ts";
import { PAGE_VIEWS, VIEW_TITLES, compareCards, type PageView, needsOwner, pageViewOf, toCard, type Dependency, type QueueCard, type QueueSort } from "./lib/queue.ts";
import { registerReportTool, type ReportState } from "./lib/report.ts";
import { activeDisposition, checkTarget, type DispositionKind } from "./lib/requests.ts";
import { cleanupHelperSessions, readCodexUsage, unexpectedWorkspaceEntries } from "./lib/sessions.ts";
import { STATE_EMOJI } from "./lib/status.ts";
import { MIGRATIONS, Store, type StatusRecord } from "./lib/store.ts";
import { describeUntil, isTimeZone, parseUntil } from "./lib/time.ts";
import { createTracker } from "./lib/tracker.ts";
import { COLLECTOR_CRON, createTriggers } from "./lib/triggers.ts";

export const DEFAULT_HELPER_WORKSPACE = join(homedir(), ".local", "share", "bb-thread-card", "helper");
export const DEFAULT_PROVIDER = "codex";
export const DEFAULT_MODEL = "gpt-6-luna";
export const DEFAULT_REASONING: ReasoningLevel = "max";
const REASONING_LEVELS: ReasoningLevel[] = ["none", "low", "medium", "high", "xhigh", "max"];
const STATUS_DISPLAYS: StatusDisplay[] = ["row", "title"];
const DAY_MS = 86_400_000;

const count = (min: number, max: number) => z.number().int().min(min).max(max);
const threadInput = z.object({ threadId: z.string().min(1) }).strict();
const stateEnum = z.enum(["running", "question", "waiting", "done", "unknown"]);
const sourceEnum = z.enum(["bb", "agent", "helper", "none"]);
const viewEnum = z.enum(["needs", "waiting", "stopped"]);
const executionEnum = z.enum(["active", "queued", "failed", "stoppedByOwner", "interrupted", "sendFailed"]);
const freshnessEnum = z.enum(["fresh", "checking", "unavailable"]);
/** A request as the owner saw it: an action on another version does nothing. */
const targetInput = z
  .object({ threadId: z.string().min(1), requestId: z.string().min(1).optional(), version: z.number().int().min(1).optional() })
  .strict();
const dispositionResult = z.object({
  ok: z.boolean(),
  /** gone: nothing to act on any more; changed: a newer request replaced it; past: the time has passed. */
  reason: z.enum(["gone", "changed", "past"]).nullable(),
  requestId: z.string().nullable(),
  version: z.number().nullable(),
});

const statusView = z.object({
  state: stateEnum,
  reason: z.string(),
  since: z.number(),
  source: z.enum(["bb", "agent", "helper", "none"]),
  view: viewEnum.nullable(),
  execution: executionEnum.nullable(),
  freshness: freshnessEnum,
});

const reportView = z.object({
  state: z.string(),
  done: z.string(),
  stoppedAt: z.string(),
  at: z.number(),
  by: z.enum(["agent", "helper"]),
});

const cardView = z.object({
  status: statusView.nullable(),
  topic: z.string().nullable(),
  report: reportView.nullable(),
  /** Why the plugin never handles this thread (child, hidden, plugin thread). */
  skipped: z.string().nullable(),
  policy: z.enum(["auto", "owner-words", "off"]),
  lockReason: z.string().nullable(),
  automatic: z.boolean(),
  running: z.boolean(),
  canRevert: z.boolean(),
  lastError: z.string().nullable(),
  /** The owner's snooze or hide on the thread's current request, if any. */
  disposition: z.object({ kind: z.enum(["snoozed", "dismissed"]), untilAt: z.number().nullable(), tz: z.string().nullable() }).nullable(),
});

const dependencyView = z.object({
  threadId: z.string(),
  title: z.string().nullable(),
  state: stateEnum.nullable(),
  available: z.boolean(),
  archived: z.boolean(),
});

const queueItem = z.object({
  threadId: z.string(),
  projectId: z.string(),
  topic: z.string().nullable(),
  state: stateEnum,
  reason: z.string(),
  since: z.number(),
  done: z.string().nullable(),
  dismissed: z.boolean(),
  view: viewEnum.nullable(),
  execution: executionEnum.nullable(),
  freshness: freshnessEnum,
  source: sourceEnum,
  ask: z.string().nullable(),
  count: z.number(),
  requestId: z.string().nullable(),
  version: z.number().nullable(),
  requestedAt: z.number().nullable(),
  attentionAt: z.number().nullable(),
  disposition: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("snoozed"), untilAt: z.number(), tz: z.string().nullable(), at: z.number() }),
      z.object({ kind: z.literal("dismissed"), at: z.number() }),
    ])
    .nullable(),
  sendAt: z.number().nullable(),
  waitingOn: z.array(dependencyView),
  activityAt: z.number().nullable(),
  checkedAt: z.number(),
  legacyDismissal: z.boolean(),
});

const rowView = z.object({
  state: stateEnum,
  reason: z.string(),
  source: sourceEnum,
  view: viewEnum.nullable(),
  execution: executionEnum.nullable(),
  freshness: freshnessEnum,
  disposition: z.enum(["snoozed", "dismissed"]).nullable(),
  activityAt: z.number().nullable(),
});

export const rpcContract = defineRpcContract({
  getCard: { input: threadInput, output: cardView },
  refresh: {
    input: threadInput,
    output: z.object({ status: z.string(), title: z.string().nullable(), reason: z.string().nullable() }),
  },
  lock: { input: threadInput, output: z.object({ ok: z.boolean() }) },
  unlock: { input: threadInput, output: z.object({ ok: z.boolean() }) },
  revert: { input: threadInput, output: z.object({ title: z.string().nullable() }) },
  /** Every tracked thread's status, for the sidebar row icons and the status order of the list. */
  rows: {
    input: z.object({}).strict(),
    output: z.object({ display: z.enum(["row", "title"]), rows: z.record(z.string(), rowView) }),
  },
  /**
   * The Needs-you page: every thread that asks the owner, waits on someone
   * else or stopped, newest request first, and those whose status is being
   * clarified. Filters are for callers without bb's live sidebar (the page
   * filters itself).
   */
  queue: {
    input: z.object({ projectId: z.string().min(1).optional(), sectionId: z.string().min(1).optional() }).strict(),
    output: z.object({ items: z.array(queueItem), now: z.number() }),
  },
  /** Snooze this version of the request until `untilAt` (chosen in time zone `tz`). */
  snooze: {
    input: targetInput.extend({ untilAt: z.number().int(), tz: z.string().min(1).max(64).nullable() }).strict(),
    output: dispositionResult,
  },
  /** Take this version of the request off the page until the thread asks something new. */
  dismiss: { input: targetInput, output: dispositionResult },
  /** Undo a snooze or a hide of this version of the request. */
  restore: { input: targetInput, output: dispositionResult },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Automatic titles and helper checks",
      description:
        "Write titles from the thread's topic, and let the helper read threads whose agent did not report (after X quiet minutes). Status tracking stays on when this is off; titles then change only from Recheck card or `bb thread-card refresh`.",
      default: false,
    },
    statusDisplay: {
      type: "select",
      label: "Where the status shows",
      description: "row: an icon on the thread's sidebar row, the title is the topic only. title: an emoji (❓ ⛔ ✅) in front of the title.",
      options: STATUS_DISPLAYS,
      default: "row",
    },
    idleMinutes: {
      type: "number",
      label: "Helper after X quiet minutes",
      description: "A turn the agent did not report on gets the helper once the thread has been quiet this long.",
      experimental_schema: count(1, 1440),
      default: 15,
    },
    minIntervalMinutes: {
      type: "number",
      label: "Helper at most once per Y minutes per thread",
      experimental_schema: count(0, 1440),
      default: 10,
    },
    skipSections: {
      type: "string",
      label: "Sections left alone",
      description:
        "Excludes whole sections: their threads get no status, no queue items and no title changes. Section names or ids, separated by commas. To only keep one thread's title, use Keep current title in its card.",
      default: "",
    },
    providerId: {
      type: "string",
      label: "Helper provider",
      description: "Agent provider for the helper thread that reads a thread its agent did not report on (`bb provider list`).",
      default: DEFAULT_PROVIDER,
    },
    model: {
      type: "string",
      label: "Helper model",
      description: "Model for the helper thread (`bb provider models <provider>`).",
      default: DEFAULT_MODEL,
    },
    reasoningLevel: {
      type: "select",
      label: "Helper reasoning",
      description: "Reasoning effort of the helper model. Higher reads the thread more carefully and costs more of the subscription limit.",
      options: REASONING_LEVELS,
      default: DEFAULT_REASONING,
    },
    workers: {
      type: "number",
      label: "Helpers at once",
      description: "How many helper threads may run in parallel. Each is a full agent session on this host.",
      experimental_schema: count(1, 6),
      default: 2,
    },
    cleanupSessions: {
      type: "boolean",
      label: "Delete helper session files",
      description:
        "Each helper is a Claude Code or Codex session whose transcript file holds a copy of another thread. Delete those files after each helper and at startup (only under the helper workspace's session directories).",
      default: true,
    },
    helperWorkspace: {
      type: "string",
      label: "Helper workspace",
      description:
        "Empty directory where every helper thread runs, so helpers never touch the owner's workspaces. Keep it excluded from memory capture.",
      experimental_schema: z.string().regex(/^\/\S/, "Use an absolute path"),
      default: DEFAULT_HELPER_WORKSPACE,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new Store(db);
  // Before any recompute: 0.4 dismissals are read against the statuses they were given on.
  const moved = store.migrateDismissals();
  if (moved.bound + moved.inactive + moved.unresolved > 0) {
    bb.log.info(
      `0.4 dismissals: ${moved.bound} bound to their turn, ${moved.inactive} no longer hid anything, ${moved.unresolved} kept without a request`,
    );
  }
  const home = homedir();
  registerReportTool(bb, (threadId) => store.getTopic(threadId)?.topic ?? null);

  const helperWorkspace = (value: string) => value.trim() || DEFAULT_HELPER_WORKSPACE;
  const displayOf = (value: string): StatusDisplay => (value === "title" ? "title" : "row");
  const engineSettings = async (): Promise<EngineSettings> => {
    const current = await settings.get();
    return {
      writeTitles: current.enabled,
      statusDisplay: displayOf(current.statusDisplay),
      providerId: current.providerId.trim() || DEFAULT_PROVIDER,
      model: current.model.trim() || DEFAULT_MODEL,
      reasoningLevel: REASONING_LEVELS.includes(current.reasoningLevel as ReasoningLevel)
        ? (current.reasoningLevel as ReasoningLevel)
        : DEFAULT_REASONING,
      helperWorkspace: helperWorkspace(current.helperWorkspace),
      workers: current.workers,
      skipSections: current.skipSections,
    };
  };

  /** Delete helper session files: the given sessions now, anything older than ten minutes. */
  const cleanSessions = async (sessionIds: string[]) => {
    const current = await settings.get();
    if (!current.cleanupSessions) return;
    const result = await cleanupHelperSessions({ home, helperWorkspace: helperWorkspace(current.helperWorkspace), sessionIds });
    if (result.claudeFiles + result.codexFiles + result.refused > 0) {
      bb.log.info(
        `helper session files deleted: ${result.claudeFiles} Claude, ${result.codexFiles} Codex${result.refused > 0 ? `; ${result.refused} left alone (outside the session roots or a symlink)` : ""}`,
      );
    }
  };

  const publish = (threadId: string) => bb.realtime.publish("card", { threadId });
  const warn = (what: string) => (error: unknown) => bb.log.warn(`${what} failed: ${String(error)}`);

  const engine = createEngine({
    sdk: bb.sdk,
    store,
    kv: bb.storage.kv,
    log: bb.log,
    pluginId: bb.pluginId,
    settings: engineSettings,
    providerUsage: async ({ providerId, sessionId }) =>
      providerId === "codex" ? readCodexUsage(home, sessionId) : null,
    afterHelper: async ({ sessionId }) => {
      // Helpers run with accept-edits (nothing stricter ends with a plain
      // answer), so check that none wrote into its workspace.
      const extra = await unexpectedWorkspaceEntries(helperWorkspace((await settings.get()).helperWorkspace));
      if (extra.length > 0) bb.log.warn(`helper workspace has unexpected entries: ${extra.slice(0, 10).join(", ")}`);
      await cleanSessions(sessionId ? [sessionId] : []);
    },
    onChange: publish,
  });

  /** Threads that wait on this one look again: their card shows its new state. */
  const touchDependents = (threadId: string) => {
    for (const dependent of store.dependentsOf(threadId)) {
      publish(dependent);
      void tracker.schedule(dependent);
    }
  };

  const tracker = createTracker({
    sdk: bb.sdk,
    store,
    log: bb.log,
    skip: (thread) => engine.skipped(thread),
    allThreads: () => engine.allRootThreads(),
    // A new status or topic: open cards and row icons reload, and the title follows.
    onChange: (threadId, what) => {
      publish(threadId);
      touchDependents(threadId);
      void engine.applyTitle(threadId, what.topic ? "topic" : "status").catch(warn(`title of ${threadId}`));
    },
  });

  const triggers = createTriggers({
    store,
    engine,
    kv: bb.storage.kv,
    log: bb.log,
    settings: async () => {
      const current = await settings.get();
      return {
        enabled: current.enabled,
        idleMinutes: current.idleMinutes,
        minIntervalMinutes: current.minIntervalMinutes,
        workers: current.workers,
      };
    },
    onAnswer: (threadId) => tracker.schedule(threadId),
  });

  // A title given at creation (spawn --title, a dispatcher, a person) keeps
  // its words. Recording it is passive: no model call, no title write.
  bb.events.on("thread.created", ({ thread }) => {
    if (thread.parentThreadId !== null || thread.visibility !== "visible") return;
    engine.recordCreated({ id: thread.id, title: thread.title ?? null });
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    store.deleteThread(thread.id);
    touchDependents(thread.id);
  });
  // Every event about a thread only schedules a recompute of its status.
  const track = (thread: Parameters<typeof skipReason>[0] & { id: string }) =>
    skipReason(thread) === null ? tracker.schedule(thread.id) : undefined;
  bb.events.on("thread.active", ({ thread }) => {
    // The thread is about to change: a helper reading it is wasted.
    triggers.onActive(thread);
    return track(thread);
  });
  // Child threads are not tracked, but a parent may wait on them.
  bb.events.on("thread.idle", ({ thread }) => {
    touchDependents(thread.id);
    return track(thread);
  });
  bb.events.on("thread.failed", ({ thread }) => {
    touchDependents(thread.id);
    return track(thread);
  });
  bb.events.on("thread.unarchived", ({ thread }) => track(thread));
  bb.events.on("thread.archived", ({ thread }) => {
    touchDependents(thread.id);
    tracker.forget(thread.id);
  });
  bb.events.on("interaction.pending", ({ thread }) => track(thread));
  bb.events.on("turn.failed", ({ threadId }) => tracker.schedule(threadId));
  bb.events.on("message.queued", ({ entry }) => tracker.schedule(entry.threadId));
  bb.events.on("message.dispatched", ({ entry }) => tracker.schedule(entry.threadId));
  bb.events.on("message.cancelled", ({ entry }) => tracker.schedule(entry.threadId));
  // New log events: a request to the owner answered, a turn started.
  bb.events.on("experimental_thread.events", ({ thread }) => {
    if (skipReason(thread) === null) tracker.nudge(thread.id);
  });
  bb.onDispose(() => tracker.dispose());

  /** Snoozed cards whose time has come go back on the page. */
  const expireSnoozes = () => {
    for (const disposition of store.takeExpiredSnoozes(Date.now())) publish(disposition.threadId);
  };
  expireSnoozes();

  bb.background.schedule("collector", COLLECTOR_CRON, async () => {
    expireSnoozes();
    await Promise.all([triggers.collect(), tracker.collect()]);
  });

  /** Bring every title the plugin wrote in line (old stage emoji off, status display changed). */
  const alignTitles = async (reason: string) => {
    if (!(await settings.get()).enabled) return;
    const ids = new Set([...store.titledThreads(), ...store.listStatuses().map((status) => status.threadId)]);
    let written = 0;
    for (const threadId of ids) {
      try {
        if ((await engine.applyTitle(threadId, reason)) !== null) written += 1;
      } catch (error) {
        if (!/404/.test(String(error))) warn(`title of ${threadId}`)(error);
      }
    }
    if (written > 0) bb.log.info(`titles aligned (${reason}): ${written} written`);
  };

  const applyEnabled = (enabled: boolean) => {
    if (enabled) void triggers.arm().catch(warn("enabling automatic updates"));
    else void triggers.disarm(true).catch(warn("disabling automatic updates"));
  };
  settings.onChange((next, prev) => {
    if (next.enabled !== prev.enabled) applyEnabled(next.enabled);
    if (next.statusDisplay !== prev.statusDisplay || (next.enabled && !prev.enabled)) {
      void alignTitles("display").catch(warn("aligning titles"));
      bb.realtime.publish("rows", {});
    }
  });
  if ((await settings.get()).enabled) applyEnabled(true);
  bb.onDispose(() => void triggers.disarm(false));

  // Helpers and session files a crash or restart left behind. Deferred so
  // load stays fast.
  const cleanupTimer = setTimeout(() => {
    void cleanupOrphanHelpers(bb.sdk, bb.pluginId)
      .then((removed) => {
        if (removed.length > 0) bb.log.info(`deleted ${removed.length} orphan helper threads`);
      })
      .catch(warn("orphan helper cleanup"))
      .then(() => cleanSessions([]))
      .catch(warn("helper session cleanup"));
  }, 10_000);
  bb.onDispose(() => clearTimeout(cleanupTimer));
  // Statuses of what happened while the plugin was not loaded, then the titles.
  const sweepTimer = setTimeout(() => {
    void tracker
      .sweep()
      .then((count) => bb.log.info(`status: looked at ${count} threads`))
      .catch(warn("status sweep"))
      .then(() => alignTitles("startup"))
      .catch(warn("aligning titles"));
  }, 5_000);
  bb.onDispose(() => clearTimeout(sweepTimer));

  /** The newest report on the thread: the agent's, or the helper's when it read later. */
  function latestReport(threadId: string): z.input<typeof reportView> | null {
    const agent = store.getFacts(threadId)?.lastReport ?? null;
    const helper = store.getHelper(threadId)?.report ?? null;
    if (agent !== null && (helper === null || agent.seq >= helper.basisSeq)) {
      return { state: agent.state, done: agent.done, stoppedAt: agent.stoppedAt, at: agent.at, by: "agent" };
    }
    return helper ? { state: helper.state, done: helper.done, stoppedAt: helper.stoppedAt, at: helper.at, by: "helper" } : null;
  }

  const statusOf = (status: StatusRecord | null) =>
    status
      ? {
          state: status.state,
          reason: status.reason,
          since: status.since,
          source: status.source,
          view: status.view,
          execution: status.execution,
          freshness: status.freshness,
        }
      : null;

  async function view(threadId: string): Promise<z.input<typeof cardView>> {
    const state = store.getState(threadId);
    const current = await settings.get();
    let skipped: string | null = null;
    try {
      skipped = await engine.skipped(await bb.sdk.threads.get({ threadId }));
    } catch {
      skipped = "thread not found";
    }
    return {
      status: statusOf(store.getStatus(threadId)),
      topic: store.getTopic(threadId)?.topic ?? null,
      report: latestReport(threadId),
      skipped,
      policy: engine.policyView(threadId),
      lockReason: state.lockReason,
      automatic: current.enabled,
      running: triggers.isRunning(threadId) || engine.inFlight(threadId),
      canRevert: store.titleHistory(threadId).some((record) => record.reason !== "unlock"),
      lastError: state.lastError,
      disposition: (() => {
        expireSnoozes();
        const status = store.getStatus(threadId);
        const request = store.getRequest(threadId);
        const held = request !== null && request.view === status?.view ? activeDisposition(request, store.getDisposition(threadId), Date.now()) : null;
        return held ? { kind: held.kind, untilAt: held.untilAt, tz: held.tz } : null;
      })(),
    };
  }

  /** Threads another thread waits on, as its card names them; bb is asked at most once a minute per thread. */
  const threadInfo = new Map<string, { at: number; title: string | null; archived: boolean; available: boolean; sectionId: string | null }>();
  async function infoOf(threadId: string) {
    const cached = threadInfo.get(threadId);
    if (cached && Date.now() - cached.at < 60_000) return cached;
    let info: { at: number; title: string | null; archived: boolean; available: boolean; sectionId: string | null };
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      info = {
        at: Date.now(),
        title: thread.title ?? thread.titleFallback ?? null,
        archived: thread.archivedAt !== null,
        available: thread.deletedAt === null,
        sectionId: thread.sectionId ?? null,
      };
    } catch {
      info = { at: Date.now(), title: null, archived: false, available: false, sectionId: null };
    }
    threadInfo.set(threadId, info);
    return info;
  }
  async function dependency(threadId: string): Promise<Dependency> {
    const info = await infoOf(threadId);
    return {
      threadId,
      title: store.getTopic(threadId)?.topic ?? info.title,
      state: store.getStatus(threadId)?.state ?? null,
      available: info.available,
      archived: info.archived,
    };
  }

  /**
   * The page's cards: threads on it (a request, a wait, a stop) and those
   * whose status is being clarified, newest request first.
   */
  async function queueCards(filter: { projectId?: string | undefined; sectionId?: string | undefined } = {}): Promise<QueueCard[]> {
    expireSnoozes();
    const now = Date.now();
    const requests = new Map(store.listRequests().map((request) => [request.threadId, request]));
    const dispositions = new Map(store.listDispositions().map((disposition) => [disposition.threadId, disposition]));
    const legacy = new Set(store.unresolvedDismissals().map((row) => row.threadId));
    const statuses = store
      .listStatuses()
      .filter((status) => status.view !== null || status.freshness === "checking")
      .filter((status) => filter.projectId === undefined || status.projectId === filter.projectId);
    const cards = await Promise.all(
      statuses.map(async (status) =>
        toCard({
          status,
          request: requests.get(status.threadId) ?? null,
          disposition: dispositions.get(status.threadId) ?? null,
          topic: store.getTopic(status.threadId)?.topic ?? null,
          done: latestReport(status.threadId)?.done ?? null,
          waitingOn: await Promise.all(status.waitingOn.map(dependency)),
          legacyDismissal: legacy.has(status.threadId),
          now,
        }),
      ),
    );
    let chosen = cards;
    if (filter.sectionId !== undefined) {
      const wanted = filter.sectionId.trim().toLowerCase();
      const sections = await bb.sdk.threadSections.list();
      const section = sections.find((item) => item.id.toLowerCase() === wanted || item.name.toLowerCase() === wanted);
      const id = section?.id ?? filter.sectionId;
      const inSection = await Promise.all(cards.map(async (card) => (await infoOf(card.threadId)).sectionId === id));
      chosen = cards.filter((_, index) => inSection[index]);
    }
    return chosen.sort(compareCards("new"));
  }

  /** Snooze, hide or bring back one version of a thread's request: the page and the CLI both call this. */
  function dispose(
    target: { threadId: string; requestId?: string | undefined; version?: number | undefined },
    change: { kind: DispositionKind; untilAt?: number; tz?: string | null } | { kind: "restore" },
  ): z.infer<typeof dispositionResult> {
    expireSnoozes();
    const now = Date.now();
    const check = checkTarget(store.getRequest(target.threadId), target);
    if (!check.ok) {
      return { ok: false, reason: check.reason, requestId: check.request?.requestId ?? null, version: check.request?.version ?? null };
    }
    const { request } = check;
    const answer = { ok: true, reason: null, requestId: request.requestId, version: request.version };
    if (change.kind === "restore") {
      if (store.clearDisposition(target.threadId, request.requestId, request.version)) publish(target.threadId);
      return answer;
    }
    if (change.kind === "snoozed" && (change.untilAt === undefined || change.untilAt <= now)) {
      return { ...answer, ok: false, reason: "past" };
    }
    const current = activeDisposition(request, store.getDisposition(target.threadId), now);
    const untilAt = change.kind === "snoozed" ? (change.untilAt ?? null) : null;
    const tz = change.kind === "snoozed" ? (change.tz ?? null) : null;
    // The same action twice is one action.
    if (current?.kind === change.kind && current.untilAt === untilAt && current.tz === tz) return answer;
    store.setDisposition({ threadId: target.threadId, requestId: request.requestId, version: request.version, kind: change.kind, untilAt, tz, at: now });
    store.endUnresolvedDismissal(target.threadId);
    publish(target.threadId);
    return answer;
  }

  /** Read the thread with the helper now, then recompute the status and bring the title in line. */
  async function refreshNow(threadId: string, options: { dryRun: boolean; signal?: AbortSignal; trigger: string }): Promise<DescribeResult & { title: string | null }> {
    await tracker.schedule(threadId);
    const result = await engine.describe(threadId, options);
    if (options.dryRun) return { ...result, title: null };
    await tracker.schedule(threadId);
    const title = await engine.applyTitle(threadId, options.trigger, true);
    return { ...result, title };
  }

  const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
  bb.rpc.register(rpcContract, {
    getCard: ({ threadId }) => view(threadId),
    // The owner asked explicitly: read the thread again.
    refresh: async ({ threadId }) => {
      const result = await refreshNow(threadId, { dryRun: false, trigger: "manual" });
      return {
        status: result.status,
        title: result.title ?? store.getTopic(threadId)?.topic ?? null,
        reason: result.reason,
      };
    },
    lock: async ({ threadId }) => {
      await engine.lock(threadId);
      return { ok: true };
    },
    unlock: async ({ threadId }) => {
      await engine.unlock(threadId);
      return { ok: true };
    },
    revert: async ({ threadId }) => {
      try {
        return { title: (await engine.revert(threadId)).title };
      } catch (error) {
        throw new Error(errorMessage(error));
      }
    },
    rows: async () => {
      expireSnoozes();
      const now = Date.now();
      const requests = new Map(store.listRequests().map((request) => [request.threadId, request]));
      const dispositions = new Map(store.listDispositions().map((disposition) => [disposition.threadId, disposition]));
      const rows: Record<string, z.input<typeof rowView>> = {};
      for (const status of store.listStatuses()) {
        const request = requests.get(status.threadId) ?? null;
        const held = request?.view === status.view ? activeDisposition(request, dispositions.get(status.threadId) ?? null, now) : null;
        rows[status.threadId] = {
          state: status.state,
          reason: status.reason,
          source: status.source,
          view: status.view,
          execution: status.execution,
          freshness: status.freshness,
          disposition: held?.kind ?? null,
          activityAt: status.activityAt,
        };
      }
      return { display: displayOf((await settings.get()).statusDisplay), rows };
    },
    queue: async (input) => ({ items: await queueCards(input), now: Date.now() }),
    snooze: async ({ untilAt, tz, ...target }) => dispose(target, { kind: "snoozed", untilAt, tz }),
    dismiss: async (target) => dispose(target, { kind: "dismissed" }),
    restore: async (target) => dispose(target, { kind: "restore" }),
  });

  const targetOf = (input: { positionals: { thread: string }; options: { request?: string | undefined; version?: number | undefined } }) => ({
    threadId: input.positionals.thread,
    requestId: input.options.request,
    version: input.options.version,
  });

  const threadArg = (id: string | undefined, ctxThreadId: string | undefined, command: string) => {
    if (id) return id;
    throw new PluginCliError("a thread id is required", {
      code: "missing_thread",
      hint: ctxThreadId
        ? `For this thread: bb thread-card ${command} ${ctxThreadId}`
        : `bb thread-card ${command} <thread-id>`,
    });
  };

  bb.cli.register(
    defineCli({
      name: "thread-card",
      summary: "Thread status (who makes the next step), topic and what is done, and the titles built from them",
      commands: {
        show: cliCommand({
          summary: "Show a thread's card: status, topic, last report, title policy and the titles written",
          positionals: [{ name: "thread", description: "Thread id; defaults to the current thread" }],
          options: { json: { type: "boolean", description: "Print JSON" } },
          run: async (input, ctx) => {
            const id = input.positionals.thread ?? ctx.threadId ?? threadArg(undefined, undefined, "show");
            const card = await view(id);
            const history = store.titleHistory(id);
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify({ threadId: id, ...card, state: store.getState(id), titleHistory: history }) };
            }
            const status = store.getStatus(id);
            return {
              exitCode: 0,
              stdout: [
                status ? formatStatus(status) : "(no status yet)",
                `  Topic: ${card.topic ?? "(none)"}`,
                ...(card.report
                  ? [
                      `  Progress: ${card.report.done}`,
                      `  Next step / blocker: ${card.report.stoppedAt}`,
                      `  Report: ${card.report.by}, ${card.report.state}, ${new Date(card.report.at).toISOString()}`,
                    ]
                  : []),
                `  Title policy: ${card.policy}${card.lockReason ? ` (${card.lockReason})` : ""}`,
                ...(card.skipped ? [`  left alone: ${card.skipped}`] : []),
                ...(history.length > 0
                  ? ["  Title history:", ...history.map((record) => `    ${new Date(record.at).toISOString()} ${record.reason}: ${record.title}`)]
                  : []),
              ].join("\n"),
            };
          },
        }),
        status: cliCommand({
          summary: "Show a thread's status (who makes the next step, and why) and the last report",
          positionals: [{ name: "thread", description: "Thread id; defaults to the current thread" }],
          options: {
            refresh: { type: "boolean", description: "Read the thread log and recompute first" },
            json: { type: "boolean", description: "Print JSON" },
          },
          run: async (input, ctx) => {
            const id = input.positionals.thread ?? ctx.threadId ?? threadArg(undefined, undefined, "status");
            if (input.options.refresh) await tracker.schedule(id);
            const status = store.getStatus(id);
            const facts = store.getFacts(id);
            const topic = store.getTopic(id);
            const report = facts?.lastReport ?? null;
            const helper = store.getHelper(id);
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ threadId: id, status, topic, report, helper, lastTurn: facts?.turns.at(-1) ?? null }),
              };
            }
            if (!status) return { exitCode: 1, stderr: `No status for ${id} yet. Compute it: bb thread-card status ${id} --refresh` };
            const latest = latestReport(id);
            return {
              exitCode: 0,
              stdout: [
                formatStatus(status),
                `  Topic: ${topic ? `${topic.topic} (${topic.setBy})` : "(none)"}`,
                ...(latest
                  ? [
                      `  Progress: ${latest.done}`,
                      `  Next step / blocker: ${latest.stoppedAt}`,
                      `  Report: ${latest.by}, ${latest.state}, ${new Date(latest.at).toISOString()}`,
                    ]
                  : ["  no reports yet"]),
                ...(helper?.error ? [`  helper: ${helper.tries} tries on ${helper.tryTurnId}, error: ${helper.error}`] : []),
                `  turns the agent reported: ${status.reported} of ${status.turns}`,
              ].join("\n"),
            };
          },
        }),
        queue: cliCommand({
          summary: "The Needs-you page: requests to you, waits on others and stopped work, newest request first",
          description:
            "One card per thread, grouped by view: needs (asks you), waiting (waits on someone or a scheduled send), stopped (an error, a stop, a status nobody could read), snoozed (until their time). Cards taken off the page show with --all. --json prints the cards with their request id and version, which snooze/dismiss/restore accept.",
          options: {
            view: { type: "enum", values: [...PAGE_VIEWS, "all"], default: "all", description: "One view, or all of them" },
            project: { type: "string", description: "Only this project id" },
            section: { type: "string", description: "Only this section (id or name)" },
            sort: { type: "enum", values: ["new", "old"], default: "new", description: "new: newest request first; old: longest waiting first" },
            all: { type: "boolean", description: "Include cards taken off the page (dismiss)" },
            json: { type: "boolean", description: "Print JSON" },
          },
          run: async (input) => {
            const sort = input.options.sort as QueueSort;
            const inPlace = await queueCards({ projectId: input.options.project, sectionId: input.options.section });
            const checking = inPlace.filter((card) => card.view === null).length;
            const cards = inPlace
              .filter((card) => card.view !== null)
              .filter((card) => input.options.all || card.disposition?.kind !== "dismissed")
              .filter((card) => input.options.view === "all" || pageViewOf(card) === input.options.view)
              .sort(compareCards(sort));
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(cards) };
            const lines: string[] = [];
            if (cards.length === 0) lines.push(input.options.view === "all" ? "The queue is empty." : `Nothing in ${VIEW_TITLES[input.options.view as PageView] ?? input.options.view}.`);
            for (const view of PAGE_VIEWS) {
              const inView = cards.filter((card) => pageViewOf(card) === view);
              if (inView.length === 0) continue;
              lines.push(`${VIEW_TITLES[view]} · ${inView.length}`);
              for (const card of inView) lines.push(...formatCard(card, sort));
            }
            if (checking > 0) lines.push(`(status still being checked for ${checking} more)`);
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        snooze: cliCommand({
          summary: "Snooze a thread's current request on the Needs-you page until a time; a new request brings it back at once",
          positionals: [{ name: "thread", description: "Thread id", required: true }],
          options: {
            for: { type: "duration", defaultUnit: "h", min: 60_000, max: 366 * DAY_MS, description: "How long: 1h, 90m, 2d" },
            until: {
              type: "string",
              description: "When it comes back: 09:00, tomorrow, 2026-09-29T09:00 (read in --tz) or an ISO time with an offset",
            },
            tz: { type: "string", description: "IANA time zone for --until (default: the server's)" },
            request: { type: "string", description: "Act only if this is still the request id (queue --json)" },
            version: { type: "integer", min: 1, max: 1_000_000, description: "Act only if this is still the request version" },
            json: { type: "boolean", description: "Print JSON" },
          },
          constraints: [{ kind: "exactly-one", options: ["for", "until"] }],
          run: async (input) => {
            const now = Date.now();
            const tz = input.options.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
            if (!isTimeZone(tz)) throw new PluginCliError(`unknown time zone "${tz}"`, { code: "invalid_tz", hint: "--tz Europe/Moscow" });
            const untilAt = input.options.until !== undefined ? parseUntil(input.options.until, now, tz) : now + (input.options.for ?? 0);
            if (untilAt === null) {
              throw new PluginCliError(`cannot read the time "${input.options.until}"`, {
                code: "invalid_until",
                hint: "--until 09:00, --until tomorrow, --until 2026-09-29T09:00 or --for 2h",
              });
            }
            const result = dispose(targetOf(input), { kind: "snoozed", untilAt, tz });
            return dispositionOutput(result, input.options.json, `Snoozed until ${describeUntil(untilAt, tz)}`);
          },
        }),
        dismiss: cliCommand({
          summary: "Take a thread's current request off the Needs-you page until it asks something new (the agent gets no answer)",
          positionals: [{ name: "thread", description: "Thread id", required: true }],
          options: {
            request: { type: "string", description: "Act only if this is still the request id (queue --json)" },
            version: { type: "integer", min: 1, max: 1_000_000, description: "Act only if this is still the request version" },
            json: { type: "boolean", description: "Print JSON" },
          },
          run: async (input) =>
            dispositionOutput(dispose(targetOf(input), { kind: "dismissed" }), input.options.json, "Hidden until the thread asks again"),
        }),
        restore: cliCommand({
          summary: "Bring a snoozed or hidden request back onto the Needs-you page",
          positionals: [{ name: "thread", description: "Thread id", required: true }],
          options: {
            request: { type: "string", description: "Act only if this is still the request id (queue --json)" },
            version: { type: "integer", min: 1, max: 1_000_000, description: "Act only if this is still the request version" },
            json: { type: "boolean", description: "Print JSON" },
          },
          run: async (input) => dispositionOutput(dispose(targetOf(input), { kind: "restore" }), input.options.json, "Back in the queue"),
        }),
        stats: cliCommand({
          summary: "Status tracking at a glance: states, turns with an agent report by provider, helper runs",
          options: { json: { type: "boolean", description: "Print JSON" } },
          run: async (input) => {
            const statuses = store.listStatuses();
            const states: Record<string, number> = {};
            const sources: Record<string, number> = {};
            const providers: Record<string, { threads: number; turns: number; reported: number }> = {};
            for (const status of statuses) {
              states[status.state] = (states[status.state] ?? 0) + 1;
              sources[status.source] = (sources[status.source] ?? 0) + 1;
              const provider = (providers[status.providerId] ??= { threads: 0, turns: 0, reported: 0 });
              provider.threads += 1;
              provider.turns += status.turns;
              provider.reported += status.reported;
            }
            const needHelper = statuses.filter((status) => status.needHelper).length;
            const views: Record<string, number> = {};
            for (const status of statuses) if (status.view !== null) views[status.view] = (views[status.view] ?? 0) + 1;
            // Threads whose agent has the tool: at least one of its turns ended with a report.
            const reporting = statuses.filter((status) => status.reported > 0).length;
            const helper = store.runsSince(Date.now() - DAY_MS);
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ threads: statuses.length, states, views, sources, providers, needHelper, reporting, helper24h: helper }),
              };
            }
            const share = (part: number, whole: number) => (whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`);
            return {
              exitCode: 0,
              stdout: [
                `threads: ${statuses.length}; ${Object.entries(states)
                  .map(([state, n]) => `${STATE_EMOJI[state as StatusRecord["state"]] || "·"} ${state} ${n}`)
                  .join(", ")}`,
                `on the Needs-you page: ${Object.entries(views)
                  .map(([view, n]) => `${view} ${n}`)
                  .join(", ") || "nothing"}`,
                `decided by: ${Object.entries(sources)
                  .map(([source, n]) => `${source} ${n}`)
                  .join(", ")}`,
                `waiting for the helper: ${needHelper}`,
                `threads whose agent has reported at least once: ${reporting}`,
                `helper runs in 24 h: ${helper.runs} (${helper.failed} failed), ${kTokens(helper.inputTokens)} in / ${kTokens(helper.outputTokens)} out`,
                "turns with an agent report:",
                ...Object.entries(providers).map(
                  ([id, p]) => `  ${id}: ${p.reported} of ${p.turns} (${share(p.reported, p.turns)}) in ${p.threads} threads`,
                ),
              ].join("\n"),
            };
          },
        }),
        list: cliCommand({
          summary: "List a project's threads with topic, status and last report (input for project briefs)",
          options: {
            project: { type: "string", required: true, description: "Project id (bb project list --include-personal)" },
            json: { type: "boolean", description: "Print JSON" },
          },
          run: async (input) => {
            const threads = await engine.threadsWithActivity(input.options.project, Number.POSITIVE_INFINITY);
            const rows = threads.map((thread) => {
              const status = store.getStatus(thread.id);
              const report = latestReport(thread.id);
              return {
                threadId: thread.id,
                title: thread.title ?? null,
                topic: store.getTopic(thread.id)?.topic ?? null,
                state: status?.state ?? null,
                reason: status?.reason ?? null,
                since: status?.since ?? null,
                done: report?.done ?? null,
                stoppedAt: report?.stoppedAt ?? null,
                policy: engine.policyView(thread.id),
                view: status?.view ?? null,
                execution: status?.execution ?? null,
                freshness: status?.freshness ?? null,
                ask: status?.ask ?? null,
                activityAt: status?.activityAt ?? null,
              };
            });
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(rows) };
            if (rows.length === 0) return { exitCode: 0, stdout: "No threads in this project." };
            return {
              exitCode: 0,
              stdout: rows
                .map(
                  (row) =>
                    `${row.state ? STATE_EMOJI[row.state] || "·" : "·"} ${row.threadId}  ${row.topic ?? row.title ?? "(untitled)"}${row.done ? `\n    ${row.done}` : ""}`,
                )
                .join("\n"),
            };
          },
        }),
        refresh: cliCommand({
          summary: "Read one thread, or a project's recently active threads, with the helper now",
          description:
            "The helper reads the thread after its last report and answers with status, topic (only when there is none), done and stopped-at; the title follows. With --dry-run nothing is stored or written: it prints the helper's answer.",
          positionals: [{ name: "thread", description: "Thread id (or use --project)" }],
          options: {
            project: { type: "string", description: "Every visible root thread of this project" },
            since: {
              type: "duration",
              defaultUnit: "d",
              default: 14 * DAY_MS,
              description: "With --project: only threads with activity in this window (default 14d)",
            },
            "dry-run": { type: "boolean", description: "Print the helper's answer; store nothing, write no title" },
            json: { type: "boolean", description: "Print JSON" },
          },
          run: async (input, ctx) => {
            const dryRun = input.options["dry-run"];
            const threadId = input.positionals.thread;
            const projectId = input.options.project;
            if ((threadId === undefined) === (projectId === undefined)) {
              throw new PluginCliError("give either a thread id or --project, not both", {
                code: "invalid_target",
                hint: ctx.threadId
                  ? `bb thread-card refresh ${ctx.threadId} --dry-run`
                  : "bb thread-card refresh <thread-id> --dry-run",
              });
            }
            const options = { dryRun, trigger: "cli", ...(ctx.signal ? { signal: ctx.signal } : {}) };
            if (threadId !== undefined) {
              const result = await refreshNow(threadId, options);
              return {
                exitCode: result.status === "failed" ? 1 : 0,
                stdout: input.options.json ? JSON.stringify(result) : formatResult(result),
              };
            }
            const threads = await engine.threadsWithActivity(projectId as string, input.options.since);
            const results = await pool(threads, (await engineSettings()).workers, (thread) =>
              refreshNow(thread.id, options).catch((error: unknown) => ({
                ...failed(thread.id),
                reason: error instanceof Error ? error.message : String(error),
              })),
            );
            return {
              exitCode: 0,
              stdout: input.options.json ? JSON.stringify(results) : results.map(formatResult).join("\n\n"),
            };
          },
        }),
        lock: cliCommand({
          summary: "Stop touching this thread's title (the status keeps updating)",
          positionals: [{ name: "thread", description: "Thread id" }],
          run: async (input, ctx) => {
            const id = threadArg(input.positionals.thread, ctx.threadId, "lock");
            await engine.lock(id);
            return { exitCode: 0, stdout: `Locked ${id}: its title will not be changed.` };
          },
        }),
        unlock: cliCommand({
          summary: "Let the plugin write this thread's title (its topic) again",
          positionals: [{ name: "thread", description: "Thread id" }],
          run: async (input, ctx) => {
            const id = threadArg(input.positionals.thread, ctx.threadId, "unlock");
            await engine.unlock(id);
            return { exitCode: 0, stdout: `Unlocked ${id}.` };
          },
        }),
        revert: cliCommand({
          summary: "Restore the title the thread had before the plugin first renamed it; its words stay",
          positionals: [{ name: "thread", description: "Thread id" }],
          run: async (input, ctx) => {
            const id = threadArg(input.positionals.thread, ctx.threadId, "revert");
            try {
              const result = await engine.revert(id);
              return { exitCode: 0, stdout: `Reverted ${id}: ${result.from ?? "(none)"} → ${result.title ?? "(no title)"}` };
            } catch (error) {
              throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "nothing_to_revert" });
            }
          },
        }),
      },
    }),
  );

  bb.log.info("loaded");
}

function failed(threadId: string): DescribeResult & { title: string | null } {
  return {
    threadId,
    status: "failed",
    reason: null,
    providerId: null,
    turnId: null,
    answer: null,
    mode: null,
    model: null,
    wallMs: null,
    queueMs: null,
    usage: null,
    rateLimits: null,
    promptChars: null,
    transcriptOmitted: null,
    helperCwd: null,
    title: null,
  };
}

async function pool<T, R>(items: readonly T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

const REPORT_EMOJI: Record<ReportState, string> = { done: "✅", question: "❓", waiting: "⛔", continuing: "⏳" };

const EXECUTION_NOTES: Record<string, string> = {
  stoppedByOwner: "stopped by you",
  sendFailed: "message not sent",
};

function formatCard(card: QueueCard, sort: QueueSort): string[] {
  const at = sort === "new" ? (card.attentionAt ?? card.since) : (card.requestedAt ?? card.since);
  const marks = [
    card.count > 1 ? `${card.count} questions` : null,
    card.disposition?.kind === "snoozed" ? `until ${describeUntil(card.disposition.untilAt, card.disposition.tz)}` : null,
    card.disposition?.kind === "dismissed" ? "hidden" : null,
    card.execution ? (EXECUTION_NOTES[card.execution] ?? null) : null,
    card.freshness === "checking" ? "status updating" : null,
  ].filter((mark): mark is string => mark !== null);
  const lines = [
    `  ${STATE_EMOJI[card.state] || "·"} ${card.threadId}  ${card.topic ?? "(no topic)"}${marks.length > 0 ? `  [${marks.join(", ")}]` : ""}`,
    `      ${card.ask ?? card.reason} · ${new Date(at).toISOString()}${card.version !== null ? ` · v${card.version}` : ""}`,
  ];
  for (const dependency of card.waitingOn) {
    lines.push(`      waiting on: ${dependency.title ?? dependency.threadId} (${dependency.available ? (dependency.state ?? "no status") : "thread unavailable"})`);
  }
  return lines;
}

function dispositionOutput(
  result: { ok: boolean; reason: "gone" | "changed" | "past" | null; requestId: string | null; version: number | null },
  json: boolean,
  done: string,
) {
  if (json) return { exitCode: result.ok ? 0 : 1, stdout: JSON.stringify(result) };
  if (result.ok) return { exitCode: 0, stdout: `${done} (${result.requestId} v${result.version})` };
  const why =
    result.reason === "changed"
      ? `the request has changed: it is now ${result.requestId} v${result.version}`
      : result.reason === "past"
        ? "that time has already passed"
        : "the thread has no request on the Needs-you page now";
  return { exitCode: 1, stderr: `Nothing done: ${why}.` };
}
const kTokens = (value: number) => `${(value / 1000).toFixed(1)}k`;
const windowName = (minutes: number | null) =>
  minutes === 10_080 ? "week" : minutes === 300 ? "5 h" : minutes === null ? "window" : `${minutes} min`;

function formatStatus(status: StatusRecord): string {
  const mark = STATE_EMOJI[status.state] || "·";
  return `${mark} ${status.state}: ${status.reason} (since ${new Date(status.since).toISOString()}, ${status.source})`;
}

function formatResult(result: DescribeResult & { title: string | null }): string {
  const facts = [
    result.providerId,
    result.mode,
    result.model,
    result.wallMs !== null ? `${(result.wallMs / 1000).toFixed(1)} s` : null,
    result.usage
      ? `${kTokens(result.usage.promptTokens)} in (${kTokens(result.usage.cachedInputTokens)} cached) / ${kTokens(result.usage.outputTokens)} out${result.usage.reasoningTokens !== null ? ` (${kTokens(result.usage.reasoningTokens)} reasoning)` : ""}`
      : null,
    result.rateLimits?.primary ? `limit ${result.rateLimits.primary.usedPercent}% of ${windowName(result.rateLimits.primary.windowMinutes)}` : null,
  ].filter((fact): fact is string => fact !== null);
  const lines = [`${result.threadId} [${result.status}] ${facts.join(" · ")}`];
  if (result.reason) lines.push(`  ${result.reason}`);
  if (result.answer) {
    lines.push(`  ${REPORT_EMOJI[result.answer.state]} ${result.answer.about}`);
    lines.push(`  Progress: ${result.answer.done}`);
    lines.push(`  Next step / blocker: ${result.answer.stoppedAt}`);
  }
  if (result.title) lines.push(`  Title: ${result.title}`);
  return lines.join("\n");
}
