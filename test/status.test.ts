// The status rule table: sequences of thread-log events and bb's live state
// → who makes the next step. Pure: the log is folded into facts, the facts
// and the live state give the status.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { emptyFacts, foldEvents, type Facts } from "../lib/facts.ts";
import { REPORT_TOOL } from "../lib/report.ts";
import { CONTINUE_MS, UNENDED_MS, deriveStatus, readableError, withChildren, type Live, type QueuedRow } from "../lib/status.ts";

const T0 = Date.UTC(2026, 8, 27, 12, 0, 0);

/** A thread log written the way bb writes it: turn-scoped events with seq and time. */
function log() {
  const events: Record<string, unknown>[] = [];
  let seq = 0;
  let turns = 0;
  let turn: string | null = null;
  let at = T0;
  const push = (type: string, data: Record<string, unknown>, scoped = true) => {
    seq += 1;
    at += 1_000;
    events.push({ seq, type, createdAt: at, scope: scoped && turn ? { kind: "turn", turnId: turn } : { kind: "thread" }, data });
  };
  const api = {
    events,
    get at() {
      return at;
    },
    /** A message: starts a turn, or is steered into the running one. */
    say(initiator = "user", kind = "unlabeled") {
      const requestId = `creq_${seq + 1}`;
      push("client/turn/requested", { requestId, initiator, systemMessageKind: kind }, false);
      if (turn === null) {
        turns += 1;
        turn = `t${turns}`;
        push("turn/started", {});
      }
      push("turn/input/accepted", { clientRequestId: requestId });
      return api;
    },
    /** A turn with no input: a background task woke the thread. */
    wake() {
      turns += 1;
      turn = `t${turns}`;
      push("turn/started", {});
      return api;
    },
    /** A subagent's turn inside the running one (Codex delegation), with its own end. */
    subagent(status = "completed") {
      const outer = turn;
      turns += 1;
      turn = `t${turns}`;
      push("turn/started", { parentToolCallId: `${outer}-i${seq}` });
      push("turn/completed", { status });
      turn = outer;
      return api;
    },
    /** A turn with no input: a context compaction bb starts itself. */
    compaction() {
      turns += 1;
      turn = `t${turns}`;
      push("turn/started", {});
      push("thread/compacted", {});
      return api;
    },
    report(state: string, stoppedAt = "", extra: Record<string, unknown> = {}) {
      push("item/started", {
        item: { type: "toolCall", id: `${turn}-i${seq + 1}`, server: "bb", tool: REPORT_TOOL, arguments: { state, about: "Настроить Codex для Hermes", done: "сделано", stoppedAt, ...extra } },
      });
      return api;
    },
    question(id: string, status: string) {
      push("system/interaction/lifecycle", {
        interaction: { id, status, payload: { kind: "user_question", questions: [{ prompt: "Какой токен?" }] } },
      });
      return api;
    },
    ask(id: string, status: string) {
      push("system/interaction/lifecycle", {
        interaction: { id, status, payload: { kind: "approval", subject: { kind: "command" } } },
      });
      return api;
    },
    error(detail: string) {
      push("provider/error", { message: "Provider error", detail });
      return api;
    },
    stop(reason: string) {
      push("system/thread/interrupted", { reason }, false);
      return api;
    },
    /** Time passes with nothing in the log. */
    pause(ms: number) {
      at += ms;
      return api;
    },
    end(status = "completed") {
      push("turn/completed", { status });
      turn = null;
      return api;
    },
  };
  return api;
}

const idle: Live = { status: "idle", queue: [] };
const facts = (events: readonly unknown[]): Facts => foldEvents(emptyFacts(), events);
const statusOf = (events: readonly unknown[], live: Live = idle, now = T0 + 3_600_000) => deriveStatus({ facts: facts(events), live, now });

