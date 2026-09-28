// A small fake bb for the plugin tests: threads made of events (owner
// messages, agent turns with tool calls and file changes, provisioning), and
// a helper model whose answers the test scripts. Built on the SDK's official
// fake plugin host, so settings, storage, CLI parsing, RPC, schedules and
// thread events behave like the real server.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { REPORT_TOOL, type ReportArgs } from "../lib/report.ts";
import plugin, { DEFAULT_HELPER_WORKSPACE } from "../server.ts";

// Session cleanup and usage reading look under the home directory: point it
// at an empty one so tests never read or delete the owner's session files.
process.env.HOME = mkdtempSync(join(tmpdir(), "thread-card-home-"));

export const PLUGIN_ID = "thread-card";
export const PROJECT_ID = "proj_personal";

type ThreadResponse = ReturnType<typeof makeThreadResponse>;

export interface FakeEvent {
  seq: number;
  type: string;
  createdAt: number;
  scope: { kind: "turn"; turnId: string } | { kind: "thread" };
  data: Record<string, unknown>;
}

export interface FakeThread {
  thread: ThreadResponse;
  events: FakeEvent[];
  maxSeq: number;
  /** The turn running now, as bb scopes its events; null between turns. */
  turn: string | null;
  turns: number;
}

export interface Answer {
  state?: string;
  about?: string;
  done?: string;
  stoppedAt?: string;
}

/** The helper's reply: one JSON object with the four fields the report tool takes. */
export const answer = (overrides: Answer = {}) =>
  JSON.stringify({
    state: "done",
    about: "Перевести Hermes на Codex",
    done: "Hermes ходит в модели через Codex app-server",
    stoppedAt: "PR #12",
    ...overrides,
  });

const push = (item: FakeThread, type: string, data: Record<string, unknown>, scoped = true): number => {
  item.maxSeq += 1;
  const scope = scoped && item.turn !== null ? { kind: "turn" as const, turnId: item.turn } : { kind: "thread" as const };
  item.events.push({ seq: item.maxSeq, type, createdAt: Date.now(), scope, data });
  return item.maxSeq;
};

function startTurn(item: FakeThread): void {
  if (item.turn !== null) return;
  item.turns += 1;
  item.turn = `${item.thread.id}-t${item.turns}`;
  push(item, "turn/started", {});
}

/**
 * A message: it starts a turn, or while one runs it is steered into it.
 * `initiator` other than user is a service message.
 */
export function say(item: FakeThread, text: string, initiator: "user" | "agent" | "system" = "user"): void {
  const requestId = `creq_${item.maxSeq + 1}`;
  push(item, "client/turn/requested", { requestId, initiator, input: [{ type: "text", text, mentions: [] }] }, false);
  startTurn(item);
  push(item, "turn/input/accepted", { clientRequestId: requestId });
}

/** The agent's status report: its tool call as the thread log records it. */
export function report(item: FakeThread, args: Partial<ReportArgs> = {}): void {
  startTurn(item);
  push(item, "item/started", {
    item: {
      type: "toolCall",
      id: `${item.turn}-i${item.maxSeq + 1}`,
      server: "bb",
      tool: REPORT_TOOL,
      arguments: { state: "done", about: "Настроить Codex для Hermes", done: "Hermes ходит через Codex", stoppedAt: "Всё сделано", ...args },
    },
  });
}

/** A request to the owner inside the running turn: `pending`, then `resolved` once answered. */
export function interaction(item: FakeThread, id: string, status: "pending" | "resolving" | "resolved"): void {
  push(item, "system/interaction/lifecycle", {
    interaction: { id, status, payload: { kind: "user_question", questions: [{ prompt: "Какую строку записать?" }] } },
  });
}

/** bb stops the running turn (`manual-stop` is the owner's Stop); the turn then ends as interrupted. */
export function interrupt(item: FakeThread, reason: string): void {
  push(item, "system/thread/interrupted", { reason }, false);
  reply(item, null, { status: "interrupted" });
}

/** The provider's error inside the running turn (the turn then ends with status failed). */
export function providerError(item: FakeThread, detail: string): void {
  push(item, "provider/error", { message: "Provider error", detail, errorInfo: { category: "rate-limit" } });
}

