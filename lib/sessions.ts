// Provider session files the helpers leave behind. Every helper is a full
// Claude Code or Codex session, and each one writes a transcript file that
// holds a copy of another thread's conversation. The plugin created them,
// so it removes them: right after a helper finishes (by its session id) and
// in the startup sweep (anything older than ten minutes, so a helper still
// running is never touched).
//
// Deletion is strictly scoped to two roots:
//   - Claude: ~/.claude/projects/<helper workspace with non-alphanumerics as
//     dashes>/ — that directory holds only helper sessions;
//   - Codex: rollout files under ~/.codex/sessions/ or
//     ~/.codex/archived_sessions/ whose thread row in the Codex state
//     database has cwd = the helper workspace. The database is opened
//     read-only and never written.
// Symlinks are never followed or deleted, and every path is checked against
// its root after resolving. Only counts are logged, never contents.
//
// The workspace is a setting, and a wrong value (the home directory, a real
// project) would point both roots at the owner's own sessions. So sessions
// of helpers that just finished go by their ids (they are the plugin's by
// provenance), but the sweep by age runs only while the workspace is a
// dedicated directory: a real directory, not the home directory or above
// it, holding nothing but the memory-bypass config.
import { lstat, readFile, readdir, realpath, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export const SESSION_MIN_AGE_MS = 10 * 60_000;
/** The helper workspace keeps only its memory-bypass config. */
export const HELPER_WORKSPACE_KEEP = new Set([".openviking"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionCleanupResult {
  claudeFiles: number;
  codexFiles: number;
  /** Candidates left alone because they were outside a root or a symlink. */
  refused: number;
  /** False when the workspace is not a dedicated directory: only given ids went. */
  sweptByAge: boolean;
}

export interface SessionCleanupOptions {
  home: string;
  helperWorkspace: string;
  /** Provider session ids of helpers that just finished: deleted at any age. */
  sessionIds?: readonly string[];
  now?: number;
  minAgeMs?: number;
}

/** Claude Code names a project's session directory after its cwd this way. */
export function claudeProjectDirName(workspace: string): string {
  return workspace.replace(/[^a-zA-Z0-9]/g, "-");
}

/** A path is under `root` when it resolves inside it (not equal to it). */
export function isInside(root: string, path: string): boolean {
  const base = resolve(root);
  const target = resolve(path);
  return target.startsWith(base.endsWith(sep) ? base : base + sep);
}

function usableWorkspace(workspace: string): boolean {
  // "/" or a one-segment path would map to a Claude directory that is not a
  // dedicated helper directory.
  return isAbsolute(workspace) && resolve(workspace).split(sep).filter(Boolean).length >= 2;
}

async function realInside(root: string, path: string): Promise<boolean> {
  try {
    const realRoot = await realpath(root);
    const realParent = await realpath(dirname(path));
    return realParent === realRoot || isInside(realRoot, realParent);
  } catch {
    return false;
  }
}

/** A real directory, not the home directory or above it, with only the bypass config. */
async function dedicatedWorkspace(workspace: string, home: string): Promise<boolean> {
  const info = await lstat(workspace).catch(() => null);
  if (info === null || !info.isDirectory() || info.isSymbolicLink()) return false;
  const target = resolve(workspace);
  const resolvedHome = resolve(home);
  if (target === resolvedHome || isInside(target, resolvedHome)) return false;
  return (await unexpectedWorkspaceEntries(workspace)).length === 0;
}

async function cleanupClaude(options: Required<Omit<SessionCleanupOptions, "sessionIds">> & { ids: Set<string> }) {
  const root = join(options.home, ".claude", "projects", claudeProjectDirName(options.helperWorkspace));
  const rootInfo = await lstat(root).catch(() => null);
  if (rootInfo === null) return { deleted: 0, refused: 0 };
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return { deleted: 0, refused: 1 };
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { deleted: 0, refused: 0 };
  }
  let deleted = 0;
  let refused = 0;
  for (const entry of entries) {
    const stem = entry.name.endsWith(".jsonl") ? entry.name.slice(0, -".jsonl".length) : entry.name;
    const sessionFile = entry.isFile() && entry.name.endsWith(".jsonl");
    const sessionDir = entry.isDirectory() && UUID.test(entry.name);
    if (!sessionFile && !sessionDir) continue; // memory/, symlinks, anything else
    const path = join(root, entry.name);
    if (!isInside(root, path) || !(await realInside(root, path))) {
      refused += 1;
      continue;
    }
    const info = await lstat(path).catch(() => null);
    if (info === null || info.isSymbolicLink()) {
      refused += 1;
      continue;
    }
    const old = options.now - info.mtimeMs >= options.minAgeMs;
    if (!old && !options.ids.has(stem)) continue;
    if (sessionDir) await rm(path, { recursive: true, force: true });
    else await unlink(path);
    deleted += 1;
  }
  return { deleted, refused };
}

interface CodexRow {
  id: string;
  rollout_path: string | null;
  updated_at_ms?: number | null;
  updated_at?: number | null;
}

async function codexDatabase(codexHome: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(codexHome);
  } catch {
    return null;
  }
  const versions = names
    .map((name) => /^state_(\d+)\.sqlite$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  return versions[0] ? join(codexHome, versions[0][0]) : null;
}

async function codexRows(home: string, where: "cwd" | "id", value: string): Promise<CodexRow[] | null> {
  const dbPath = await codexDatabase(join(home, ".codex"));
  if (dbPath === null) return null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare(`SELECT * FROM threads WHERE ${where} = ?`).all(value) as unknown as CodexRow[];
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

const codexRoots = (home: string) => [join(home, ".codex", "sessions"), join(home, ".codex", "archived_sessions")];

/** A rollout path from the Codex database, if it is a regular file under a Codex session root. */
async function scopedRollout(home: string, rolloutPath: string | null): Promise<string | null | "refused"> {
  if (typeof rolloutPath !== "string" || rolloutPath === "") return null;
  const path = resolve(rolloutPath);
  const root = codexRoots(home).find((candidate) => isInside(candidate, path));
  if (root === undefined || !(await realInside(root, path))) return "refused";
  const info = await lstat(path).catch(() => null);
  if (info === null) return null;
  if (!info.isFile() || info.isSymbolicLink()) return "refused";
  return path;
}

export interface RateWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}

export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  /** Subscription limit use right after the call, as the provider reported it. */
  primary: RateWindow | null;
  secondary: RateWindow | null;
  planType: string | null;
}

function rateWindow(value: unknown): RateWindow | null {
  const record = value as { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown } | null;
  if (!record || typeof record.used_percent !== "number") return null;
  return {
    usedPercent: record.used_percent,
    windowMinutes: typeof record.window_minutes === "number" ? record.window_minutes : null,
    resetsAt: typeof record.resets_at === "number" ? record.resets_at : null,
  };
}

/**
 * Token use and the rate-limit snapshot of one Codex helper session, from
 * the last `token_count` event of its rollout. Read before the cleanup
 * deletes the rollout; the database is opened read-only.
 */
export async function readCodexUsage(home: string, sessionId: string): Promise<CodexUsage | null> {
  const rows = await codexRows(home, "id", sessionId);
  const path = await scopedRollout(home, rows?.[0]?.rollout_path ?? null);
  if (path === null || path === "refused") return null;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  type TokenCount = { type?: string; info?: { total_token_usage?: Record<string, unknown> }; rate_limits?: Record<string, unknown> };
  let last: TokenCount | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"token_count"')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; payload?: TokenCount };
      if (event.type === "event_msg" && event.payload?.type === "token_count") last = event.payload;
    } catch {
      // A partly written last line.
    }
  }
  if (last === null) return null;
  const total = last.info?.total_token_usage ?? {};
  const n = (key: string) => (typeof total[key] === "number" ? (total[key] as number) : 0);
  const limits = last.rate_limits ?? {};
  return {
    inputTokens: n("input_tokens"),
    cachedInputTokens: n("cached_input_tokens"),
    outputTokens: n("output_tokens"),
    reasoningOutputTokens: n("reasoning_output_tokens"),
    totalTokens: n("total_tokens"),
    primary: rateWindow(limits.primary),
    secondary: rateWindow(limits.secondary),
    planType: typeof limits.plan_type === "string" ? limits.plan_type : null,
  };
}

