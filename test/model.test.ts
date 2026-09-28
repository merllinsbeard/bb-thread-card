// The Needs-you page's model: cards joined with bb's threads, grouped
// project → section → thread, filtered and ordered; the route; saved
// preferences; live updates while the owner reads; the sidebar row icon and
// the status order.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueueCard } from "../lib/queue.ts";
import {
  DEFAULT_FILTERS,
  NO_SECTION,
  checkingCount,
  groupBySection,
  groupEntries,
  joinCards,
  matches,
  mergeIncoming,
  needsCount,
  parsePrefs,
  parseRoute,
  formatRoute,
  rowIcon,
  sectionOptions,
  statusRank,
  viewCounts,
  withProject,
  type Filters,
  type ListGroup,
  type RowView,
  type Stay,
  type ThreadFacts,
} from "../ui/model.ts";

const T0 = Date.UTC(2026, 8, 28, 12, 0);
const MINUTE = 60_000;

function card(threadId: string, overrides: Partial<QueueCard> = {}): QueueCard {
  const at = overrides.attentionAt ?? T0;
  return {
    threadId,
    projectId: "proj_a",
    topic: null,
    state: "question",
    reason: "Выбери вариант обложки",
    since: at,
    done: null,
    dismissed: false,
    view: "needs",
    execution: null,
    freshness: "fresh",
    source: "agent",
    ask: "Выбери вариант обложки",
    count: 1,
    requestId: `${threadId}:t1`,
    version: 1,
    requestedAt: at,
    attentionAt: at,
    disposition: null,
    sendAt: null,
    waitingOn: [],
    activityAt: at,
    checkedAt: at,
    legacyDismissal: false,
    ...overrides,
  };
}

function thread(id: string, overrides: Partial<ThreadFacts> = {}): ThreadFacts {
  return {
    id,
    projectId: "proj_a",
    sectionId: null,
    displayTitle: `Тред ${id}`,
    parentThreadId: null,
    status: "idle",
    indicator: "none",
    hasPendingInteraction: false,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    isHidden: false,
    createdAt: T0 - 60 * MINUTE,
    latestAttentionAt: T0,
    ...overrides,
  };
}

const PROJECTS = [
  { id: "proj_a", name: "Проект A" },
  { id: "proj_b", name: "Personal" },
];
// Sections in bb are global: one section can hold threads of several projects, and two can share a name.
const SECTIONS = [
  { id: "sec_ui", name: "Интерфейс" },
  { id: "sec_ui2", name: "Интерфейс" },
  { id: "sec_content", name: "Контент" },
];

const shape = (groups: readonly ListGroup[]) =>
  groups.map((group) => [group.name, group.count, group.sections.map((section) => [section.name, section.entries.map((entry) => entry.card.threadId)])]);

test("cards group project → section → thread by id; threads outside a section sit under the project; archived and hidden threads are not on the page", () => {
  const threads = [
    thread("thr_a1", { sectionId: "sec_ui" }),
    thread("thr_a2", { sectionId: "sec_ui2" }),
    thread("thr_a3"),
    thread("thr_b1", { projectId: "proj_b", sectionId: "sec_ui" }),
    thread("thr_b2", { projectId: "proj_b", sectionId: "sec_content" }),
    thread("thr_arch", { isArchived: true }),
    thread("thr_hidden", { isHidden: true }),
  ];
  const cards = [
    card("thr_a1", { attentionAt: T0 + 1 * MINUTE }),
    card("thr_a2", { attentionAt: T0 + 5 * MINUTE }),
    card("thr_a3", { attentionAt: T0 + 2 * MINUTE }),
    card("thr_b1", { attentionAt: T0 + 9 * MINUTE }),
    card("thr_b2", { attentionAt: T0 + 3 * MINUTE }),
    card("thr_arch", { attentionAt: T0 + 20 * MINUTE }),
    card("thr_hidden", { attentionAt: T0 + 20 * MINUTE }),
    card("thr_gone", { attentionAt: T0 + 20 * MINUTE }),
  ];
  const entries = joinCards(cards, threads);
  assert.deepEqual(
    shape(groupEntries(entries, PROJECTS, SECTIONS, "new")),
    [
      ["Personal", 2, [["Интерфейс", ["thr_b1"]], ["Контент", ["thr_b2"]]]],
      ["Проект A", 3, [[null, ["thr_a3"]], ["Интерфейс", ["thr_a2"]], ["Интерфейс", ["thr_a1"]]]],
    ],
  );
  // The two «Интерфейс» sections of «Проект A» stay apart by id.
  const projectA = groupEntries(entries, PROJECTS, SECTIONS, "new")[1]!;
  assert.deepEqual(projectA.sections.map((section) => section.key), ["s:proj_a:none", "s:proj_a:sec_ui2", "s:proj_a:sec_ui"]);

  // A thread moved to another project in bb moves with it; the card's own projectId is the server's last read.
  const moved = joinCards(cards, threads.map((item) => (item.id === "thr_a3" ? { ...item, projectId: "proj_b" } : item)));
  assert.deepEqual(
    groupEntries(moved, PROJECTS, SECTIONS, "new").map((group) => [group.name, group.count]),
    [
      ["Personal", 3],
      ["Проект A", 2],
    ],
  );
});

