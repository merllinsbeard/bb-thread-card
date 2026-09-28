// The request on the Needs-you page. A thread has at most one current
// request (or wait, or stop): the owner's card for it. Its id is the thread
// and the working turn it comes from, so the agent's report and the helper's
// retelling of the same turn are one card. Its version moves only when
// something new is asked: a new question form, a question after the owner
// answered, a switch from a wait to a question. A recompute that reads the
// same facts again changes nothing, and closing one of several questions
// only shrinks what is open. The times come from the log: `requestedAt` is
// the oldest requirement still open, `attentionAt` the newest one that made
// the version move.
//
// Snoozing and hiding a card name the version they were given on. They hold
// while that version is current: a new question brings the card back at
// once, a snooze runs out at its time, and a click on a card that changed in
// the meantime does nothing to the new request.
import type { Derived, Requirement, RequestBasis, View } from "./status.ts";

/** Requirement keys remembered per request, so one read again is not new. */
const KEEP_SEEN = 50;

export interface RequestRecord {
  threadId: string;
  requestId: string;
  version: number;
  view: View;
  source: RequestBasis["source"];
  anchor: string;
  /** Requirements open now. */
  open: Requirement[];
  /** Every requirement key this request has had. */
  seen: string[];
  count: number;
  ask: string | null;
  requestedAt: number;
  attentionAt: number;
  basisSeq: number | null;
  /** False once the thread moved on (answered, running, done); the record stays for its dispositions. */
  active: boolean;
  updatedAt: number;
}

export type DispositionKind = "snoozed" | "dismissed";

export interface Disposition {
  threadId: string;
  requestId: string;
  version: number;
  kind: DispositionKind;
  /** Snoozed: when the card comes back (UTC ms) and the IANA time zone it was chosen in. */
  untilAt: number | null;
  tz: string | null;
  at: number;
}

export const requestIdOf = (threadId: string, anchor: string) => `${threadId}:${anchor}`;

/** The request after a recompute; null when the thread never had one. */
export function nextRequest(
  previous: RequestRecord | null,
  derived: Pick<Derived, "view" | "request" | "ask">,
  threadId: string,
  now: number,
): RequestRecord | null {
  const basis = derived.request;
  if (derived.view === null || basis === null) {
    return previous === null || !previous.active ? previous : { ...previous, active: false, updatedAt: now };
  }
  const requestId = requestIdOf(threadId, basis.anchor);
  const same = previous !== null && previous.requestId === requestId ? previous : null;
  const seen = new Set(same?.seen ?? []);
  const fresh = basis.requirements.filter((requirement) => !seen.has(requirement.key));
  const times = basis.requirements.map((requirement) => requirement.at);
  const requestedAt = times.length > 0 ? Math.min(...times) : now;
  const newest = (list: readonly Requirement[]) => Math.max(...list.map((requirement) => requirement.at));
  const version = same === null ? 1 : same.version + (fresh.length > 0 ? 1 : 0);
  const attentionAt = same === null ? (times.length > 0 ? Math.max(...times) : now) : fresh.length > 0 ? newest(fresh) : same.attentionAt;
  const next: RequestRecord = {
    threadId,
    requestId,
    version,
    view: derived.view,
    source: basis.source,
    anchor: basis.anchor,
    open: basis.requirements,
    seen: [...seen, ...fresh.map((requirement) => requirement.key)].slice(-KEEP_SEEN),
    count: basis.count,
    ask: derived.ask,
    requestedAt,
    attentionAt,
    basisSeq: basis.basisSeq,
    active: true,
    updatedAt: now,
  };
  return previous !== null && sameRequest(previous, next) ? previous : next;
}

/** Nothing the page shows changed: keep the stored record (and its updatedAt). */
function sameRequest(a: RequestRecord, b: RequestRecord): boolean {
  return (
    a.requestId === b.requestId &&
    a.version === b.version &&
    a.view === b.view &&
    a.active === b.active &&
    a.count === b.count &&
    a.ask === b.ask &&
    a.requestedAt === b.requestedAt &&
    a.attentionAt === b.attentionAt &&
    a.basisSeq === b.basisSeq &&
    JSON.stringify(a.open) === JSON.stringify(b.open)
  );
}

/** The disposition that holds for the request now, or null (a new version, a snooze that ran out). */
export function activeDisposition(request: RequestRecord | null, disposition: Disposition | null, now: number): Disposition | null {
  if (request === null || disposition === null || !request.active) return null;
  if (disposition.requestId !== request.requestId || disposition.version !== request.version) return null;
  if (disposition.kind === "snoozed" && (disposition.untilAt === null || disposition.untilAt <= now)) return null;
  return disposition;
}

export type DispositionOutcome =
  | { ok: true; request: RequestRecord; disposition: Disposition | null }
  | { ok: false; reason: "gone" | "changed"; request: RequestRecord | null };

/**
 * Check that an action names the request as it is now. Without a version
 * (the CLI on the current request) the current one is taken.
 */
export function checkTarget(
  request: RequestRecord | null,
  target: { requestId?: string | undefined; version?: number | undefined },
): { ok: true; request: RequestRecord } | { ok: false; reason: "gone" | "changed"; request: RequestRecord | null } {
  if (request === null || !request.active) return { ok: false, reason: "gone", request };
  if (target.requestId !== undefined && target.requestId !== request.requestId) return { ok: false, reason: "changed", request };
  if (target.version !== undefined && target.version !== request.version) return { ok: false, reason: "changed", request };
  return { ok: true, request };
}
