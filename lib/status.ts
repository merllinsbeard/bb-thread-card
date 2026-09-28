// The thread's status, by one rule: who makes the next step. ⏳ the thread
// works or will go on by itself, ❓ the owner, ⛔ someone else, ✅ nobody,
// and no mark while that is not known. It is a pure function of the thread
// log's facts and bb's live state: while the thread runs bb decides; once it
// stops, the newest report does, as long as no input (a message, a steer,
// an answer to a request) came after it. Turns without input (a background
// task woke the thread, a context compaction) keep the report before them.
// Without a report that holds, the helper reads the thread and its answer
// counts as a report; until it answers the status is being clarified. The
// first rule that matches wins.
//
// Beside the state it says where the thread belongs on the Needs-you page
// (`view`): a request to the owner, a wait on someone else, or work that
// stopped without anyone asked (an error, a stop, a status nobody could
// read). A stop or an error is not a question to the owner: the owner sees
// it among the stopped threads, not in the count of requests. For each such
// place it names the request's basis: the working turn it comes from and the
// requirements in it, so a technical recompute never makes a new request and
// a new question after an answer always does (lib/requests.ts).
import { labelText, type Facts, type TurnFact } from "./facts.ts";
import type { ReportState } from "./report.ts";

export type State = "running" | "question" | "waiting" | "done" | "unknown";
export type Source = "bb" | "agent" | "helper" | "none";
/** How the work itself stands, beside the state. */
export type Execution = "active" | "queued" | "failed" | "stoppedByOwner" | "interrupted" | "sendFailed";
/** Whether the status is confirmed, being clarified, or could not be determined. */
export type Freshness = "fresh" | "checking" | "unavailable";
/** Where the thread shows on the Needs-you page. */
export type View = "needs" | "waiting" | "stopped";

export const STATE_EMOJI: Record<State, string> = {
  running: "⏳",
  question: "❓",
  waiting: "⛔",
  done: "✅",
  unknown: "",
};

/** How long a failed turn waits for provider-retry to queue its retry (it does so at once). */
export const SETTLE_MS = 15_000;
/** A turn the log never ended, although bb says the thread stopped, is given up on after this long. */
export const UNENDED_MS = 60_000;
/** An agent that said it would go on by itself and has not, this long after, is shown as stopped. */
export const CONTINUE_MS = 3 * 3_600_000;
/** Helper runs on one turn before the status is given up on. */
export const HELPER_TRIES = 3;

const RUNNING_STATUSES = new Set(["active", "starting", "stopping", "pending"]);
/** A pending child is scheduled or an unsent draft: nothing to wait for yet. */
const LIVE_CHILD_STATUSES = new Set(["active", "starting", "stopping"]);

export interface QueuedRow {
  id?: string;
  createdAt?: number;
  sendAt: number | null;
  failureReason: string | null;
  retry: boolean;
}

export interface Live {
  /** bb's thread status: idle, active, starting, stopping, pending, error. */
  status: string;
  queue: readonly QueuedRow[];
}

/** A report as the status reads it: the agent's own, or the helper's for a turn the agent did not report on. */
export interface Report {
  state: ReportState;
  done: string;
  stoppedAt: string;
  /** Where it sits in the log: the report's own seq, or the last seq the helper read (inclusive). */
  seq: number;
  turnId: string;
  at: number;
  source: "agent" | "helper";
  questionCount?: number | null;
  waitingOnThreadIds?: readonly string[] | null;
}

/** One thing the owner is asked or waits for, keyed so the same thing read again is recognised. */
export interface Requirement {
  key: string;
  /** When it appeared in the log. */
  at: number;
}

/** What a request (or a wait, or a stop) on the page rests on. */
export interface RequestBasis {
  /** Stable within the thread: the working turn it comes from, or the first event of it. */
  anchor: string;
  source: "interaction" | "agent" | "helper" | "bb";
  requirements: Requirement[];
  /** How many separate things are asked. */
  count: number;
  basisSeq: number | null;
}

export interface Derived {
  state: State;
  reason: string;
  since: number;
  source: Source;
  /** The turn whose report or end decided the status. */
  turnId: string | null;
  /** Look again at this time: a failed turn may still get its retry, a promise to go on may run out. */
  settleUntil: number | null;
  /** Keep the previous status until `settleUntil`: the facts are not final yet. */
  hold: boolean;
  /** No report holds for the last turn: the helper should read the thread. */
  needHelper: boolean;
  /** A done report: a live child thread turns it into waiting (see withChildren). */
  checkChildren: boolean;
  view: View | null;
  execution: Execution | null;
  freshness: Freshness;
  /** What the owner is asked, in the agent's words (view needs). */
  ask: string | null;
  request: RequestBasis | null;
  /** When a queued retry or message goes out. */
  sendAt: number | null;
  /** bb threads this one waits on. */
  waitingOn: string[];
}

