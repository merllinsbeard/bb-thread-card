// What the card model reads: owner messages in full, agent finals per turn,
// service messages as one line, and how a long thread fits the budget.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BLOB_THRESHOLD,
  REPLY_FULL_MAX,
  TRANSCRIPT_BUDGET,
  composeOwnerBlock,
  composeTranscript,
  messagesFromEvents,
  readThreadContent,
  turnsToFetch,
  type ThreadMessage,
  type TurnReply,
} from "../lib/transcript.ts";
import { reply, say, thread, type FakeEvent } from "./world.ts";

const userEvent = (seq: number, text: string, extra: Record<string, unknown> = {}) => ({
  type: "client/turn/requested",
  seq,
  data: { initiator: "user", input: [{ type: "text", text, mentions: [] }], ...extra },
});

const fakeThreads = (events: FakeEvent[]) => {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    threads: {
      events: {
        list: async (args: Record<string, unknown>) => {
          calls.push(args);
          const types = args.types as string[];
          const after = args.afterSeq !== undefined ? Number(args.afterSeq) : -1;
          const before = args.beforeSeq !== undefined ? Number(args.beforeSeq) : Number.POSITIVE_INFINITY;
          const list = events
            .filter((event) => types.includes(event.type) && event.seq > after && event.seq < before)
            .sort((a, b) => a.seq - b.seq);
          if (args.order === "desc") list.reverse();
          return list.slice(0, Number(args.limit ?? 100));
        },
      },
    } as never,
  };
};

