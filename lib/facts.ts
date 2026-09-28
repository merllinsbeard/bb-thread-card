// What the thread log says about a thread's recent turns, folded event by
// event: when each turn started and ended and how, what input it took, the
// agent's status report, and which requests to the owner are open. Folding
// is split-invariant (reading the log in any number of pieces gives the same
// facts), so the plugin keeps the facts with a cursor and reads only new
// events, and a restart resumes where it stopped.
//
// Only the thread's own turns count. Codex writes the turns of the subagents
// a turn delegates to into the same log (turn/started with parentToolCallId)
// while the outer turn still runs; they are skipped, with everything scoped
// to them.
import { REPORT_TOOL, reportSchema, type ReportArgs } from "./report.ts";

/** Bump when the facts shape changes: stored facts of an older version are rebuilt. */
/** How soon after a stop announced between turns the next turn must start for the stop to be its end. */
export const STOP_BEFORE_TURN_MS = 30_000;
export const FACTS_VERSION = 1;
/** Turns kept: the last one decides the status, the ones before it back up a turn without input. */
const KEEP_TURNS = 4;
/** Requests never accepted (rejected, cancelled) and requests left open are bounded, so stored facts stay small. */
const KEEP_REQUESTS = 20;
const KEEP_INTERACTIONS = 10;
const LABEL_MAX = 160;

/** Event types the fold reads; everything else in the log is skipped. */
export const FACT_EVENT_TYPES = [
  "client/turn/requested",
  "turn/started",
  "turn/input/accepted",
  "turn/completed",
  "item/started",
  "provider/error",
  "system/interaction/lifecycle",
  "system/thread/interrupted",
  "thread/compacted",
] as const;

export interface ReportFact extends ReportArgs {
  seq: number;
  turnId: string;
  itemId: string;
  at: number;
}

export interface TurnFact {
  id: string;
  startSeq: number;
  startAt: number;
  endSeq: number | null;
  endAt: number | null;
  /** completed | failed | interrupted; null while the turn runs. */
  status: string | null;
  /** The provider's error text of a failed turn. */
  error: string | null;
  /** Why an interrupted turn stopped (manual-stop, host-daemon-restarted, …). */
  interruptReason: string | null;
  /** Who started it: user, agent (another thread), system:<kind>, or null when unseen. */
  trigger: string | null;
  /** Seq of the last input the turn took: its first message, a steer or an answer to a request. */
  lastInputSeq: number | null;
  compacted: boolean;
  /** The turn's last valid report. */
  report: ReportFact | null;
}

export interface OpenInteraction {
  id: string;
  turnId: string | null;
  kind: string;
  label: string;
  since: number;
}

export interface Facts {
  version: number;
  processedSeq: number;
  /** When the newest folded event was written. */
  lastEventAt: number;
  /** Seq of the newest input to any turn: a message, a steer or an answer to a request. */
  lastInputSeq: number | null;
  /** When that input was written; absent in facts folded before 0.5. */
  lastInputAt?: number | null;
  turns: TurnFact[];
  interactions: OpenInteraction[];
  /** Requests not yet accepted into a turn: requestId → who sent them. */
  requests: Record<string, string>;
  /** A stop announced while its turn still ran. */
  interrupt: string | null;
  /** A stop announced while no turn ran, for a turn that starts right after it. */
  stopBeforeTurn?: { reason: string; at: number } | null;
  /** The newest valid report of any turn: the card's content. */
  lastReport: ReportFact | null;
  /** Finished turns, and those that ended with a report of their own. */
  counts: { turns: number; reported: number };
}

export function emptyFacts(): Facts {
  return {
    version: FACTS_VERSION,
    processedSeq: 0,
    lastEventAt: 0,
    lastInputSeq: null,
    turns: [],
    interactions: [],
    requests: {},
    interrupt: null,
    stopBeforeTurn: null,
    lastReport: null,
    counts: { turns: 0, reported: 0 },
  };
}

type UnknownRecord = Record<string, unknown>;
const asRecord = (value: unknown): UnknownRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const clip = (text: string) => (text.length <= LABEL_MAX ? text : `${text.slice(0, LABEL_MAX - 1)}…`);

