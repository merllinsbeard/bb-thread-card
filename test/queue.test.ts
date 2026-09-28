// The Needs-you page on the SDK's fake host: the order of its cards, a
// request that keeps its identity across recomputes and changes version only
// when something new is asked, snoozing and hiding one version (page and
// CLI), the threads a card waits on, honest states for work that stopped,
// and the move of 0.4 dismissals with the file still usable by 0.4.2.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueueCard } from "../lib/queue.ts";
import { LEGACY_MIGRATIONS, MIGRATIONS } from "../lib/store.ts";
import { describeUntil, parseUntil } from "../lib/time.ts";
import plugin from "../server.ts";
import {
  type FakeThread,
  type World,
  interaction,
  interrupt,
  makeWorld,
  providerError,
  reply,
  report,
  say,
  thread,
  until,
} from "./world.ts";

const T0 = Date.UTC(2026, 8, 27, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Host = Pick<World, "harness">;

async function cards(host: Host, input: Record<string, unknown> = {}): Promise<QueueCard[]> {
  return ((await host.harness.behavior.callRpc("queue", input)) as { items: QueueCard[] }).items;
}

async function card(host: Host, threadId: string): Promise<QueueCard | null> {
  return (await cards(host)).find((item) => item.threadId === threadId) ?? null;
}

const rpc = (host: Host, method: string, input: unknown) =>
  host.harness.behavior.callRpc(method, input) as Promise<{ ok: boolean; reason: string | null; requestId: string | null; version: number | null }>;

const cli = (host: Host, ...argv: string[]) => host.harness.behavior.runCli(argv, { cwd: "/tmp" });

async function cliCards(host: Host, ...argv: string[]): Promise<QueueCard[]> {
  return JSON.parse((await cli(host, "queue", "--json", ...argv)).stdout) as QueueCard[];
}

const cardSignals = (host: Host, threadId: string, from = 0) =>
  host.harness.inspection.realtimeSignals
    .slice(from)
    .filter((signal) => signal.channel === "card" && (signal.payload as { threadId?: string }).threadId === threadId).length;

/** The agent ends a turn with a question to the owner. */
function ask(item: FakeThread, stoppedAt: string, extra: Record<string, unknown> = {}): void {
  say(item, "Продолжай");
  report(item, { state: "question", stoppedAt, ...extra });
  reply(item, "Нужен твой ответ");
}

test("newest request first; «Давно ждут» by the oldest open question; a tie keeps the thread id order", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const [a, b, c, d] = ["thr_a", "thr_b", "thr_c", "thr_d"].map((id) => thread(id, {}, 1)) as [FakeThread, FakeThread, FakeThread, FakeThread];
  const world = makeWorld({ threads: [a, b, c, d] });
  await world.load();

  t.mock.timers.tick(MINUTE);
  ask(a, "Выбери вариант обложки");
  t.mock.timers.tick(MINUTE);
  say(c, "Собери релиз");
  interaction(c, "pint_c1", "pending");
  t.mock.timers.tick(3 * MINUTE);
  ask(d, "Проверь тему на телефоне");
  ask(b, "Дай токен Telegram");
  t.mock.timers.tick(3 * MINUTE);
  // A second question form while the first is still open.
  interaction(c, "pint_c2", "pending");
  c.thread = { ...c.thread, status: "active" };
  for (const id of ["thr_a", "thr_b", "thr_c", "thr_d"]) await world.status(id);

  assert.deepEqual((await cards(world)).map((item) => item.threadId), ["thr_c", "thr_b", "thr_d", "thr_a"]);
  assert.deepEqual((await cliCards(world, "--sort", "old")).map((item) => item.threadId), ["thr_a", "thr_c", "thr_b", "thr_d"]);
  const two = (await card(world, "thr_c"))!;
  assert.deepEqual(
    [two.view, two.count, two.execution, two.source, two.requestedAt, two.attentionAt],
    ["needs", 2, "active", "bb", T0 + 2 * MINUTE, T0 + 8 * MINUTE],
  );
  assert.equal(two.ask, "2 questions: Какую строку записать?; Какую строку записать?");
  await world.dispose();
});

