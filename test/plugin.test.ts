// The plugin through its CLI and RPC on the SDK's fake host: the helper that
// reads a thread its agent did not report on and the title that follows the
// topic within the thread's title policy. The Needs-you page is in
// queue.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { cleanupOrphanHelpers } from "../lib/helper.ts";
import { DEFAULT_HELPER_WORKSPACE } from "../server.ts";
import { PLUGIN_ID, answer, grow, makeWorld, reply, report, say, thread, until } from "./world.ts";

const TOPIC = "Перевести Hermes на Codex";

test("a dry-run prints the helper's answer and stores nothing", async () => {
  const world = makeWorld({ threads: [thread("thr_a")] });
  await world.load();

  const result = await world.refresh("thr_a", "--dry-run");
  assert.equal(result.status, "dry-run");
  assert.deepEqual(result.answer, JSON.parse(answer()));
  assert.equal(result.mode, "full");
  assert.deepEqual(world.updates, []);
  const shown = await world.show("thr_a");
  assert.deepEqual([shown.topic, shown.report, shown.titleHistory.length], [null, null, 0]);
  assert.equal((await world.status("thr_a", true)).status?.state, "unknown");

  const text = (await world.cli("refresh", "thr_a", "--dry-run")).stdout;
  assert.match(text, /✅ Перевести Hermes на Codex\n  Progress: Hermes ходит в модели через Codex app-server/);
  await world.dispose();
});

