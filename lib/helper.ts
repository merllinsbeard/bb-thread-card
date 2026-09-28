// The model call. A plugin cannot call a model directly, so each card update
// runs one short hidden helper thread: spawn → wait for the turn → read the
// answer and token usage → stop → delete. Helpers are deleted, not archived,
// so they do not pile up.
//
// Every helper runs in one dedicated empty directory (setting
// `helperWorkspace`), never in the workspace of the thread it describes: the
// helper is a full agent session with hooks and memory capture, and the
// owner's workspace and memory must not see transcripts of other threads.
import type { PluginBbSdk } from "@get-bb/plugin-sdk";

export const HELPER_TITLE = "Thread card helper";
/** Helpers younger than this may belong to a run still in flight. */
const ORPHAN_MIN_AGE_MS = 5 * 60_000;

export interface TokenUsage {
  /** Everything the model read: fresh plus cached input. */
  promptTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  raw: unknown;
}

export interface HelperResult {
  output: string;
  helperThreadId: string;
  environmentId: string | null;
  cwd: string | null;
  wallMs: number;
  usage: TokenUsage | null;
  /** The provider's own session id (Claude session, Codex thread). */
  sessionId: string | null;
}

export class HelperError extends Error {
  readonly helperThreadId: string | null;
  readonly cwd: string | null;
  sessionId: string | null = null;
  constructor(message: string, helperThreadId: string | null, cwd: string | null) {
    super(message);
    this.name = "HelperError";
    this.helperThreadId = helperThreadId;
    this.cwd = cwd;
  }
}

export type ReasoningLevel = NonNullable<Parameters<PluginBbSdk["threads"]["spawn"]>[0]["reasoningLevel"]>;

export interface HelperRequest {
  prompt: string;
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  projectId: string;
  hostId: string | null;
  workspacePath: string;
  /** Environment from an earlier helper at the same path; reused when alive. */
  environmentId: string | null;
  /** bb removes the helper with this thread if the plugin dies mid-run. */
  ownerThreadId: string | null;
  targetThreadId: string;
  deadline: number;
  signal?: AbortSignal;
  /** Problems that do not fail the run (the cwd could not be read, ...). */
  warn?: (message: string) => void;
}

type Sdk = Pick<PluginBbSdk, "threads" | "environments">;

function tokenUsage(events: readonly unknown[]): TokenUsage | null {
  const event = events[0] as { data?: { tokenUsage?: { total?: Record<string, unknown> } } } | undefined;
  const total = event?.data?.tokenUsage?.total;
  if (!total) return null;
  const n = (key: string) => (typeof total[key] === "number" ? (total[key] as number) : 0);
  // Claude reports input without cache and Codex with it; total − output is
  // the prompt size for both.
  return {
    promptTokens: n("totalTokens") - n("outputTokens"),
    cachedInputTokens: n("cachedInputTokens"),
    outputTokens: n("outputTokens"),
    raw: event?.data?.tokenUsage ?? null,
  };
}

/** Is a stored helper environment still usable for `workspacePath`? */
async function reusableEnvironment(
  sdk: Sdk,
  environmentId: string | null,
  workspacePath: string,
): Promise<string | null> {
  if (environmentId === null) return null;
  try {
    const environment = await sdk.environments.get({ environmentId });
    const env = environment as { status?: string; path?: string | null; lifecycle?: { phase?: string } };
    if (env.status === "ready" && env.path === workspacePath && (env.lifecycle?.phase ?? "active") === "active") {
      return environmentId;
    }
  } catch {
    // Gone or unreadable: start a fresh one at the same path.
  }
  return null;
}

