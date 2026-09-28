// The Needs-you page as the owner sees it: the server's cards joined with
// bb's live threads, projects and sections, filtered, grouped project →
// section → thread and ordered; the page's route; the icon on a sidebar
// row and a thread's place in a status order. Pure, so the node tests read
// it without a browser.
import { PAGE_VIEWS, VIEW_TITLES, compareCards, orderTime, pageViewOf, type PageView, type QueueCard, type QueueSort } from "../lib/queue.ts";

export { PAGE_VIEWS, VIEW_TITLES, type PageView, type QueueCard, type QueueSort };

/** What the page reads from bb's sidebar about a thread (PluginSidebarThread). */
export interface ThreadFacts {
  id: string;
  projectId: string;
  sectionId: string | null;
  displayTitle: string;
  parentThreadId: string | null;
  status: string;
  indicator: string;
  hasPendingInteraction: boolean;
  isUnread: boolean;
  isPinned: boolean;
  pinnedAt: number | null;
  pinSortKey: string | null;
  isArchived: boolean;
  isHidden: boolean;
  createdAt: number;
  latestAttentionAt: number;
}

export interface NamedFacts {
  id: string;
  name: string;
}

/** A section filter value for threads outside any section. */
export const NO_SECTION = "none";

/** How the page groups its cards: by bb section (as the sidebar in its sections mode) or by project. */
export type GroupBy = "section" | "project";

export interface Filters {
  groupBy: GroupBy;
  projectId: string | null;
  /** A section id, NO_SECTION, or null for all. */
  sectionId: string | null;
  search: string;
  sort: QueueSort;
}

export const DEFAULT_FILTERS: Filters = { groupBy: "section", projectId: null, sectionId: null, search: "", sort: "new" };

export const SORT_TITLES: Record<QueueSort, string> = { new: "Newest first", old: "Waiting longest" };

/** A card on the page: the server's card, the live thread and the tab it shows under. */
export interface Entry {
  card: QueueCard;
  thread: ThreadFacts;
  view: PageView;
}

export interface SectionGroup {
  key: string;
  /** Null for the threads outside any section, shown straight under the project. */
  sectionId: string | null;
  name: string | null;
  entries: Entry[];
}

/** A top-level group on the page: a project, or a section when grouped by section. */
export interface ListGroup {
  key: string;
  name: string;
  count: number;
  sections: SectionGroup[];
}

export interface ProjectGroup extends ListGroup {
  projectId: string;
}

/** Cards of threads bb lists now (not archived, hidden or gone), on the tab they show under. */
export function joinCards(cards: readonly QueueCard[], threads: readonly ThreadFacts[]): Entry[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const entries: Entry[] = [];
  for (const card of cards) {
    const thread = byId.get(card.threadId);
    if (!thread || thread.isArchived || thread.isHidden) continue;
    const view = pageViewOf(card);
    if (view === null) continue;
    entries.push({ card, thread, view });
  }
  return entries;
}

/** Threads bb lists whose status is being clarified: shown as a count beside the tabs. */
export function checkingCount(cards: readonly QueueCard[], threads: readonly ThreadFacts[], filters: Filters): number {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  return cards.filter((card) => {
    const thread = byId.get(card.threadId);
    return card.view === null && card.freshness === "checking" && thread !== undefined && !thread.isArchived && inPlace(thread, filters);
  }).length;
}

function inPlace(thread: ThreadFacts, filters: Filters): boolean {
  if (filters.projectId !== null && thread.projectId !== filters.projectId) return false;
  if (filters.sectionId === NO_SECTION) return thread.sectionId === null;
  if (filters.sectionId !== null) return thread.sectionId === filters.sectionId;
  return true;
}

const fold = (text: string) => text.toLocaleLowerCase("ru").replaceAll("ё", "е");

/** The project, section and search filters (every word of the search, anywhere in the card); hidden cards only when asked for. */
export function matches(entry: Entry, filters: Filters, showHidden: boolean): boolean {
  if (!showHidden && entry.card.disposition?.kind === "dismissed") return false;
  if (!inPlace(entry.thread, filters)) return false;
  const words = fold(filters.search).split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return true;
  const { card, thread } = entry;
  const text = [thread.displayTitle, card.topic, card.ask, card.reason].filter((part): part is string => part !== null).map(fold).join("\n");
  return words.every((word) => text.includes(word));
}