test("a thread its agent did not report on gets the helper's status and topic, and the topic becomes its title", async () => {
  const world = makeWorld({ threads: [thread("thr_a")] });
  await world.load();

  const result = await world.refresh("thr_a");
  assert.equal(result.status, "answered");
  assert.equal(result.title, TOPIC);
  assert.deepEqual(world.updates, [{ threadId: "thr_a", title: TOPIC }]);

  const shown = await world.status("thr_a");
  assert.deepEqual([shown.status?.state, shown.status?.source, shown.status?.reason], ["done", "helper", "Hermes ходит в модели через Codex app-server"]);
  assert.deepEqual([shown.topic?.topic, shown.topic?.setBy], [TOPIC, "helper"]);
  const card = await world.show("thr_a");
  assert.equal(card.report?.by, "helper");
  assert.deepEqual(
    card.titleHistory.map((record) => [record.title, record.previousTitle]),
    [[TOPIC, "Настроить Codex для Hermes"]],
  );
  // The helper read the whole thread: the owner's messages in their own block and the agent's replies.
  assert.match(world.prompts[0]!, /<owner-messages>\n#1: Сообщение 1 про Codex app-server в Hermes\n#2: Сообщение 2/);
  assert.match(world.prompts[0]!, /<transcript>\n\[владелец #1\]\nАгент: Ответ на «Сообщение 1/);
  assert.doesNotMatch(world.prompts[0]!, /<previous-report>/);
  // Every change reaches open cards and the row icons.
  assert.ok(world.harness.inspection.realtimeSignals.some((signal) => signal.channel === "card"));
  await world.dispose();
});

test("the helper runs the configured provider, model and reasoning, hidden in the dedicated workspace, and is deleted", async () => {
  const world = makeWorld({ threads: [thread("thr_a")] });
  await world.load();

  await world.refresh("thr_a", "--dry-run");
  await world.setSettings({ providerId: "claude-code", model: "claude-haiku-4-5-20251001", reasoningLevel: "low" });
  await world.refresh("thr_a", "--dry-run");

  assert.equal(world.spawns.length, 2);
  assert.deepEqual(world.projects.map((project) => [project.name, project.sources[0]!.path]), [
    ["thread-card helpers", DEFAULT_HELPER_WORKSPACE],
  ]);
  assert.deepEqual(world.spawns[0], {
    ...world.spawns[0],
    projectId: "proj_helpers1",
    environment: { type: "host", hostId: "host_1", workspace: { type: "unmanaged", path: DEFAULT_HELPER_WORKSPACE } },
    providerId: "codex",
    model: "gpt-6-luna",
    reasoningLevel: "max",
    permissionMode: "accept-edits",
    visibility: "hidden",
    lifecycleOwnerThreadId: "thr_a",
  });
  assert.deepEqual(
    [world.spawns[1]!.providerId, world.spawns[1]!.model, world.spawns[1]!.reasoningLevel],
    ["claude-code", "claude-haiku-4-5-20251001", "low"],
  );
  assert.deepEqual(world.spawns[1]!.environment, { type: "reuse", environmentId: "env_helper" });
  assert.deepEqual(world.deleted, ["thr_helper1", "thr_helper2"]);
  await world.dispose();
});

test("the helper reads only what came after the agent's last report and keeps the agent's topic", async () => {
  const item = thread("thr_a", {}, 1);
  const world = makeWorld({ threads: [item] });
  await world.load();
  say(item, "Переведи Hermes на Codex");
  report(item, { state: "done", about: TOPIC, done: "Hermes ходит через Codex", stoppedAt: "PR #12" });
  reply(item, "Готово");
  say(item, "Теперь обнови README");
  reply(item, "Обновил, нужен токен npm для публикации");

  world.answers(answer({ state: "question", about: "Обновить README", done: "README обновлён", stoppedAt: "Нужен токен npm" }));
  const result = await world.refresh("thr_a");
  assert.equal(result.mode, "incremental");
  const prompt = world.prompts[0]!;
  assert.match(prompt, /<previous-report>[\s\S]*PR #12[\s\S]*<\/previous-report>/);
  assert.match(prompt, /<owner-messages>\n#3: Теперь обнови README\n<\/owner-messages>/);
  assert.match(prompt, /тема треда уже есть: "Перевести Hermes на Codex"/);

  const shown = await world.status("thr_a");
  assert.deepEqual([shown.status?.state, shown.status?.reason, shown.status?.source], ["question", "Нужен токен npm", "helper"]);
  assert.deepEqual([shown.topic?.topic, shown.topic?.setBy], [TOPIC, "agent"]);
  assert.equal(item.thread.title, TOPIC);
  await world.dispose();
});

test("a new turn that begins while the helper reads makes its answer stale", async () => {
  const item = thread("thr_a");
  const world = makeWorld({ threads: [item] });
  await world.load();

  const release = world.holdHelpers();
  const running = world.refresh("thr_a");
  await until(() => world.spawns.length === 1);
  grow(item, 1);
  await world.idle(item);
  await until(async () => (await world.status("thr_a")).status?.turns === 3);
  release();

  const result = await running;
  assert.equal(result.status, "stale");
  const shown = await world.status("thr_a");
  assert.deepEqual([shown.status?.state, shown.status?.needHelper, shown.helper?.report ?? null], ["unknown", true, null]);
  assert.equal(shown.topic, null);
  await world.dispose();
});

test("an unparseable answer is asked once more; a failed helper call is not retried", async () => {
  const world = makeWorld({ threads: [thread("thr_a"), thread("thr_b")], answers: ["Я не могу вернуть JSON", answer()] });
  await world.load();

  assert.equal((await world.refresh("thr_a", "--dry-run")).status, "dry-run");
  assert.equal(world.spawns.length, 2);
  assert.match(world.prompts[1]!, /Прошлый ответ не разобрался/);

  world.answers("мусор", "снова мусор");
  const failed = await world.refresh("thr_b");
  assert.equal(failed.status, "failed");
  assert.equal(world.spawns.length, 4);
  assert.deepEqual(world.updates, []);
  assert.equal((await world.status("thr_b")).helper?.tries, 1);
  await world.dispose();

  let spawnCalls = 0;
  const broken = makeWorld({
    threads: [thread("thr_c")],
    spawnError: () => {
      spawnCalls += 1;
      return new Error("HTTP 503: provider is not ready");
    },
  });
  await broken.load();
  const noHelper = await broken.refresh("thr_c");
  assert.equal(noHelper.status, "failed");
  assert.match(noHelper.reason ?? "", /provider is not ready/);
  // One call plus one retry without the lifecycle owner; no model retry.
  assert.equal(spawnCalls, 2);
  await broken.dispose();
});

test("a person's rename keeps its words; lock leaves the title alone; revert restores it and unlock writes the topic", async () => {
  const item = thread("thr_a", { title: "Сгенерированное" });
  const world = makeWorld({ threads: [item] });
  await world.load();
  await world.refresh("thr_a");
  assert.equal(item.thread.title, TOPIC);

  // A person renames the thread: the words are theirs from now on.
  item.thread = { ...item.thread, title: "Мой тред про Codex" };
  grow(item, 1);
  const renamed = await world.refresh("thr_a");
  assert.equal(renamed.title, null);
  let card = await world.show("thr_a");
  assert.deepEqual([card.policy, card.lockReason], ["owner-words", "manual"]);

  // With the status in titles, owner words get only the status mark in front.
  await world.setSettings({ statusDisplay: "title" });
  grow(item, 1);
  await world.refresh("thr_a");
  assert.equal(item.thread.title, "✅ Мой тред про Codex");

  // Locked by command: the plugin does not touch the title at all.
  await world.rpc("lock", { threadId: "thr_a" });
  grow(item, 1);
  world.answers(answer({ state: "question", stoppedAt: "Выбрать вариант" }));
  await world.refresh("thr_a");
  assert.equal(item.thread.title, "✅ Мой тред про Codex");
  assert.equal((await world.show("thr_a")).policy, "off");

  const reverted = await world.cli("revert", "thr_a");
  assert.equal(reverted.exitCode, 0, reverted.stderr);
  assert.equal(item.thread.title, "Сгенерированное");
  card = await world.show("thr_a");
  assert.deepEqual([card.policy, card.lockReason], ["owner-words", "reverted"]);

  await world.setSettings({ statusDisplay: "row" });
  assert.equal((await world.cli("unlock", "thr_a")).exitCode, 0);
  assert.equal(item.thread.title, TOPIC);
  assert.equal((await world.show("thr_a")).policy, "auto");
  await world.dispose();
});

test("a lock or rename made while the helper reads wins over its title", async () => {
  const item = thread("thr_a");
  const world = makeWorld({ threads: [item] });
  await world.load();

  let release = world.holdHelpers();
  let running = world.refresh("thr_a");
  await until(() => world.spawns.length === 1);
  await world.rpc("lock", { threadId: "thr_a" });
  release();
  assert.equal((await running).title, null);
  assert.deepEqual(world.updates, []);

  await world.rpc("unlock", { threadId: "thr_a" });
  const written = world.updates.length;
  grow(item, 1);
  release = world.holdHelpers();
  running = world.refresh("thr_a");
  await until(() => world.spawns.length === 2);
  item.thread = { ...item.thread, title: "Мой тред" };
  release();
  assert.equal((await running).title, null);
  assert.equal(world.updates.length, written);
  const state = (await world.show("thr_a")).state;
  assert.deepEqual([state.locked, state.lockReason], [true, "manual"]);
  await world.dispose();
});

test("threads in a section left alone, child threads and plugin threads are skipped without a model call", async () => {
  const world = makeWorld({
    threads: [
      thread("thr_kept", { sectionId: "sec_kept", title: "Ручное имя" }),
      thread("thr_child", { parentThreadId: "thr_parent" }),
      thread("thr_mine", { visibility: "hidden", originPluginId: PLUGIN_ID }),
      thread("thr_recap", { originPluginId: "bb-recap" }),
    ],
  });
  await world.load();
  await world.setSettings({ skipSections: "kept" });

  const kept = await world.refresh("thr_kept");
  assert.deepEqual([kept.status, kept.reason], ["skipped", 'section "Kept" is left alone']);
  assert.equal((await world.show("thr_kept")).skipped, kept.reason);
  for (const id of ["thr_child", "thr_mine", "thr_recap"]) {
    assert.equal((await world.refresh(id)).status, "skipped", id);
  }
  assert.match((await world.show("thr_child")).skipped ?? "", /child thread/);
  assert.equal(world.spawns.length, 0);
  assert.deepEqual(world.updates, []);
  await world.dispose();
});

test("list --project returns topic, status and the last report for a project brief", async () => {
  const item = thread("thr_a", {}, 1);
  const world = makeWorld({ threads: [item, thread("thr_b", { title: "Второй" })] });
  await world.load();
  say(item, "Переведи Hermes на Codex");
  report(item, { state: "waiting", about: TOPIC, done: "PR #12 открыт", stoppedAt: "Ждём CI" });
  reply(item, "Жду CI");
  await world.status("thr_a");

  const listed = JSON.parse((await world.cli("list", "--project", "proj_personal", "--json")).stdout) as Record<string, unknown>[];
  const row = listed.find((entry) => entry.threadId === "thr_a")!;
  assert.deepEqual(
    [row.topic, row.state, row.reason, row.done, row.stoppedAt, row.policy],
    [TOPIC, "waiting", "Ждём CI", "PR #12 открыт", "Ждём CI", "auto"],
  );
  assert.deepEqual(
    [listed.find((entry) => entry.threadId === "thr_b")?.topic, listed.find((entry) => entry.threadId === "thr_b")?.title],
    [null, "Второй"],
  );
  assert.notEqual((await world.cli("list", "--json")).exitCode, 0);
  await world.dispose();
});

test("orphan cleanup deletes old helpers of this plugin and leaves fresh ones", async () => {
  const now = Date.now();
  const world = makeWorld({
    helpers: [
      makeThreadResponse({ id: "thr_old", visibility: "hidden", originPluginId: PLUGIN_ID, createdAt: now - 3_600_000 }),
      makeThreadResponse({ id: "thr_fresh", visibility: "hidden", originPluginId: PLUGIN_ID, createdAt: now - 10_000 }),
    ],
  });
  const removed = await cleanupOrphanHelpers(world.bb.sdk, PLUGIN_ID, now);
  assert.deepEqual(removed, ["thr_old"]);
  assert.deepEqual(world.deleted, ["thr_old"]);
  await world.dispose();
});