/** HH:MM today, DD.MM HH:MM on another day. */
const clock = (at: number, now: number) => {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === new Date(now).toDateString() ? time : `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${time}`;
};

const result = (partial: Partial<Derived> & Pick<Derived, "state" | "reason" | "since">): Derived => ({
  source: "bb",
  turnId: null,
  settleUntil: null,
  hold: false,
  needHelper: false,
  checkChildren: false,
  view: null,
  execution: null,
  freshness: "fresh",
  ask: null,
  request: null,
  sendAt: null,
  waitingOn: [],
  ...partial,
});

const INTERRUPTS: Record<string, string> = {
  "host-daemon-restarted": "Turn cut off by a bb restart",
  "provider-turn-idle": "Turn cut off: the agent went silent",
};

/** "1 question", "2 questions". */
export function questions(count: number): string {
  return `${count} ${count === 1 ? "question" : "questions"}`;
}

/** A provider error often comes as its JSON body (cut short): show its message. */
export function readableError(text: string): string {
  const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
  if (!text.trimStart().startsWith("{") || message === undefined) return text;
  return message.replace(/\\(["\\/])/g, "$1").replace(/\\n/g, " ");
}

/** bb's own mention of a thread in text (`@thread:thr_…`): a structured reference, not a guess. */
export function mentionedThreads(text: string): string[] {
  return [...text.matchAll(/@thread:(thr_[a-z0-9]+)/g)].map((match) => match[1]!);
}

/** The agent's newest report as the status reads it. */
export function agentReport(facts: Facts): Report | null {
  const report = facts.lastReport;
  if (report === null) return null;
  return {
    state: report.state,
    done: report.done,
    stoppedAt: report.stoppedAt,
    seq: report.seq,
    turnId: report.turnId,
    at: report.at,
    source: "agent",
    questionCount: report.questionCount ?? null,
    waitingOnThreadIds: report.waitingOnThreadIds ?? null,
  };
}

/**
 * Does the report still say where the thread stands? Not once an input came
 * after it; a promise to go on by itself not once another turn began.
 */
function holds(report: Report, facts: Facts): boolean {
  // An input at the report's own seq is one the helper already read.
  if (report.seq < (facts.lastInputSeq ?? -1)) return false;
  if (report.state === "continuing" && facts.turns.at(-1)?.id !== report.turnId) return false;
  return true;
}

/** The threads a report says it waits on, without the thread itself and repeats. */
function waitingOf(report: Report, threadId: string | null): string[] {
  const ids = [...(report.waitingOnThreadIds ?? []), ...mentionedThreads(report.stoppedAt)];
  return [...new Set(ids)].filter((id) => id !== threadId);
}

function fromReport(report: Report, facts: Facts, now: number, threadId: string | null): Derived {
  const turn = facts.turns.find((item) => item.id === report.turnId);
  // The helper reads a turn after it ended: its answer dates from the turn, not from the helper's run.
  const at = report.source === "agent" ? report.at : (turn?.endAt ?? report.at);
  const common = { since: turn?.endAt ?? report.at, source: report.source, turnId: report.turnId };
  // One requirement per answer boundary: reading the same turn again is the same requirement.
  const requirement = (view: View): Requirement => ({ key: `${view}:r:${report.turnId}:${facts.lastInputSeq ?? 0}`, at });
  const basis = (view: View, count = 1): RequestBasis => ({
    anchor: report.turnId,
    source: report.source,
    requirements: [requirement(view)],
    count,
    basisSeq: report.seq,
  });
  switch (report.state) {
    case "question": {
      const count = report.questionCount ?? 1;
      return result({
        ...common,
        state: "question",
        reason: report.stoppedAt || "Reply needed",
        view: "needs",
        ask: report.stoppedAt || "Answer the agent",
        request: basis("needs", count),
      });
    }
    case "waiting":
      return result({
        ...common,
        state: "waiting",
        reason: report.stoppedAt || "Waiting on others",
        view: "waiting",
        request: basis("waiting"),
        waitingOn: waitingOf(report, threadId),
      });
    case "continuing": {
      const until = report.at + CONTINUE_MS;
      if (now >= until) {
        return result({
          ...common,
          state: "unknown",
          reason: `Said it would go on by itself, silent since ${clock(report.at, now)}`,
          view: "stopped",
          execution: "interrupted",
          request: { anchor: report.turnId, source: report.source, requirements: [{ key: `stopped:silent:${report.turnId}`, at: until }], count: 1, basisSeq: report.seq },
        });
      }
      return result({ ...common, state: "running", reason: `Goes on by itself: ${report.stoppedAt || "background task"}`, settleUntil: until });
    }
    default:
      return result({ ...common, state: "done", reason: report.done || report.stoppedAt || "Done", checkChildren: true });
  }
}

/** A stop that is nobody's question: an error, an interruption, a status nobody could read. */
function stopped(
  reason: string,
  execution: Execution | null,
  anchor: string,
  at: number,
  extra: Partial<Derived> = {},
): Derived {
  return result({
    state: "unknown",
    reason,
    since: at,
    view: "stopped",
    execution,
    request: { anchor, source: "bb", requirements: [{ key: `stopped:${execution ?? "status"}:${anchor}`, at }], count: 1, basisSeq: null },
    ...extra,
  });
}

/** When the thread last moved in a way that matters: input, a new request, a turn's start or end, a queued send. */
export function meaningfulActivityAt(facts: Facts, live: Live): number | null {
  const times: number[] = [];
  if (typeof facts.lastInputAt === "number") times.push(facts.lastInputAt);
  const last: TurnFact | undefined = facts.turns.at(-1);
  if (last) times.push(last.endAt ?? last.startAt);
  for (const open of facts.interactions) times.push(open.since);
  for (const row of live.queue) if (typeof row.createdAt === "number") times.push(row.createdAt);
  return times.length === 0 ? null : Math.max(...times);
}

export function deriveStatus(args: {
  facts: Facts;
  live: Live;
  now: number;
  settleMs?: number;
  /** Other reports that may speak for the thread (the helper's). */
  reports?: readonly (Report | null)[];
  /** The turn the helper tried HELPER_TRIES times without an answer. */
  helperGaveUpOn?: string | null;
  /** The thread itself, so a report that names it is not read as waiting on itself. */
  threadId?: string | null;
}): Derived {
  const { facts, live, now } = args;
  const threadId = args.threadId ?? null;
  const settleMs = args.settleMs ?? SETTLE_MS;
  const last = facts.turns.at(-1) ?? null;
  // "pending" is work only when an accepted message is about to start a turn.
  // A queued first message waits for its time (the queue below says so), and
  // a thread with no turn and nothing queued is an unsent draft.
  const running = RUNNING_STATUSES.has(live.status) && !(live.status === "pending" && (live.queue.length > 0 || last === null));
  const newest = [agentReport(facts), ...(args.reports ?? [])]
    .filter((report): report is Report => report !== null)
    .sort((a, b) => b.seq - a.seq)[0];
  const holding = newest !== undefined && holds(newest, facts) ? newest : null;

  // 1. A request to the owner is open: an approval or a question form. It
  // stays the owner's while the agent works or errs beside it.
  const open = facts.interactions;
  if (open.length > 0) {
    const first = open[0]!;
    const labels = open.map((item) => labelText(item.label));
    const ask = open.length === 1 ? labels[0]! : `${questions(open.length)}: ${labels.join("; ")}`;
    return result({
      state: "question",
      reason: labels[0]!,
      since: first.since,
      turnId: first.turnId,
      view: "needs",
      execution: running ? "active" : null,
      ask,
      request: {
        anchor: first.turnId ?? `i:${first.id}`,
        source: "interaction",
        requirements: open.map((item) => ({ key: `needs:i:${item.id}`, at: item.since })),
        count: open.length,
        basisSeq: null,
      },
    });
  }

  // 2. The thread works.
  if (running) {
    return result({ state: "running", reason: "Working", since: last && last.endSeq === null ? last.startAt : now, turnId: last?.id ?? null, execution: "active" });
  }

  // 3. The queue. A message that failed to send leaves an open question
  // open (the owner's answer did not go); otherwise the work stopped on it.
  // A retry or a scheduled message waits for its time; any other row runs
  // the thread at once.
  const failedRow = live.queue.find((row) => row.failureReason !== null);
  if (failedRow) {
    const failure = failedRow.failureReason ?? "unknown error";
    if (holding?.state === "question") {
      const asked = fromReport(holding, facts, now, threadId);
      return { ...asked, reason: `Your answer failed to send: ${failure}`, execution: "sendFailed" };
    }
    const anchor = `q:${failedRow.id ?? last?.id ?? "send"}`;
    return stopped(`Message failed to send: ${failure}`, "sendFailed", anchor, failedRow.createdAt ?? facts.lastEventAt, { turnId: last?.id ?? null });
  }
  const retry = live.queue.find((row) => row.retry);
  if (retry) {
    return result({
      state: "running",
      reason: retry.sendAt ? `Retry scheduled for ${clock(retry.sendAt, now)}` : "Retry queued",
      since: retry.createdAt ?? now,
      turnId: last?.id ?? null,
      view: "waiting",
      execution: "queued",
      sendAt: retry.sendAt,
      request: queued(retry, last),
    });
  }
  const waitingRow = live.queue[0];
  if (waitingRow) {
    const later = waitingRow.sendAt !== null && waitingRow.sendAt > now;
    return result({
      state: "running",
      reason: later ? `Message scheduled for ${clock(waitingRow.sendAt!, now)}` : "Message queued",
      since: waitingRow.createdAt ?? now,
      turnId: last?.id ?? null,
      execution: "queued",
      sendAt: waitingRow.sendAt,
      ...(later ? { view: "waiting" as const, request: queued(waitingRow, last) } : {}),
    });
  }

  if (last === null) {
    return live.status === "error"
      ? stopped("Thread failed", "failed", "thread", facts.lastEventAt || now)
      : result({ state: "unknown", reason: "No turns yet", since: now, source: "none" });
  }

  // 4. The thread stopped but its last turn has not ended in the log: the end is on its way, or was lost.
  if (last.endSeq === null) {
    const until = facts.lastEventAt + UNENDED_MS;
    if (now < until) {
      return result({ state: "unknown", reason: "Turn finishing", since: now, source: "none", turnId: last.id, settleUntil: until, hold: true, freshness: "checking" });
    }
    return stopped("Turn ended without finishing", "interrupted", last.id, facts.lastEventAt, { turnId: last.id });
  }

  // 5. It failed or was stopped: give provider-retry its moment, then it is shown as stopped.
  if (last.status === "failed") {
    const end = last.endAt ?? now;
    if (now < end + settleMs) {
      return result({ state: "unknown", reason: "Turn failed, waiting for a retry", since: end, source: "none", turnId: last.id, settleUntil: end + settleMs, hold: true, freshness: "checking" });
    }
    return stopped(`Run failed: ${last.error ? readableError(last.error) : "unknown error"}`, "failed", last.id, end, { turnId: last.id });
  }
  if (last.status === "interrupted") {
    const end = last.endAt ?? now;
    if (last.interruptReason === "manual-stop") return stopped("Stopped by you", "stoppedByOwner", last.id, end, { turnId: last.id });
    return stopped(INTERRUPTS[last.interruptReason ?? ""] ?? "Interrupted", "interrupted", last.id, end, { turnId: last.id });
  }
  if (live.status === "error") return stopped("Thread failed", "failed", last.id, last.endAt ?? now, { turnId: last.id });

  // 6. The newest report, while nothing came in after it.
  if (holding) return fromReport(holding, facts, now, threadId);

  // 7. No report speaks for the thread since its last input: the helper reads it, or gave up.
  const since = last.endAt ?? now;
  if (args.helperGaveUpOn === last.id) {
    return stopped("Status unavailable: the agent did not report and the helper could not read the thread", null, `unread:${last.id}`, since, {
      turnId: last.id,
      freshness: "unavailable",
    });
  }
  return result({ state: "unknown", reason: "The agent did not report", since, source: "none", turnId: last.id, needHelper: true, freshness: "checking" });
}

/** A retry or a scheduled message: its row and its time make the wait. */
function queued(row: QueuedRow, last: TurnFact | null): RequestBasis {
  const anchor = `q:${row.id ?? last?.id ?? "queued"}`;
  return {
    anchor,
    source: "bb",
    requirements: [{ key: `waiting:${anchor}:${row.sendAt ?? ""}`, at: row.createdAt ?? row.sendAt ?? 0 }],
    count: 1,
    basisSeq: null,
  };
}

/** A done thread with a live child thread still waits for it. */
export function withChildren(derived: Derived, children: readonly { id?: string; title: string | null; status: string }[]): Derived {
  if (derived.state !== "done") return derived;
  const live = children.find((child) => LIVE_CHILD_STATUSES.has(child.status));
  if (!live) return derived;
  const anchor = derived.turnId ?? "children";
  return {
    ...derived,
    state: "waiting",
    reason: `Waiting for child thread: ${live.title ?? "untitled"}`,
    view: "waiting",
    waitingOn: live.id ? [live.id] : [],
    request: {
      anchor,
      source: derived.source === "helper" ? "helper" : derived.source === "agent" ? "agent" : "bb",
      requirements: [{ key: `waiting:c:${anchor}:${live.id ?? live.title ?? ""}`, at: derived.since }],
      count: 1,
      basisSeq: null,
    },
  };
}