/** Did the turn's report come after its last input (a steer after the report makes it stale)? */
export const reportHolds = (turn: TurnFact): boolean =>
  turn.report !== null && turn.report.seq > (turn.lastInputSeq ?? -1);

/** A report's arguments; optional fields the agent got wrong are dropped rather than losing the report. */
function parseReport(value: unknown): ReportArgs | null {
  const parsed = reportSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const record = asRecord(value);
  if (record === null) return null;
  const { questionCount: _count, waitingOnThreadIds: _waiting, ...core } = record;
  const fallback = reportSchema.safeParse(core);
  return fallback.success ? fallback.data : null;
}

/** What the owner is asked, in a few words. */
function interactionLabel(payload: UnknownRecord | null): string {
  const kind = str(payload?.kind);
  // A plugin's request says what it asks for itself ("Requesting TELEGRAM_BOT_TOKEN").
  const pending = str(asRecord(asRecord(payload?.presentation)?.label)?.pending);
  if (kind === "user_question") {
    const first = asRecord(Array.isArray(payload?.questions) ? payload.questions[0] : null);
    const prompt = str(first?.prompt) ?? str(first?.question);
    return prompt ? clip(prompt.replace(/\s+/g, " ").trim()) : "Answer a question";
  }
  if (kind === "approval") {
    const subject = str(asRecord(payload?.subject)?.kind);
    if (subject === "command") return "Approve a command";
    if (subject === "plan") return "Approve a plan";
    return "Approve an action";
  }
  return pending ? clip(pending) : "Respond to a request";
}

/** Labels the plugin wrote before it spoke English, kept in stored facts until the request closes. */
const LEGACY_LABELS: Record<string, string> = {
  вопрос: "Answer a question",
  "одобрить команду": "Approve a command",
  "одобрить план": "Approve a plan",
  "одобрить действие": "Approve an action",
  запрос: "Respond to a request",
};

/** An open request's label as shown: an agent's own words as they are, the plugin's in English. */
export const labelText = (label: string): string => LEGACY_LABELS[label] ?? label;

