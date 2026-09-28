// SQLite storage: every title the plugin wrote (the only way to tell its
// titles from a person's), per-thread title protection, a log of helper runs
// (time, tokens) for cost and debugging, and the status tracking: the folded
// log facts with their cursor, the derived status, the thread's topic, the
// helper's report on a turn the agent did not report on, the current request
// on the Needs-you page and what the owner did with it (snoozed, hidden).
// The cards table of 0.2 and the dismissals of 0.4 stay for a rollback; the
// dismissals are moved to the requests they hid once (migrateDismissals).
import type Database from "better-sqlite3";
import type { HelperState } from "./card.ts";
import { FACTS_VERSION, type Facts } from "./facts.ts";
import type { Disposition, DispositionKind, RequestRecord } from "./requests.ts";
import type { Execution, Freshness, Requirement, Source, State, View } from "./status.ts";

/** Append-only: never edit or reorder a shipped statement, only add new ones. */
export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS cards (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    area TEXT NOT NULL,
    subject TEXT NOT NULL,
    goal TEXT NOT NULL,
    context TEXT NOT NULL,
    stage TEXT NOT NULL,
    open_question TEXT,
    distinguisher TEXT,
    title TEXT NOT NULL,
    model TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS cards_project ON cards(project_id)`,
  `CREATE TABLE IF NOT EXISTS title_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    title TEXT NOT NULL,
    previous_title TEXT,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS title_history_thread ON title_history(thread_id, id)`,
  `CREATE TABLE IF NOT EXISTS thread_state (
    thread_id TEXT PRIMARY KEY,
    last_processed_seq INTEGER NOT NULL DEFAULT 0,
    user_msgs_at_last_run INTEGER NOT NULL DEFAULT 0,
    idle_since INTEGER,
    last_run_at INTEGER,
    locked INTEGER NOT NULL DEFAULT 0,
    lock_reason TEXT,
    created_title TEXT,
    increments_since_rebuild INTEGER NOT NULL DEFAULT 0,
    identity_candidate TEXT,
    last_error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    mode TEXT NOT NULL,
    dry_run INTEGER NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    helper_thread_id TEXT,
    helper_cwd TEXT,
    wall_ms INTEGER,
    queue_ms INTEGER,
    prompt_chars INTEGER,
    input_tokens INTEGER,
    cached_input_tokens INTEGER,
    output_tokens INTEGER,
    ok INTEGER NOT NULL,
    error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS runs_thread ON runs(thread_id, id)`,
  // Title protection: the title the plugin first saw on the thread, and when.
  `ALTER TABLE thread_state ADD COLUMN baseline_title TEXT`,
  `ALTER TABLE thread_state ADD COLUMN baseline_at INTEGER`,
  `ALTER TABLE thread_state ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0`,
  // A non-terminal stage change waits for the next run to confirm it.
  `ALTER TABLE thread_state ADD COLUMN stage_candidate TEXT`,
  // The idle period the collector already decided on.
  `ALTER TABLE thread_state ADD COLUMN idle_checked_at INTEGER`,
  // Cost measurement: reasoning level, reasoning tokens and the provider's
  // own rate-limit snapshot after the call (Codex rollouts carry it).
  `ALTER TABLE runs ADD COLUMN reasoning_level TEXT`,
  `ALTER TABLE runs ADD COLUMN reasoning_tokens INTEGER`,
  `ALTER TABLE runs ADD COLUMN rate_primary_pct REAL`,
  `ALTER TABLE runs ADD COLUMN rate_primary_window INTEGER`,
  `ALTER TABLE runs ADD COLUMN rate_secondary_pct REAL`,
  `ALTER TABLE runs ADD COLUMN rate_secondary_window INTEGER`,
  // Three stages led by an emoji replace the seven words: ревью waits for
  // the owner's check, готово and брошено close the work, the rest is
  // unfinished. Stages no longer wait a run, so candidates go.
  `UPDATE cards SET stage = CASE stage
     WHEN 'ревью' THEN 'needs_owner'
     WHEN 'готово' THEN 'done'
     WHEN 'брошено' THEN 'done'
     ELSE 'unfinished' END
   WHERE stage NOT IN ('needs_owner', 'unfinished', 'done')`,
  `UPDATE thread_state SET stage_candidate = NULL`,
  // The title style a card's core was written in (TITLE_STYLE in card.ts).
  `ALTER TABLE cards ADD COLUMN style INTEGER NOT NULL DEFAULT 1`,
  // Status tracking: the facts folded from the thread log so far (the
  // cursor is facts.processedSeq), the status derived from them, and the
  // topic the agent's reports set.
  `CREATE TABLE IF NOT EXISTS status_facts (
    thread_id TEXT PRIMARY KEY,
    facts TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS thread_status (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT NOT NULL,
    since INTEGER NOT NULL,
    source TEXT NOT NULL,
    turn_id TEXT,
    settle_until INTEGER,
    need_helper INTEGER NOT NULL DEFAULT 0,
    turns INTEGER NOT NULL DEFAULT 0,
    reported INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS thread_status_settle ON thread_status(settle_until)`,
  `CREATE TABLE IF NOT EXISTS thread_topic (
    thread_id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    set_by TEXT NOT NULL,
    set_at INTEGER NOT NULL
  )`,
  // The helper's last answer (for turn_id, from the log up to basis_seq) and
  // its attempts on the turn it last tried.
  `CREATE TABLE IF NOT EXISTS helper_reports (
    thread_id TEXT PRIMARY KEY,
    turn_id TEXT,
    basis_seq INTEGER,
    state TEXT,
    about TEXT,
    done TEXT,
    stopped_at TEXT,
    at INTEGER,
    model TEXT,
    try_turn_id TEXT,
    tries INTEGER NOT NULL DEFAULT 0,
    tried_at INTEGER,
    error TEXT
  )`,
  // "Забил" in the Needs-you queue: set aside until the thread moves again.
  `CREATE TABLE IF NOT EXISTS dismissals (
    thread_id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    status_key TEXT NOT NULL
  )`,
  // 0.5, the Needs-you queue: where the thread shows, how its work stands,
  // whether the status is confirmed, what the owner is asked, when a queued
  // send goes, which threads it waits on and when it last moved.
  `ALTER TABLE thread_status ADD COLUMN view TEXT`,
  `ALTER TABLE thread_status ADD COLUMN execution TEXT`,
  `ALTER TABLE thread_status ADD COLUMN freshness TEXT NOT NULL DEFAULT 'fresh'`,
  `ALTER TABLE thread_status ADD COLUMN ask TEXT`,
  `ALTER TABLE thread_status ADD COLUMN send_at INTEGER`,
  `ALTER TABLE thread_status ADD COLUMN waiting_on TEXT`,
  `ALTER TABLE thread_status ADD COLUMN activity_at INTEGER`,
  // The current request per thread (lib/requests.ts).
  `CREATE TABLE IF NOT EXISTS requests (
    thread_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    view TEXT NOT NULL,
    source TEXT NOT NULL,
    anchor TEXT NOT NULL,
    open TEXT NOT NULL,
    seen TEXT NOT NULL,
    count INTEGER NOT NULL,
    ask TEXT,
    requested_at INTEGER NOT NULL,
    attention_at INTEGER NOT NULL,
    basis_seq INTEGER,
    active INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // Snoozed or hidden, for one version of the request.
  `CREATE TABLE IF NOT EXISTS dispositions (
    thread_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    kind TEXT NOT NULL,
    until_at INTEGER,
    tz TEXT,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS dispositions_until ON dispositions(until_at)`,
  // What became of a 0.4 dismissal: bound:<turn> (waits for its request),
  // moved, inactive (it no longer hid anything) or unresolved (no turn to
  // bind it to; a note for the owner until they act on the thread's request
  // or it asks anew, hides nothing). migrated_at is the
  // dismissal's own `at` when it was read: after a rollback 0.4.2 updates
  // the row in place, and a new `at` makes it a dismissal to read again.
  `ALTER TABLE dismissals ADD COLUMN migrated TEXT`,
  `ALTER TABLE dismissals ADD COLUMN migrated_at INTEGER`,
  // The helper's answer carries the same optional fields as the agent's report.
  `ALTER TABLE helper_reports ADD COLUMN question_count INTEGER`,
  `ALTER TABLE helper_reports ADD COLUMN waiting_on TEXT`,
];

/** Statements 0.4.2 shipped: a rollback to it runs on the same file. */
export const LEGACY_MIGRATIONS = 27;

export interface ThreadState {
  threadId: string;
  /** The last helper run, finished or failed. */
  lastRunAt: number | null;
  locked: boolean;
  lockReason: string | null;
  createdTitle: string | null;
  lastError: string | null;
  /** The title when the plugin first observed the thread; null if untitled. */
  baselineTitle: string | null;
  /** When the baseline was taken; null means not observed yet. */
  baselineAt: number | null;
  /** The thread existed before the plugin was first enabled. */
  legacy: boolean;
}

export interface StatusRecord {
  threadId: string;
  projectId: string;
  providerId: string;
  state: State;
  reason: string;
  since: number;
  source: Source;
  turnId: string | null;
  settleUntil: number | null;
  needHelper: boolean;
  /** Finished turns seen since tracking began, and those with a report of their own. */
  turns: number;
  reported: number;
  /** When the status was last recomputed (a technical time: never an order). */
  updatedAt: number;
  view: View | null;
  execution: Execution | null;
  freshness: Freshness;
  ask: string | null;
  sendAt: number | null;
  waitingOn: string[];
  /** When the thread last moved in a way that matters (lib/status.ts meaningfulActivityAt). */
  activityAt: number | null;
}

/** A status as the queue's "set aside" remembers it: the same status on the same turn stays set aside. */
export const statusKey = (status: Pick<StatusRecord, "state" | "turnId" | "reason">) =>
  `${status.state}|${status.turnId ?? ""}|${status.reason}`;

export interface TopicRecord {
  topic: string;
  /** agent | helper | migration */
  setBy: string;
  setAt: number;
}

export interface HelperReport {
  /** The turn it describes and the log it read, up to this seq. */
  turnId: string;
  basisSeq: number;
  state: HelperState;
  about: string;
  done: string;
  stoppedAt: string;
  at: number;
  model: string;
  questionCount?: number | null;
  waitingOnThreadIds?: string[] | null;
}

export interface HelperRecord {
  report: HelperReport | null;
  /** The turn of the last attempt, how many attempts it had, the last error. */
  tryTurnId: string | null;
  tries: number;
  triedAt: number | null;
  error: string | null;
}

export interface TitleRecord {
  title: string;
  previousTitle: string | null;
  reason: string;
  at: number;
}

export interface RunRecord {
  threadId: string;
  at: number;
  mode: string;
  dryRun: boolean;
  providerId: string;
  model: string;
  helperThreadId: string | null;
  helperCwd: string | null;
  wallMs: number | null;
  queueMs: number | null;
  promptChars: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  ok: boolean;
  error: string | null;
  reasoningLevel?: string | null;
  reasoningTokens?: number | null;
  ratePrimaryPct?: number | null;
  ratePrimaryWindow?: number | null;
  rateSecondaryPct?: number | null;
  rateSecondaryWindow?: number | null;
}

interface StateRow {
  thread_id: string;
  last_run_at: number | null;
  locked: number;
  lock_reason: string | null;
  created_title: string | null;
  last_error: string | null;
  baseline_title: string | null;
  baseline_at: number | null;
  legacy: number;
}

interface HelperRow {
  turn_id: string | null;
  basis_seq: number | null;
  state: string | null;
  about: string | null;
  done: string | null;
  stopped_at: string | null;
  at: number | null;
  model: string | null;
  try_turn_id: string | null;
  tries: number;
  tried_at: number | null;
  error: string | null;
  question_count: number | null;
  waiting_on: string | null;
}

const parseJson = <T>(text: string | null, fallback: T): T => {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

export function emptyState(threadId: string): ThreadState {
  return {
    threadId,
    lastRunAt: null,
    locked: false,
    lockReason: null,
    createdTitle: null,
    lastError: null,
    baselineTitle: null,
    baselineAt: null,
    legacy: false,
  };
}

export class Store {
  private readonly db: Database.Database;
  constructor(db: Database.Database) {
    this.db = db;
  }

  deleteThread(threadId: string): void {
    for (const table of [
      "cards",
      "thread_state",
      "title_history",
      "runs",
      "status_facts",
      "thread_status",
      "thread_topic",
      "helper_reports",
      "dismissals",
      "requests",
      "dispositions",
    ]) {
      this.db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(threadId);
    }
  }

  getState(threadId: string): ThreadState {
    const row = this.db.prepare(`SELECT * FROM thread_state WHERE thread_id = ?`).get(threadId) as
      | StateRow
      | undefined;
    if (!row) return emptyState(threadId);
    return {
      threadId,
      lastRunAt: row.last_run_at,
      locked: row.locked === 1,
      lockReason: row.lock_reason,
      createdTitle: row.created_title,
      lastError: row.last_error,
      baselineTitle: row.baseline_title,
      baselineAt: row.baseline_at,
      legacy: row.legacy === 1,
    };
  }

  saveState(state: ThreadState): void {
    this.db
      .prepare(
        `INSERT INTO thread_state (thread_id, last_run_at, locked, lock_reason, created_title, last_error,
           baseline_title, baseline_at, legacy)
         VALUES (@threadId, @lastRunAt, @locked, @lockReason, @createdTitle, @lastError, @baselineTitle,
           @baselineAt, @legacy)
         ON CONFLICT(thread_id) DO UPDATE SET last_run_at = excluded.last_run_at, locked = excluded.locked,
           lock_reason = excluded.lock_reason, created_title = excluded.created_title,
           last_error = excluded.last_error, baseline_title = excluded.baseline_title,
           baseline_at = excluded.baseline_at, legacy = excluded.legacy`,
      )
      .run({ ...state, locked: state.locked ? 1 : 0, legacy: state.legacy ? 1 : 0 });
  }

  /** Apply `change` to the stored state (read, modify, write). */
  updateState(threadId: string, change: (state: ThreadState) => Partial<ThreadState>): ThreadState {
    const state = this.getState(threadId);
    const next = { ...state, ...change(state) };
    this.saveState(next);
    return next;
  }

  titleHistory(threadId: string): TitleRecord[] {
    const rows = this.db
      .prepare(
        `SELECT title, previous_title, reason, at FROM title_history WHERE thread_id = ? ORDER BY id`,
      )
      .all(threadId) as { title: string; previous_title: string | null; reason: string; at: number }[];
    return rows.map((row) => ({
      title: row.title,
      previousTitle: row.previous_title,
      reason: row.reason,
      at: row.at,
    }));
  }

  /** Returns the row id, so a write that fails can take its record back. */
  addTitle(threadId: string, record: TitleRecord): number {
    const info = this.db
      .prepare(
        `INSERT INTO title_history (thread_id, title, previous_title, reason, at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(threadId, record.title, record.previousTitle, record.reason, record.at);
    return Number(info.lastInsertRowid);
  }

  deleteTitle(id: number): void {
    this.db.prepare(`DELETE FROM title_history WHERE id = ?`).run(id);
  }

  addRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (thread_id, at, mode, dry_run, provider_id, model, helper_thread_id,
           helper_cwd, wall_ms, queue_ms, prompt_chars, input_tokens, cached_input_tokens,
           output_tokens, ok, error, reasoning_level, reasoning_tokens, rate_primary_pct,
           rate_primary_window, rate_secondary_pct, rate_secondary_window)
         VALUES (@threadId, @at, @mode, @dryRun, @providerId, @model, @helperThreadId, @helperCwd,
           @wallMs, @queueMs, @promptChars, @inputTokens, @cachedInputTokens, @outputTokens, @ok, @error,
           @reasoningLevel, @reasoningTokens, @ratePrimaryPct, @ratePrimaryWindow, @rateSecondaryPct,
           @rateSecondaryWindow)`,
      )
      .run({
        ...run,
        dryRun: run.dryRun ? 1 : 0,
        ok: run.ok ? 1 : 0,
        reasoningLevel: run.reasoningLevel ?? null,
        reasoningTokens: run.reasoningTokens ?? null,
        ratePrimaryPct: run.ratePrimaryPct ?? null,
        ratePrimaryWindow: run.ratePrimaryWindow ?? null,
        rateSecondaryPct: run.rateSecondaryPct ?? null,
        rateSecondaryWindow: run.rateSecondaryWindow ?? null,
      });
  }

  /** Stored facts, or null when there are none or they are of an older shape. */
  getFacts(threadId: string): Facts | null {
    const row = this.db.prepare(`SELECT facts FROM status_facts WHERE thread_id = ?`).get(threadId) as
      | { facts: string }
      | undefined;
    const facts = parseJson<Facts | null>(row?.facts ?? null, null);
    return facts !== null && facts.version === FACTS_VERSION ? facts : null;
  }

  getStatus(threadId: string): StatusRecord | null {
    const row = this.db.prepare(`SELECT * FROM thread_status WHERE thread_id = ?`).get(threadId) as
      | StatusRow
      | undefined;
    return row ? rowToStatus(row) : null;
  }

  getTopic(threadId: string): TopicRecord | null {
    const row = this.db.prepare(`SELECT topic, set_by, set_at FROM thread_topic WHERE thread_id = ?`).get(threadId) as
      | { topic: string; set_by: string; set_at: number }
      | undefined;
    return row ? { topic: row.topic, setBy: row.set_by, setAt: row.set_at } : null;
  }

  /** One recompute's results, all or nothing. */
  saveTracking(
    threadId: string,
    next: { facts: Facts; status: StatusRecord | null; topic: TopicRecord | null; at: number; request?: RequestRecord | null },
  ): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO status_facts (thread_id, facts, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET facts = excluded.facts, updated_at = excluded.updated_at`,
        )
        .run(threadId, JSON.stringify(next.facts), next.at);
      if (next.status) {
        this.db
          .prepare(
            `INSERT INTO thread_status (thread_id, project_id, provider_id, state, reason, since, source, turn_id,
               settle_until, need_helper, turns, reported, updated_at, view, execution, freshness, ask, send_at,
               waiting_on, activity_at)
             VALUES (@threadId, @projectId, @providerId, @state, @reason, @since, @source, @turnId,
               @settleUntil, @needHelper, @turns, @reported, @updatedAt, @view, @execution, @freshness, @ask, @sendAt,
               @waitingOn, @activityAt)
             ON CONFLICT(thread_id) DO UPDATE SET project_id = excluded.project_id,
               provider_id = excluded.provider_id, state = excluded.state, reason = excluded.reason,
               since = excluded.since, source = excluded.source, turn_id = excluded.turn_id,
               settle_until = excluded.settle_until, need_helper = excluded.need_helper,
               turns = excluded.turns, reported = excluded.reported, updated_at = excluded.updated_at,
               view = excluded.view, execution = excluded.execution, freshness = excluded.freshness,
               ask = excluded.ask, send_at = excluded.send_at, waiting_on = excluded.waiting_on,
               activity_at = excluded.activity_at`,
          )
          .run({
            ...next.status,
            needHelper: next.status.needHelper ? 1 : 0,
            waitingOn: next.status.waitingOn.length > 0 ? JSON.stringify(next.status.waitingOn) : null,
          });
      }
      // Undefined: this pass does not decide the request (a partial read, a held status).
      if (next.request !== undefined) {
        if (next.request === null) this.endDismissalBinding(threadId);
        else {
          const previous = this.getRequest(threadId);
          this.saveRequest(next.request);
          // A new request is not the one a 0.4 dismissal without a request was about.
          if (previous !== null && previous.requestId !== next.request.requestId) this.endUnresolvedDismissal(threadId);
          this.bindLegacyDismissal(next.request);
        }
      }
      if (next.topic) {
        this.db
          .prepare(
            `INSERT INTO thread_topic (thread_id, topic, set_by, set_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(thread_id) DO UPDATE SET topic = excluded.topic, set_by = excluded.set_by, set_at = excluded.set_at`,
          )
          .run(threadId, next.topic.topic, next.topic.setBy, next.topic.setAt);
      }
    })();
  }

  /** Forget a thread's status and facts (it was archived or is left alone); the topic stays, its request closes. */
  dropTracking(threadId: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM thread_status WHERE thread_id = ?`).run(threadId);
      this.db.prepare(`DELETE FROM status_facts WHERE thread_id = ?`).run(threadId);
      this.db.prepare(`UPDATE requests SET active = 0 WHERE thread_id = ?`).run(threadId);
    })();
  }

  /** Threads whose status waits for a moment that has come. */
  settleDue(now: number): string[] {
    const rows = this.db
      .prepare(`SELECT thread_id FROM thread_status WHERE settle_until IS NOT NULL AND settle_until <= ?`)
      .all(now) as { thread_id: string }[];
    return rows.map((row) => row.thread_id);
  }

  /** Threads shown as running whose status has not been looked at since `before`. */
  staleRunning(before: number): string[] {
    const rows = this.db
      .prepare(`SELECT thread_id FROM thread_status WHERE state = 'running' AND updated_at < ?`)
      .all(before) as { thread_id: string }[];
    return rows.map((row) => row.thread_id);
  }

  listStatuses(): StatusRecord[] {
    return (this.db.prepare(`SELECT * FROM thread_status`).all() as StatusRow[]).map(rowToStatus);
  }

  /** Tracked threads that wait on this one (their report or a live child names it). */
  dependentsOf(threadId: string): string[] {
    const rows = this.db
      .prepare(`SELECT thread_id FROM thread_status WHERE waiting_on LIKE ? ESCAPE '\\' AND thread_id != ?`)
      .all(`%"${threadId.replace(/[\\%_]/g, (char) => `\\${char}`)}"%`, threadId) as { thread_id: string }[];
    return rows.map((row) => row.thread_id);
  }

  /** Threads whose last turn has no report and has been quiet since `before`. */
  needHelper(before: number): StatusRecord[] {
    return (
      this.db.prepare(`SELECT * FROM thread_status WHERE need_helper = 1 AND since <= ?`).all(before) as StatusRow[]
    ).map(rowToStatus);
  }

  /** Threads the plugin has written a title on. */
  titledThreads(): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT thread_id FROM title_history`).all() as { thread_id: string }[];
    return rows.map((row) => row.thread_id);
  }

  setTopic(threadId: string, topic: TopicRecord): void {
    this.db
      .prepare(
        `INSERT INTO thread_topic (thread_id, topic, set_by, set_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET topic = excluded.topic, set_by = excluded.set_by, set_at = excluded.set_at`,
      )
      .run(threadId, topic.topic, topic.setBy, topic.setAt);
  }

  getHelper(threadId: string): HelperRecord | null {
    const row = this.db.prepare(`SELECT * FROM helper_reports WHERE thread_id = ?`).get(threadId) as HelperRow | undefined;
    if (!row) return null;
    const report: HelperReport | null =
      row.turn_id !== null && row.state !== null
        ? {
            turnId: row.turn_id,
            basisSeq: row.basis_seq ?? 0,
            state: row.state as HelperState,
            about: row.about ?? "",
            done: row.done ?? "",
            stoppedAt: row.stopped_at ?? "",
            at: row.at ?? 0,
            model: row.model ?? "",
            questionCount: row.question_count ?? null,
            waitingOnThreadIds: parseJson<string[] | null>(row.waiting_on ?? null, null),
          }
        : null;
    return { report, tryTurnId: row.try_turn_id, tries: row.tries, triedAt: row.tried_at, error: row.error };
  }

  /** The helper answered for `report.turnId`: its answer replaces the previous one. */
  saveHelperReport(threadId: string, report: HelperReport): void {
    this.db
      .prepare(
        `INSERT INTO helper_reports (thread_id, turn_id, basis_seq, state, about, done, stopped_at, at, model,
           try_turn_id, tries, tried_at, error, question_count, waiting_on)
         VALUES (@threadId, @turnId, @basisSeq, @state, @about, @done, @stoppedAt, @at, @model, @turnId, 1, @at, NULL,
           @questionCount, @waitingOn)
         ON CONFLICT(thread_id) DO UPDATE SET turn_id = excluded.turn_id, basis_seq = excluded.basis_seq,
           state = excluded.state, about = excluded.about, done = excluded.done, stopped_at = excluded.stopped_at,
           at = excluded.at, model = excluded.model,
           tries = CASE WHEN helper_reports.try_turn_id = excluded.try_turn_id THEN helper_reports.tries + 1 ELSE 1 END,
           try_turn_id = excluded.try_turn_id, tried_at = excluded.tried_at, error = NULL,
           question_count = excluded.question_count, waiting_on = excluded.waiting_on`,
      )
      .run({
        threadId,
        turnId: report.turnId,
        basisSeq: report.basisSeq,
        state: report.state,
        about: report.about,
        done: report.done,
        stoppedAt: report.stoppedAt,
        at: report.at,
        model: report.model,
        questionCount: report.questionCount ?? null,
        waitingOn: report.waitingOnThreadIds && report.waitingOnThreadIds.length > 0 ? JSON.stringify(report.waitingOnThreadIds) : null,
      });
  }

  /** An attempt on `turnId` that gave no answer; the previous answer stays. */
  saveHelperFailure(threadId: string, turnId: string, error: string, at: number): void {
    this.db
      .prepare(
        `INSERT INTO helper_reports (thread_id, try_turn_id, tries, tried_at, error) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           tries = CASE WHEN helper_reports.try_turn_id = excluded.try_turn_id THEN helper_reports.tries + 1 ELSE 1 END,
           try_turn_id = excluded.try_turn_id, tried_at = excluded.tried_at, error = excluded.error`,
      )
      .run(threadId, turnId, at, error);
  }

  getRequest(threadId: string): RequestRecord | null {
    const row = this.db.prepare(`SELECT * FROM requests WHERE thread_id = ?`).get(threadId) as RequestRow | undefined;
    return row ? rowToRequest(row) : null;
  }

  listRequests(): RequestRecord[] {
    return (this.db.prepare(`SELECT * FROM requests WHERE active = 1`).all() as RequestRow[]).map(rowToRequest);
  }

  saveRequest(request: RequestRecord): void {
    this.db
      .prepare(
        `INSERT INTO requests (thread_id, request_id, version, view, source, anchor, open, seen, count, ask,
           requested_at, attention_at, basis_seq, active, updated_at)
         VALUES (@threadId, @requestId, @version, @view, @source, @anchor, @open, @seen, @count, @ask,
           @requestedAt, @attentionAt, @basisSeq, @active, @updatedAt)
         ON CONFLICT(thread_id) DO UPDATE SET request_id = excluded.request_id, version = excluded.version,
           view = excluded.view, source = excluded.source, anchor = excluded.anchor, open = excluded.open,
           seen = excluded.seen, count = excluded.count, ask = excluded.ask, requested_at = excluded.requested_at,
           attention_at = excluded.attention_at, basis_seq = excluded.basis_seq, active = excluded.active,
           updated_at = excluded.updated_at`,
      )
      .run({
        ...request,
        open: JSON.stringify(request.open),
        seen: JSON.stringify(request.seen),
        active: request.active ? 1 : 0,
      });
  }

  getDisposition(threadId: string): Disposition | null {
    const row = this.db.prepare(`SELECT * FROM dispositions WHERE thread_id = ?`).get(threadId) as DispositionRow | undefined;
    return row ? rowToDisposition(row) : null;
  }

  listDispositions(): Disposition[] {
    return (this.db.prepare(`SELECT * FROM dispositions`).all() as DispositionRow[]).map(rowToDisposition);
  }

  setDisposition(disposition: Disposition): void {
    this.db
      .prepare(
        `INSERT INTO dispositions (thread_id, request_id, version, kind, until_at, tz, at)
         VALUES (@threadId, @requestId, @version, @kind, @untilAt, @tz, @at)
         ON CONFLICT(thread_id) DO UPDATE SET request_id = excluded.request_id, version = excluded.version,
           kind = excluded.kind, until_at = excluded.until_at, tz = excluded.tz, at = excluded.at`,
      )
      .run(disposition);
  }

  /** Take back what the owner did with this version of the request; true if there was something. */
  clearDisposition(threadId: string, requestId: string, version: number): boolean {
    const info = this.db
      .prepare(`DELETE FROM dispositions WHERE thread_id = ? AND request_id = ? AND version = ?`)
      .run(threadId, requestId, version);
    return info.changes > 0;
  }

  /** Snoozes whose time has come: removed, and returned so their cards can be announced. */
  takeExpiredSnoozes(now: number): Disposition[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(`SELECT * FROM dispositions WHERE kind = 'snoozed' AND until_at IS NOT NULL AND until_at <= ?`)
        .all(now) as DispositionRow[];
      this.db.prepare(`DELETE FROM dispositions WHERE kind = 'snoozed' AND until_at IS NOT NULL AND until_at <= ?`).run(now);
      return rows.map(rowToDisposition);
    })();
  }

  /**
   * 0.4 hid a thread from the queue while its status stayed the same
   * (statusKey). Read before any recompute, a dismissal that still matched
   * its status is bound to the turn behind that status; the thread's first
   * request from that turn takes it over (bindLegacyDismissal). One that no
   * longer matched hid nothing and is not carried over. One whose status has
   * no turn cannot be bound: it is kept as a note on the card and hides nothing. Rows are
   * never deleted, so 0.4.2 reads them as before after a rollback. Running it
   * again does nothing, except for a row 0.4.2 wrote anew after a rollback.
   */
  migrateDismissals(): { bound: number; inactive: number; unresolved: number } {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(`SELECT thread_id, status_key, at FROM dismissals WHERE migrated IS NULL OR migrated_at IS NOT at`)
        .all() as { thread_id: string; status_key: string; at: number }[];
      const counts = { bound: 0, inactive: 0, unresolved: 0 };
      const mark = this.db.prepare(`UPDATE dismissals SET migrated = ?, migrated_at = at WHERE thread_id = ?`);
      for (const row of rows) {
        const status = this.getStatus(row.thread_id);
        const active =
          status !== null && (status.state === "question" || status.state === "waiting") && statusKey(status) === row.status_key;
        if (!active) {
          mark.run("inactive", row.thread_id);
          counts.inactive += 1;
        } else if (status.turnId === null) {
          mark.run("unresolved", row.thread_id);
          counts.unresolved += 1;
        } else {
          mark.run(`bound:${status.turnId}`, row.thread_id);
          counts.bound += 1;
        }
      }
      return counts;
    })();
  }

  /** 0.4 dismissals kept without a request to move to, for the owner to hide again by hand. */
  unresolvedDismissals(): { threadId: string; at: number; statusKey: string }[] {
    const rows = this.db
      .prepare(`SELECT thread_id, at, status_key FROM dismissals WHERE migrated = 'unresolved'`)
      .all() as { thread_id: string; at: number; status_key: string }[];
    return rows.map((row) => ({ threadId: row.thread_id, at: row.at, statusKey: row.status_key }));
  }

  /** A request of the turn a 0.4 dismissal was bound to takes it over; any other request ends the binding. */
  private bindLegacyDismissal(request: RequestRecord): void {
    const row = this.db.prepare(`SELECT migrated, at FROM dismissals WHERE thread_id = ? AND migrated LIKE 'bound:%'`).get(request.threadId) as
      | { migrated: string; at: number }
      | undefined;
    if (!row) return;
    const turnId = row.migrated.slice("bound:".length);
    const mark = this.db.prepare(`UPDATE dismissals SET migrated = ? WHERE thread_id = ?`);
    const sameTurn = request.active && (request.anchor === turnId || request.anchor === `unread:${turnId}`);
    if (!sameTurn) {
      mark.run("inactive", request.threadId);
      return;
    }
    this.setDisposition({
      threadId: request.threadId,
      requestId: request.requestId,
      version: request.version,
      kind: "dismissed",
      untilAt: null,
      tz: null,
      at: row.at,
    });
    mark.run("moved", request.threadId);
  }

  /** The thread has no request at all: it moved on, and a 0.4 dismissal hid nothing. */
  endDismissalBinding(threadId: string): void {
    this.db
      .prepare(`UPDATE dismissals SET migrated = 'inactive' WHERE thread_id = ? AND (migrated LIKE 'bound:%' OR migrated = 'unresolved')`)
      .run(threadId);
  }

  /** The owner acted on the thread's request, or it asked anew: the note on its 0.4 dismissal is done. */
  endUnresolvedDismissal(threadId: string): void {
    this.db.prepare(`UPDATE dismissals SET migrated = 'inactive' WHERE thread_id = ? AND migrated = 'unresolved'`).run(threadId);
  }

  /** Helper runs since `after`: count, failures and tokens, for stats. */
  runsSince(after: number): { runs: number; failed: number; inputTokens: number; outputTokens: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS runs, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed,
           COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output
         FROM runs WHERE at > ? AND dry_run = 0`,
      )
      .get(after) as { runs: number; failed: number | null; input: number; output: number };
    return { runs: row.runs, failed: row.failed ?? 0, inputTokens: row.input, outputTokens: row.output };
  }
}

interface StatusRow {
  thread_id: string;
  project_id: string;
  provider_id: string;
  state: string;
  reason: string;
  since: number;
  source: string;
  turn_id: string | null;
  settle_until: number | null;
  need_helper: number;
  turns: number;
  reported: number;
  updated_at: number;
  view: string | null;
  execution: string | null;
  freshness: string | null;
  ask: string | null;
  send_at: number | null;
  waiting_on: string | null;
  activity_at: number | null;
}

interface RequestRow {
  thread_id: string;
  request_id: string;
  version: number;
  view: string;
  source: string;
  anchor: string;
  open: string;
  seen: string;
  count: number;
  ask: string | null;
  requested_at: number;
  attention_at: number;
  basis_seq: number | null;
  active: number;
  updated_at: number;
}

interface DispositionRow {
  thread_id: string;
  request_id: string;
  version: number;
  kind: string;
  until_at: number | null;
  tz: string | null;
  at: number;
}

const rowToRequest = (row: RequestRow): RequestRecord => ({
  threadId: row.thread_id,
  requestId: row.request_id,
  version: row.version,
  view: row.view as View,
  source: row.source as RequestRecord["source"],
  anchor: row.anchor,
  open: parseJson<Requirement[]>(row.open, []),
  seen: parseJson<string[]>(row.seen, []),
  count: row.count,
  ask: row.ask,
  requestedAt: row.requested_at,
  attentionAt: row.attention_at,
  basisSeq: row.basis_seq,
  active: row.active === 1,
  updatedAt: row.updated_at,
});

const rowToDisposition = (row: DispositionRow): Disposition => ({
  threadId: row.thread_id,
  requestId: row.request_id,
  version: row.version,
  kind: row.kind as DispositionKind,
  untilAt: row.until_at,
  tz: row.tz,
  at: row.at,
});

const rowToStatus = (row: StatusRow): StatusRecord => ({
  threadId: row.thread_id,
  projectId: row.project_id,
  providerId: row.provider_id,
  state: row.state as State,
  reason: row.reason,
  since: row.since,
  source: row.source as Source,
  turnId: row.turn_id,
  settleUntil: row.settle_until,
  needHelper: row.need_helper === 1,
  turns: row.turns,
  reported: row.reported,
  updatedAt: row.updated_at,
  view: (row.view as View | null) ?? null,
  execution: (row.execution as Execution | null) ?? null,
  freshness: (row.freshness as Freshness | null) ?? "fresh",
  ask: row.ask ?? null,
  sendAt: row.send_at ?? null,
  waitingOn: parseJson<string[]>(row.waiting_on ?? null, []),
  activityAt: row.activity_at ?? null,
});
