// What the card model reads. The helper model has a 272k-token window, so
// the thread goes in nearly whole; only noise is dropped:
//   - every owner message in full, in order, in its own block — the owner's
//     words decide what the thread is about. Only pasted blobs (logs, docs,
//     dispatcher prompts over 2,000 characters) are cut to their start and
//     end with a size note;
//   - for each agent turn its final reply in full (up to 3,000 characters;
//     longer ones keep the first 2,000 and the last 800) and the paths of
//     files it changed. Tool output never enters; code becomes a marker;
//   - service messages (workflow results, other threads, "Please continue")
//     as one short line each: they arrive as user turns but are machine text.
// Past the budget the first 3 and the last 10 turns stay in full and the
// middle is sampled evenly, with a marker for what was skipped.
//
// Everything comes from thread events: `client/turn/requested` for
// messages, `turn/completed` for turn boundaries, and one small
// `item/completed` read before each turn's end for its final reply. The
// start of a long thread costs the same as its end, and a turn with
// hundreds of commands is never paged through.
import type { PluginBbSdk } from "@get-bb/plugin-sdk";

/** Characters for the owner block and the transcript together (full rebuild). */
export const TRANSCRIPT_BUDGET = 120_000;
/** The owner block is sampled only past this (it rarely is). */
export const OWNER_BLOCK_BUDGET = 60_000;
export const BLOB_THRESHOLD = 2_000;
export const BLOB_HEAD = 1_000;
export const BLOB_TAIL = 300;
export const OWNER_KEEP_FIRST = 5;
export const OWNER_KEEP_LAST = 10;
export const REPLY_FULL_MAX = 3_000;
export const REPLY_HEAD = 2_000;
export const REPLY_TAIL = 800;
export const SERVICE_LINE_MAX = 200;
/** Turns always shown in full when over budget: the plan and the latest state. */
export const HEAD_TURNS = 3;
export const TAIL_TURNS = 10;
/** Final replies fetched per card; past this the middle is sampled. */
export const MAX_FETCHED_TURNS = 60;
const MAX_FILES_PER_TURN = 12;
const MAX_EVENT_PAGES = 30;

/** Machine text that bb delivers as a user turn. */
const SERVICE_PREFIXES = ["[BB workflow finished", "[bb message from thread:", "[bb system]", "Please continue"];

export interface ThreadMessage {
  seq: number;
  text: string;
  initiator: "user" | "agent" | "system";
  /** Workflow results, other threads, system nudges: not the owner's words. */
  service: boolean;
}

export interface TurnReply {
  /** Sequence of the turn's `turn/completed` event. */
  seq: number;
  status: string | null;
  /** Final agent reply; null when the turn had none; undefined when not fetched. */
  text?: string | null;
  /** Files the turn changed (only for turns shown in full). */
  files?: string[];
}

type UnknownRecord = Record<string, unknown>;
const asRecord = (value: unknown): UnknownRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

// ---------------------------------------------------------------------------
// Text shaping

/** Replace fenced code with `[код: lang, N строк]`; an unclosed fence runs to the end. */
export function replaceCodeBlocks(text: string): string {
  const marker = (lang: string, body: string) => {
    const lines = body.replace(/\n+$/, "").split("\n").length;
    return `[код: ${lang.trim() ? `${lang.trim()}, ` : ""}${lines} строк]`;
  };
  return text
    .replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_match, lang: string, body: string) => marker(lang, body))
    .replace(/```([^\n`]*)\n([\s\S]*)$/, (_match, lang: string, body: string) => marker(lang, body));
}