test("inside a group pinned threads come first in bb's pin order; groups order by their freshest or oldest request", () => {
  const threads = [
    thread("thr_1"),
    thread("thr_2", { isPinned: true, pinnedAt: T0 - 10 * MINUTE }),
    thread("thr_3", { isPinned: true, pinnedAt: T0 - 5 * MINUTE }),
    thread("thr_4", { isPinned: true, pinnedAt: T0 - 50 * MINUTE, pinSortKey: "a0" }),
    thread("thr_5"),
    thread("thr_6", { projectId: "proj_b" }),
  ];
  const cards = [
    card("thr_1", { attentionAt: T0 + 10 * MINUTE, requestedAt: T0 - 30 * MINUTE }),
    card("thr_2", { attentionAt: T0 + 20 * MINUTE }),
    card("thr_3", { attentionAt: T0 + 1 * MINUTE }),
    card("thr_4", { attentionAt: T0 }),
    card("thr_5", { attentionAt: T0 + 30 * MINUTE, requestedAt: T0 + 30 * MINUTE }),
    card("thr_6", { attentionAt: T0 + 15 * MINUTE, requestedAt: T0 - 60 * MINUTE }),
  ];
  const entries = joinCards(cards, threads);
  // "Newest first": pins by pin time, newest first (a key counts only between two keyed pins, as in bb),
  // then newest request first; «Проект A» has the freshest request.
  assert.deepEqual(shape(groupEntries(entries, PROJECTS, SECTIONS, "new")), [
    ["Проект A", 5, [[null, ["thr_3", "thr_2", "thr_4", "thr_5", "thr_1"]]]],
    ["Personal", 1, [[null, ["thr_6"]]]],
  ]);
  // "Waiting longest": pins stay first; the rest by the oldest open request; «Personal» waits longest.
  assert.deepEqual(shape(groupEntries(entries, PROJECTS, SECTIONS, "old")), [
    ["Personal", 1, [[null, ["thr_6"]]]],
    ["Проект A", 5, [[null, ["thr_3", "thr_2", "thr_4", "thr_1", "thr_5"]]]],
  ]);
  // Two keyed pins go by their keys, whatever their pin times.
  const keyed = joinCards(
    [card("thr_k1"), card("thr_k2")],
    [
      thread("thr_k1", { isPinned: true, pinnedAt: T0, pinSortKey: "b0" }),
      thread("thr_k2", { isPinned: true, pinnedAt: T0 - 60 * MINUTE, pinSortKey: "a0" }),
    ],
  );
  assert.deepEqual(shape(groupEntries(keyed, PROJECTS, SECTIONS, "new"))[0]![2], [[null, ["thr_k2", "thr_k1"]]]);
  // A tie keeps the thread id order, whatever order the cards came in.
  const tied = joinCards([card("thr_b", { attentionAt: T0 }), card("thr_a", { attentionAt: T0 })], [thread("thr_a"), thread("thr_b")]);
  assert.deepEqual(shape(groupEntries(tied, PROJECTS, SECTIONS, "new"))[0]![2], [[null, ["thr_a", "thr_b"]]]);
});