export function viewCounts(entries: readonly Entry[]): Record<PageView, number> {
  const counts: Record<PageView, number> = { needs: 0, waiting: 0, stopped: 0, snoozed: 0 };
  for (const entry of entries) counts[entry.view] += 1;
  return counts;
}

/** Requests to the owner that nobody snoozed or hid: the number in the navigation. */
export function needsCount(cards: readonly QueueCard[], threads: readonly ThreadFacts[]): number {
  return joinCards(cards, threads).filter((entry) => entry.view === "needs" && entry.card.disposition === null).length;
}

/**
 * bb's pin order (thread-list's comparePinnedRoots): two pins with keys by
 * key; otherwise, and on equal keys, by pin time (newest first), creation, id.
 */
export function comparePinned(a: ThreadFacts, b: ThreadFacts): number {
  if (a.pinSortKey !== null && b.pinSortKey !== null && a.pinSortKey !== b.pinSortKey) return a.pinSortKey < b.pinSortKey ? -1 : 1;
  const pinned = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
  if (pinned !== 0) return pinned;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Inside a group: pinned threads first in bb's pin order, then the chosen order. */
export function compareEntries(sort: QueueSort) {
  const byCard = compareCards(sort);
  return (a: Entry, b: Entry): number => {
    if (a.thread.isPinned !== b.thread.isPinned) return a.thread.isPinned ? -1 : 1;
    if (a.thread.isPinned) return comparePinned(a.thread, b.thread);
    return byCard(a.card, b.card);
  };
}

/** A group's time: its freshest request for "new", its oldest for "old". */
function groupTime(entries: readonly Entry[], sort: QueueSort): number {
  const times = entries.map((entry) => orderTime(entry.card, sort));
  return sort === "new" ? Math.max(...times) : Math.min(...times);
}

function compareGroups<T extends { id: string; time: number }>(sort: QueueSort) {
  return (a: T, b: T): number => {
    if (a.time !== b.time) return sort === "new" ? b.time - a.time : a.time - b.time;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/**
 * Project → section → thread. Sections are bb's own (global, by id): a
 * section shows under every project that has a card in it, so two sections
 * with one name stay apart. Threads outside a section come first, straight
 * under the project. Empty groups do not exist.
 */
export function groupEntries(
  entries: readonly Entry[],
  projects: readonly NamedFacts[],
  sections: readonly NamedFacts[],
  sort: QueueSort,
): ProjectGroup[] {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const sectionNames = new Map(sections.map((section) => [section.id, section.name]));
  const byProject = new Map<string, Map<string | null, Entry[]>>();
  for (const entry of entries) {
    const inProject = byProject.get(entry.thread.projectId) ?? new Map<string | null, Entry[]>();
    byProject.set(entry.thread.projectId, inProject);
    const list = inProject.get(entry.thread.sectionId) ?? [];
    list.push(entry);
    inProject.set(entry.thread.sectionId, list);
  }
  const order = compareEntries(sort);
  const groups = [...byProject].map(([projectId, bySection]) => {
    const loose = bySection.get(null);
    const named = [...bySection]
      .filter((pair): pair is [string, Entry[]] => pair[0] !== null)
      .map(([sectionId, list]) => ({ id: sectionId, time: groupTime(list, sort), list }))
      .sort(compareGroups(sort))
      .map(
        ({ id, list }): SectionGroup => ({
          key: `s:${projectId}:${id}`,
          sectionId: id,
          name: sectionNames.get(id) ?? "Section",
          entries: [...list].sort(order),
        }),
      );
    const all = [...bySection.values()].flat();
    return {
      id: projectId,
      time: groupTime(all, sort),
      group: {
        key: `p:${projectId}`,
        projectId,
        name: projectNames.get(projectId) ?? "Project",
        count: all.length,
        sections: [...(loose ? [{ key: `s:${projectId}:${NO_SECTION}`, sectionId: null, name: null, entries: [...loose].sort(order) }] : []), ...named],
      } satisfies ProjectGroup,
    };
  });
  return groups.sort(compareGroups(sort)).map(({ group }) => group);
}

/** The key of the group a thread shows under: its section's, or its project's section block. */
export function groupKeyOf(thread: Pick<ThreadFacts, "projectId" | "sectionId">, groupBy: GroupBy): string {
  return groupBy === "section" ? `g:${thread.sectionId ?? NO_SECTION}` : `s:${thread.projectId}:${thread.sectionId ?? NO_SECTION}`;
}

/**
 * Section → thread, as the sidebar shows sections: one group per bb section
 * whatever project its threads run in (each row names its project), and
 * the threads outside any section last, under "No section". Empty groups do
 * not exist.
 */
export function groupBySection(entries: readonly Entry[], sections: readonly NamedFacts[], sort: QueueSort): ListGroup[] {
  const sectionNames = new Map(sections.map((section) => [section.id, section.name]));
  const bySection = new Map<string | null, Entry[]>();
  for (const entry of entries) {
    const list = bySection.get(entry.thread.sectionId) ?? [];
    list.push(entry);
    bySection.set(entry.thread.sectionId, list);
  }
  const order = compareEntries(sort);
  const group = (sectionId: string | null, list: Entry[]): ListGroup => {
    const key = `g:${sectionId ?? NO_SECTION}`;
    const name = sectionId === null ? "No section" : (sectionNames.get(sectionId) ?? "Section");
    return { key, name, count: list.length, sections: [{ key: `${key}:all`, sectionId: null, name: null, entries: [...list].sort(order) }] };
  };
  const named = [...bySection]
    .filter((pair): pair is [string, Entry[]] => pair[0] !== null)
    .map(([id, list]) => ({ id, time: groupTime(list, sort), list }))
    .sort(compareGroups(sort))
    .map(({ id, list }) => group(id, list));
  const loose = bySection.get(null);
  return loose ? [...named, group(null, loose)] : named;
}

/** Projects with a card, by name. */
export function projectOptions(entries: readonly Entry[], projects: readonly NamedFacts[]): NamedFacts[] {
  const ids = new Set(entries.map((entry) => entry.thread.projectId));
  return projects.filter((project) => ids.has(project.id)).sort((a, b) => a.name.localeCompare(b.name));
}

/** Sections with a card in the chosen project, by name; "No section" last when it has any. */
export function sectionOptions(entries: readonly Entry[], sections: readonly NamedFacts[], projectId: string | null): NamedFacts[] {
  const inProject = entries.filter((entry) => projectId === null || entry.thread.projectId === projectId);
  const ids = new Set(inProject.map((entry) => entry.thread.sectionId));
  const named = sections.filter((section) => ids.has(section.id)).sort((a, b) => a.name.localeCompare(b.name));
  return ids.has(null) ? [...named, { id: NO_SECTION, name: "No section" }] : named;
}

/** A project change drops a section the project has no cards in. */
export function withProject(filters: Filters, projectId: string | null, entries: readonly Entry[], sections: readonly NamedFacts[]): Filters {
  const next = { ...filters, projectId };
  if (next.sectionId !== null && !sectionOptions(entries, sections, projectId).some((section) => section.id === next.sectionId)) {
    next.sectionId = null;
  }
  return next;
}

export const filtersActive = (filters: Filters) => filters.projectId !== null || filters.sectionId !== null || filters.search.trim() !== "";

// ---------------------------------------------------------------------------
// Route and saved preferences

/** `subPath` is `<view>` or `<view>/<threadId>`; the root is the needs tab. */
export function parseRoute(subPath: string): { view: PageView; threadId: string | null } {
  const [first = "", second = ""] = subPath.split("/").filter((part) => part !== "");
  const view = (PAGE_VIEWS as readonly string[]).includes(first) ? (first as PageView) : "needs";
  const threadId = /^thr_[a-z0-9]+$/.test(second) ? second : null;
  return { view, threadId };
}

export const formatRoute = (view: PageView, threadId: string | null) => (threadId === null ? view : `${view}/${threadId}`);

export interface Prefs {
  filters: Filters;
  collapsed: string[];
}

/** Saved preferences, read defensively: anything unreadable falls back to the defaults. */
export function parsePrefs(raw: string | null): Prefs {
  const fallback: Prefs = { filters: DEFAULT_FILTERS, collapsed: [] };
  if (raw === null) return fallback;
  try {
    const value = JSON.parse(raw) as { filters?: Partial<Filters>; collapsed?: unknown };
    const filters = value.filters ?? {};
    const text = (field: unknown) => (typeof field === "string" && field !== "" ? field : null);
    return {
      filters: {
        groupBy: filters.groupBy === "project" ? "project" : "section",
        projectId: text(filters.projectId),
        sectionId: text(filters.sectionId),
        search: typeof filters.search === "string" ? filters.search.slice(0, 200) : "",
        sort: filters.sort === "old" ? "old" : "new",
      },
      collapsed: Array.isArray(value.collapsed) ? value.collapsed.filter((key): key is string => typeof key === "string").slice(0, 500) : [],
    };
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Live updates while the owner reads

const requestKey = (card: QueueCard) => `${card.requestId ?? card.state}#${card.version ?? 0}`;

/**
 * The selected thread's row after its card left the tab the owner reads:
 * it stays under that tab, marked with where the thread went, until the
 * owner moves on. `card` is the row as it was before it left.
 */
export interface Stay {
  threadId: string;
  from: PageView;
  to: PageView | "checking" | "closed";
  card: QueueCard;
}

/** The selected row's place on the `view` tab: kept, marked, while its card is elsewhere. */
function stayOf(view: PageView, stay: Stay | null, before: QueueCard | undefined, card: QueueCard | null): Stay | null {
  const was = stay?.card ?? (before !== undefined && pageViewOf(before) === view ? before : undefined);
  if (was === undefined) return null;
  const to = card === null ? "closed" : card.view === null ? "checking" : pageViewOf(card);
  return to === view ? null : { threadId: was.threadId, from: view, to: to ?? "closed", card: was };
}

/**
 * What the list shows after a reload while the owner reads the `view` tab.
 * A row on this tab that is still the same request takes its new data in
 * place, and so does any card off this tab. A new row on this tab (a thread
 * new to it or back from another tab, a new request or version) waits
 * behind "Show N new", and the row it would replace keeps its place
 * meanwhile. A card that left the page goes.
 * The selected thread always shows its current state; when its card leaves
 * the tab, `stay` keeps its row there, marked.
 */
export function mergeIncoming(
  shown: readonly QueueCard[],
  latest: readonly QueueCard[],
  where: { selected: string | null; view: PageView; stay: Stay | null },
): { shown: QueueCard[]; held: QueueCard[]; stay: Stay | null } {
  const current = new Map(shown.map((card) => [card.threadId, card]));
  const next: QueueCard[] = [];
  const held: QueueCard[] = [];
  let stay = where.stay !== null && where.stay.threadId === where.selected && where.stay.from === where.view ? where.stay : null;
  let selectedSeen = false;
  for (const card of latest) {
    const before = current.get(card.threadId);
    if (card.threadId === where.selected) {
      selectedSeen = true;
      next.push(card);
      stay = stayOf(where.view, stay, before, card);
    } else if ((before && pageViewOf(before) === where.view && requestKey(before) === requestKey(card)) || pageViewOf(card) !== where.view) {
      next.push(card);
    } else {
      held.push(card);
      if (before) next.push(before);
    }
  }
  if (where.selected !== null && !selectedSeen) stay = stayOf(where.view, stay, current.get(where.selected), null);
  return { shown: next, held, stay };
}

/** Take one thread's card from the latest data (after the owner's own action on it). */
export function applyOne(shown: readonly QueueCard[], latest: readonly QueueCard[], threadId: string): QueueCard[] {
  const fresh = latest.find((card) => card.threadId === threadId);
  const rest = shown.filter((card) => card.threadId !== threadId);
  return fresh ? [...rest, fresh] : rest;
}

// ---------------------------------------------------------------------------
// Words and times

export function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const STATE_WORDS: Record<string, string> = {
  running: "working",
  question: "waits for an answer",
  waiting: "waits on others",
  done: "done",
  unknown: "status unknown",
};

/** The one-line note under a card's request, from how its work stands. */
export function executionNote(card: Pick<QueueCard, "execution" | "freshness" | "view">): string | null {
  if (card.freshness === "checking") return "Status updating";
  if (card.freshness === "unavailable") return "Status unknown";
  switch (card.execution) {
    case "sendFailed":
      return "Message not sent";
    case "stoppedByOwner":
      return "Stopped by you";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Work cut off";
    case "active":
      return card.view === "needs" ? "The agent is working; the question stays open" : "The agent is working";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Sidebar rows

export interface RowView {
  state: string;
  reason: string;
  source: string;
  view: PageView | "needs" | "waiting" | "stopped" | null;
  execution: string | null;
  freshness: string;
  disposition: "snoozed" | "dismissed" | null;
  activityAt: number | null;
}

export interface RowIcon {
  icon: string;
  label: string;
  tone: "default" | "error" | "running" | "success";
}

/**
 * The icon on a thread's sidebar row, or null to leave the row to bb. A
 * request to the owner always shows. A stop, a wait and a status nobody
 * could read show too, since their meaning outweighs bb's unread dot; the
 * label then says the thread is unread. Done and "goes on by itself" give
 * way to any signal bb has for the row.
 */
export function rowIcon(row: RowView | undefined, thread: Pick<ThreadFacts, "indicator" | "isUnread">): RowIcon | null {
  if (!row) return null;
  const unread = thread.isUnread ? " · unread" : "";
  if (row.view === "needs") {
    if (row.disposition === "snoozed") return { icon: "Clock", label: `Snoozed: ${row.reason}${unread}`, tone: "default" };
    if (row.disposition === "dismissed") return thread.indicator === "none" ? { icon: "CircleQuestion", label: `Hidden from the queue: ${row.reason}`, tone: "default" } : null;
    return { icon: "CircleQuestion", label: `Needs you: ${row.reason}${unread}`, tone: "error" };
  }
  if (row.view === "stopped") {
    if (row.execution === "stoppedByOwner") return { icon: "Pause", label: `Stopped by you${unread}`, tone: "default" };
    if (row.freshness === "unavailable") return { icon: "AlertTriangle", label: `Status unknown: ${row.reason}${unread}`, tone: "default" };
    return { icon: "AlertCircle", label: `Stopped: ${row.reason}${unread}`, tone: "error" };
  }
  if (row.view === "waiting") {
    if (thread.indicator === "runtime" || thread.indicator === "waiting-for-input") return null;
    return { icon: "Clock", label: `Waiting: ${row.reason}${unread}`, tone: "default" };
  }
  if (thread.indicator !== "none") return null;
  if (row.state === "running" && row.source !== "bb") return { icon: "TimeSchedule", label: row.reason, tone: "running" };
  if (row.state === "done") return { icon: "CircleCheck", label: `Done: ${row.reason}`, tone: "success" };
  return null;
}

/**
 * A thread's place in the sidebar's status order (1 first) and its time
 * inside it: 1 asks the owner, 2 stopped on an error, 3 works, 4 waits, 5
 * snoozed, hidden, stopped by the owner or not confirmed, 6 done. A thread
 * the plugin does not track is placed by bb's own facts.
 */
export function statusRank(row: RowView | undefined, thread: ThreadFacts): { rank: number; at: number } {
  const at = row?.activityAt ?? thread.latestAttentionAt;
  const busy = thread.status === "active" || thread.status === "starting" || thread.status === "stopping";
  if (!row) {
    if (thread.hasPendingInteraction) return { rank: 1, at };
    if (thread.indicator === "unread-error" || thread.indicator === "queued-failed") return { rank: 2, at };
    if (busy) return { rank: 3, at };
    return { rank: 5, at };
  }
  if (row.view === "needs") return { rank: row.disposition === null ? 1 : 5, at };
  if (row.view === "stopped") return { rank: row.execution === "stoppedByOwner" || row.freshness === "unavailable" ? 5 : 2, at };
  if (busy || (row.state === "running" && row.view === null)) return { rank: 3, at };
  if (row.view === "waiting") return { rank: 4, at };
  if (row.state === "done") return { rank: 6, at };
  return { rank: 5, at };
}