const tidy = (text: string) =>
  text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** First `max` characters, cut on a word boundary when one is near. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.8 ? cut.slice(0, space) : cut).trimEnd()} […]`;
}

/** Start and end of a long text: summaries open a reply, results close it. */
export function keepHeadTail(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text;
  const start = text.slice(0, head);
  const end = text.slice(-tail);
  const headSpace = start.lastIndexOf(" ");
  const tailSpace = end.indexOf(" ");
  const first = headSpace > head * 0.8 ? start.slice(0, headSpace) : start;
  const last = tailSpace >= 0 && tailSpace < tail * 0.2 ? end.slice(tailSpace + 1) : end;
  return `${first.trimEnd()} […] ${last.trimStart()}`;
}

/** `@thread:thr_x` mentions carry the other thread's title; keep it in the text. */
export function renderMentions(text: string, mentions: unknown): string {
  if (!Array.isArray(mentions)) return text;
  const spans = mentions
    .map((mention) => {
      const record = asRecord(mention);
      const resource = asRecord(record?.resource);
      const start = num(record?.start);
      const end = num(record?.end);
      const label = str(resource?.label);
      if (start === null || end === null || label === null || end <= start) return null;
      if (str(resource?.kind) !== "thread") return null;
      return { start, end, label: `@тред «${label}»` };
    })
    .filter((span): span is { start: number; end: number; label: string } => span !== null)
    .sort((a, b) => b.start - a.start);
  let result = text;
  for (const span of spans) {
    if (span.end > result.length) continue;
    result = `${result.slice(0, span.start)}${span.label}${result.slice(span.end)}`;
  }
  return result;
}

const shortPath = (path: string) => path.replace(/^\/(?:home|Users)\/[^/]+\//, "~/");

export function isServiceMessage(text: string, initiator: ThreadMessage["initiator"]): boolean {
  if (initiator !== "user") return true;
  const start = text.trimStart();
  return SERVICE_PREFIXES.some((prefix) => start.startsWith(prefix));
}

/** Parse `client/turn/requested` events into messages, oldest first. */
export function messagesFromEvents(events: readonly unknown[]): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  for (const raw of events) {
    const event = asRecord(raw);
    if (event?.type !== "client/turn/requested") continue;
    const data = asRecord(event.data);
    const seq = num(event.seq);
    if (!data || seq === null) continue;
    const parts = Array.isArray(data.input) ? data.input : [];
    const text = parts
      .map((part) => {
        const record = asRecord(part);
        if (record?.type !== "text") return "";
        return renderMentions(str(record.text) ?? "", record.mentions);
      })
      .filter((part) => part.trim() !== "")
      .join("\n");
    if (text.trim() === "") continue;
    const initiator = data.initiator === "agent" || data.initiator === "system" ? data.initiator : "user";
    messages.push({ seq, text, initiator, service: isServiceMessage(text, initiator) });
  }
  return messages.sort((a, b) => a.seq - b.seq);
}

export const ownerMessages = (messages: readonly ThreadMessage[]) =>
  messages.filter((message) => !message.service);

/** An owner message in full; a pasted blob keeps its start and end and says how big it was. */
export function renderOwnerText(text: string): string {
  const clean = tidy(replaceCodeBlocks(text));
  if (clean.length <= BLOB_THRESHOLD) return clean;
  return `${keepHeadTail(clean, BLOB_HEAD, BLOB_TAIL)} [вставка: ${clean.length} симв.]`;
}

// ---------------------------------------------------------------------------
// The owner block

/**
 * Every owner message, numbered, in order and in full (pasted blobs cut).
 * Past the block budget the first five and the last ten stay and the middle
 * is sampled evenly. `offset` numbers them when only later messages are passed.
 */
export function composeOwnerBlock(
  messages: readonly ThreadMessage[],
  budget = OWNER_BLOCK_BUDGET,
  offset = 0,
): { text: string; count: number; omitted: number } {
  const owner = ownerMessages(messages);
  const lines = owner.map((message, index) => `#${offset + index + 1}: ${renderOwnerText(message.text)}`);
  const all = lines.map((_line, index) => index);
  const kept = sampleToBudget(all, (index) => lines[index]!.length + 1, budget, OWNER_KEEP_FIRST, OWNER_KEEP_LAST);
  const parts: string[] = [];
  let skipped = 0;
  for (const index of all) {
    if (kept.has(index)) {
      if (skipped > 0) parts.push(`[… пропущено сообщений владельца: ${skipped} …]`);
      skipped = 0;
      parts.push(lines[index]!);
    } else {
      skipped += 1;
    }
  }
  if (skipped > 0) parts.push(`[… пропущено сообщений владельца: ${skipped} …]`);
  return { text: parts.join("\n"), count: owner.length, omitted: lines.length - kept.size };
}