test("grouped by section, a section is one group whatever projects its threads run in; threads outside a section come last under No section", () => {
  const threads = [
    thread("thr_a1", { sectionId: "sec_ui" }),
    thread("thr_b1", { projectId: "proj_b", sectionId: "sec_ui" }),
    thread("thr_a2", { sectionId: "sec_ui2" }),
    thread("thr_b2", { projectId: "proj_b", sectionId: "sec_content" }),
    thread("thr_a3"),
    thread("thr_b3", { projectId: "proj_b" }),
  ];
  const cards = [
    card("thr_a1", { attentionAt: T0 + 1 * MINUTE }),
    card("thr_b1", { attentionAt: T0 + 9 * MINUTE }),
    card("thr_a2", { attentionAt: T0 + 5 * MINUTE }),
    card("thr_b2", { attentionAt: T0 + 3 * MINUTE }),
    card("thr_a3", { attentionAt: T0 + 20 * MINUTE }),
    card("thr_b3", { attentionAt: T0 + 2 * MINUTE }),
  ];
  const entries = joinCards(cards, threads);
  const groups = groupBySection(entries, SECTIONS, "new");
  assert.deepEqual(shape(groups), [
    ["Интерфейс", 2, [[null, ["thr_b1", "thr_a1"]]]],
    ["Интерфейс", 1, [[null, ["thr_a2"]]]],
    ["Контент", 1, [[null, ["thr_b2"]]]],
    // Last, as in the sidebar, even though it holds the freshest request.
    ["No section", 2, [[null, ["thr_a3", "thr_b3"]]]],
  ]);
  // Two sections with one name stay apart by id.
  assert.deepEqual(groups.map((group) => group.key), ["g:sec_ui", "g:sec_ui2", "g:sec_content", "g:none"]);
  // "Waiting longest": the section waiting longest first.
  assert.deepEqual(groupBySection(entries, SECTIONS, "old").map((group) => group.key), ["g:sec_ui", "g:sec_content", "g:sec_ui2", "g:none"]);
});

test("filters: project, section (a project change drops a section it has no cards in), search by every word in the title and the request; counts follow the filters", () => {
  const threads = [
    thread("thr_1", { sectionId: "sec_ui", displayTitle: "Проверить тёмную тему" }),
    thread("thr_2", { projectId: "proj_b", sectionId: "sec_content" }),
    thread("thr_3", { projectId: "proj_b" }),
    thread("thr_4", { sectionId: "sec_ui" }),
  ];
  const cards = [
    card("thr_1", { ask: "Проверь на телефоне" }),
    card("thr_2", { view: "waiting", state: "waiting", ask: null, reason: "Ждём CI" }),
    card("thr_3", { disposition: { kind: "snoozed", untilAt: T0 + 60 * MINUTE, tz: "Europe/Moscow", at: T0 } }),
    card("thr_4", { disposition: { kind: "dismissed", at: T0 }, dismissed: true }),
  ];
  const entries = joinCards(cards, threads);
  const counts = (filters: Filters, hidden = false) => viewCounts(entries.filter((entry) => matches(entry, filters, hidden)));
  assert.deepEqual(counts(DEFAULT_FILTERS), { needs: 1, waiting: 1, stopped: 0, snoozed: 1 });
  assert.deepEqual(counts(DEFAULT_FILTERS, true), { needs: 2, waiting: 1, stopped: 0, snoozed: 1 });
  assert.deepEqual(counts({ ...DEFAULT_FILTERS, projectId: "proj_b" }), { needs: 0, waiting: 1, stopped: 0, snoozed: 1 });
  assert.deepEqual(counts({ ...DEFAULT_FILTERS, sectionId: NO_SECTION }), { needs: 0, waiting: 0, stopped: 0, snoozed: 1 });
  assert.deepEqual(counts({ ...DEFAULT_FILTERS, search: "ТЁМНУЮ" }), { needs: 1, waiting: 0, stopped: 0, snoozed: 0 });
  assert.deepEqual(counts({ ...DEFAULT_FILTERS, search: "телефоне" }), { needs: 1, waiting: 0, stopped: 0, snoozed: 0 });
  assert.deepEqual(counts({ ...DEFAULT_FILTERS, search: "ci" }), { needs: 0, waiting: 1, stopped: 0, snoozed: 0 });
  // Every word, anywhere in the card: the title and the request together.
  assert.deepEqual(counts({ ...DEFAULT_FILTERS, search: " тем  телефон " }), { needs: 1, waiting: 0, stopped: 0, snoozed: 0 });
  assert.deepEqual(counts({ ...DEFAULT_FILTERS, search: "тем ci" }), { needs: 0, waiting: 0, stopped: 0, snoozed: 0 });

  assert.deepEqual(sectionOptions(entries, SECTIONS, "proj_b").map((section) => section.id), ["sec_content", NO_SECTION]);
  const inUi = { ...DEFAULT_FILTERS, sectionId: "sec_ui" };
  assert.equal(withProject(inUi, "proj_b", entries, SECTIONS).sectionId, null);
  assert.equal(withProject(inUi, "proj_a", entries, SECTIONS).sectionId, "sec_ui");

  // The navigation counts requests to the owner in any project, without snoozed or hidden ones.
  assert.equal(needsCount(cards, threads), 1);
  assert.equal(
    checkingCount([...cards, card("thr_5", { view: null, freshness: "checking" })], [...threads, thread("thr_5", { projectId: "proj_b" })], {
      ...DEFAULT_FILTERS,
      projectId: "proj_b",
    }),
    1,
  );
});

