// Helper session cleanup deletes only helper transcripts, only under the two
// session roots, and never writes the Codex database.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { claudeProjectDirName, cleanupHelperSessions, readCodexUsage, unexpectedWorkspaceEntries } from "../lib/sessions.ts";

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);
const OLD = (NOW - 3_600_000) / 1000;
const FRESH = (NOW - 60_000) / 1000;
/** A dedicated helper workspace: a directory with only the memory-bypass config. */
function helperWorkspace(): string {
  const workspace = join(mkdtempSync(join(tmpdir(), "tc-helper-")), "helper");
  mkdirSync(join(workspace, ".openviking"), { recursive: true });
  return workspace;
}
const WORKSPACE = helperWorkspace();
const UUID = (n: number) => `0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`;

function file(path: string, mtime: number, text = "{}\n"): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  utimesSync(path, mtime, mtime);
  return path;
}

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("Claude: old and just-finished helper sessions go; fresh ones, memory, symlinks and other projects stay", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-claude-"));
  const root = join(home, ".claude", "projects", claudeProjectDirName(WORKSPACE));
  assert.equal(claudeProjectDirName("/home/example/.local/share/bb-thread-card/helper"), "-home-example--local-share-bb-thread-card-helper");
  const old = file(join(root, `${UUID(1)}.jsonl`), OLD);
  const finished = file(join(root, `${UUID(2)}.jsonl`), FRESH);
  const running = file(join(root, `${UUID(3)}.jsonl`), FRESH);
  const oldDir = join(root, UUID(4));
  file(join(oldDir, "subagents", "a.jsonl"), OLD);
  utimesSync(oldDir, OLD, OLD);
  const memory = file(join(root, "memory", "MEMORY.md"), OLD);
  const outsideTarget = file(join(home, "precious.jsonl"), OLD);
  symlinkSync(outsideTarget, join(root, `${UUID(5)}.jsonl`));
  const otherProject = file(join(home, ".claude", "projects", "-home-example-code-app", `${UUID(6)}.jsonl`), OLD);

  const result = await cleanupHelperSessions({ home, helperWorkspace: WORKSPACE, sessionIds: [UUID(2)], now: NOW });

  assert.equal(result.claudeFiles, 3);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(finished), false);
  assert.equal(existsSync(oldDir), false);
  assert.equal(existsSync(running), true, "a helper still running keeps its session");
  assert.equal(existsSync(memory), true);
  assert.equal(existsSync(outsideTarget), true, "a symlink is never followed");
  assert.equal(existsSync(join(root, `${UUID(5)}.jsonl`)), true, "nor deleted");
  assert.equal(existsSync(otherProject), true);
});

test("Codex: only rollouts of helper-workspace threads under the session roots go; the database is untouched", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-codex-"));
  const codex = join(home, ".codex");
  const sessions = join(codex, "sessions", "2026", "09", "27");
  const helperOld = file(join(sessions, "rollout-helper-old.jsonl"), OLD);
  const helperJust = file(join(sessions, "rollout-helper-just.jsonl"), FRESH);
  const helperRunning = file(join(sessions, "rollout-helper-running.jsonl"), FRESH);
  const archived = file(join(codex, "archived_sessions", "rollout-helper-archived.jsonl"), OLD);
  const ownerThread = file(join(sessions, "rollout-owner.jsonl"), OLD);
  const escaped = file(join(home, "Dev", "notes.jsonl"), OLD);
  const linked = join(sessions, "rollout-helper-link.jsonl");
  symlinkSync(escaped, linked);

  const dbPath = join(codex, "state_5.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, updated_at INTEGER, updated_at_ms INTEGER)");
  const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)");
  const row = (id: string, path: string, cwd: string, at: number) => insert.run(id, path, cwd, Math.floor(at), Math.floor(at * 1000));
  row("t-old", helperOld, WORKSPACE, OLD);
  row("t-just", helperJust, WORKSPACE, FRESH);
  row("t-running", helperRunning, WORKSPACE, FRESH);
  row("t-archived", archived, WORKSPACE, OLD);
  row("t-owner", ownerThread, "/home/example/code/app", OLD);
  row("t-escape", join(codex, "sessions", "..", "..", "Dev", "notes.jsonl"), WORKSPACE, OLD);
  row("t-outside", escaped, WORKSPACE, OLD);
  row("t-link", linked, WORKSPACE, OLD);
  row("t-gone", join(sessions, "rollout-gone.jsonl"), WORKSPACE, OLD);
  db.close();
  // An older state database is ignored in favour of the newest.
  file(join(codex, "state_4.sqlite"), OLD, "not a database");
  const before = sha(dbPath);

  const result = await cleanupHelperSessions({ home, helperWorkspace: WORKSPACE, sessionIds: ["t-just"], now: NOW });

  assert.equal(result.codexFiles, 3);
  assert.equal(result.refused, 3);
  assert.equal(existsSync(helperOld), false);
  assert.equal(existsSync(helperJust), false);
  assert.equal(existsSync(archived), false);
  assert.equal(existsSync(helperRunning), true);
  assert.equal(existsSync(ownerThread), true, "the owner's own Codex sessions are never touched");
  assert.equal(existsSync(escaped), true, "paths that leave the session roots are refused");
  assert.equal(existsSync(linked), true);
  assert.equal(sha(dbPath), before, "the database is opened read-only");
});