test("owner messages go in full; only a pasted blob is cut to its start and end with its size", () => {
  const long = `Сделай так, чтобы Hermes ходил через Codex. ${"Подробно объясняю задачу. ".repeat(60)}`;
  assert.ok(long.length < BLOB_THRESHOLD);
  const log = `глянь лог\n${"ERROR 401 unauthorized at gateway\n".repeat(200)}конец лога`;
  const code = "```python\nimport os\nprint(os.environ)\nexit(1)\n```\nпочему падает?";
  const block = composeOwnerBlock(messagesFromEvents([userEvent(1, long), userEvent(5, log), userEvent(9, code)]));
  const [first, second, third] = block.text.split("\n#").map((line) => line.replace(/^#?/, "#"));
  assert.equal(first, `#1: ${long.trim()}`);
  assert.match(second!, /^#2: глянь лог/);
  assert.match(second!, /конец лога \[вставка: \d+ симв\.\]$/);
  assert.ok(second!.length < 1_400, `blob kept ${second!.length} characters`);
  assert.equal(third, "#3: [код: python, 3 строк]\nпочему падает?");
});

test("service messages are one line each and never count as the owner's words", () => {
  const messages = messagesFromEvents([
    userEvent(1, "Настрой туннель до example-host"),
    userEvent(3, "[BB workflow finished: review]\n" + "подробный отчёт ".repeat(100)),
    userEvent(5, "[bb message from thread:thr_x] готово"),
    userEvent(7, "Please continue"),
    userEvent(8, "Please continue"),
    userEvent(9, "Сделай это агентом", { initiator: "agent" }),
    userEvent(11, "Проверь ещё Helium"),
  ]);
  assert.deepEqual(
    messages.map((message) => message.service),
    [false, true, true, true, true, true, false],
  );
  const owner = composeOwnerBlock(messages);
  assert.equal(owner.count, 2);
  assert.equal(owner.text, "#1: Настрой туннель до example-host\n#2: Проверь ещё Helium");

  const { text } = composeTranscript({ messages, turns: [], budget: TRANSCRIPT_BUDGET });
  const lines = text.split("\n");
  assert.deepEqual(lines.filter((line) => line.startsWith("[владелец")), ["[владелец #1]", "[владелец #2]"]);
  const service = lines.filter((line) => line.startsWith("Служебное: "));
  assert.equal(service.length, 4, text);
  assert.ok(service.every((line) => line.length <= "Служебное: ".length + 210), text);
  assert.ok(service.includes("Служебное: Please continue (×2)"), text);
});

test("an agent final goes in full up to 3,000 characters, longer ones keep their start and end", () => {
  const short = "Итог: туннель поднят, Helium один.";
  const long = `Начало: план такой. ${"середина ".repeat(600)}Конец: всё проверено.`;
  const turns: TurnReply[] = [
    { seq: 2, status: "completed", text: short, files: ["/home/example/code/tunnel/main.go"] },
    { seq: 4, status: "failed", text: long },
    { seq: 6, status: "interrupted", text: null },
  ];
  const { text } = composeTranscript({ messages: [], turns, budget: TRANSCRIPT_BUDGET });
  assert.match(text, /^Агент: Итог: туннель поднят, Helium один\.\n {2}\[изменены файлы: ~\/code\/tunnel\/main\.go\]/);
  const longLine = text.split("\n").find((line) => line.startsWith("Агент: Начало"))!;
  assert.ok(long.length > REPLY_FULL_MAX);
  assert.ok(longLine.length < 2_900, `${longLine.length}`);
  assert.match(longLine, /Конец: всё проверено\. \[ход оборвался ошибкой\]$/);
  assert.match(text, /Агент: \[итогового ответа нет\] \[ход прерван\]$/);
});

test("past the budget the first 3 and last 10 turns stay in full and the middle is sampled with a marker", () => {
  const messages: ThreadMessage[] = [];
  const turns: TurnReply[] = [];
  for (let i = 0; i < 60; i++) {
    messages.push({ seq: i * 10 + 1, text: `Запрос ${i}`, initiator: "user", service: false });
    turns.push({ seq: i * 10 + 5, status: "completed", text: `Ответ ${i}: ${"работа ".repeat(400)}` });
  }
  const budget = 60_000;
  const { text, omitted } = composeTranscript({ messages, turns, budget });
  assert.ok(text.length <= budget, `length ${text.length}`);
  assert.ok(omitted > 0);
  for (const i of [0, 1, 2, 50, 55, 59]) assert.match(text, new RegExp(`Ответ ${i}:`), `turn ${i}`);
  const kept = [...text.matchAll(/Ответ (\d+):/g)].map((match) => Number(match[1]));
  const middle = kept.filter((i) => i >= 3 && i < 50);
  assert.ok(middle.length > 3, `sampled middle: ${middle.join(",")}`);
  assert.ok(middle.at(-1)! - middle[0]! > 25, "the sample spans the middle evenly");
  assert.match(text, /\[… пропущено ходов агента: \d+ …\]/);
});

test("a long thread fetches the finals of the first, last and an even sample of the middle turns", () => {
  assert.deepEqual(turnsToFetch(5), [0, 1, 2, 3, 4]);
  const picked = turnsToFetch(200, 60);
  assert.equal(picked.length, 60);
  assert.deepEqual(picked.slice(0, 3), [0, 1, 2]);
  assert.deepEqual(picked.slice(-10), [190, 191, 192, 193, 194, 195, 196, 197, 198, 199]);
  assert.ok(new Set(picked).size === 60);
});

test("reading a thread takes each turn's final message and the files it changed, never tool output", async () => {
  const item = thread("thr_a", {}, 0);
  say(item, "Подними туннель");
  reply(item, "Смотрю конфиги", { tools: 5 });
  say(item, "Дальше");
  reply(item, "Туннель поднят", { tools: 2, files: ["/home/example/code/tunnel/main.go", "/home/example/code/tunnel/main.go"] });
  const { threads, calls } = fakeThreads(item.events);

  const content = await readThreadContent(threads, "thr_a", 0);

  assert.deepEqual(content.messages.map((message) => message.text), ["Подними туннель", "Дальше"]);
  assert.deepEqual(
    content.turns.map((turn) => [turn.text, turn.files]),
    [
      ["Смотрю конфиги", []],
      ["Туннель поднят", ["/home/example/code/tunnel/main.go"]],
    ],
  );
  assert.equal(content.maxSeq, item.maxSeq);
  assert.equal(content.cost.requests, calls.length);
  // Finals are read backwards from each turn's end, a few events at a time.
  assert.ok(calls.some((call) => (call.types as string[])[0] === "item/completed" && call.order === "desc" && call.limit === "3"));

  // An incremental read sees only turns after the last processed sequence,
  // but every message (the numbering of owner messages needs them).
  const firstEnd = item.events.find((event) => event.type === "turn/completed")!.seq;
  const later = await readThreadContent(threads, "thr_a", firstEnd);
  assert.deepEqual(later.turns.map((turn) => turn.text), ["Туннель поднят"]);
  assert.equal(later.messages.length, 2);
});

test("an increment numbers new owner messages after the ones the previous card covered", () => {
  const messages = messagesFromEvents([userEvent(30, "Новая просьба")]);
  assert.equal(composeOwnerBlock(messages, undefined, 7).text, "#8: Новая просьба");
  const { text } = composeTranscript({ messages, turns: [], budget: TRANSCRIPT_BUDGET, ownerOffset: 7 });
  assert.equal(text, "[владелец #8]");
});

test("thread mentions keep the other thread's title", () => {
  const [message] = messagesFromEvents([
    userEvent(1, "@thread:thr_abc доведи до конца", {
      input: [
        {
          type: "text",
          text: "@thread:thr_abc доведи до конца",
          mentions: [{ start: 0, end: 15, resource: { kind: "thread", threadId: "thr_abc", label: "Сборка GLT" } }],
        },
      ],
    }),
  ]);
  assert.equal(message!.text, "@тред «Сборка GLT» доведи до конца");
});