test("the route names the tab and the selected thread; saved preferences fall back to defaults when unreadable", () => {
  assert.deepEqual(parseRoute(""), { view: "needs", threadId: null });
  assert.deepEqual(parseRoute("waiting/thr_abc123"), { view: "waiting", threadId: "thr_abc123" });
  assert.deepEqual(parseRoute("nonsense/../etc"), { view: "needs", threadId: null });
  assert.equal(formatRoute("snoozed", "thr_x1"), "snoozed/thr_x1");
  assert.equal(formatRoute("needs", null), "needs");

  assert.deepEqual(parsePrefs(null), { filters: DEFAULT_FILTERS, collapsed: [] });
  assert.deepEqual(parsePrefs("{broken"), { filters: DEFAULT_FILTERS, collapsed: [] });
  // Saved before the grouping switch: grouped by section; a saved choice stays.
  assert.equal(parsePrefs(JSON.stringify({ filters: { sort: "old" } })).filters.groupBy, "section");
  assert.equal(parsePrefs(JSON.stringify({ filters: { groupBy: "project" } })).filters.groupBy, "project");
  assert.deepEqual(parsePrefs(JSON.stringify({ filters: { projectId: "proj_a", sort: "old", search: 5 }, collapsed: ["p:proj_a", 7] })), {
    filters: { groupBy: "section", projectId: "proj_a", sectionId: null, search: "", sort: "old" },
    collapsed: ["p:proj_a"],
  });
});