test("the agent's report on the last turn decides: done ✅, question ❓, waiting ⛔", () => {
  for (const state of ["question", "waiting"] as const) {
    const status = statusOf(log().say().report(state, "Ждём ревьюера").end().events);
    assert.equal(status.state, state);
    assert.equal(status.source, "agent");
    assert.equal(status.reason, "Ждём ревьюера");
  }
  // ✅ says what was done; where the result is stays in the card.
  const done = statusOf(log().say().report("done", "PR #12").end().events);
  assert.equal(done.state, "done");
  assert.equal(done.reason, "сделано");
});

test("an agent that goes on by itself is ⏳ until the thread moves, and ❓ if it never does", () => {
  const thread = log().say().report("continuing", "жду сборку, проснусь по её концу").end();
  const status = statusOf(thread.events, idle, thread.at + 60_000);
  assert.equal(status.state, "running");
  assert.equal(status.reason, "Goes on by itself: жду сборку, проснусь по её концу");
  assert.equal(status.settleUntil, thread.at - 1_000 + CONTINUE_MS);
  assert.match(statusOf(thread.events, idle, thread.at + CONTINUE_MS).reason, /^Said it would go on by itself, silent since /);
  // It woke up and ended the turn without a word: the helper reads it.
  assert.equal(statusOf(thread.wake().end().events).needHelper, true);
});

test("turns without input (a background task woke the thread) keep the report before them", () => {
  const thread = log().say().report("waiting", "CI").end().wake().end().wake().end();
  assert.equal(statusOf(thread.events).state, "waiting");
  assert.equal(statusOf(thread.events).reason, "CI");
  // A message is input: without a new report the thread needs the helper.
  assert.equal(statusOf(thread.say().end().events).needHelper, true);
});

test("the owner's answer to a request is input: the question report before it no longer holds", () => {
  const thread = log().say().report("question", "Нужен токен").question("pint_1", "pending").question("pint_1", "resolved").end();
  assert.equal(statusOf(thread.events).state, "unknown");
  assert.equal(statusOf(thread.events).needHelper, true);
});

test("a stopped thread whose last turn never ended in the log is held a minute, then shown as broken off", () => {
  const thread = log().say().report("done");
  const early = statusOf(thread.events, idle, thread.at + 5_000);
  assert.equal(early.hold, true);
  assert.equal(early.freshness, "checking");
  assert.equal(early.settleUntil, thread.at + UNENDED_MS);
  const late = statusOf(thread.events, idle, thread.at + UNENDED_MS);
  assert.deepEqual([late.state, late.view, late.execution, late.reason], ["unknown", "stopped", "interrupted", "Turn ended without finishing"]);
});

test("a retry on another day says the date", () => {
  const thread = log().say().error("You've hit your usage limit").end("failed");
  const retry: QueuedRow = { sendAt: thread.at + 3 * 86_400_000, failureReason: null, retry: true };
  assert.match(statusOf(thread.events, { status: "error", queue: [retry] }, thread.at + 5_000).reason, /^Retry scheduled for \d\d\.\d\d \d\d:\d\d$/);
});

test("a subagent's turns inside the running one are not the thread's turns", () => {
  const thread = log().say().subagent().subagent("interrupted").report("done").subagent().end();
  const facts = foldEvents(emptyFacts(), thread.events);
  assert.deepEqual(
    facts.turns.map((turn) => turn.id),
    ["t1"],
  );
  assert.equal(statusOf(thread.events).state, "done");
});

test("a request to the owner is ❓ at once, and ⏳ again once he answers", () => {
  const thread = log().say().ask("pint_1", "pending");
  const running: Live = { status: "active", queue: [] };
  assert.equal(statusOf(thread.events, running).state, "question");
  assert.match(statusOf(thread.events, running).reason, /Approve a command/);
  thread.ask("pint_1", "resolving");
  assert.equal(statusOf(thread.events, running).state, "running");
  // A request its turn left open closes with the turn.
  const stopped = log().say().ask("pint_2", "pending").end("interrupted");
  assert.equal(statusOf(stopped.events).reason, "Interrupted");
});

