// The helper and the title. When the working agent did not report on its
// last turn, a helper model reads the thread from the last report on and
// answers with the same fields (lib/card.ts); the answer feeds the status
// and, when the thread has none yet, the topic. The title follows the topic
// (and the status, when titles carry it) within the thread's title policy;
// a title a person set is never overwritten. Also the manual controls: lock,
// unlock, revert.
import type { PluginBbSdk, PluginKvStorage, PluginLogger } from "@get-bb/plugin-sdk";
import {
  LOCKED_BY_COMMAND,
  buildHelperPrompt,
  decideLock,
  desiredTitle,
  parseHelperAnswer,
  titlePolicy,
  type HelperAnswer,
  type HelperPromptInput,
  type StatusDisplay,
  type TitlePolicy,
} from "./card.ts";
import { HelperError, createLimiter, runHelper, type ReasoningLevel, type TokenUsage } from "./helper.ts";
import type { CodexUsage } from "./sessions.ts";
import type { Store, ThreadState } from "./store.ts";
import { TRANSCRIPT_BUDGET, composeOwnerBlock, composeTranscript, ownerMessages, readThreadContent } from "./transcript.ts";

/** Covers the wait for a free worker slot as well as the model call. */
export const HELPER_TIMEOUT_MS = 600_000;
export const MAX_WORKERS = 2;
const HELPER_ENV_KEY = "helper-environment";
/** A helper that never got a free worker did not try to read the thread. */
const QUEUE_TIMEOUT = "timed out waiting for a free worker";
/** When automatic updates were first switched on; set once, never moved. */
export const ENABLED_AT_KEY = "enabled-at";
export const HELPER_PROJECT_NAME = "thread-card helpers";
const LIST_CACHE_MS = 60_000;

export interface EngineSettings {
  /** Automatic updates: the plugin writes titles. */
  writeTitles: boolean;
  statusDisplay: StatusDisplay;
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  helperWorkspace: string;
  /** Helper threads at once (setting "workers"). */
  workers: number;
  /** Sections whose threads keep their titles and get no card: names or ids, comma or line separated. */
  skipSections: string;
}

export type DescribeStatus = "answered" | "dry-run" | "stale" | "skipped" | "failed";

export interface DescribeResult {
  threadId: string;
  status: DescribeStatus;
  reason: string | null;
  providerId: string | null;
  /** The turn the answer is for. */
  turnId: string | null;
  answer: HelperAnswer | null;
  mode: "full" | "incremental" | null;
  model: string | null;
  wallMs: number | null;
  queueMs: number | null;
  usage: (Omit<TokenUsage, "raw"> & { reasoningTokens: number | null }) | null;
  /** Subscription limit use after the call (Codex), percent of each window. */
  rateLimits: Pick<CodexUsage, "primary" | "secondary"> | null;
  promptChars: number | null;
  transcriptOmitted: number | null;
  helperCwd: string | null;
}

type ThreadLike = Awaited<ReturnType<PluginBbSdk["threads"]["get"]>> & {
  environment?: {
    id?: string;
    isGitRepo?: boolean;
    branchName?: string | null;
  } | null;
};
type ListedThread = Awaited<ReturnType<PluginBbSdk["threads"]["list"]>>[number];

export interface EngineDeps {
  sdk: PluginBbSdk;
  store: Store;
  kv: PluginKvStorage;
  log: PluginLogger;
  pluginId: string;
  settings: () => Promise<EngineSettings>;
  now?: () => number;
  /** Provider-side usage of a finished helper session (read before cleanup). */
  providerUsage?: (helper: { providerId: string; sessionId: string }) => Promise<CodexUsage | null>;
  /** After every helper, finished or failed: session cleanup, workspace check. */
  afterHelper?: (helper: { helperThreadId: string | null; sessionId: string | null }) => Promise<void>;
  /** A card or title changed (the header popover refetches). */
  onChange?: (threadId: string) => void;
}

export interface DescribeOptions {
  dryRun: boolean;
  signal?: AbortSignal;
  /** Why the run started, for the log: idle, manual, cli. */
  trigger?: string;
}

/**
 * Deleted, hidden, child and plugin threads are never processed. Children
 * are named by their dispatcher and shown nested; plugin threads (helpers,
 * automations, recaps) are service threads.
 */