test("while the owner reads a tab, a new row for it waits behind a button with the old row in place; the same request and other tabs update in place", () => {
  const waiting = { view: "waiting" as const, state: "waiting" as const };
  const shown = [card("thr_1"), card("thr_2"), card("thr_3"), card("thr_5", waiting), card("thr_7")];
  const latest = [
    card("thr_1", { disposition: { kind: "dismissed", at: T0 }, dismissed: true }),
    card("thr_2", { version: 2, attentionAt: T0 + MINUTE }),
    card("thr_4", { attentionAt: T0 + 2 * MINUTE }),
    card("thr_5", { ...waiting, requestId: "thr_5:t2" }),
    card("thr_6", { view: "stopped", state: "unknown", execution: "failed" }),
    card("thr_7", { view: null, state: "unknown", freshness: "checking", requestId: null, version: null }),
  ];
  const merged = mergeIncoming(shown, latest, { selected: null, view: "needs", stay: null });
  assert.deepEqual(
    merged.shown.map((item) => [item.threadId, item.version, item.view, item.disposition?.kind ?? null]),
    [
      ["thr_1", 1, "needs", "dismissed"],
      // A new version of a row on the tab: the old one keeps its place.
      ["thr_2", 1, "needs", null],
      // Off the tab the owner reads: in place, so the counts beside the tabs are current.
      ["thr_5", 1, "waiting", null],
      ["thr_6", 1, "stopped", null],
      // Being clarified: off the list, counted beside the tabs.
      ["thr_7", null, null, null],
    ],
  );
  assert.deepEqual(merged.shown.find((item) => item.threadId === "thr_5")?.requestId, "thr_5:t2");
  // Only rows for this tab wait: a new version and a new thread; thr_3 left the page.
  assert.deepEqual(merged.held.map((item) => [item.threadId, item.version]), [
    ["thr_2", 2],
    ["thr_4", 1],
  ]);
  assert.equal(merged.stay, null);
  // The next reload keeps holding them.
  const again = mergeIncoming(merged.shown, latest, { selected: null, view: "needs", stay: null });
  assert.deepEqual(again.held.map((item) => item.threadId), ["thr_2", "thr_4"]);

  // A snooze that ran out: the same request, back on this tab from Snoozed, waits too.
  const snoozed = card("thr_s", { disposition: { kind: "snoozed", untilAt: T0, tz: "Europe/Moscow", at: T0 - MINUTE } });
  const woke = mergeIncoming([card("thr_1"), snoozed], [card("thr_1"), card("thr_s")], { selected: null, view: "needs", stay: null });
  assert.deepEqual(woke.held.map((item) => item.threadId), ["thr_s"]);
  assert.deepEqual(woke.shown.map((item) => [item.threadId, item.disposition?.kind ?? null]), [
    ["thr_1", null],
    ["thr_s", "snoozed"],
  ]);
  // On Snoozed the same change is a row leaving: in place.
  assert.deepEqual(mergeIncoming([snoozed], [card("thr_s")], { selected: null, view: "snoozed", stay: null }).held, []);
});

test("the selected thread always shows its current state; when it leaves the tab its row stays there, marked, until the owner moves on", () => {
  const shown = [card("thr_1"), card("thr_2")];
  const where = (stay: Stay | null = null) => ({ selected: "thr_2", view: "needs" as const, stay });
  // A new version of the selected request is taken at once.
  const renewed = mergeIncoming(shown, [card("thr_1"), card("thr_2", { version: 2 })], where());
  assert.deepEqual(renewed.shown.map((item) => [item.threadId, item.version]), [
    ["thr_1", 1],
    ["thr_2", 2],
  ]);
  assert.deepEqual([renewed.held, renewed.stay], [[], null]);

  // Answered: the request closed and the thread left the page.
  const closed = mergeIncoming(shown, [card("thr_1")], where());
  assert.deepEqual(closed.stay, { threadId: "thr_2", from: "needs", to: "closed", card: shown[1] });
  // The agent is now waiting on someone: the row stays on Needs you, its card is the current one.
  const moved = mergeIncoming(closed.shown, [card("thr_1"), card("thr_2", { view: "waiting", state: "waiting", requestId: "thr_2:t2" })], where(closed.stay));
  assert.deepEqual([moved.stay?.from, moved.stay?.to, moved.stay?.card], ["needs", "waiting", shown[1]]);
  assert.equal(moved.shown.find((item) => item.threadId === "thr_2")?.view, "waiting");
  // Its status is being clarified: still there, marked.
  const checking = mergeIncoming(moved.shown, [card("thr_1"), card("thr_2", { view: null, freshness: "checking", requestId: null, version: null })], where(moved.stay));
  assert.deepEqual([checking.stay?.to, checking.stay?.card], ["checking", shown[1]]);
  // Asks again: an ordinary row on the tab.
  const back = mergeIncoming(checking.shown, [card("thr_1"), card("thr_2", { requestId: "thr_2:t3" })], where(checking.stay));
  assert.equal(back.stay, null);
  // Another selection lets the kept row go.
  assert.equal(mergeIncoming(closed.shown, [card("thr_1")], { selected: "thr_1", view: "needs", stay: closed.stay }).stay, null);

  // The row is kept on the tab being read: the selected thread read on Waiting that moves on stays there.
  const onWaiting = [card("thr_2", { view: "waiting", state: "waiting", requestId: "thr_2:w1" })];
  const stopped = card("thr_2", { view: "stopped", state: "unknown", execution: "failed", requestId: "thr_2:s1" });
  const kept = mergeIncoming(onWaiting, [stopped], { selected: "thr_2", view: "waiting", stay: null });
  assert.deepEqual([kept.stay?.from, kept.stay?.to, kept.stay?.card], ["waiting", "stopped", onWaiting[0]]);
  // A thread that was not on the tab being read leaves no kept row there.
  assert.equal(mergeIncoming(shown, [card("thr_1"), stopped], { selected: "thr_2", view: "waiting", stay: null }).stay, null);
  // A kept row from another tab is not carried over.
  assert.equal(mergeIncoming(onWaiting, [stopped], { selected: "thr_2", view: "waiting", stay: closed.stay }).stay?.from, "waiting");
});

