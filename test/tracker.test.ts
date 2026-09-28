// The status end to end on the fake host: who gets the report tool, a
// report → status and topic (titles untouched while the status runs in
// shadow), a request to the owner, a failed turn and its retry window, and
// a restart that missed events.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import { REPORT_TOOL } from "../lib/report.ts";
import plugin from "../server.ts";
import { interaction, makeWorld, providerError, reply, report, say, thread, until } from "./world.ts";

const T0 = Date.UTC(2026, 8, 27, 12, 0, 0);

const context = (thread: Partial<PluginAgentConfigurationContext["thread"]>, pluginId: string | null = null): PluginAgentConfigurationContext => ({
  pluginMetadata: {},
  thread: { id: "thr_a", title: null, parentThreadId: null, sourceThreadId: null, ...thread },
  project: { id: "proj_personal", kind: "personal", name: "Personal", gitRemoteUrl: null },
  environment: { id: "env_a", name: null, path: null, branchName: null, workspaceProvisionType: null },
  host: { id: "host_1", name: "example-host" },
  provider: { id: "claude-code", model: "opus", capabilities: { supportsNativeUserQuestion: true } },
  origin: { kind: pluginId === "side-chat" ? "fork" : null, pluginId },
});

test("the report tool goes to the owner's root threads, not to children, side chats or plugin threads", async () => {
  const world = makeWorld();
  await world.load();
  const tools = async (ctx: PluginAgentConfigurationContext) =>
    (await world.harness.behavior.resolveAgentConfiguration(ctx)).tools.map((tool) => tool.name);
  assert.deepEqual(await tools(context({})), [REPORT_TOOL]);
  assert.deepEqual(await tools(context({ parentThreadId: "thr_parent" })), []);
  assert.deepEqual(await tools(context({}, "side-chat")), []);
  assert.deepEqual(await tools(context({}, "thread-card")), []);
  await world.dispose();
});

test("a turn ending with the agent's report sets the status and the topic; the title stays as it is", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const item = thread("thr_a", {}, 1);
  const world = makeWorld({ threads: [item] });
  await world.load();

  say(item, "Переведи Hermes на Codex");
  report(item, { state: "done", about: "Перевести Hermes на Codex", done: "Hermes ходит через Codex app-server", stoppedAt: "Всё сделано" });
  reply(item, "Готово");
  await world.idle(item);
  await until(async () => (await world.status("thr_a", true)).status?.state === "done");

  const shown = await world.status("thr_a", true);
  assert.equal(shown.status?.source, "agent");
  assert.equal(shown.status?.reason, "Hermes ходит через Codex app-server");
  assert.equal(shown.topic?.topic, "Перевести Hermes на Codex");
  assert.equal(shown.topic?.setBy, "agent");
  assert.equal(shown.report?.done, "Hermes ходит через Codex app-server");
  assert.equal(shown.status?.reported, 1);
  assert.equal(shown.status?.turns, 2);
  assert.deepEqual(world.updates, []);

  // The agent is told the kept topic, so it does not rename the thread by rewording it.
  const answer = await world.harness.behavior.callAgentTool(
    REPORT_TOOL,
    { state: "done", about: "Настроить Codex", done: "", stoppedAt: "" },
    { threadId: "thr_a" },
  );
  assert.equal(answer, "Статус записан. Тема треда: Перевести Hermes на Codex");

  // A later report without topicChanged keeps the topic; with it the topic moves.
  say(item, "Теперь про Telegram");
  report(item, { about: "Подключить Telegram к Hermes" });
  reply(item, "Сделал");
  assert.equal((await world.status("thr_a")).topic?.topic, "Перевести Hermes на Codex");
  say(item, "Точно другая задача");
  report(item, { about: "Подключить Telegram к Hermes", topicChanged: true });
  reply(item, "Сделал");
  assert.equal((await world.status("thr_a")).topic?.topic, "Подключить Telegram к Hermes");
  await world.dispose();
});

test("a question to the owner is ❓ while it waits and ⏳ once answered", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const item = thread("thr_a", {}, 1);
  const world = makeWorld({ threads: [item] });
  await world.load();

  say(item, "Создай файл");
  interaction(item, "pint_1", "pending");
  item.thread = { ...item.thread, status: "active" };
  await world.interactionPending(item);
  await until(async () => (await world.status("thr_a", true)).status?.state === "question");
  assert.equal((await world.status("thr_a", true)).status?.reason, "Какую строку записать?");

  interaction(item, "pint_1", "resolved");
  assert.equal((await world.status("thr_a")).status?.state, "running");
  await world.dispose();
});

test("a failed turn holds for provider-retry, then shows as stopped with its error, not as a question", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const item = thread("thr_a", {}, 1);
  const world = makeWorld({ threads: [item] });
  await world.load();

  say(item, "Продолжай");
  providerError(item, "You've hit your session limit");
  reply(item, null, { status: "failed" });
  item.thread = { ...item.thread, status: "error" };
  await world.failed(item);
  await until(async () => (await world.status("thr_a", true)).status !== null);
  assert.notEqual((await world.status("thr_a", true)).status?.state, "question");

  t.mock.timers.tick(16_000);
  await world.collect();
  const shown = await world.status("thr_a", true);
  assert.deepEqual(
    [shown.status?.state, shown.status?.view, shown.status?.execution, shown.status?.reason],
    ["unknown", "stopped", "failed", "Run failed: You've hit your session limit"],
  );
  await world.dispose();
});

test("a log longer than one pass is read to its end before the status is set", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const item = thread("thr_a", {}, 1);
  const world = makeWorld({ threads: [item] });
  await world.load();
  say(item, "Долгая цель");
  report(item, { state: "waiting", stoppedAt: "Ждём CI" });
  // A Codex goal turn: thousands of items before its end.
  reply(item, "Готово", { tools: 6_000 });
  const shown = await world.status("thr_a");
  assert.equal(shown.status?.state, "waiting");
  assert.equal(shown.status?.reason, "Ждём CI");
  await world.dispose();
});

test("after a restart the startup pass catches up on turns the plugin did not see", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: T0 });
  const item = thread("thr_a", {}, 1);
  const world = makeWorld({ threads: [item] });
  await world.load();
  say(item, "Сделай");
  report(item, { state: "done" });
  reply(item, "Готово");
  await world.idle(item);
  await until(async () => (await world.status("thr_a", true)).status?.state === "done");

  const reloaded = await world.harness.lifecycle.reload(plugin);
  // While the plugin was away: a new turn that ends with a question.
  say(item, "А ещё");
  report(item, { state: "question", stoppedAt: "Нужен токен Telegram" });
  reply(item, "Нужен токен");
  t.mock.timers.tick(5_000);
  const status = async () => {
    const result = await reloaded.harness.behavior.runCli(["status", "thr_a", "--json"], { cwd: "/tmp" });
    return (JSON.parse(result.stdout) as { status: { state: string; reason: string } | null }).status;
  };
  await until(async () => (await status())?.state === "question");
  assert.equal((await status())?.reason, "Нужен токен Telegram");
  await reloaded.harness.lifecycle.dispose();
});