/** An agent turn: tool calls, file changes, the final message and the turn end. */
export function reply(
  item: FakeThread,
  text: string | null,
  options: { tools?: number; files?: string[]; status?: string } = {},
): void {
  startTurn(item);
  for (let i = 0; i < (options.tools ?? 0); i++) {
    push(item, "item/started", { item: { type: "commandExecution", id: `cmd${item.maxSeq}`, command: "ls" } });
  }
  for (const path of options.files ?? []) {
    push(item, "item/started", { item: { type: "fileChange", changes: [{ path, kind: "update", diff: "+x" }] } });
  }
  if (text !== null) push(item, "item/completed", { item: { type: "agentMessage", text } });
  push(item, "turn/completed", { status: options.status ?? "completed" });
  item.turn = null;
}

/** Owner message plus the agent's answer. */
export function exchange(item: FakeThread, text: string, answerText = `Ответ на «${text}»`): void {
  say(item, text);
  reply(item, answerText);
}

/** bb's provisioning record; `titleGenerated` marks a title bb generated. */
export function provision(item: FakeThread, titleGenerated: boolean): void {
  push(item, "system/thread-provisioning", { entries: [{ metadata: { titleGenerated } }] }, false);
}

/**
 * A visible root thread with `userCount` owner messages, each answered. Its
 * title counts as generated by bb unless `titleGenerated` is false.
 */
export function thread(
  id: string,
  overrides: Partial<ThreadResponse> = {},
  userCount = 2,
  titleGenerated = true,
): FakeThread {
  const item: FakeThread = {
    thread: makeThreadResponse({
      id,
      projectId: PROJECT_ID,
      environmentId: `env_${id}`,
      providerId: "claude-code",
      title: "Настроить Codex для Hermes",
      visibility: "visible",
      status: "idle",
      createdAt: 1_000,
      ...overrides,
    }),
    events: [],
    maxSeq: 0,
    turn: null,
    turns: 0,
  };
  provision(item, titleGenerated);
  for (let i = 0; i < userCount; i++) exchange(item, `Сообщение ${i + 1} про Codex app-server в Hermes`);
  return item;
}

/** Add owner messages (each answered) after the thread's current end. */
export function grow(item: FakeThread, count: number, text = "Продолжаем про Codex app-server"): void {
  for (let i = 0; i < count; i++) exchange(item, `${text} ${i + 1}`);
}

function listEvents(events: readonly FakeEvent[], args: Record<string, unknown>): FakeEvent[] {
  const types = args.types as readonly string[] | undefined;
  const after = args.afterSeq !== undefined ? Number(args.afterSeq) : null;
  const before = args.beforeSeq !== undefined ? Number(args.beforeSeq) : null;
  const limit = Math.min(Number(args.limit ?? 100), 100);
  let list = events.filter(
    (event) =>
      (!types || types.includes(event.type)) &&
      (after === null || event.seq > after) &&
      (before === null || event.seq < before),
  );
  list = [...list].sort((a, b) => a.seq - b.seq);
  if (args.order === "desc") list.reverse();
  return list.slice(0, limit);
}

