// What happens on its own once automatic updates are on: the helper reads a
// quiet turn its agent did not report on (at most three times per turn), a
// new turn aborts it, titles follow the topic and the status display, and
// switching updates on brings old titles in line without a model call.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { interaction, makeWorld, reply, report, say, thread, until, type FakeThread, type World } from "./world.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 8, 27, 12, 0, 0);
const TOPIC = "Перевести Hermes на Codex";

/** A clock the test moves (started before any thread is made), and a world with automatic updates on. */
async function setup(
  t: TestContext,
  make: () => FakeThread[],
  options: { settings?: Record<string, string | number | boolean>; spawnError?: () => Error | null } = {},
) {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const world = makeWorld({
    threads: make(),
    settings: { minIntervalMinutes: 0, ...options.settings },
    ...(options.spawnError ? { spawnError: options.spawnError } : {}),
  });
  await world.load();
  await world.setSettings({ enabled: true });
  await until(() => world.harness.inspection.logEntries.some((entry) => entry.message.includes("first enable")));
  const tick = (minutes: number) => t.mock.timers.tick(minutes * MINUTE);
  return { world, tick };
}

const status = async (world: World, threadId: string) => (await world.status(threadId, true)).status;
/** No helper runs or waits for this thread any more. */
const settled = (world: World, threadId: string) =>
  until(async () => !((await world.rpc("getCard", { threadId })) as { running: boolean }).running);

/** An owner message and an agent turn without a report, then bb says the thread is idle. */
async function unreportedTurn(world: World, item: FakeThread, text = "Продолжаем") {
  say(item, text);
  reply(item, `Ответ на «${text}»`);
  await world.idle(item);
  await until(async () => (await status(world, item.thread.id))?.needHelper === true);
}

test("automatic updates are off by default: the status shows, but idle events and the collector start no helper", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const item = thread("thr_a");
  const world = makeWorld({ threads: [item] });
  await world.load();
  await unreportedTurn(world, item);
  t.mock.timers.tick(60 * MINUTE);
  await world.collect();
  assert.equal(world.spawns.length, 0);
  assert.equal((await status(world, "thr_a"))?.state, "unknown");
  await world.dispose();
});

test("a turn the agent did not report on gets the helper once, after X quiet minutes, and its topic becomes the title", async (t) => {
  const item = thread("thr_a", {}, 0);
  const { world, tick } = await setup(t, () => [item]);
  tick(1);
  await unreportedTurn(world, item, "Переведи Hermes на Codex");

  tick(14);
  await world.collect();
  assert.equal(world.spawns.length, 0, "not quiet long enough");
  tick(1);
  await world.collect();
  await until(async () => (await status(world, "thr_a"))?.state === "done");
  await until(() => item.thread.title === TOPIC);
  assert.equal((await status(world, "thr_a"))?.source, "helper");

  tick(30);
  await world.collect();
  assert.equal(world.spawns.length, 1, "one helper per turn");
  await world.dispose();
});

test("turns that ended before automatic updates were switched on are not read on their own", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const item = thread("thr_a");
  const world = makeWorld({ threads: [item], settings: { minIntervalMinutes: 0 } });
  await world.load();
  assert.equal((await world.status("thr_a")).status?.needHelper, true);
  t.mock.timers.tick(5 * MINUTE);
  await world.setSettings({ enabled: true });
  await until(() => world.harness.inspection.logEntries.some((entry) => entry.message.includes("first enable")));
  t.mock.timers.tick(30 * MINUTE);
  await world.collect();
  assert.equal(world.spawns.length, 0);
  await world.dispose();
});

test("a helper that cannot read a turn tries again after Y minutes, and after three tries leaves the thread to the owner", async (t) => {
  let spawnCalls = 0;
  const item = thread("thr_a", {}, 0);
  const { world, tick } = await setup(t, () => [item], {
    settings: { minIntervalMinutes: 10 },
    spawnError: () => {
      spawnCalls += 1;
      return new Error("HTTP 503: provider is not ready");
    },
  });
  tick(1);
  await unreportedTurn(world, item);
  tick(15);
  const tries = async () => (await world.status("thr_a", true)).helper?.tries ?? 0;

  await world.collect();
  await until(async () => (await tries()) === 1);
  await settled(world, "thr_a");
  const afterFirst = spawnCalls;
  await world.collect();
  assert.equal(spawnCalls, afterFirst, "not again within Y minutes");

  tick(10);
  await world.collect();
  await until(async () => (await tries()) === 2);
  await settled(world, "thr_a");
  assert.equal((await status(world, "thr_a"))?.state, "unknown");

  tick(10);
  await world.collect();
  // Nobody could read the status: shown among the stopped threads, not as a question to the owner.
  await until(async () => (await status(world, "thr_a"))?.freshness === "unavailable");
  const gaveUp = await status(world, "thr_a");
  assert.deepEqual(
    [gaveUp?.state, gaveUp?.view, gaveUp?.reason],
    ["unknown", "stopped", "Status unavailable: the agent did not report and the helper could not read the thread"],
  );
  await settled(world, "thr_a");

  const calls = spawnCalls;
  tick(60);
  await world.collect();
  assert.equal(spawnCalls, calls);
  await world.dispose();
});