test("a message to a ✅ thread makes it ⏳ while it runs; the new turn's report then decides", () => {
  const thread = log().say().report("done").end().say();
  assert.equal(statusOf(thread.events, { status: "active", queue: [] }).state, "running");
  thread.report("question", "Нужен токен").end();
  assert.equal(statusOf(thread.events).state, "question");
});

test("a report followed by a steer in the same turn no longer holds; neither does an earlier turn's report", () => {
  const steered = log().say().report("done").say().end();
  assert.equal(statusOf(steered.events).state, "unknown");
  assert.equal(statusOf(steered.events).needHelper, true);

  const unreported = log().say().report("done").end().say().end();
  assert.equal(statusOf(unreported.events).state, "unknown");
  assert.equal(statusOf(unreported.events).needHelper, true);

  // Reporting again after the steer holds.
  assert.equal(statusOf(log().say().report("done").say().report("waiting", "CI").end().events).state, "waiting");
});

test("a turn that only compacted the context keeps the report before it", () => {
  assert.equal(statusOf(log().say().report("waiting", "CI").end().compaction().end().events).state, "waiting");
  assert.equal(statusOf(log().say().end().compaction().end().events).state, "unknown");
});

test("a failed turn waits for provider-retry, shows the retry as a wait, and otherwise shows as stopped", () => {
  const thread = log().say().error("You've hit your session limit").end("failed");
  const end = thread.at;
  const early = statusOf(thread.events, { status: "error", queue: [] }, end + 5_000);
  assert.equal(early.hold, true);
  assert.equal(early.settleUntil, end + 15_000);

  const retry: QueuedRow = { id: "q1", createdAt: end + 1_000, sendAt: end + 600_000, failureReason: null, retry: true };
  const retrying = statusOf(thread.events, { status: "error", queue: [retry] }, end + 5_000);
  assert.deepEqual([retrying.state, retrying.view, retrying.execution, retrying.sendAt], ["running", "waiting", "queued", end + 600_000]);
  assert.match(retrying.reason, /^Retry scheduled for \d\d:\d\d$/);
  // The wait dates from the retry being queued, not from the recompute.
  assert.equal(retrying.request?.requirements[0]?.at, end + 1_000);

  const late = statusOf(thread.events, { status: "error", queue: [] }, end + 20_000);
  assert.deepEqual([late.state, late.view, late.execution], ["unknown", "stopped", "failed"]);
  assert.equal(late.reason, "Run failed: You've hit your session limit");
  assert.equal(late.request?.anchor, "t1");
});

test("a turn the owner stopped is shown as stopped by him, not as a question; so is a message that failed to send", () => {
  const stopped = statusOf(log().say().report("done").stop("manual-stop").end("interrupted").events);
  assert.deepEqual([stopped.state, stopped.view, stopped.execution, stopped.reason], ["unknown", "stopped", "stoppedByOwner", "Stopped by you"]);

  const failedSend: QueuedRow = { id: "q1", createdAt: T0, sendAt: null, failureReason: "provider unavailable", retry: false };
  const unsent = statusOf(log().say().report("done").end().events, { status: "idle", queue: [failedSend] });
  assert.deepEqual([unsent.state, unsent.view, unsent.execution], ["unknown", "stopped", "sendFailed"]);
  assert.equal(unsent.reason, "Message failed to send: provider unavailable");

  // The owner's answer to an open question failed to send: the question stays open, with the reason.
  const asked = log().say().report("question", "Выбери вариант обложки").end();
  const open = statusOf(asked.events);
  const unanswered = statusOf(asked.events, { status: "idle", queue: [failedSend] });
  assert.deepEqual([unanswered.state, unanswered.view, unanswered.execution], ["question", "needs", "sendFailed"]);
  assert.equal(unanswered.ask, "Выбери вариант обложки");
  assert.equal(unanswered.reason, "Your answer failed to send: provider unavailable");
  assert.deepEqual(unanswered.request, open.request, "the same request, not a new one");
});