test("a request keeps its id, version and time across recomputes; an answer takes it off; a question in the next turn is a new request", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const a = thread("thr_a", {}, 1);
  const world = makeWorld({ threads: [a] });
  await world.load();

  t.mock.timers.tick(MINUTE);
  ask(a, "Выбери вариант обложки");
  await world.status("thr_a");
  const first = (await card(world, "thr_a"))!;
  assert.deepEqual(
    [first.requestId, first.version, first.attentionAt, first.requestedAt, first.ask, first.source],
    ["thr_a:thr_a-t2", 1, T0 + MINUTE, T0 + MINUTE, "Выбери вариант обложки", "agent"],
  );

  // The same log read again an hour later is the same request, at the same time.
  t.mock.timers.tick(HOUR);
  await world.status("thr_a");
  await world.collect();
  const again = (await card(world, "thr_a"))!;
  assert.deepEqual(
    [again.requestId, again.version, again.attentionAt, again.requestedAt],
    [first.requestId, 1, first.attentionAt, first.requestedAt],
  );

  // The owner answers: the thread works and the card leaves the page.
  say(a, "Второй вариант");
  a.thread = { ...a.thread, status: "active" };
  await world.status("thr_a");
  assert.equal(await card(world, "thr_a"), null);

  // A question in the turn the answer started: a new request at its own time.
  t.mock.timers.tick(5 * MINUTE);
  report(a, { state: "question", stoppedAt: "Проверь тему на телефоне и ноутбуке" });
  reply(a, "Посмотри");
  a.thread = { ...a.thread, status: "idle" };
  await world.status("thr_a");
  const next = (await card(world, "thr_a"))!;
  assert.deepEqual([next.requestId, next.version, next.attentionAt], ["thr_a:thr_a-t3", 1, T0 + 66 * MINUTE]);
  await world.dispose();
});

test("a new question in the same turn moves the version: a card hidden on the old one comes back, a click on the old one does nothing", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const a = thread("thr_a", {}, 1);
  const world = makeWorld({ threads: [a] });
  await world.load();

  say(a, "Создай файл");
  interaction(a, "pint_1", "pending");
  a.thread = { ...a.thread, status: "active" };
  await world.status("thr_a");
  const v1 = (await card(world, "thr_a"))!;
  assert.deepEqual([v1.requestId, v1.version], ["thr_a:thr_a-t2", 1]);
  const target = { threadId: "thr_a", requestId: v1.requestId, version: 1 };
  assert.deepEqual(await rpc(world, "dismiss", target), { ok: true, reason: null, requestId: "thr_a:thr_a-t2", version: 1 });
  assert.equal((await card(world, "thr_a"))?.disposition?.kind, "dismissed");
  assert.deepEqual(await cliCards(world), []);
  assert.deepEqual((await cliCards(world, "--all")).map((item) => item.threadId), ["thr_a"]);

  interaction(a, "pint_1", "resolved");
  await world.status("thr_a");
  assert.equal(await card(world, "thr_a"), null);
  t.mock.timers.tick(5 * MINUTE);
  interaction(a, "pint_2", "pending");
  await world.status("thr_a");
  const v2 = (await card(world, "thr_a"))!;
  assert.deepEqual([v2.requestId, v2.version, v2.attentionAt, v2.disposition], ["thr_a:thr_a-t2", 2, T0 + 5 * MINUTE, null]);

  const stale = await rpc(world, "snooze", { ...target, untilAt: Date.now() + HOUR, tz: null });
  assert.deepEqual(stale, { ok: false, reason: "changed", requestId: "thr_a:thr_a-t2", version: 2 });
  assert.equal((await card(world, "thr_a"))?.disposition, null);
  await world.dispose();
});