/** Fold events (in seq order, any subset of the log after `facts.processedSeq`) into the facts. */
export function foldEvents(previous: Facts, events: readonly unknown[]): Facts {
  const facts: Facts = structuredClone(previous);
  const sorted = events
    .map(asRecord)
    .filter((event): event is UnknownRecord => event !== null && num(event.seq) !== null)
    .sort((a, b) => (a.seq as number) - (b.seq as number));

  // Turns begin only at turn/started: an event of a turn no longer kept (a
  // long-running item of an old turn) must not bring it back as the latest.
  const turnOf = (id: string | null): TurnFact | null =>
    id === null ? null : (facts.turns.find((item) => item.id === id) ?? null);
  const startTurn = (id: string | null, seq: number, at: number): void => {
    if (id === null || turnOf(id) !== null) return;
    facts.turns.push({
      id,
      startSeq: seq,
      startAt: at,
      endSeq: null,
      endAt: null,
      status: null,
      error: null,
      interruptReason: null,
      trigger: null,
      lastInputSeq: null,
      compacted: false,
      report: null,
    });
    if (facts.turns.length > KEEP_TURNS) facts.turns.splice(0, facts.turns.length - KEEP_TURNS);
  };

  const input = (turn: TurnFact | null, seq: number, at: number) => {
    if (turn) turn.lastInputSeq = seq;
    facts.lastInputSeq = seq;
    facts.lastInputAt = at;
  };

  for (const event of sorted) {
    const seq = event.seq as number;
    if (seq <= facts.processedSeq) continue;
    facts.processedSeq = seq;
    const at = num(event.createdAt) ?? 0;
    facts.lastEventAt = Math.max(facts.lastEventAt, at);
    const data = asRecord(event.data) ?? {};
    const turnId = str(asRecord(event.scope)?.turnId);
    switch (event.type) {
      case "client/turn/requested": {
        const requestId = str(data.requestId);
        if (requestId === null) break;
        const initiator = str(data.initiator) ?? "user";
        facts.requests[requestId] = initiator === "system" ? `system:${str(data.systemMessageKind) ?? "unlabeled"}` : initiator;
        const ids = Object.keys(facts.requests);
        for (const old of ids.slice(0, Math.max(0, ids.length - KEEP_REQUESTS))) delete facts.requests[old];
        break;
      }
      case "turn/started":
        // A subagent's turn inside the running one (Codex delegation).
        if (str(data.parentToolCallId) !== null) break;
        startTurn(turnId, seq, at);
        {
          const early = facts.stopBeforeTurn ?? null;
          facts.interrupt = early !== null && at - early.at <= STOP_BEFORE_TURN_MS ? early.reason : null;
          facts.stopBeforeTurn = null;
        }
        break;
      case "turn/input/accepted": {
        const turn = turnOf(turnId);
        const requestId = str(data.clientRequestId);
        const sender = requestId !== null ? facts.requests[requestId] : undefined;
        if (requestId !== null) delete facts.requests[requestId];
        input(turn, seq, at);
        if (turn) turn.trigger ??= sender ?? "unknown";
        break;
      }
      case "item/started": {
        const item = asRecord(data.item);
        if (item?.type === "contextCompaction") {
          const turn = turnOf(turnId);
          if (turn) turn.compacted = true;
          break;
        }
        if (item?.type !== "toolCall" || item.tool !== REPORT_TOOL) break;
        const server = str(item.server);
        if (server !== null && server !== "bb") break;
        const parsed = parseReport(item.arguments);
        const turn = turnOf(turnId);
        if (parsed === null || !turn) break;
        const report: ReportFact = { ...parsed, seq, turnId: turn.id, itemId: str(item.id) ?? "", at };
        turn.report = report;
        facts.lastReport = report;
        break;
      }
      case "thread/compacted": {
        const turn = turnOf(turnId);
        if (turn) turn.compacted = true;
        break;
      }
      case "provider/error": {
        const turn = turnOf(turnId);
        if (turn) turn.error = clip(str(data.detail) ?? str(data.message) ?? "provider error");
        break;
      }
      case "system/thread/interrupted": {
        // bb announces a stop before the turn ends, or (a bb restart) just after it.
        const reason = str(data.reason) ?? "interrupted";
        const last = facts.turns.at(-1);
        if (last && last.endSeq === null) facts.interrupt = reason;
        else if (last && last.status === "interrupted" && last.interruptReason === null) last.interruptReason = reason;
        // Or before the turn it ends has started: a message steered in as the owner pressed Stop.
        else if (!last || last.status !== "interrupted") facts.stopBeforeTurn = { reason, at };
        break;
      }
      case "turn/completed": {
        // A request the turn left open closes with it, even if its own end event never comes.
        if (turnId !== null) facts.interactions = facts.interactions.filter((open) => open.turnId !== turnId);
        const turn = turnOf(turnId);
        // A turn ends once: a second end (interrupted, then failed) changes nothing.
        if (!turn || turn.endSeq !== null) break;
        turn.endSeq = seq;
        turn.endAt = at;
        turn.status = str(data.status) ?? "completed";
        if (turn.status === "interrupted") turn.interruptReason = facts.interrupt;
        facts.interrupt = null;
        facts.counts.turns += 1;
        if (reportHolds(turn)) facts.counts.reported += 1;
        break;
      }
      case "system/interaction/lifecycle": {
        const interaction = asRecord(data.interaction);
        const id = str(interaction?.id);
        if (id === null) break;
        facts.interactions = facts.interactions.filter((open) => open.id !== id);
        const status = str(interaction?.status);
        // Resolving means the owner has answered: that is input, like a message.
        if (status === "resolving" || status === "resolved") input(turnOf(turnId), seq, at);
        // Only a pending request waits for the owner.
        if (status === "pending") {
          const payload = asRecord(interaction?.payload);
          facts.interactions.push({ id, turnId, kind: str(payload?.kind) ?? "unknown", label: interactionLabel(payload), since: at });
          facts.interactions.splice(0, Math.max(0, facts.interactions.length - KEEP_INTERACTIONS));
        }
        break;
      }
    }
  }
  return facts;
}