export async function runHelper(sdk: Sdk, request: HelperRequest): Promise<HelperResult> {
  const started = Date.now();
  const reuse = await reusableEnvironment(sdk, request.environmentId, request.workspacePath);
  const base = {
    projectId: request.projectId,
    prompt: request.prompt,
    title: HELPER_TITLE,
    providerId: request.providerId,
    model: request.model,
    reasoningLevel: request.reasoningLevel,
    permissionMode: "accept-edits" as const,
    visibility: "hidden" as const,
    pluginMetadata: { helper: true, targetThreadId: request.targetThreadId },
  };
  const environment =
    reuse !== null
      ? { type: "reuse" as const, environmentId: reuse }
      : {
          type: "host" as const,
          ...(request.hostId !== null ? { hostId: request.hostId } : {}),
          workspace: { type: "unmanaged" as const, path: request.workspacePath },
        };

  let helper: Awaited<ReturnType<Sdk["threads"]["spawn"]>>;
  try {
    helper = await sdk.threads.spawn({
      ...base,
      environment,
      ...(request.ownerThreadId !== null ? { lifecycleOwnerThreadId: request.ownerThreadId } : {}),
    });
  } catch (error) {
    if (request.ownerThreadId === null) {
      throw new HelperError(`could not start the helper: ${String(error)}`, null, null);
    }
    // An owner in another project or an archived owner can be refused;
    // orphan cleanup covers the helper without it.
    try {
      helper = await sdk.threads.spawn({ ...base, environment });
    } catch (retryError) {
      throw new HelperError(`could not start the helper: ${String(retryError)}`, null, null);
    }
  }

  // The environment is provisioned after spawn returns, so the cwd and the
  // environment id are read once the turn has completed.
  let cwd: string | null = null;
  let environmentId: string | null = helper.environmentId ?? null;
  let sessionId: string | null = null;
  try {
    const remaining = request.deadline - Date.now();
    if (remaining <= 0) throw new HelperError("timed out before the helper started", helper.id, cwd);
    try {
      await sdk.threads.wait({
        threadId: helper.id,
        event: "turn/completed",
        timeoutMs: remaining,
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      if (request.signal?.aborted) throw new HelperError("aborted", helper.id, cwd);
      throw new HelperError(
        Date.now() >= request.deadline
          ? `the helper did not answer in ${Math.round((request.deadline - started) / 1000)} s`
          : `waiting for the helper failed: ${String(error)}`,
        helper.id,
        cwd,
      );
    }
    const state = (await sdk.threads.get({ threadId: helper.id, include: "environment" })) as Awaited<
      ReturnType<Sdk["threads"]["get"]>
    > & { environment?: { id?: string; path?: string | null } | null };
    environmentId = state.environment?.id ?? state.environmentId ?? environmentId;
    cwd = state.environment?.path ?? null;
    if (cwd === null) request.warn?.(`helper ${helper.id} has no environment path`);
    if (state.status === "error") {
      throw new HelperError(
        `the helper on ${request.providerId}/${request.model} failed; check that the provider is signed in and the model exists`,
        helper.id,
        cwd,
      );
    }
    const { output } = await sdk.threads.output({ threadId: helper.id });
    if (output === null || output.trim() === "") {
      throw new HelperError("the helper returned no text", helper.id, cwd);
    }
    let usage: TokenUsage | null = null;
    try {
      usage = tokenUsage(
        await sdk.threads.events.list({
          threadId: helper.id,
          types: ["thread/tokenUsage/updated"],
          order: "desc",
          limit: "1",
        }),
      );
    } catch {
      // Usage is for measurement only.
    }
    sessionId = await providerSessionId(sdk, helper.id);
    return { output, helperThreadId: helper.id, environmentId, cwd, wallMs: Date.now() - started, usage, sessionId };
  } catch (error) {
    // Any failure keeps the helper's ids, so its session file is removed now.
    const failure =
      error instanceof HelperError
        ? error
        : new HelperError(`reading the helper failed: ${error instanceof Error ? error.message : String(error)}`, helper.id, cwd);
    failure.sessionId = await providerSessionId(sdk, helper.id);
    throw failure;
  } finally {
    await disposeHelper(sdk, helper.id);
  }
}

/** The provider session behind a helper, so its session file can go too. */
async function providerSessionId(sdk: Pick<Sdk, "threads">, threadId: string): Promise<string | null> {
  try {
    const events = await sdk.threads.events.list({
      threadId,
      types: ["thread/identity"],
      order: "desc",
      limit: "1",
    });
    const data = (events[0] as { data?: { providerThreadId?: unknown } } | undefined)?.data;
    return typeof data?.providerThreadId === "string" ? data.providerThreadId : null;
  } catch {
    return null;
  }
}

export async function disposeHelper(sdk: Pick<Sdk, "threads">, threadId: string): Promise<void> {
  await sdk.threads.stop({ threadId }).catch(() => {});
  await sdk.threads.delete({ threadId, childThreadsConfirmed: true }).catch(() => {});
}

/**
 * Delete helpers a crash or restart left behind: hidden threads attributed
 * to this plugin that are older than any run still in flight.
 */
export async function cleanupOrphanHelpers(
  sdk: Pick<Sdk, "threads">,
  pluginId: string,
  now = Date.now(),
): Promise<string[]> {
  const removed: string[] = [];
  for (let offset = 0; offset < 2_000; offset += 200) {
    const page = await sdk.threads.list({
      includeHidden: true,
      originPluginId: pluginId,
      limit: 200,
      offset,
    });
    for (const thread of page) {
      if (thread.originPluginId !== pluginId || thread.visibility !== "hidden") continue;
      if (now - thread.createdAt < ORPHAN_MIN_AGE_MS) continue;
      await disposeHelper(sdk, thread.id);
      removed.push(thread.id);
    }
    if (page.length < 200) break;
  }
  return removed;
}

/** At most `limit` helpers at once; the rest wait in order (from Recap). A function limit is read on every grant, so a settings change applies to the queue. */
export function createLimiter(limit: number | (() => number)) {
  const max = typeof limit === "function" ? limit : () => limit;
  let active = 0;
  const waiting: { resolve: (ok: boolean) => void; signal?: AbortSignal; onAbort?: () => void }[] = [];
  const grant = () => {
    while (active < max() && waiting.length > 0) {
      const next = waiting.shift()!;
      if (next.signal?.aborted) {
        next.resolve(false);
        continue;
      }
      if (next.onAbort) next.signal?.removeEventListener("abort", next.onAbort);
      active += 1;
      next.resolve(true);
    }
  };
  return {
    /** Resolves true with a slot, or false when `signal` aborts first. */
    acquire(signal?: AbortSignal): Promise<boolean> {
      if (signal?.aborted) return Promise.resolve(false);
      if (active < max()) {
        active += 1;
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        const waiter: (typeof waiting)[number] = { resolve, ...(signal ? { signal } : {}) };
        if (signal) {
          waiter.onAbort = () => {
            const index = waiting.indexOf(waiter);
            if (index >= 0) waiting.splice(index, 1);
            resolve(false);
          };
          signal.addEventListener("abort", waiter.onAbort, { once: true });
        }
        waiting.push(waiter);
      });
    },
    release() {
      if (active > 0) active -= 1;
      grant();
    },
    activeCount: () => active,
    queuedCount: () => waiting.length,
  };
}