test("a Stop announced just before the steered turn starts ends that turn as the owner's stop", () => {
  // bb announced the stop between turns, then the message it raced started a turn that was cut.
  const raced = statusOf(log().say().report("done").end().stop("manual-stop").say().end("interrupted").events);
  assert.deepEqual([raced.execution, raced.reason], ["stoppedByOwner", "Stopped by you"]);
  // A stop long before an interrupted turn says nothing about it.
  const stale = statusOf(log().say().report("done").end().stop("manual-stop").pause(120_000).say().end("interrupted").events);
  assert.deepEqual([stale.execution, stale.reason], ["interrupted", "Interrupted"]);
  // A turn that completes after such a stop drops it.
  const completed = log().say().report("done").end().stop("manual-stop").say().report("done").end();
  assert.equal(statusOf(completed.events).state, "done");
  assert.equal(statusOf(completed.say().end("interrupted").events).reason, "Interrupted");
});

test("a pending thread works only when an accepted message is about to start its turn", () => {
  const pending = (queue: QueuedRow[] = []): Live => ({ status: "pending", queue });
  // An unsent draft: no turn, nothing queued.
  const draft = statusOf([], pending(), T0);
  assert.deepEqual([draft.state, draft.reason], ["unknown", "No turns yet"]);
  // A thread created for later: its first message waits for its time.
  const scheduled: QueuedRow = { id: "q1", createdAt: T0, sendAt: T0 + 3_600_000, failureReason: null, retry: false };
  const later = statusOf([], pending([scheduled]), T0 + 60_000);
  assert.deepEqual([later.state, later.view, later.execution], ["running", "waiting", "queued"]);
  assert.match(later.reason, /^Message scheduled for /);
  // The owner's answer is accepted and the turn is about to start.
  const answered = statusOf(log().say().report("question", "Выбери вариант").end().events, pending());
  assert.deepEqual([answered.state, answered.reason], ["running", "Working"]);
});

test("done with a live child thread waits for the child", () => {
  const done = statusOf(log().say().report("done").end().events);
  assert.equal(done.checkChildren, true);
  const waiting = withChildren(done, [{ title: "Собрать отчёт", status: "active" }]);
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.reason, 'Waiting for child thread: Собрать отчёт');
  assert.equal(withChildren(done, [{ title: "Собрать отчёт", status: "idle" }]).state, "done");
  // A pending child is scheduled or an unsent draft.
  assert.equal(withChildren(done, [{ title: "Черновик", status: "pending" }]).state, "done");
});

test("folding the log in pieces gives the same facts as folding it whole", () => {
  const thread = log()
    .say()
    .ask("pint_1", "pending")
    .ask("pint_1", "resolved")
    .report("done")
    .end()
    .say("system", "child-completed")
    .say()
    .error("boom")
    .end("failed")
    .say()
    .report("question", "Выбери вариант")
    .stop("manual-stop")
    .end("interrupted")
    .compaction()
    .end()
    .say()
    .ask("pint_2", "pending");
  const whole = facts(thread.events);
  for (const size of [1, 2, 3, 5, 7]) {
    let folded = emptyFacts();
    for (let i = 0; i < thread.events.length; i += size) folded = foldEvents(folded, thread.events.slice(i, i + size));
    assert.deepEqual(folded, whole, `pieces of ${size}`);
  }
  // Events already folded are skipped when read again.
  assert.deepEqual(foldEvents(whole, thread.events), whole);
});

// Recorded event sequences, anonymized for publication: stable substitute IDs,
// shifted timestamps, generic provider errors, and no message text.
const fixture = (name: string): Record<string, unknown>[] =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>[];
const reportIn = (turnId: string, seq: number, state = "done") => ({
  seq,
  type: "item/started",
  createdAt: 0,
  scope: { kind: "turn", turnId },
  data: { item: { type: "toolCall", id: `${turnId}-report`, server: "bb", tool: REPORT_TOOL, arguments: { state, about: "Довести тред", done: "сделано", stoppedAt: "" } } },
});
const later = (events: readonly Record<string, unknown>[]) => (events.at(-1)!.createdAt as number) + 3_600_000;