test("a snooze holds until its time, survives a reload, ends by itself and can be undone; the same click twice is one", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const a = thread("thr_a", {}, 1);
  const world = makeWorld({ threads: [a] });
  await world.load();
  ask(a, "Выбери вариант обложки");
  await world.status("thr_a");
  const target = { threadId: "thr_a", requestId: "thr_a:thr_a-t2", version: 1 };

  assert.deepEqual(await rpc(world, "snooze", { ...target, untilAt: T0 - 1, tz: null }), {
    ok: false,
    reason: "past",
    requestId: target.requestId,
    version: 1,
  });
  const untilAt = T0 + HOUR;
  assert.equal((await rpc(world, "snooze", { ...target, untilAt, tz: "Europe/Moscow" })).ok, true);
  assert.deepEqual((await card(world, "thr_a"))?.disposition, { kind: "snoozed", untilAt, tz: "Europe/Moscow", at: T0 });
  assert.deepEqual(await cliCards(world, "--view", "needs"), []);
  assert.deepEqual((await cliCards(world, "--view", "snoozed")).map((item) => item.threadId), ["thr_a"]);
  const rows = (await world.rpc("rows", {})) as { rows: Record<string, { disposition: string | null }> };
  assert.equal(rows.rows.thr_a?.disposition, "snoozed");

  const signals = world.harness.inspection.realtimeSignals.length;
  assert.equal((await rpc(world, "snooze", { ...target, untilAt, tz: "Europe/Moscow" })).ok, true);
  assert.equal(world.harness.inspection.realtimeSignals.length, signals);

  const reloaded = await world.harness.lifecycle.reload(plugin);
  assert.equal((await card(reloaded, "thr_a"))?.disposition?.kind, "snoozed");

  // Its time comes: the once-a-minute pass puts the card back and announces it.
  t.mock.timers.tick(HOUR + MINUTE);
  const before = reloaded.harness.inspection.realtimeSignals.length;
  await reloaded.harness.behavior.runSchedule("collector");
  assert.equal(cardSignals(reloaded, "thr_a", before), 1);
  const back = (await card(reloaded, "thr_a"))!;
  assert.deepEqual([back.disposition, back.view, back.version], [null, "needs", 1]);

  // «Отменить» right after a snooze or a hide.
  assert.equal((await rpc(reloaded, "snooze", { ...target, untilAt: Date.now() + HOUR, tz: null })).ok, true);
  assert.equal((await rpc(reloaded, "restore", target)).ok, true);
  assert.equal((await card(reloaded, "thr_a"))?.disposition, null);
  assert.equal((await rpc(reloaded, "dismiss", target)).ok, true);
  assert.equal((await rpc(reloaded, "restore", target)).ok, true);
  assert.equal((await card(reloaded, "thr_a"))?.disposition, null);
  // The page's old call without a request id still works on the current request.
  assert.equal((await rpc(reloaded, "dismiss", { threadId: "thr_a" })).ok, true);
  assert.equal((await card(reloaded, "thr_a"))?.dismissed, true);
  await reloaded.harness.lifecycle.dispose();
});

test("the CLI lists the page and snoozes, hides and brings back a request", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const a = thread("thr_a", {}, 1);
  const b = thread("thr_b", {}, 1);
  const c = thread("thr_c", {}, 1);
  const world = makeWorld({ threads: [a, b, c] });
  await world.load();
  ask(a, "Выбери вариант обложки");
  t.mock.timers.tick(MINUTE);
  ask(b, "2 вопроса: токен Telegram и имя бота", { questionCount: 2 });
  for (const id of ["thr_a", "thr_b", "thr_c"]) await world.status(id);

  const listed = (await cli(world, "queue")).stdout;
  assert.match(listed, /^Needs you · 2\n  ❓ thr_b .*\[2 questions\]\n      2 вопроса: токен Telegram и имя бота · 2026-09-27T12:01:00\.000Z · v1\n  ❓ thr_a /);

  const snoozed = JSON.parse((await cli(world, "snooze", "thr_a", "--for", "2h", "--json")).stdout);
  assert.deepEqual(snoozed, { ok: true, reason: null, requestId: "thr_a:thr_a-t2", version: 1 });
  assert.deepEqual((await card(world, "thr_a"))?.disposition, {
    kind: "snoozed",
    untilAt: T0 + MINUTE + 2 * HOUR,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    at: T0 + MINUTE,
  });
  assert.match((await cli(world, "queue")).stdout, /\nSnoozed · 1\n  ❓ thr_a .*\[until /);

  // A wall-clock time is read in --tz: 15:01 in Moscow, so 09:00 is tomorrow morning.
  const morning = await cli(world, "snooze", "thr_a", "--until", "09:00", "--tz", "Europe/Moscow");
  assert.match(morning.stdout, /^Snoozed until .*09:00 \(Europe\/Moscow\) \(thr_a:thr_a-t2 v1\)$/);
  assert.equal(((await card(world, "thr_a"))?.disposition as { untilAt: number }).untilAt, Date.UTC(2026, 8, 28, 6, 0));

  assert.notEqual((await cli(world, "snooze", "thr_a", "--for", "1h", "--until", "09:00")).exitCode, 0);
  assert.match((await cli(world, "snooze", "thr_a", "--until", "когда-нибудь")).stderr, /cannot read the time/);
  assert.match((await cli(world, "snooze", "thr_a", "--until", "09:00", "--tz", "Mars/Base")).stderr, /unknown time zone/);

  const stale = await cli(world, "dismiss", "thr_a", "--version", "7");
  assert.equal(stale.exitCode, 1);
  assert.match(stale.stderr, /the request has changed: it is now thr_a:thr_a-t2 v1/);
  assert.equal((await cli(world, "dismiss", "thr_a")).stdout, "Hidden until the thread asks again (thr_a:thr_a-t2 v1)");
  assert.deepEqual((await cliCards(world)).map((item) => item.threadId), ["thr_b"]);
  assert.deepEqual((await cliCards(world, "--all")).map((item) => [item.threadId, item.disposition?.kind ?? null]), [
    ["thr_b", null],
    ["thr_a", "dismissed"],
  ]);
  assert.equal((await cli(world, "restore", "thr_a")).stdout, "Back in the queue (thr_a:thr_a-t2 v1)");
  assert.deepEqual((await cliCards(world)).map((item) => item.threadId), ["thr_b", "thr_a"]);

  const none = await cli(world, "dismiss", "thr_c");
  assert.equal(none.exitCode, 1);
  assert.match(none.stderr, /no request on the Needs-you page/);
  assert.deepEqual(await cliCards(world, "--view", "waiting"), []);
  await world.dispose();
});