test("the sidebar icon: a request always, a stop and a wait over bb's unread dot with the label saying so, done only when bb shows nothing", () => {
  const row = (overrides: Partial<RowView>): RowView => ({
    state: "question",
    reason: "Выбери вариант обложки",
    source: "agent",
    view: "needs",
    execution: null,
    freshness: "fresh",
    disposition: null,
    activityAt: T0,
    ...overrides,
  });
  const idle = { indicator: "none", isUnread: false };
  const unread = { indicator: "unread-success", isUnread: true };
  assert.deepEqual(rowIcon(row({}), unread), { icon: "CircleQuestion", label: "Needs you: Выбери вариант обложки · unread", tone: "error" });
  assert.deepEqual(rowIcon(row({ view: "stopped", state: "unknown", execution: "stoppedByOwner", reason: "Stopped by you" }), unread), {
    icon: "Pause",
    label: "Stopped by you · unread",
    tone: "default",
  });
  assert.equal(rowIcon(row({ view: "stopped", state: "unknown", execution: "failed", reason: "Run failed: limit" }), idle)?.icon, "AlertCircle");
  assert.equal(rowIcon(row({ view: "stopped", state: "unknown", freshness: "unavailable" }), idle)?.icon, "AlertTriangle");
  assert.equal(rowIcon(row({ view: "waiting", state: "waiting", reason: "Ждём CI" }), unread)?.label, "Waiting: Ждём CI · unread");
  assert.equal(rowIcon(row({ disposition: "snoozed" }), idle)?.icon, "Clock");
  assert.equal(rowIcon(row({ view: null, state: "done", reason: "PR #12" }), unread), null);
  assert.deepEqual(rowIcon(row({ view: null, state: "done", reason: "PR #12" }), idle), { icon: "CircleCheck", label: "Done: PR #12", tone: "success" });
  assert.equal(rowIcon(undefined, idle), null);
});

test("the status order: request, error, work, wait, the owner's stop or snoozed or unconfirmed, done; untracked threads by bb's facts", () => {
  const facts = thread("thr_x", { latestAttentionAt: T0 - MINUTE });
  const row = (overrides: Partial<RowView>): RowView => ({
    state: "question",
    reason: "",
    source: "agent",
    view: "needs",
    execution: null,
    freshness: "fresh",
    disposition: null,
    activityAt: T0,
    ...overrides,
  });
  const rank = (value: RowView | undefined, overrides: Partial<ThreadFacts> = {}) => statusRank(value, { ...facts, ...overrides }).rank;
  assert.equal(rank(row({})), 1);
  assert.equal(rank(row({ disposition: "snoozed" })), 5);
  assert.equal(rank(row({ view: "stopped", state: "unknown", execution: "failed" })), 2);
  assert.equal(rank(row({ view: "stopped", state: "unknown", execution: "stoppedByOwner" })), 5);
  assert.equal(rank(row({ view: null, state: "running" }), { status: "active" }), 3);
  assert.equal(rank(row({ view: "waiting", state: "waiting" })), 4);
  assert.equal(rank(row({ view: null, state: "done" })), 6);
  assert.equal(rank(row({ view: null, state: "unknown", freshness: "checking" })), 5);
  assert.equal(rank(undefined, { hasPendingInteraction: true }), 1);
  assert.equal(rank(undefined, { indicator: "unread-error" }), 2);
  assert.equal(rank(undefined, { status: "active" }), 3);
  assert.equal(rank(undefined), 5);
  // The time inside a rank: the plugin's activity, else bb's attention time, never the clock.
  assert.equal(statusRank(row({}), facts).at, T0);
  assert.equal(statusRank(undefined, facts).at, T0 - MINUTE);
});