export function makeWorld(
  options: {
    threads?: FakeThread[];
    answers?: string[];
    settings?: Record<string, string | number | boolean>;
    helpers?: ThreadResponse[];
    spawnError?: (args: Record<string, unknown>) => Error | null;
    /** Title writes fail (bb refused the update). */
    failUpdates?: boolean;
  } = {},
) {
  const threads = new Map<string, FakeThread>();
  for (const item of options.threads ?? []) threads.set(item.thread.id, item);
  const answers = [...(options.answers ?? [])];
  const spawns: Record<string, unknown>[] = [];
  const deleted: string[] = [];
  const stopped: string[] = [];
  const updates: { threadId: string; title: string | null }[] = [];
  const prompts: string[] = [];
  let helperCount = 0;
  const helpers = new Map<string, ThreadResponse>();
  for (const helper of options.helpers ?? []) helpers.set(helper.id, helper);
  const outputs = new Map<string, string>();
  /** Messages waiting in a thread's send queue (bb's queuedMessages rows). */
  const queued = new Map<string, Record<string, unknown>[]>();
  const projects: { id: string; name: string; kind: string; sources: { type: string; hostId: string; path: string }[] }[] = [];
  /** While set, helpers do not answer until `release()` or an abort. */
  let gate: { promise: Promise<void>; release: () => void } | null = null;

  const getThread = (threadId: string) => {
    const found = threads.get(threadId)?.thread ?? helpers.get(threadId);
    if (!found) throw new Error(`HTTP 404: no thread ${threadId}`);
    return found;
  };

  const host = createFakePluginHost({
    pluginId: PLUGIN_ID,
    settings: { cleanupSessions: false, ...(options.settings ?? {}) },
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_1" }) },
      projects: {
        get: async () => ({ id: PROJECT_ID, name: "Personal", kind: "personal" }),
        list: async () => [
          { id: PROJECT_ID, name: "Personal", kind: "personal", sources: [] },
          { id: "proj_client", name: "client", kind: "standard", sources: [{ type: "local_path", hostId: "host_1", path: "/home/example/Dev/client" }] },
          ...projects,
        ],
        create: async (args: { name: string; source: { type: string; hostId: string; path: string } }) => {
          const project = { id: `proj_helpers${projects.length + 1}`, name: args.name, kind: "standard", sources: [args.source] };
          projects.push(project);
          return project;
        },
      },
      threadSections: {
        list: async () => [
          { id: "sec_kept", name: "Kept" },
          { id: "sec_work", name: "work" },
        ],
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({
          id: environmentId,
          status: "ready",
          path: DEFAULT_HELPER_WORKSPACE,
          lifecycle: { phase: "active" },
        }),
      },
      threads: {
        get: async ({ threadId, include }: { threadId: string; include?: string }) => {
          const found = getThread(threadId);
          if (include === "environment" && found.visibility === "hidden") {
            return { ...found, environment: { id: found.environmentId, path: DEFAULT_HELPER_WORKSPACE } };
          }
          return found;
        },
        list: async (args?: { projectId?: string; includeHidden?: boolean; originPluginId?: string; parentThreadId?: string }) => {
          if (args?.originPluginId) {
            return [...helpers.values()].filter((helper) => helper.originPluginId === args.originPluginId);
          }
          return [...threads.values()]
            .map((item) => item.thread)
            .filter((item) => !args?.projectId || item.projectId === args.projectId)
            .filter((item) => !args?.parentThreadId || item.parentThreadId === args.parentThreadId);
        },
        events: {
          list: async (listArgs: object) => {
            const args = listArgs as Record<string, unknown>;
            const threadId = String(args.threadId);
            if (helpers.has(threadId)) {
              const types = args.types as readonly string[] | undefined;
              if (types?.[0] === "thread/tokenUsage/updated") {
                return [
                  {
                    type: "thread/tokenUsage/updated",
                    seq: 9,
                    data: { tokenUsage: { total: { totalTokens: 12_345, outputTokens: 345, cachedInputTokens: 10_000 } } },
                  },
                ];
              }
              if (types?.[0] === "thread/identity") {
                return [{ type: "thread/identity", seq: 2, data: { providerThreadId: `sess_${threadId}` } }];
              }
              return [];
            }
            return listEvents(threads.get(threadId)?.events ?? [], args);
          },
        },
        spawn: async (spawnArgs: object) => {
          const args = spawnArgs as Record<string, unknown>;
          spawns.push(args);
          const error = options.spawnError?.(args);
          if (error) throw error;
          prompts.push(String(args.prompt));
          helperCount += 1;
          const helper = makeThreadResponse({
            id: `thr_helper${helperCount}`,
            projectId: PROJECT_ID,
            environmentId: "env_helper",
            visibility: "hidden",
            originPluginId: PLUGIN_ID,
            status: "idle",
          });
          helpers.set(helper.id, helper);
          outputs.set(helper.id, answers.shift() ?? answer());
          return helper;
        },
        wait: async ({ signal }: { signal?: AbortSignal }) => {
          if (gate !== null) {
            const waiting = gate.promise;
            await new Promise<void>((resolve, reject) => {
              signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
              void waiting.then(resolve);
            });
          }
          return { matched: true };
        },
        output: async ({ threadId }: { threadId: string }) => ({ output: outputs.get(threadId) ?? null }),
        queuedMessages: {
          list: async ({ threadId }: { threadId: string }) => queued.get(threadId) ?? [],
        },
        stop: async ({ threadId }: { threadId: string }) => {
          stopped.push(threadId);
          return { ok: true };
        },
        delete: async ({ threadId }: { threadId: string }) => {
          deleted.push(threadId);
          helpers.delete(threadId);
          return { ok: true };
        },
        update: async ({ threadId, title = null }: { threadId: string; title?: string | null }) => {
          if (options.failUpdates) throw new Error("HTTP 500: update failed");
          updates.push({ threadId, title });
          const item = threads.get(threadId)!;
          item.thread = { ...item.thread, title, updatedAt: item.thread.updatedAt + 1 };
          return item.thread;
        },
      },
    },
  });

  const emit = host.harness.behavior.emitThreadEvent;
  return {
    ...host,
    threads,
    spawns,
    deleted,
    stopped,
    updates,
    prompts,
    helpers,
    projects,
    queued,
    /** Queue the helper's next answers. */
    answers: (...next: string[]) => answers.push(...next),
    /** Hold helpers until the returned release is called (or they are aborted). */
    holdHelpers() {
      let release = () => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      gate = { promise, release };
      return () => {
        gate = null;
        release();
      };
    },
    async load() {
      await plugin(host.bb);
    },
    cli(...argv: string[]) {
      return host.harness.behavior.runCli(argv, { cwd: "/tmp" });
    },
    rpc(method: string, input: unknown) {
      return host.harness.behavior.callRpc(method, input);
    },
    idle: (item: FakeThread) => emit("thread.idle", { thread: item.thread, lastAssistantText: null }),
    active: (item: FakeThread) => emit("thread.active", { thread: item.thread }),
    archived: (item: FakeThread) => emit("thread.archived", { thread: { ...item.thread, archivedAt: Date.now() } }),
    created: (item: FakeThread) => emit("thread.created", { thread: item.thread }),
    deletedThread: (item: FakeThread) => emit("thread.deleted", { thread: { ...item.thread, deletedAt: Date.now() } }),
    collect: () => host.harness.behavior.runSchedule("collector"),
    setSettings: (values: Record<string, string | number | boolean | null>) => host.harness.behavior.setSettings(values),
    async refresh(threadId: string, ...flags: string[]) {
      const result = await host.harness.behavior.runCli(["refresh", threadId, "--json", ...flags], { cwd: "/tmp" });
      if (result.exitCode !== 0 && result.stdout === "") throw new Error(result.stderr);
      return JSON.parse(result.stdout) as {
        status: string;
        reason: string | null;
        turnId: string | null;
        answer: { state: string; about: string; done: string; stoppedAt: string } | null;
        mode: string | null;
        title: string | null;
      };
    },
    /** `bb thread-card status --json`, recomputed first unless `cached`. */
    async status(threadId: string, cached = false) {
      const result = await host.harness.behavior.runCli(["status", threadId, "--json", ...(cached ? [] : ["--refresh"])], { cwd: "/tmp" });
      return JSON.parse(result.stdout) as {
        status: {
          state: string;
          reason: string;
          source: string;
          needHelper: boolean;
          turns: number;
          reported: number;
          view: string | null;
          execution: string | null;
          freshness: string;
          ask: string | null;
          waitingOn: string[];
          activityAt: number | null;
        } | null;
        topic: { topic: string; setBy: string } | null;
        report: { state: string; done: string; stoppedAt: string } | null;
        helper: { tries: number; tryTurnId: string | null; error: string | null; report: { state: string; about: string } | null } | null;
      };
    },
    failed: (item: FakeThread) => emit("thread.failed", { thread: item.thread, error: null }),
    interactionPending: (item: FakeThread) =>
      emit("interaction.pending", { thread: item.thread, interaction: { id: "pint_1" } as never }),
    async show(threadId: string) {
      const result = await host.harness.behavior.runCli(["show", threadId, "--json"], { cwd: "/tmp" });
      return JSON.parse(result.stdout) as {
        status: { state: string; reason: string; source: string } | null;
        topic: string | null;
        report: { state: string; done: string; stoppedAt: string; by: string } | null;
        skipped: string | null;
        policy: string;
        lockReason: string | null;
        canRevert: boolean;
        lastError: string | null;
        state: {
          locked: boolean;
          lockReason: string | null;
          baselineTitle: string | null;
          baselineAt: number | null;
          legacy: boolean;
        };
        titleHistory: { title: string; previousTitle: string | null; reason: string }[];
      };
    },
    dispose: () => host.harness.lifecycle.dispose(),
  };
}

export type World = ReturnType<typeof makeWorld>;

/** Let fire-and-forget work (arming, event handlers) finish. */
export async function until(condition: () => boolean | Promise<boolean>, rounds = 200): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not reached");
}