test("a new turn aborts an automatic helper, and its answer is never stored", async (t) => {
  const item = thread("thr_a", {}, 0);
  const { world, tick } = await setup(t, () => [item]);
  tick(1);
  await unreportedTurn(world, item);
  tick(15);

  const release = world.holdHelpers();
  await world.collect();
  await until(() => world.spawns.length === 1);
  say(item, "Ещё одно");
  item.thread = { ...item.thread, status: "active" };
  await world.active(item);
  await settled(world, "thr_a");
  release();

  assert.deepEqual(world.deleted, ["thr_helper1"]);
  const shown = await world.status("thr_a", true);
  assert.equal(shown.helper, null);
  assert.deepEqual([shown.status?.state, shown.status?.reason], ["running", "Working"]);
  await world.dispose();
});

test("switching updates on strips old stage emoji and keeps owner words, without a model call", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const generated = thread("thr_gen", { title: "⏸️ Hermes: Codex как рантайм" });
  const human = thread("thr_human", { title: "Opus vs Sol · 5 · лид-магнит" }, 2, false);
  const world = makeWorld({ threads: [generated, human] });
  await world.load();
  await world.status("thr_gen");
  await world.status("thr_human");
  assert.deepEqual(world.updates, [], "no title changes while updates are off");

  await world.setSettings({ enabled: true });
  await until(() => generated.thread.title === "Hermes: Codex как рантайм");
  assert.equal(human.thread.title, "Opus vs Sol · 5 · лид-магнит");
  const card = await world.show("thr_human");
  assert.deepEqual([card.policy, card.lockReason], ["owner-words", "legacy-set-title"]);
  assert.equal(world.spawns.length, 0);
  await world.dispose();
});

test("new threads: the first report names an untitled one; a title given at creation keeps its words", async (t) => {
  const { world, tick } = await setup(t, () => []);
  tick(1);
  const untitled = thread("thr_new", { title: null, createdAt: T0 + MINUTE }, 0);
  const named = thread("thr_named", { title: "Codex для Hermes", createdAt: T0 + MINUTE }, 0);
  for (const item of [untitled, named]) {
    world.threads.set(item.thread.id, item);
    await world.created(item);
  }
  for (const item of [untitled, named]) {
    say(item, "Переведи Hermes на Codex");
    item.thread = { ...item.thread, status: "active" };
    await world.active(item);
  }
  // The status runs before bb names the untitled thread after its first message.
  await until(async () => (await status(world, "thr_new"))?.state === "running");
  untitled.thread = { ...untitled.thread, title: "Настройка Codex" };
  for (const item of [untitled, named]) {
    report(item, { state: "done", about: TOPIC });
    reply(item, "Готово");
    item.thread = { ...item.thread, status: "idle" };
    await world.idle(item);
  }

  await until(() => untitled.thread.title === TOPIC);
  assert.equal((await world.show("thr_new")).policy, "auto");
  await until(async () => (await status(world, "thr_named"))?.state === "done");
  assert.equal(named.thread.title, "Codex для Hermes");
  const card = await world.show("thr_named");
  assert.deepEqual([card.policy, card.lockReason, card.topic], ["owner-words", "title given at creation", TOPIC]);
  assert.equal(world.spawns.length, 0);
  await world.dispose();
});

test("with the status in titles its mark leads the title and holds while the thread runs; back to row icons it goes", async (t) => {
  const item = thread("thr_a", {}, 0);
  const human = thread("thr_human", { title: "Opus vs Sol · обложка" }, 0, false);
  const { world, tick } = await setup(t, () => [item, human], { settings: { statusDisplay: "title" } });
  tick(1);
  say(human, "Сделай обложку");
  report(human, { state: "done", about: "Сделать обложку" });
  reply(human, "Готово");
  await world.idle(human);
  await until(() => human.thread.title === "✅ Opus vs Sol · обложка");

  say(item, "Переведи Hermes на Codex");
  report(item, { state: "question", about: TOPIC, stoppedAt: "Смержить PR #12" });
  reply(item, "Смержи PR");
  await world.idle(item);
  await until(() => item.thread.title === `❓ ${TOPIC}`);

  say(item, "Смержил");
  item.thread = { ...item.thread, status: "active" };
  await world.active(item);
  await until(async () => (await status(world, "thr_a"))?.state === "running");
  assert.equal(item.thread.title, `❓ ${TOPIC}`);

  report(item, { state: "done", about: TOPIC, stoppedAt: "PR #12 смержен" });
  reply(item, "Готово");
  item.thread = { ...item.thread, status: "idle" };
  await world.idle(item);
  await until(() => item.thread.title === `✅ ${TOPIC}`);

  await world.setSettings({ statusDisplay: "row" });
  await until(() => item.thread.title === TOPIC);
  // A title in the owner's words gets its words back, without the mark.
  await until(() => human.thread.title === "Opus vs Sol · обложка");
  assert.ok(world.harness.inspection.realtimeSignals.some((signal) => signal.channel === "rows"));
  await world.dispose();
});

test("an answer to a form given after the turn ended is read once: the helper's report then holds", async (t) => {
  const item = thread("thr_a", {}, 0);
  const { world, tick } = await setup(t, () => [item]);
  tick(1);
  say(item, "Переведи Hermes на Codex");
  report(item, { state: "question", about: TOPIC, stoppedAt: "Какой вариант выкатывать?" });
  reply(item, "Какой вариант выкатывать?");
  interaction(item, "int_1", "pending");
  interaction(item, "int_1", "resolved");
  await world.idle(item);
  await until(async () => (await status(world, "thr_a"))?.needHelper === true);

  tick(15);
  await world.collect();
  await until(async () => (await status(world, "thr_a"))?.state === "done");
  await settled(world, "thr_a");
  tick(30);
  await world.collect();
  assert.equal(world.spawns.length, 1);
  assert.equal((await status(world, "thr_a"))?.source, "helper");
  await world.dispose();
});