test("a card names the threads it waits on with their state, and looks again when one of them moves", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const a = thread("thr_a", {}, 1);
  const b = thread("thr_b", { title: "Собрать релиз" }, 1);
  const world = makeWorld({ threads: [a, b] });
  await world.load();

  say(b, "Собери релиз");
  b.thread = { ...b.thread, status: "active" };
  await world.status("thr_b");
  say(a, "Подожди релиз");
  report(a, {
    state: "waiting",
    stoppedAt: "Жду релиз и ревью в @thread:thr_zz (сам я @thread:thr_a)",
    waitingOnThreadIds: ["thr_b"],
  });
  reply(a, "Жду");
  await world.status("thr_a");
  const waiting = (await card(world, "thr_a"))!;
  assert.equal(waiting.view, "waiting");
  assert.deepEqual(waiting.waitingOn, [
    { threadId: "thr_b", title: "Собрать релиз", state: "running", available: true, archived: false },
    { threadId: "thr_zz", title: null, state: null, available: false, archived: false },
  ]);

  // thr_b finishes: thr_a's card is announced and shows it done.
  const before = world.harness.inspection.realtimeSignals.length;
  report(b, { state: "done", about: "Собрать релиз 1.2", done: "Релиз 1.2 собран" });
  reply(b, "Готово");
  b.thread = { ...b.thread, status: "idle" };
  await world.idle(b);
  await until(() => cardSignals(world, "thr_a", before) > 0);
  await until(async () => (await card(world, "thr_a"))?.waitingOn[0]?.state === "done");
  assert.equal((await card(world, "thr_a"))?.waitingOn[0]?.title, "Собрать релиз 1.2");

  // thr_b is deleted: the card says it is gone.
  world.threads.delete("thr_b");
  const beforeDelete = world.harness.inspection.realtimeSignals.length;
  await world.deletedThread(b);
  assert.ok(cardSignals(world, "thr_a", beforeDelete) > 0);
  t.mock.timers.tick(MINUTE + 1_000);
  assert.deepEqual((await card(world, "thr_a"))?.waitingOn[0], {
    threadId: "thr_b",
    title: null,
    state: null,
    available: false,
    archived: false,
  });
  await world.dispose();
});