/**
 * All items when they fit; otherwise the first `head` and last `tail`, and
 * an even sample of the middle while the budget lasts.
 */
function sampleToBudget(
  items: readonly number[],
  size: (item: number) => number,
  budget: number,
  head: number,
  tail: number,
): Set<number> {
  const total = items.reduce((sum, item) => sum + size(item), 0);
  if (total <= budget) return new Set(items);
  const kept = new Set([...items.slice(0, head), ...items.slice(Math.max(head, items.length - tail))]);
  let used = [...kept].reduce((sum, item) => sum + size(item), 0);
  const middle = items.filter((item) => !kept.has(item));
  for (let step = Math.max(1, Math.floor(middle.length / 2)); ; step = Math.floor(step / 2)) {
    for (let i = Math.floor(step / 2); i < middle.length; i += step) {
      const item = middle[i]!;
      if (kept.has(item) || used + size(item) + 80 > budget) continue;
      kept.add(item);
      used += size(item);
    }
    if (step <= 1) break;
  }
  return kept;
}

// ---------------------------------------------------------------------------
// The transcript

const TURN_STATUS: Record<string, string> = {
  failed: "ход оборвался ошибкой",
  interrupted: "ход прерван",
  cancelled: "ход отменён",
};

export function renderReply(turn: TurnReply): string {
  const note = turn.status && turn.status !== "completed" ? ` [${TURN_STATUS[turn.status] ?? turn.status}]` : "";
  const lines: string[] = [];
  if (!turn.text) lines.push(`Агент: [итогового ответа нет]${note}`);
  else {
    const text = tidy(replaceCodeBlocks(turn.text));
    const body = text.length <= REPLY_FULL_MAX ? text : keepHeadTail(text, REPLY_HEAD, REPLY_TAIL);
    lines.push(`Агент: ${body}${note}`);
  }
  if (turn.files && turn.files.length > 0) {
    const files = turn.files.slice(0, MAX_FILES_PER_TURN).map(shortPath).join(", ");
    const more = turn.files.length > MAX_FILES_PER_TURN ? ` и ещё ${turn.files.length - MAX_FILES_PER_TURN}` : "";
    lines.push(`  [изменены файлы: ${files}${more}]`);
  }
  return lines.join("\n");
}

interface Segment {
  lines: string[];
  turn: TurnReply | null;
}

/**
 * Agent replies and service lines in time order, with a marker where each
 * owner message came in (its text is in the owner block). Past the budget
 * the first 3 and last 10 turns stay and the middle is sampled evenly.
 * `ownerOffset` numbers the markers when only later messages are passed.
 */