test("a workspace that is not a dedicated helper directory loses only the sessions of helpers that just ran", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-owner-"));
  const project = join(home, "code", "app");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), "{}");
  for (const workspace of [home, project]) {
    const root = join(home, ".claude", "projects", claudeProjectDirName(workspace));
    const ownersOld = file(join(root, `${UUID(1)}.jsonl`), OLD);
    const helperJustRan = file(join(root, `${UUID(2)}.jsonl`), FRESH);
    const result = await cleanupHelperSessions({ home, helperWorkspace: workspace, sessionIds: [UUID(2)], now: NOW });
    assert.equal(result.sweptByAge, false, workspace);
    assert.equal(existsSync(ownersOld), true, `the owner's sessions under ${workspace} stay`);
    assert.equal(existsSync(helperJustRan), false);
  }
  // "/" and relative paths are refused before anything is read.
  const stray = file(join(home, ".claude", "projects", "-", `${UUID(3)}.jsonl`), OLD);
  for (const workspace of ["/", "relative/path"]) {
    assert.deepEqual(await cleanupHelperSessions({ home, helperWorkspace: workspace, sessionIds: [UUID(3)], now: NOW }), {
      claudeFiles: 0,
      codexFiles: 0,
      refused: 0,
      sweptByAge: false,
    });
  }
  assert.equal(existsSync(stray), true);
});

test("a Claude session directory that is itself a symlink is not followed", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-rootlink-"));
  const elsewhere = join(home, "elsewhere");
  const precious = file(join(elsewhere, `${UUID(1)}.jsonl`), OLD);
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  symlinkSync(elsewhere, join(home, ".claude", "projects", claudeProjectDirName(WORKSPACE)));
  const result = await cleanupHelperSessions({ home, helperWorkspace: WORKSPACE, sessionIds: [UUID(1)], now: NOW });
  assert.equal(result.claudeFiles, 0);
  assert.equal(existsSync(precious), true);
});

test("a Codex helper's tokens and rate-limit use are read from its rollout", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-usage-"));
  const codex = join(home, ".codex");
  const tokenCount = (input: number, used: number) =>
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: 1_000,
            output_tokens: 500,
            reasoning_output_tokens: 300,
            total_tokens: input + 500,
          },
        },
        rate_limits: { primary: { used_percent: used, window_minutes: 10_080, resets_at: 1 }, secondary: null, plan_type: "pro" },
      },
    });
  const rollout = file(
    join(codex, "sessions", "2026", "09", "27", "rollout-x.jsonl"),
    FRESH,
    [JSON.stringify({ type: "session_meta" }), tokenCount(30_000, 4), tokenCount(35_000, 5), ""].join("\n"),
  );
  const db = new DatabaseSync(join(codex, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run("t1", rollout, WORKSPACE);
  db.close();

  assert.deepEqual(await readCodexUsage(home, "t1"), {
    inputTokens: 35_000,
    cachedInputTokens: 1_000,
    outputTokens: 500,
    reasoningOutputTokens: 300,
    totalTokens: 35_500,
    primary: { usedPercent: 5, windowMinutes: 10_080, resetsAt: 1 },
    secondary: null,
    planType: "pro",
  });
  assert.equal(await readCodexUsage(home, "missing"), null);
});

test("anything a helper leaves in its workspace is reported, never deleted", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "tc-ws-"));
  mkdirSync(join(workspace, ".openviking"));
  assert.deepEqual(await unexpectedWorkspaceEntries(workspace), []);
  writeFileSync(join(workspace, "notes.md"), "x");
  assert.deepEqual(await unexpectedWorkspaceEntries(workspace), ["notes.md"]);
  assert.equal(existsSync(join(workspace, "notes.md")), true);
});