test("stopped work shows as what happened: the owner's stop, a failed turn, a retry, an answer that did not send, a status being read", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const stop = thread("thr_stop", {}, 1);
  const limit = thread("thr_limit", {}, 1);
  const retry = thread("thr_retry", {}, 1);
  const unsent = thread("thr_unsent", {}, 1);
  const quiet = thread("thr_quiet", {}, 1);
  const world = makeWorld({ threads: [stop, limit, retry, unsent, quiet] });
  await world.load();

  say(stop, "Собери и выложи");
  report(stop, { state: "continuing", stoppedAt: "Сборка идёт в фоне" });
  interrupt(stop, "manual-stop");
  for (const item of [limit, retry]) {
    say(item, "Продолжай");
    providerError(item, "You've hit your session limit");
    reply(item, null, { status: "failed" });
  }
  retry.thread = { ...retry.thread, queuedMessageCount: 1 };
  world.queued.set("thr_retry", [
    { id: "qm_retry", createdAt: T0, sendAt: T0 + 30 * MINUTE, failureReason: null, payload: { kind: "retry" } },
  ]);
  ask(unsent, "Выбери вариант обложки");
  unsent.thread = { ...unsent.thread, queuedMessageCount: 1 };
  world.queued.set("thr_unsent", [
    { id: "qm_answer", createdAt: T0, sendAt: null, failureReason: "provider offline", payload: { kind: "message" } },
  ]);
  say(quiet, "Разбери логи");
  reply(quiet, "Разобрал");
  t.mock.timers.tick(20_000);
  for (const item of [stop, limit, retry, unsent, quiet]) await world.status(item.thread.id);

  const byId = new Map((await cards(world)).map((item) => [item.threadId, item]));
  const shape = (id: string) => {
    const item = byId.get(id)!;
    return [item.view, item.execution, item.freshness, item.reason];
  };
  assert.deepEqual(shape("thr_stop"), ["stopped", "stoppedByOwner", "fresh", "Stopped by you"]);
  assert.deepEqual(shape("thr_limit"), ["stopped", "failed", "fresh", "Run failed: You've hit your session limit"]);
  assert.deepEqual(shape("thr_retry").slice(0, 3), ["waiting", "queued", "fresh"]);
  assert.equal(byId.get("thr_retry")?.sendAt, T0 + 30 * MINUTE);
  assert.deepEqual(shape("thr_unsent"), ["needs", "sendFailed", "fresh", "Your answer failed to send: provider offline"]);
  assert.equal(byId.get("thr_unsent")?.requestId, "thr_unsent:thr_unsent-t2");
  assert.deepEqual([byId.get("thr_quiet")?.view, byId.get("thr_quiet")?.freshness], [null, "checking"]);
  // Only the unsent answer asks the owner.
  assert.deepEqual(
    [...byId.values()].filter((item) => item.view === "needs").map((item) => item.threadId),
    ["thr_unsent"],
  );

  const rows = (await world.rpc("rows", {})) as { rows: Record<string, { view: string | null; execution: string | null }> };
  assert.deepEqual(rows.rows.thr_stop, { ...rows.rows.thr_stop, view: "stopped", execution: "stoppedByOwner" });
  const listed = (await cli(world, "queue")).stdout;
  assert.match(listed, /\nStopped · 2\n/);
  assert.match(listed, /thr_stop .*\[stopped by you\]/);
  assert.match(listed, /thr_unsent .*\[message not sent\]/);
  assert.match(listed, /\(status still being checked for 1 more\)$/);
  await world.dispose();
});