test("real log: a Codex goal turn that delegated to subagents is decided by its own report", () => {
  const events = fixture("goal-with-subagents");
  const end = events.find((event) => event.type === "turn/completed" && (event.scope as { turnId: string }).turnId === "fixture0007")!;
  const withReport = [...events, reportIn("fixture0007", (end.seq as number) - 1)];
  const status = deriveStatus({ facts: facts(withReport), live: idle, now: later(events) });
  assert.equal(status.state, "done");
  assert.equal(status.turnId, "fixture0007");
  // Without the report: the helper reads it; the interrupted subagent turns do not make it ❓.
  assert.equal(deriveStatus({ facts: facts(events), live: idle, now: later(events) }).needHelper, true);
});

test("real log: an outer turn that failed on the usage limit is stopped even though subagent turns ended after it", () => {
  const events = fixture("outer-turn-rate-limit");
  const status = deriveStatus({ facts: facts(events), live: { status: "error", queue: [] }, now: later(events) });
  assert.deepEqual([status.state, status.view, status.execution], ["unknown", "stopped", "failed"]);
  assert.match(status.reason, /^Run failed: You’ve hit your usage limit/);
});

test("real log: bb announces its restart after the turn it interrupted", () => {
  const events = fixture("restart-after-interrupt");
  const cut = events.filter((event) => (event.seq as number) <= 1749);
  assert.equal(deriveStatus({ facts: facts(cut), live: idle, now: later(cut) }).reason, "Turn cut off by a bb restart");
  const whole = deriveStatus({ facts: facts(events), live: { status: "error", queue: [] }, now: later(events) });
  assert.match(whole.reason, /^Run failed: You've hit your session limit/);
});

test("real log: a turn that ends twice counts once; a stop announced with no turn running sticks to nothing", () => {
  const twice = facts(fixture("duplicate-turn-end"));
  const ends = new Set(fixture("duplicate-turn-end").filter((event) => event.type === "turn/completed").map((event) => (event.scope as { turnId: string }).turnId));
  assert.equal(twice.counts.turns, ends.size);

  const events = fixture("background-wakeups");
  const stopped = facts(events);
  assert.equal(stopped.interrupt, null);
  // A report in the turn with input holds through the wake-ups after it, until the next message.
  const wakeups = [...events.filter((event) => (event.seq as number) <= 1133), reportIn("fixture0195", 985, "waiting")];
  assert.equal(deriveStatus({ facts: facts(wakeups), live: idle, now: later(wakeups) }).state, "waiting");
  const next = [...events, reportIn("fixture0195", 985, "waiting")];
  assert.equal(deriveStatus({ facts: facts(next), live: idle, now: later(next) }).needHelper, true);
});

test("real logs fold the same in pieces as whole", () => {
  for (const name of ["goal-with-subagents", "outer-turn-rate-limit", "restart-after-interrupt", "duplicate-turn-end", "background-wakeups"]) {
    const events = fixture(name);
    const whole = facts(events);
    let folded = emptyFacts();
    for (let i = 0; i < events.length; i += 7) folded = foldEvents(folded, events.slice(i, i + 7));
    assert.deepEqual(folded, whole, name);
  }
});

test("a report with arguments out of shape is not a report", () => {
  const status = statusOf(log().say().report("done", "", { about: "x".repeat(60) }).end().events);
  assert.equal(status.state, "unknown");
});

test("a provider error sent as its JSON body shows its message", () => {
  assert.equal(
    readableError('{"error":{"message":"The supported API model names are deepseek-flash, but you passed gpt-6-astra.","type":"invalid_request_error","param":nul…'),
    "The supported API model names are deepseek-flash, but you passed gpt-6-astra.",
  );
  assert.equal(readableError("Failed to authenticate: OAuth session expired"), "Failed to authenticate: OAuth session expired");
});
