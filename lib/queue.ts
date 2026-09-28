// The Needs-you page as data: one card per thread that asks the owner
// something, waits on someone else or stopped, with its request's id,
// version and times, what the owner did with it (snoozed, hidden) and what
// it waits on. The page (app.tsx) and `bb thread-card queue` read the same
// cards; the page groups and filters them with bb's live projects,
// sections and pins, the CLI with the ones the server reads.
import type { Disposition, RequestRecord } from "./requests.ts";
import { activeDisposition } from "./requests.ts";
import type { Execution, Freshness, Source, State, View } from "./status.ts";
import type { StatusRecord } from "./store.ts";

export type QueueSort = "new" | "old";
export const PAGE_VIEWS = ["needs", "waiting", "stopped", "snoozed"] as const;
export type PageView = (typeof PAGE_VIEWS)[number];

/** Each view's name on the page, in the CLI and on the thread card. */
export const VIEW_TITLES: Record<PageView, string> = {
  needs: "Needs you",
  waiting: "Waiting",
  stopped: "Stopped",
  snoozed: "Snoozed",
};

export interface Dependency {
  threadId: string;
  title: string | null;
  state: State | null;
  /** False when bb no longer has the thread. */
  available: boolean;
  archived: boolean;
}

export interface QueueCard {
  threadId: string;
  projectId: string;
  topic: string | null;
  state: State;
  reason: string;
  since: number;
  /** What is done, from the newest report: the card's "Context". */
  done: string | null;
  /** 0.4 field: hidden from the queue. */
  dismissed: boolean;
  view: View | null;
  execution: Execution | null;
  freshness: Freshness;
  source: Source;
  ask: string | null;
  count: number;
  requestId: string | null;
  version: number | null;
  requestedAt: number | null;
  attentionAt: number | null;
  disposition:
    | { kind: "snoozed"; untilAt: number; tz: string | null; at: number }
    | { kind: "dismissed"; at: number }
    | null;
  sendAt: number | null;
  waitingOn: Dependency[];
  activityAt: number | null;
  /** When the status was last recomputed. */
  checkedAt: number;
  /** A 0.4 dismissal that could not be moved to a request. */
  legacyDismissal: boolean;
}

/** The page's tab a card shows under: snoozed cards leave their own tab for "Snoozed". */
export function pageViewOf(card: Pick<QueueCard, "view" | "disposition">): PageView | null {
  if (card.view === null) return null;
  if (card.disposition?.kind === "snoozed") return "snoozed";
  return card.view;
}

/** Counts in the navigation: requests to the owner that nobody snoozed or hid. */
export const needsOwner = (card: Pick<QueueCard, "view" | "disposition">) => card.view === "needs" && card.disposition === null;

export function toCard(args: {
  status: StatusRecord;
  request: RequestRecord | null;
  disposition: Disposition | null;
  topic: string | null;
  done: string | null;
  waitingOn: Dependency[];
  legacyDismissal: boolean;
  now: number;
}): QueueCard {
  const { status, now } = args;
  // The request speaks for the card only while it is the one the status names.
  const request = args.request?.active && status.view !== null && args.request.view === status.view ? args.request : null;
  const held = activeDisposition(request, args.disposition, now);
  const disposition: QueueCard["disposition"] =
    held === null
      ? null
      : held.kind === "snoozed"
        ? { kind: "snoozed", untilAt: held.untilAt ?? now, tz: held.tz, at: held.at }
        : { kind: "dismissed", at: held.at };
  return {
    threadId: status.threadId,
    projectId: status.projectId,
    topic: args.topic,
    state: status.state,
    reason: status.reason,
    since: status.since,
    done: args.done,
    dismissed: disposition !== null,
    view: status.view,
    execution: status.execution,
    freshness: status.freshness,
    source: status.source,
    ask: status.ask ?? request?.ask ?? null,
    count: request?.count ?? 1,
    requestId: request?.requestId ?? null,
    version: request?.version ?? null,
    requestedAt: request?.requestedAt ?? null,
    attentionAt: request?.attentionAt ?? null,
    disposition,
    sendAt: status.sendAt,
    waitingOn: args.waitingOn,
    activityAt: status.activityAt,
    checkedAt: status.updatedAt,
    legacyDismissal: args.legacyDismissal,
  };
}

/** A card's time for the order: the newest new requirement, or the oldest open one. */
export function orderTime(card: Pick<QueueCard, "attentionAt" | "requestedAt" | "since">, sort: QueueSort): number {
  return sort === "new" ? (card.attentionAt ?? card.since) : (card.requestedAt ?? card.since);
}

/** "Newest first": newest first; "Waiting longest": oldest first; a tie keeps the thread id order. */
export function compareCards(sort: QueueSort) {
  return (a: QueueCard, b: QueueCard): number => {
    const delta = orderTime(a, sort) - orderTime(b, sort);
    if (delta !== 0) return sort === "new" ? -delta : delta;
    return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;
  };
}

export function viewCounts(cards: readonly QueueCard[], includeHidden = false): Record<PageView, number> {
  const counts: Record<PageView, number> = { needs: 0, waiting: 0, stopped: 0, snoozed: 0 };
  for (const card of cards) {
    const view = pageViewOf(card);
    if (view === null) continue;
    if (card.disposition?.kind === "dismissed" && !includeHidden) continue;
    counts[view] += 1;
  }
  return counts;
}