export function skipReason(thread: {
  visibility: string;
  parentThreadId: string | null;
  originPluginId: string | null;
  deletedAt: number | null;
}): string | null {
  if (thread.deletedAt !== null) return "deleted thread";
  if (thread.visibility !== "visible") return "hidden thread";
  if (thread.originPluginId !== null) return "plugin thread";
  if (thread.parentThreadId !== null) return "child thread: named by its dispatcher";
  return null;
}

const emptyResult = (threadId: string): DescribeResult => ({
  threadId,
  status: "skipped",
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
});

const noop = () => undefined;

export function createEngine(deps: EngineDeps) {
  const { sdk, store } = deps;
  const now = deps.now ?? (() => Date.now());
  let workers = MAX_WORKERS;
  const limiter = createLimiter(() => workers);
  const inFlight = new Map<string, Promise<DescribeResult>>();
  const titling = new Map<string, Promise<unknown>>();
  const listCache = new Map<string, { at: number; threads: ListedThread[] }>();
  const helperProjects = new Map<string, string>();
  let primaryHostId: string | null | undefined;

  /**
   * The project the helpers live in. The personal project accepts only
   * personal workspaces, whose directory is per thread and is removed five
   * minutes after its last thread goes, so helpers there would not keep one
   * fixed cwd (which memory capture is excluded by). A standard project
   * whose only source is the helper workspace keeps the cwd fixed. It is
   * found by that source, or created once.
   */
  async function helperProjectId(workspacePath: string): Promise<string> {
    const cached = helperProjects.get(workspacePath);
    if (cached) return cached;
    const host = await hostId();
    if (host === null) throw new Error("no primary host to run helper threads on");
    const projects = await sdk.projects.list();
    const existing = projects.find((project) =>
      (project.sources ?? []).some(
        (source) => source.type === "local_path" && source.path === workspacePath && source.hostId === host,
      ),
    );
    const id =
      existing?.id ??
      (
        await sdk.projects.create({
          name: HELPER_PROJECT_NAME,
          source: { type: "local_path", hostId: host, path: workspacePath },
        })
      ).id;
    if (!existing) deps.log.info(`created project ${id} for helper threads at ${workspacePath}`);
    helperProjects.set(workspacePath, id);
    return id;
  }

  async function hostId(): Promise<string | null> {
    if (primaryHostId === undefined) {
      const config = await sdk.system.config();
      primaryHostId = config.primaryHostId ?? null;
    }
    return primaryHostId;
  }

  /** Visible, unarchived root threads of a project (cached briefly). */
  async function projectThreads(projectId: string): Promise<ListedThread[]> {
    const cached = listCache.get(projectId);
    if (cached && now() - cached.at < LIST_CACHE_MS) return cached.threads;
    const threads: ListedThread[] = [];
    for (let offset = 0; offset < 2_000; offset += 200) {
      const page = await sdk.threads.list({ projectId, archived: false, limit: 200, offset });
      threads.push(...page);
      if (page.length < 200) break;
    }
    const roots = threads.filter(
      (thread) => thread.visibility === "visible" && thread.parentThreadId === null && thread.archivedAt === null,
    );
    listCache.set(projectId, { at: now(), threads: roots });
    return roots;
  }

  async function pullRequestTitle(thread: ThreadLike): Promise<string | null> {
    const environment = thread.environment;
    if (!environment?.id || !environment.isGitRepo || !environment.branchName) return null;
    try {
      const response = (await sdk.environments.pullRequest({
        environmentId: environment.id,
        signal: AbortSignal.timeout(5_000),
      })) as { outcome?: string; pullRequest?: { title?: string; number?: number } };
      if (response.outcome !== "available" || !response.pullRequest?.title) return null;
      return `#${response.pullRequest.number ?? "?"} ${response.pullRequest.title}`;
    } catch {
      return null;
    }
  }

  async function sourceTitle(thread: ThreadLike): Promise<string | null> {
    if (!thread.sourceThreadId) return null;
    try {
      const source = await sdk.threads.get({ threadId: thread.sourceThreadId });
      return source.title ?? source.titleFallback ?? null;
    } catch {
      return null;
    }
  }

  async function callModel(
    prompt: HelperPromptInput,
    thread: ThreadLike,
    settings: EngineSettings,
    context: { mode: "full" | "incremental"; dryRun: boolean; signal?: AbortSignal },
  ): Promise<
    | {
        ok: true;
        answer: HelperAnswer;
        wallMs: number;
        queueMs: number;
        usage: TokenUsage | null;
        provider: CodexUsage | null;
        cwd: string | null;
        promptChars: number;
      }
    | { ok: false; error: string; cwd: string | null; promptChars: number }
  > {
    workers = settings.workers;
    const queuedAt = now();
    const queueSignal = AbortSignal.any([
      AbortSignal.timeout(HELPER_TIMEOUT_MS),
      ...(context.signal ? [context.signal] : []),
    ]);
    if (!(await limiter.acquire(queueSignal))) {
      const error = context.signal?.aborted ? "aborted" : QUEUE_TIMEOUT;
      return { ok: false, error, cwd: null, promptChars: 0 };
    }
    const queueMs = now() - queuedAt;
    try {
      const projectId = await helperProjectId(settings.helperWorkspace);
      const host = await hostId();
      let lastError = "";
      let lastCwd: string | null = null;
      let promptChars = 0;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const text = buildHelperPrompt(
          attempt === 1
            ? prompt
            : {
                ...prompt,
                retryNote: `Прошлый ответ не разобрался (${lastError}). Верни только один JSON-объект с полями из формата выше, без текста вокруг.`,
              },
        );
        promptChars = text.length;
        const stored = await deps.kv.get<{ environmentId: string; path: string }>(HELPER_ENV_KEY);
        const record = {
          threadId: thread.id,
          at: now(),
          mode: context.mode,
          dryRun: context.dryRun,
          providerId: settings.providerId,
          model: settings.model,
          reasoningLevel: settings.reasoningLevel,
          promptChars,
        };
        let finished: { helperThreadId: string | null; sessionId: string | null } = {
          helperThreadId: null,
          sessionId: null,
        };
        try {
          const result = await runHelper(sdk, {
            prompt: text,
            providerId: settings.providerId,
            model: settings.model,
            reasoningLevel: settings.reasoningLevel,
            projectId,
            hostId: host,
            workspacePath: settings.helperWorkspace,
            environmentId: stored?.path === settings.helperWorkspace ? stored.environmentId : null,
            ownerThreadId: thread.archivedAt === null ? thread.id : null,
            targetThreadId: thread.id,
            deadline: queuedAt + HELPER_TIMEOUT_MS * attempt,
            ...(context.signal ? { signal: context.signal } : {}),
            warn: (message) => deps.log.warn(message),
          });
          finished = { helperThreadId: result.helperThreadId, sessionId: result.sessionId };
          lastCwd = result.cwd;
          if (result.environmentId && result.environmentId !== stored?.environmentId) {
            await deps.kv.set(HELPER_ENV_KEY, {
              environmentId: result.environmentId,
              path: settings.helperWorkspace,
            });
          }
          const parsed = parseHelperAnswer(result.output);
          const provider =
            result.sessionId !== null && deps.providerUsage
              ? await deps
                  .providerUsage({ providerId: settings.providerId, sessionId: result.sessionId })
                  .catch(() => null)
              : null;
          store.addRun({
            ...record,
            helperThreadId: result.helperThreadId,
            helperCwd: result.cwd,
            wallMs: result.wallMs,
            queueMs,
            inputTokens: provider?.inputTokens ?? result.usage?.promptTokens ?? null,
            cachedInputTokens: provider?.cachedInputTokens ?? result.usage?.cachedInputTokens ?? null,
            outputTokens: provider?.outputTokens ?? result.usage?.outputTokens ?? null,
            reasoningTokens: provider?.reasoningOutputTokens ?? null,
            ratePrimaryPct: provider?.primary?.usedPercent ?? null,
            ratePrimaryWindow: provider?.primary?.windowMinutes ?? null,
            rateSecondaryPct: provider?.secondary?.usedPercent ?? null,
            rateSecondaryWindow: provider?.secondary?.windowMinutes ?? null,
            ok: parsed.ok,
            error: parsed.ok ? null : `${parsed.error}; reply: ${result.output.slice(0, 300)}`,
          });
          if (parsed.ok) {
            return {
              ok: true,
              answer: parsed.answer,
              wallMs: result.wallMs,
              queueMs,
              usage: result.usage,
              provider,
              cwd: result.cwd,
              promptChars,
            };
          }
          lastError = parsed.error;
          deps.log.warn(`helper for ${thread.id}: unparseable answer (${parsed.error}), attempt ${attempt}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const helperThreadId = error instanceof HelperError ? error.helperThreadId : null;
          finished = { helperThreadId, sessionId: error instanceof HelperError ? error.sessionId : null };
          lastCwd = error instanceof HelperError ? error.cwd : lastCwd;
          store.addRun({
            ...record,
            helperThreadId,
            helperCwd: lastCwd,
            wallMs: null,
            queueMs,
            inputTokens: null,
            cachedInputTokens: null,
            outputTokens: null,
            ok: false,
            error: message,
          });
          // Only an unparseable answer earns a retry; a failed call does not.
          return { ok: false, error: message, cwd: lastCwd, promptChars };
        } finally {
          await deps.afterHelper?.(finished).catch((error: unknown) => {
            deps.log.warn(`after-helper cleanup failed: ${String(error)}`);
          });
        }
      }
      return { ok: false, error: `unparseable answer twice: ${lastError}`, cwd: lastCwd, promptChars };
    } finally {
      limiter.release();
    }
  }

  async function enabledAt(): Promise<number | null> {
    const value = await deps.kv.get<number>(ENABLED_AT_KEY);
    return typeof value === "number" ? value : null;
  }

  /** Store the first enable time once; later calls return the stored one. */
  async function markEnabled(): Promise<number> {
    const existing = await enabledAt();
    if (existing !== null) return existing;
    const at = now();
    await deps.kv.set(ENABLED_AT_KEY, at);
    return at;
  }

  /** Did bb generate this thread's title (not a person, spawn or dispatcher)? */
  async function titleWasGenerated(threadId: string): Promise<boolean> {
    try {
      const events = await sdk.threads.events.list({
        threadId,
        types: ["system/thread-provisioning"],
        order: "asc",
        limit: "100",
      });
      return events.some((event) => {
        const entries = (event as { data?: { entries?: unknown } }).data?.entries;
        return (
          Array.isArray(entries) &&
          entries.some(
            (entry) => (entry as { metadata?: { titleGenerated?: unknown } })?.metadata?.titleGenerated === true,
          )
        );
      });
    } catch {
      return false;
    }
  }

  /**
   * The first look at a thread fixes which title the plugin may overwrite.
   *
   * New threads (created after the first enable): a title present at
   * `thread.created` came from spawn, a dispatcher or a person, so the thread
   * locks. Otherwise the current title (bb's generated one, or none) is the
   * baseline. If the plugin missed `thread.created` (it was not loaded), a
   * title bb did not generate is treated the same way.
   *
   * Legacy threads (created before the first enable): the baseline is the
   * title at enable time; a title bb did not generate locks with reason
   * "legacy-set-title". Before the first enable every thread is legacy and
   * nothing is stored unless `persist`.
   *
   * An untitled thread gets no baseline yet: bb names a thread a few seconds
   * after its first message, and the first look with a title decides. A
   * title the plugin wrote itself is never taken for a person's.
   */
  async function observe(
    thread: { id: string; title?: string | null; createdAt: number },
    persist: boolean,
  ): Promise<ThreadState> {
    const state = store.getState(thread.id);
    if (state.baselineAt !== null && state.baselineTitle !== null) return state;
    const title = thread.title ?? null;
    if (title === null || title.trim() === "") return state;
    const enabled = await enabledAt();
    const legacy = enabled === null || thread.createdAt < enabled;
    const ours = store.titleHistory(thread.id).some((record) => record.title === title);
    let lockReason: string | null = null;
    if (!legacy && state.createdTitle !== null) lockReason = "title given at creation";
    else if (!ours && !(await titleWasGenerated(thread.id))) {
      lockReason = legacy ? "legacy-set-title" : "title given at creation";
    }
    const next: ThreadState = {
      ...state,
      baselineTitle: title,
      baselineAt: now(),
      legacy,
      ...(lockReason !== null && !state.locked ? { locked: true, lockReason } : {}),
    };
    if (persist) store.saveState(next);
    return next;
  }

  /**
   * One helper run: read the thread after the last report (the agent's or a
   * helper's; all of it when there is none), ask the helper for the four
   * fields and store its answer for the last finished turn. An answer that
   * comes after a new turn began is stale and only logged.
   */
  async function describeOnce(threadId: string, options: DescribeOptions): Promise<DescribeResult> {
    const result = emptyResult(threadId);
    const thread = (await sdk.threads.get({ threadId, include: "environment" })) as ThreadLike;
    result.providerId = thread.providerId;
    const settings = await deps.settings();
    const skip = skipReason(thread) ?? (await sectionSkip(thread.sectionId, settings.skipSections));
    if (skip) return { ...result, reason: skip };

    const facts = store.getFacts(threadId);
    const last = facts?.turns.at(-1) ?? null;
    if (facts === null || last === null) return { ...result, reason: "no turns tracked yet" };
    if (last.endSeq === null) return { ...result, reason: "the last turn is still running" };
    result.turnId = last.id;

    const agent = facts.lastReport;
    const helper = store.getHelper(threadId)?.report ?? null;
    const previous =
      agent !== null && (helper === null || agent.seq >= helper.basisSeq)
        ? { seq: agent.seq, report: agent }
        : helper !== null
          ? { seq: helper.basisSeq, report: helper }
          : null;
    const afterSeq = previous?.seq ?? 0;
    const mode = previous === null ? "full" : "incremental";
    result.mode = mode;
    const content = await readThreadContent(sdk.threads, threadId, afterSeq, options.signal);
    if (options.signal?.aborted) return { ...result, status: "failed", reason: "aborted" };
    const newMessages = content.messages.filter((message) => message.seq > afterSeq);
    if (content.turns.length === 0 && ownerMessages(newMessages).length === 0) {
      return { ...result, reason: "nothing new since the last report" };
    }

    const owner = ownerMessages(content.messages);
    const ownerOffset = owner.length - ownerMessages(newMessages).length;
    const ownerBlock = composeOwnerBlock(newMessages, undefined, ownerOffset);
    const transcript = composeTranscript({
      messages: newMessages,
      turns: content.turns,
      budget: TRANSCRIPT_BUDGET - ownerBlock.text.length,
      ownerOffset,
    });
    result.transcriptOmitted = transcript.omitted;
    const topic = store.getTopic(threadId)?.topic ?? null;
    const prompt: HelperPromptInput = {
      ownerMessages: ownerBlock.text,
      transcript: transcript.text,
      previousReport: previous
        ? {
            state: previous.report.state,
            about: topic ?? previous.report.about,
            done: previous.report.done,
            stoppedAt: previous.report.stoppedAt,
          }
        : null,
      topic,
      meta: {
        providerId: thread.providerId,
        currentTitle: thread.title ?? null,
        branch: thread.environment?.branchName ?? null,
        pullRequest: await pullRequestTitle(thread),
        sourceThreadTitle: await sourceTitle(thread),
      },
    };
    const call = await callModel(prompt, thread, settings, {
      mode,
      dryRun: options.dryRun,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const model = `${settings.providerId}/${settings.model}`;
    result.model = model;
    result.helperCwd = call.cwd;
    result.promptChars = call.promptChars;
    if (!call.ok) {
      if (!options.dryRun && call.error !== "aborted" && call.error !== QUEUE_TIMEOUT) {
        store.saveHelperFailure(threadId, last.id, call.error, now());
        store.updateState(threadId, () => ({ lastError: call.error, lastRunAt: now() }));
        deps.log.warn(`helper for ${threadId} failed: ${call.error}`);
      }
      return { ...result, status: "failed", reason: call.error };
    }
    result.wallMs = call.wallMs;
    result.queueMs = call.queueMs;
    result.usage = call.provider
      ? {
          promptTokens: call.provider.inputTokens,
          cachedInputTokens: call.provider.cachedInputTokens,
          outputTokens: call.provider.outputTokens,
          reasoningTokens: call.provider.reasoningOutputTokens,
        }
      : call.usage
        ? {
            promptTokens: call.usage.promptTokens,
            cachedInputTokens: call.usage.cachedInputTokens,
            outputTokens: call.usage.outputTokens,
            reasoningTokens: null,
          }
        : null;
    result.rateLimits = call.provider ? { primary: call.provider.primary, secondary: call.provider.secondary } : null;
    result.answer = call.answer;
    if (options.dryRun) return { ...result, status: "dry-run" };

    // The helper takes minutes: a new turn may have begun meanwhile, and its
    // answer is then about a thread that has moved on.
    const moved = store.getFacts(threadId)?.turns.at(-1)?.id !== last.id;
    store.updateState(threadId, () => ({ lastError: null, lastRunAt: now() }));
    if (moved) return { ...result, status: "stale", reason: "a new turn began while the helper read the thread" };
    store.saveHelperReport(threadId, {
      turnId: last.id,
      // An input that came in after the turn ended (an answer to a form) is covered too: the thread was read after it.
      basisSeq: Math.max(content.maxSeq, facts.lastInputSeq ?? 0),
      state: call.answer.state,
      about: call.answer.about,
      done: call.answer.done,
      stoppedAt: call.answer.stoppedAt,
      at: now(),
      model,
      questionCount: call.answer.questionCount ?? null,
      waitingOnThreadIds: call.answer.waitingOnThreadIds ?? null,
    });
    // The helper names a thread only when nothing has yet.
    if (topic === null && store.getTopic(threadId) === null) {
      store.setTopic(threadId, { topic: call.answer.about, setBy: "helper", setAt: now() });
    }
    deps.log.info(`helper for ${threadId}${options.trigger ? ` (${options.trigger})` : ""}: ${call.answer.state}, «${call.answer.about}»`);
    deps.onChange?.(threadId);
    return { ...result, status: "answered" };
  }

  /**
   * One helper per thread at a time; a later request waits for the current
   * one. A dry-run stores nothing, so it runs on its own. Open popovers hear
   * when a run starts and ends.
   */
  function describe(threadId: string, options: DescribeOptions): Promise<DescribeResult> {
    if (options.dryRun) return describeOnce(threadId, options);
    const previous = inFlight.get(threadId);
    const run: Promise<DescribeResult> = (previous ? previous.then(noop, noop) : Promise.resolve())
      .then(() => {
        deps.onChange?.(threadId);
        return describeOnce(threadId, options);
      })
      .finally(() => {
        if (inFlight.get(threadId) === run) inFlight.delete(threadId);
        deps.onChange?.(threadId);
      });
    inFlight.set(threadId, run);
    return run;
  }

  /** The thread's title policy, locking it first if a person renamed it. */
  async function policyOf(thread: { id: string; title?: string | null; createdAt: number }): Promise<TitlePolicy> {
    const state = await observe(thread, true);
    const lock = decideLock({
      currentTitle: thread.title ?? null,
      state,
      pluginTitles: store.titleHistory(thread.id).map((record) => record.title),
    });
    if (lock.newLock) {
      store.updateState(thread.id, () => ({ locked: true, lockReason: lock.reason }));
      deps.onChange?.(thread.id);
    }
    return titlePolicy(lock);
  }

  /**
   * Bring the title in line with the topic and the status, when automatic
   * updates are on (or the owner asked: `force`) and the policy lets the
   * plugin write. Returns the title written, or null.
   */
  async function applyTitleOnce(threadId: string, reason: string, force: boolean): Promise<string | null> {
    const settings = await deps.settings();
    if (!settings.writeTitles && !force) return null;
    const thread = await sdk.threads.get({ threadId });
    if (thread.archivedAt !== null || (await skipped(thread)) !== null) return null;
    const policy = await policyOf(thread);
    const lastWritten = store
      .titleHistory(threadId)
      .filter((record) => record.reason !== "unlock")
      .at(-1)?.title;
    const target = desiredTitle({
      policy,
      display: settings.statusDisplay,
      topic: store.getTopic(threadId)?.topic ?? null,
      currentTitle: thread.title ?? null,
      pluginWrote: lastWritten !== undefined && lastWritten === thread.title,
      state: store.getStatus(threadId)?.state ?? null,
    });
    if (target === null || target === (thread.title ?? null)) return null;
    // Record first, so revert can always restore the title this write replaces.
    const recordId = store.addTitle(threadId, { title: target, previousTitle: thread.title ?? null, reason, at: now() });
    try {
      await sdk.threads.update({ threadId, title: target });
    } catch (error) {
      store.deleteTitle(recordId);
      throw error;
    }
    deps.log.info(`titled ${threadId} (${reason}): ${target}`);
    deps.onChange?.(threadId);
    return target;
  }

  /** Title writes (and revert) run one at a time per thread, in order. */
  function serial<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const previous = titling.get(threadId);
    const run = (previous ? previous.then(noop, noop) : Promise.resolve()).then(work).finally(() => {
      if (titling.get(threadId) === run) titling.delete(threadId);
    });
    titling.set(threadId, run);
    return run;
  }

  function applyTitle(threadId: string, reason: string, force = false): Promise<string | null> {
    return serial(threadId, () => applyTitleOnce(threadId, reason, force));
  }

  /** Threads of a project with activity in the window, newest first. */
  async function threadsWithActivity(projectId: string, sinceMs: number): Promise<ListedThread[]> {
    listCache.delete(projectId);
    const cutoff = now() - sinceMs;
    return (await projectThreads(projectId))
      .filter((thread) => (thread.latestAttentionAt ?? thread.createdAt) >= cutoff)
      .sort((a, b) => (b.latestAttentionAt ?? 0) - (a.latestAttentionAt ?? 0));
  }

  /** Every visible root thread in every project (for the enable snapshot). */
  async function allRootThreads(): Promise<ListedThread[]> {
    const projects = await sdk.projects.list({ includePersonal: true });
    const threads: ListedThread[] = [];
    for (const project of projects) {
      listCache.delete(project.id);
      threads.push(...(await projectThreads(project.id)));
    }
    return threads.filter((thread) => skipReason(thread) === null);
  }

  /** A thread in a section named in the "skipSections" setting is left alone. */
  async function sectionSkip(sectionId: string | null, skipSections: string): Promise<string | null> {
    const wanted = skipSections
      .split(/[,\n]/)
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item !== "");
    if (sectionId === null || wanted.length === 0) return null;
    const name = (await sdk.threadSections.list()).find((section) => section.id === sectionId)?.name ?? sectionId;
    if (!wanted.includes(sectionId.toLowerCase()) && !wanted.includes(name.toLowerCase())) return null;
    return `section "${name}" is left alone`;
  }

  /** Why the plugin does not handle this thread, or null. */
  async function skipped(thread: Parameters<typeof skipReason>[0] & { sectionId: string | null }): Promise<string | null> {
    return skipReason(thread) ?? (await sectionSkip(thread.sectionId, (await deps.settings()).skipSections));
  }

  /** Policy off: the plugin does not touch the title. */
  async function lock(threadId: string): Promise<void> {
    store.updateState(threadId, () => ({ locked: true, lockReason: LOCKED_BY_COMMAND }));
    deps.onChange?.(threadId);
  }

  /** Policy auto: accept the current title as known and write the topic. */
  async function unlock(threadId: string): Promise<void> {
    const thread = await sdk.threads.get({ threadId });
    store.updateState(threadId, (state) => ({
      locked: false,
      lockReason: null,
      createdTitle: null,
      // An unlocked thread with no baseline yet gets it now, so the rules
      // below do not lock it again on the next run.
      ...(state.baselineAt === null ? { baselineTitle: thread.title ?? null, baselineAt: now() } : {}),
    }));
    if (thread.title) {
      store.addTitle(threadId, { title: thread.title, previousTitle: thread.title, reason: "unlock", at: now() });
    }
    deps.onChange?.(threadId);
    await applyTitle(threadId, "unlock", true);
  }

  /** Put back the title from before the plugin's first write; its words are the owner's again. */
  async function revert(threadId: string): Promise<{ title: string | null; from: string | null }> {
    const first = store.titleHistory(threadId).find((record) => record.reason !== "unlock");
    if (!first) throw new Error("the plugin has not written a title on this thread");
    // Lock first and write in the title queue, so no write of the plugin's lands after it.
    store.updateState(threadId, () => ({ locked: true, lockReason: "reverted" }));
    return serial(threadId, async () => {
      const thread = await sdk.threads.get({ threadId });
      await sdk.threads.update({ threadId, title: first.previousTitle });
      deps.onChange?.(threadId);
      return { title: first.previousTitle, from: thread.title ?? null };
    });
  }

  /** `thread.created`: remember a title given at creation (its words stay the owner's). */
  function recordCreated(thread: { id: string; title: string | null }): void {
    if (!thread.title || thread.title.trim() === "") return;
    const state = store.getState(thread.id);
    if (state.createdTitle !== null) return;
    store.saveState({ ...state, createdTitle: thread.title });
  }

  /** The policy as the card shows it, without locking anything. */
  function policyView(threadId: string): TitlePolicy {
    const state = store.getState(threadId);
    return titlePolicy({ locked: state.locked, reason: state.lockReason });
  }

  return {
    describe,
    applyTitle,
    threadsWithActivity,
    allRootThreads,
    observe,
    skipped,
    enabledAt,
    markEnabled,
    lock,
    unlock,
    revert,
    recordCreated,
    policyView,
    limiter,
    inFlight: (threadId: string) => inFlight.has(threadId),
  };
}

export type Engine = ReturnType<typeof createEngine>;