export function composeTranscript(args: {
  messages: readonly ThreadMessage[];
  turns: readonly TurnReply[];
  budget: number;
  ownerOffset?: number;
}): { text: string; omitted: number } {
  const events = [
    ...args.messages.map((message) => ({ seq: message.seq, message, turn: null as TurnReply | null })),
    ...args.turns.map((turn) => ({ seq: turn.seq, message: null as ThreadMessage | null, turn })),
  ].sort((a, b) => a.seq - b.seq);

  const segments: Segment[] = [];
  let current: Segment = { lines: [], turn: null };
  let ownerIndex = args.ownerOffset ?? 0;
  let lastService: { text: string; count: number } | null = null;
  const flushService = () => {
    if (lastService === null) return;
    current.lines.push(`Служебное: ${lastService.text}${lastService.count > 1 ? ` (×${lastService.count})` : ""}`);
    lastService = null;
  };
  for (const event of events) {
    if (event.message) {
      if (event.message.service) {
        const text = clipText(oneLine(event.message.text), SERVICE_LINE_MAX);
        if (lastService !== null && lastService.text === text) lastService.count += 1;
        else {
          flushService();
          lastService = { text, count: 1 };
        }
      } else {
        flushService();
        ownerIndex += 1;
        current.lines.push(`[владелец #${ownerIndex}]`);
      }
      continue;
    }
    flushService();
    const turn = event.turn!;
    if (turn.text !== undefined) current.lines.push(renderReply(turn));
    current.turn = turn;
    segments.push(current);
    current = { lines: [], turn: null };
  }
  flushService();
  if (current.lines.length > 0) segments.push(current);

  const size = (index: number) =>
    segments[index]!.turn?.text === undefined && segments[index]!.turn !== null
      ? Number.POSITIVE_INFINITY // not fetched: never chosen
      : segments[index]!.lines.reduce((sum, line) => sum + line.length + 1, 0);
  const indexes = segments.map((_segment, index) => index);
  const turnIndexes = indexes.filter((index) => segments[index]!.turn !== null);
  const headTurns = new Set(turnIndexes.slice(0, HEAD_TURNS));
  const tailTurns = new Set(turnIndexes.slice(-TAIL_TURNS));
  const total = indexes.reduce((sum, index) => sum + size(index), 0);
  let chosen: Set<number>;
  if (total <= args.budget) chosen = new Set(indexes);
  else {
    // Segments without a turn (trailing messages) always stay.
    chosen = new Set(indexes.filter((index) => segments[index]!.turn === null || headTurns.has(index) || tailTurns.has(index)));
    let used = [...chosen].reduce((sum, index) => sum + Math.min(size(index), args.budget), 0);
    const middle = indexes.filter((index) => !chosen.has(index) && Number.isFinite(size(index)));
    for (let step = Math.max(1, Math.floor(middle.length / 2)); ; step = Math.floor(step / 2)) {
      for (let i = Math.floor(step / 2); i < middle.length; i += step) {
        const index = middle[i]!;
        if (chosen.has(index) || used + size(index) + 200 > args.budget) continue;
        chosen.add(index);
        used += size(index);
      }
      if (step <= 1) break;
    }
  }

  const parts: string[] = [];
  let skippedTurns = 0;
  const gap = () => {
    if (skippedTurns > 0) parts.push(`[… пропущено ходов агента: ${skippedTurns} …]`);
    skippedTurns = 0;
  };
  for (const index of indexes) {
    const segment = segments[index]!;
    if (chosen.has(index) && Number.isFinite(size(index))) {
      gap();
      parts.push(...segment.lines);
    } else if (segment.turn) {
      skippedTurns += 1;
    }
  }
  gap();
  const omitted = turnIndexes.filter((index) => !chosen.has(index) || !Number.isFinite(size(index))).length;
  return { text: parts.join("\n"), omitted };
}

// ---------------------------------------------------------------------------
// Reading from bb

export interface ThreadContent {
  /** Every message in the thread (the owner block needs all of them). */
  messages: ThreadMessage[];
  /** Turns completed after `afterSeq`; replies fetched for all or a sample. */
  turns: TurnReply[];
  /** Highest sequence seen; the next incremental read starts after it. */
  maxSeq: number;
  /** Requests made, for measuring the cost on big threads. */
  cost: { requests: number };
}

type Threads = Pick<PluginBbSdk["threads"], "events">;

async function listAll(
  threads: Threads,
  threadId: string,
  type: "client/turn/requested" | "turn/completed",
  afterSeq: number,
  cost: { requests: number },
  signal?: AbortSignal,
): Promise<unknown[]> {
  const events: unknown[] = [];
  let cursor = afterSeq;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const batch = await threads.events.list({
      threadId,
      types: [type],
      order: "asc",
      afterSeq: String(cursor),
      limit: "100",
      ...(signal ? { signal } : {}),
    });
    cost.requests += 1;
    events.push(...batch);
    if (batch.length < 100) break;
    cursor = batch[batch.length - 1]!.seq;
  }
  return events;
}