test("0.4 dismissals move to the requests they hid, the rest hide nothing, and the file still works for 0.4.2", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const items = ["thr_a", "thr_b", "thr_c", "thr_d"].map((id) => thread(id, {}, 1)) as [FakeThread, FakeThread, FakeThread, FakeThread];
  const [a, b, c] = items;
  const world = makeWorld({ threads: items });
  ask(a, "Выбери вариант обложки");
  ask(b, "Дай токен Telegram");
  ask(c, "Проверь тему на телефоне");

  // What 0.4.2 left: its tables, its statuses and its dismissals.
  const db = world.bb.storage.database();
  world.bb.storage.migrate(db, MIGRATIONS.slice(0, LEGACY_MIGRATIONS));
  const status = db.prepare(
    `INSERT INTO thread_status (thread_id, project_id, provider_id, state, reason, since, source, turn_id,
       settle_until, need_helper, turns, reported, updated_at)
     VALUES (?, 'proj_personal', 'claude-code', 'question', ?, ?, 'agent', ?, NULL, 0, 2, 1, ?)`,
  );
  const dismiss = db.prepare(`INSERT INTO dismissals (thread_id, at, status_key) VALUES (?, ?, ?)`);
  status.run("thr_a", "Выбери вариант обложки", T0, "thr_a-t2", T0);
  dismiss.run("thr_a", T0 - MINUTE, "question|thr_a-t2|Выбери вариант обложки");
  // Hidden on an older question: it no longer hid anything.
  status.run("thr_b", "Дай токен Telegram", T0, "thr_b-t2", T0);
  dismiss.run("thr_b", T0 - MINUTE, "question|thr_b-t1|Старый вопрос");
  // A status without a turn: nothing to bind it to.
  status.run("thr_c", "ждёт ответа: Какую строку записать?", T0, null, T0);
  dismiss.run("thr_c", T0 - MINUTE, "question||ждёт ответа: Какую строку записать?");
  // Bound to its turn, but the thread has moved on since.
  status.run("thr_d", "Старый вопрос", T0, "thr_d-t1", T0);
  dismiss.run("thr_d", T0 - MINUTE, "question|thr_d-t1|Старый вопрос");

  await world.load();
  assert.ok(
    world.harness.inspection.logEntries.some(
      (entry) => entry.message === "0.4 dismissals: 2 bound to their turn, 1 no longer hid anything, 1 kept without a request",
    ),
  );
  for (const item of items) await world.status(item.thread.id);
  const migrated = () =>
    db.prepare(`SELECT thread_id, migrated FROM dismissals ORDER BY thread_id`).all() as { thread_id: string; migrated: string }[];
  assert.deepEqual(
    migrated().map((row) => [row.thread_id, row.migrated]),
    [
      ["thr_a", "moved"],
      ["thr_b", "inactive"],
      ["thr_c", "unresolved"],
      ["thr_d", "inactive"],
    ],
  );
  const byId = new Map((await cards(world)).map((item) => [item.threadId, item]));
  assert.deepEqual(byId.get("thr_a")?.disposition, { kind: "dismissed", at: T0 - MINUTE });
  assert.deepEqual([byId.get("thr_b")?.disposition, byId.get("thr_b")?.legacyDismissal], [null, false]);
  assert.deepEqual([byId.get("thr_c")?.disposition, byId.get("thr_c")?.legacyDismissal], [null, true]);
  assert.deepEqual((await cliCards(world)).map((item) => item.threadId).sort(), ["thr_b", "thr_c"]);

  // A second start reads nothing again.
  const reloaded = await world.harness.lifecycle.reload(plugin);
  assert.ok(!reloaded.harness.inspection.logEntries.some((entry) => entry.message.startsWith("0.4 dismissals")));

  // A rollback: 0.4.2 runs its own 27 migrations and statements on the same file.
  const file = reloaded.bb.storage.database();
  assert.doesNotThrow(() => reloaded.bb.storage.migrate(file, MIGRATIONS.slice(0, LEGACY_MIGRATIONS)));
  assert.equal((file.prepare(`SELECT thread_id, status_key FROM dismissals`).all() as unknown[]).length, 4);
  file
    .prepare(
      `INSERT INTO thread_status (thread_id, project_id, provider_id, state, reason, since, source, turn_id,
         settle_until, need_helper, turns, reported, updated_at)
       VALUES (@threadId, @projectId, @providerId, @state, @reason, @since, @source, @turnId,
         @settleUntil, @needHelper, @turns, @reported, @updatedAt)
       ON CONFLICT(thread_id) DO UPDATE SET project_id = excluded.project_id,
         provider_id = excluded.provider_id, state = excluded.state, reason = excluded.reason,
         since = excluded.since, source = excluded.source, turn_id = excluded.turn_id,
         settle_until = excluded.settle_until, need_helper = excluded.need_helper,
         turns = excluded.turns, reported = excluded.reported, updated_at = excluded.updated_at`,
    )
    .run({
      threadId: "thr_b",
      projectId: "proj_personal",
      providerId: "claude-code",
      state: "question",
      reason: "Дай токен Telegram",
      since: T0,
      source: "agent",
      turnId: "thr_b-t2",
      settleUntil: null,
      needHelper: 0,
      turns: 2,
      reported: 1,
      updatedAt: T0,
    });
  // 0.4.2 hides thr_b in place; back on 0.5 that dismissal is read anew.
  file
    .prepare(
      `INSERT INTO dismissals (thread_id, at, status_key) VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET at = excluded.at, status_key = excluded.status_key`,
    )
    .run("thr_b", T0, "question|thr_b-t2|Дай токен Telegram");
  const upgraded = await reloaded.harness.lifecycle.reload(plugin);
  assert.ok(
    upgraded.harness.inspection.logEntries.some(
      (entry) => entry.message === "0.4 dismissals: 1 bound to their turn, 0 no longer hid anything, 0 kept without a request",
    ),
  );
  await upgraded.harness.behavior.runCli(["status", "thr_b", "--refresh", "--json"], { cwd: "/tmp" });
  assert.deepEqual((await card(upgraded, "thr_b"))?.disposition, { kind: "dismissed", at: T0 });
  await upgraded.harness.lifecycle.dispose();
});