async function cleanupCodex(options: Required<Omit<SessionCleanupOptions, "sessionIds">> & { ids: Set<string> }) {
  const rows = await codexRows(options.home, "cwd", options.helperWorkspace);
  if (rows === null) return { deleted: 0, refused: 0 };
  let deleted = 0;
  let refused = 0;
  for (const row of rows) {
    const path = await scopedRollout(options.home, row.rollout_path);
    if (path === null) continue; // no file, or already gone
    if (path === "refused") {
      refused += 1;
      continue;
    }
    const info = await lstat(path).catch(() => null);
    if (info === null) continue;
    const updated =
      typeof row.updated_at_ms === "number" && row.updated_at_ms > 0
        ? row.updated_at_ms
        : typeof row.updated_at === "number"
          ? row.updated_at * 1000
          : info.mtimeMs;
    const old = options.now - Math.max(updated, info.mtimeMs) >= options.minAgeMs;
    if (!old && !options.ids.has(row.id)) continue;
    await unlink(path);
    deleted += 1;
  }
  return { deleted, refused };
}

export async function cleanupHelperSessions(options: SessionCleanupOptions): Promise<SessionCleanupResult> {
  if (!usableWorkspace(options.helperWorkspace)) return { claudeFiles: 0, codexFiles: 0, refused: 0, sweptByAge: false };
  const sweptByAge = await dedicatedWorkspace(options.helperWorkspace, options.home);
  const resolved = {
    home: options.home,
    helperWorkspace: resolve(options.helperWorkspace),
    now: options.now ?? Date.now(),
    minAgeMs: sweptByAge ? (options.minAgeMs ?? SESSION_MIN_AGE_MS) : Number.POSITIVE_INFINITY,
    ids: new Set(options.sessionIds ?? []),
  };
  const claude = await cleanupClaude(resolved);
  const codex = await cleanupCodex(resolved);
  return {
    claudeFiles: claude.deleted,
    codexFiles: codex.deleted,
    refused: claude.refused + codex.refused,
    sweptByAge,
  };
}

/**
 * Entries in the helper workspace other than its memory-bypass config.
 * Helpers run with accept-edits (bb has nothing stricter that still ends
 * with a plain answer), so a helper could write a file there. This only
 * reports: the workspace path is a setting, and deleting inside a
 * mistyped path would be worse than a warning.
 */
export async function unexpectedWorkspaceEntries(workspace: string): Promise<string[]> {
  try {
    const names = await readdir(workspace);
    return names.filter((name) => !HELPER_WORKSPACE_KEEP.has(name)).sort();
  } catch {
    return [];
  }
}