/** The last agent message of a turn: the item right before its end, usually. */
async function finalReply(
  threads: Threads,
  threadId: string,
  turn: { start: number; end: number },
  cost: { requests: number },
  signal?: AbortSignal,
): Promise<string | null> {
  const items = await threads.events.list({
    threadId,
    types: ["item/completed"],
    order: "desc",
    beforeSeq: String(turn.end),
    limit: "3",
    ...(signal ? { signal } : {}),
  });
  cost.requests += 1;
  for (const raw of items) {
    const event = asRecord(raw);
    if ((num(event?.seq) ?? 0) <= turn.start) break;
    const item = asRecord(asRecord(event?.data)?.item);
    if (item?.type === "agentMessage") {
      const text = str(item.text);
      if (text && text.trim() !== "") return text;
    }
  }
  return null;
}

/** Paths the turn changed, from the last 100 items it started. */
async function changedFiles(
  threads: Threads,
  threadId: string,
  turn: { start: number; end: number },
  cost: { requests: number },
  signal?: AbortSignal,
): Promise<string[]> {
  const items = await threads.events.list({
    threadId,
    types: ["item/started"],
    order: "desc",
    beforeSeq: String(turn.end),
    limit: "100",
    ...(signal ? { signal } : {}),
  });
  cost.requests += 1;
  const files: string[] = [];
  for (const raw of [...items].reverse()) {
    const event = asRecord(raw);
    if ((num(event?.seq) ?? 0) <= turn.start) continue;
    const item = asRecord(asRecord(event?.data)?.item);
    if (item?.type !== "fileChange" || !Array.isArray(item.changes)) continue;
    for (const change of item.changes) {
      const path = str(asRecord(change)?.path);
      if (path && !files.includes(path)) files.push(path);
    }
  }
  return files;
}

/** Which turns to fetch: all when few, else head, tail and an even middle sample. */
export function turnsToFetch(count: number, max = MAX_FETCHED_TURNS): number[] {
  const all = Array.from({ length: count }, (_value, index) => index);
  if (count <= max) return all;
  const chosen = new Set([...all.slice(0, HEAD_TURNS), ...all.slice(-TAIL_TURNS)]);
  const middle = all.filter((index) => !chosen.has(index));
  const room = max - chosen.size;
  for (let i = 0; i < room; i++) chosen.add(middle[Math.floor(((i + 0.5) * middle.length) / room)]!);
  return [...chosen].sort((a, b) => a - b);
}

/**
 * Read what the card needs: every message in the thread, the turns completed
 * after `afterSeq`, their final replies (all, or head, tail and a sample),
 * and the changed files of the first 3 and last 10 of them.
 */
export async function readThreadContent(
  threads: Threads,
  threadId: string,
  afterSeq: number,
  signal?: AbortSignal,
): Promise<ThreadContent> {
  const cost = { requests: 0 };
  const messages = messagesFromEvents(await listAll(threads, threadId, "client/turn/requested", 0, cost, signal));
  const ends = (await listAll(threads, threadId, "turn/completed", afterSeq, cost, signal))
    .map((raw) => {
      const event = asRecord(raw);
      const seq = num(event?.seq);
      if (seq === null) return null;
      return { seq, status: str(asRecord(event?.data)?.status) } as TurnReply;
    })
    .filter((turn): turn is TurnReply => turn !== null)
    .sort((a, b) => a.seq - b.seq);

  const withFiles = new Set([
    ...ends.slice(0, HEAD_TURNS).map((turn) => turn.seq),
    ...ends.slice(-TAIL_TURNS).map((turn) => turn.seq),
  ]);
  for (const index of turnsToFetch(ends.length)) {
    if (signal?.aborted) break;
    const turn = ends[index]!;
    const span = { start: index > 0 ? ends[index - 1]!.seq : afterSeq, end: turn.seq };
    turn.text = await finalReply(threads, threadId, span, cost, signal);
    if (withFiles.has(turn.seq)) turn.files = await changedFiles(threads, threadId, span, cost, signal);
  }
  const maxSeq = Math.max(afterSeq, ends.at(-1)?.seq ?? 0, messages.at(-1)?.seq ?? 0);
  return { messages, turns: ends, maxSeq, cost };
}