test("the note on a 0.4 dismissal with no request to move to ends when the owner acts on the request or the thread asks anew", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const items = ["thr_e", "thr_f", "thr_g"].map((id) => thread(id, {}, 1)) as [FakeThread, FakeThread, FakeThread];
  const [e, f, g] = items;
  const world = makeWorld({ threads: items });
  for (const item of items) ask(item, "Какую строку записать?");
  const db = world.bb.storage.database();
  world.bb.storage.migrate(db, MIGRATIONS.slice(0, LEGACY_MIGRATIONS));
  for (const item of items) {
    const id = item.thread.id;
    db.prepare(
      `INSERT INTO thread_status (thread_id, project_id, provider_id, state, reason, since, source, turn_id,
         settle_until, need_helper, turns, reported, updated_at)
       VALUES (?, 'proj_personal', 'claude-code', 'question', 'ждёт ответа: Какую строку записать?', ?, 'agent', NULL, NULL, 0, 2, 1, ?)`,
    ).run(id, T0, T0);
    db.prepare(`INSERT INTO dismissals (thread_id, at, status_key) VALUES (?, ?, ?)`).run(id, T0 - MINUTE, "question||ждёт ответа: Какую строку записать?");
  }
  await world.load();
  for (const item of items) await world.status(item.thread.id);
  const notes = async () => (await cards(world)).filter((item) => item.legacyDismissal).map((item) => item.threadId);
  assert.deepEqual(await notes(), ["thr_e", "thr_f", "thr_g"]);

  // The owner snoozes one request and hides another; the third thread asks anew.
  assert.equal((await rpc(world, "snooze", { threadId: "thr_e", untilAt: T0 + HOUR, tz: "Europe/Moscow" })).ok, true);
  assert.equal((await rpc(world, "dismiss", { threadId: "thr_f" })).ok, true);
  t.mock.timers.tick(MINUTE);
  ask(g, "Теперь выбери цвет");
  await world.status("thr_g");
  assert.deepEqual(await notes(), []);
  // Taking the snooze back does not bring the note back.
  assert.equal((await rpc(world, "restore", { threadId: "thr_e" })).ok, true);
  assert.deepEqual(await notes(), []);
  await world.dispose();
});

test("snooze times are read in the chosen zone; a skipped hour moves forward, a repeated one takes its first occurrence", () => {
  const now = Date.UTC(2026, 8, 28, 12, 0); // 15:00 in Moscow
  assert.equal(parseUntil("завтра", now, "Europe/Moscow"), Date.UTC(2026, 8, 29, 6, 0));
  assert.equal(parseUntil("tomorrow", now, "Europe/Moscow"), Date.UTC(2026, 8, 29, 6, 0));
  assert.equal(parseUntil("16:30", now, "Europe/Moscow"), Date.UTC(2026, 8, 28, 13, 30));
  assert.equal(parseUntil("09:00", now, "Europe/Moscow"), Date.UTC(2026, 8, 29, 6, 0));
  assert.equal(parseUntil("2026-10-01T09:00", now, "Europe/Berlin"), Date.UTC(2026, 9, 1, 7, 0));
  assert.equal(parseUntil("2026-10-01T09:00+03:00", now, "Europe/Berlin"), Date.UTC(2026, 9, 1, 6, 0));
  // Berlin: 02:30 on 29 March 2026 does not exist, on 25 October it happens twice.
  assert.equal(parseUntil("2026-03-29 02:30", now, "Europe/Berlin"), Date.UTC(2026, 2, 29, 1, 30));
  assert.equal(parseUntil("2026-10-25 02:30", now, "Europe/Berlin"), Date.UTC(2026, 9, 25, 0, 30));
  assert.equal(parseUntil("когда-нибудь", now, "Europe/Moscow"), null);
  assert.equal(parseUntil("25:00", now, "Europe/Moscow"), null);
  assert.match(describeUntil(Date.UTC(2026, 8, 29, 6, 0), "Europe/Moscow"), /29 Sept.*09:00 \(Europe\/Moscow\)$/);
});
