// The Needs-you page: the queue (views, filters, project → section →
// thread groups, cards and their actions) and the selected thread's
// conversation beside it: bb's own ThreadChat in the page's right panel, or
// on a phone in place of the list, with "Back to list" to the same place.
// The selection lives in the route (`<view>/<threadId>`), so Back and
// Forward walk it and a reload keeps it.
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import {
  ThreadChat,
  experimental_Icon as Icon,
  experimental_useAppPanel,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreads,
  useBbNavigate,
  useRpc,
  type PluginNavPanelProps,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { describeUntil } from "../lib/time.ts";
import type { rpcContract } from "../server.ts";
import { FIELD, Menu, Panel, SHEET_OPTION, button, cn, portalScope, type MenuItem } from "./kit.tsx";
import { deviceTimeZone, message, useCompact, useLatestCall, useNow, usePrefs, useQueueData, useReloadOn, useSoon } from "./live.ts";
import {
  DEFAULT_FILTERS,
  NO_SECTION,
  PAGE_VIEWS,
  SORT_TITLES,
  STATE_WORDS,
  VIEW_TITLES,
  ago,
  checkingCount,
  executionNote,
  filtersActive,
  formatRoute,
  groupBySection,
  groupEntries,
  groupKeyOf,
  joinCards,
  matches,
  needsCount,
  parseRoute,
  plural,
  projectOptions,
  sectionOptions,
  viewCounts,
  withProject,
  type Entry,
  type Filters,
  type GroupBy,
  type ListGroup,
  type NamedFacts,
  type PageView,
  type QueueCard,
  type QueueSort,
  type SectionGroup,
  type Stay,
} from "./model.ts";

export const PANEL_PATH = "needs-you";
export const CHAT_TAB = { panelId: "needs-you", id: "chat" } as const;

const clock = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const fullDate = (at: number) => new Date(at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

/** What each tab holds, shown under the tabs. */
const VIEW_HINTS: Record<PageView, string> = {
  needs: "Questions, approvals and actions that need you.",
  waiting: "Threads waiting on a dependency, a scheduled message or an automatic retry.",
  stopped: "Stopped or failed runs, and threads whose status could not be read.",
  snoozed: "Items you postponed. Each comes back when its time is up, or sooner if the thread asks again.",
};

const EMPTY: Record<PageView, string> = {
  needs: "No requests need your attention.",
  waiting: "No threads are waiting.",
  stopped: "No stopped runs or unresolved statuses.",
  snoozed: "No snoozed items.",
};

const REFUSALS: Record<string, string> = {
  changed: "This item changed. Nothing was changed; the latest version is now shown.",
  gone: "This item is no longer in the queue.",
  past: "That time has already passed.",
};

/** Every thread under `threadId` in bb's list that is not archived: archiving takes them along. */
function descendants(threadId: string, threads: readonly PluginSidebarThread[]): number {
  const children = new Map<string, string[]>();
  for (const thread of threads) {
    if (thread.parentThreadId === null || thread.isArchived) continue;
    children.set(thread.parentThreadId, [...(children.get(thread.parentThreadId) ?? []), thread.id]);
  }
  let count = 0;
  const queue = [...(children.get(threadId) ?? [])];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    count += 1;
    queue.push(...(children.get(next) ?? []));
  }
  return count;
}

/** The selected thread's row kept on the tab it left, as a list entry. */
function stayEntry(stay: Stay, shown: readonly QueueCard[], byId: ReadonlyMap<string, PluginSidebarThread>): Entry | null {
  const thread = byId.get(stay.threadId);
  if (!thread || thread.isArchived || thread.isHidden) return null;
  // Moved to another tab: its current card. Closed or being clarified: the row as it was.
  const live = shown.find((card) => card.threadId === stay.threadId);
  const card = stay.to !== "closed" && stay.to !== "checking" && live ? live : stay.card;
  return { card, thread, view: stay.from };
}

function stayNote(to: Stay["to"], thread: { status: string }): string {
  if (to === "checking") return "Status updating";
  // "pending": the answer is accepted and the turn has not started yet.
  if (to === "closed") return ["pending", "starting", "active"].includes(thread.status) ? "Answer sent. The agent is working." : "Request closed";
  return `Moved to ${VIEW_TITLES[to]}`;
}

/** A selected value kept in the options even when no card has it any more. */
function withSelected(options: NamedFacts[], selected: string | null, known: readonly NamedFacts[], fallback: string): NamedFacts[] {
  if (selected === null || options.some((option) => option.id === selected)) return options;
  const name = selected === NO_SECTION ? "No section" : (known.find((item) => item.id === selected)?.name ?? fallback);
  return [...options, { id: selected, name }];
}

// ---------------------------------------------------------------------------
// The page

export function NeedsYouPage({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const appPanel = experimental_useAppPanel();
  const actions = experimental_useSidebarThreadActions();
  const sidebar = experimental_useSidebarThreads();
  const compact = useCompact();
  const route = parseRoute(subPath);
  const [prefs, setPrefs] = usePrefs();
  const [showHidden, setShowHidden] = useState(false);
  const [archiving, setArchiving] = useState<{ threadId: string; title: string; children: number } | null>(null);
  const data = useQueueData(rpc, route.threadId, route.view);
  const now = useNow();

  const filters = prefs.filters;
  const setFilters = (change: (filters: Filters) => Filters) => setPrefs((prev) => ({ ...prev, filters: change(prev.filters) }));
  const threads = sidebar.threads;
  const byId = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  const all = useMemo(() => joinCards(data.shown ?? [], threads), [data.shown, threads]);
  const visible = all.filter((entry) => matches(entry, filters, showHidden));
  // The counts are the server's newest: a row kept on screen counts where its thread is now.
  const counts = viewCounts(joinCards(data.latest, threads).filter((entry) => matches(entry, filters, showHidden)));
  const kept = data.stay !== null && data.stay.from === route.view ? stayEntry(data.stay, data.shown ?? [], byId) : null;
  const stayed = kept !== null && matches(kept, filters, true) ? kept : null;
  const inView = [...visible.filter((entry) => entry.view === route.view && entry.card.threadId !== stayed?.card.threadId), ...(stayed ? [stayed] : [])];
  const groups: ListGroup[] =
    filters.groupBy === "section" ? groupBySection(inView, sidebar.sections, filters.sort) : groupEntries(inView, sidebar.projects, sidebar.sections, filters.sort);
  const projectNames = new Map(sidebar.projects.map((project) => [project.id, project.name]));
  const heldEntries = joinCards(data.held, threads).filter((entry) => entry.view === route.view && matches(entry, filters, showHidden));
  const renewed = new Set(heldEntries.map((entry) => entry.card.threadId));
  const hiddenCount = all.filter((entry) => entry.card.disposition?.kind === "dismissed" && matches(entry, filters, true)).length;
  const hiddenInView = all.filter((entry) => entry.view === route.view && entry.card.disposition?.kind === "dismissed" && matches(entry, filters, true)).length;
  const checking = checkingCount(data.latest, threads, filters);
  const unfilteredInView = all.filter((entry) => entry.view === route.view && matches(entry, DEFAULT_FILTERS, showHidden)).length;

  // Selection and the conversation beside the list.
  const listRef = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);
  const cameFromList = useRef(false);
  const openChatTab = useRef(false);
  const go = (view: PageView, threadId: string | null, replace = false) =>
    navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute(view, threadId), replace });
  const showChatTab = () => appPanel.openFixedTab({ surface: { kind: "current" }, tab: CHAT_TAB });
  const select = (threadId: string) => {
    if (compact) {
      savedScroll.current = listRef.current?.scrollTop ?? 0;
      cameFromList.current = true;
    }
    if (threadId === route.threadId) {
      if (!compact) showChatTab();
      return;
    }
    openChatTab.current = !compact;
    go(route.view, threadId);
  };
  useEffect(() => {
    if (openChatTab.current && route.threadId !== null) {
      openChatTab.current = false;
      showChatTab();
    }
  });
  const backToQueue = () => {
    if (cameFromList.current) {
      cameFromList.current = false;
      window.history.back();
    } else go(route.view, null, true);
  };
  // Back on the list (a phone): the same scroll, focus on the row or, if it left, its group.
  const lastSelected = useRef<string | null>(route.threadId);
  useEffect(() => {
    const previous = lastSelected.current;
    lastSelected.current = route.threadId;
    if (!compact || previous === null || route.threadId !== null) return;
    requestAnimationFrame(() => {
      const list = listRef.current;
      if (!list) return;
      list.scrollTop = savedScroll.current;
      const thread = byId.get(previous);
      const target =
        list.querySelector<HTMLElement>(`[data-row="${previous}"]`) ??
        (thread ? list.querySelector<HTMLElement>(`[data-group="${groupKeyOf(thread, filters.groupBy)}"]`) : null) ??
        (thread && filters.groupBy === "project" ? list.querySelector<HTMLElement>(`[data-group="p:${thread.projectId}"]`) : null) ??
        list.querySelector<HTMLElement>("[data-row]");
      target?.focus({ preventScroll: true });
    });
  });

  // After an action takes a row off the list, keyboard focus goes to the row
  // next to it (or its group), not to the page body.
  const pendingFocus = useRef<{ leaving: string; neighbor: string | null; group: string | null; until: number } | null>(null);
  const keepFocusNear = (threadId: string) => {
    const list = listRef.current;
    if (!list) return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-row]"));
    const index = rows.findIndex((row) => row.dataset.row === threadId);
    if (index === -1) return;
    const neighbor = rows[index + 1] ?? rows[index - 1];
    const entry = inView.find((item) => item.card.threadId === threadId);
    pendingFocus.current = {
      leaving: threadId,
      neighbor: neighbor?.dataset.row ?? null,
      group: entry ? groupKeyOf(entry.thread, filters.groupBy) : null,
      until: Date.now() + 5_000,
    };
  };
  useEffect(() => {
    const pending = pendingFocus.current;
    const list = listRef.current;
    if (pending === null || !list) return;
    if (Date.now() > pending.until) {
      pendingFocus.current = null;
      return;
    }
    if (list.querySelector(`[data-row="${pending.leaving}"]`)) return;
    pendingFocus.current = null;
    // Only focus that went away with the row moves; focus the owner put somewhere stays.
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const target =
      (pending.neighbor !== null ? list.querySelector<HTMLElement>(`[data-row="${pending.neighbor}"]`) : null) ??
      (pending.group !== null ? list.querySelector<HTMLElement>(`[data-group="${pending.group}"]`) : null) ??
      list.querySelector<HTMLElement>("[data-row]");
    target?.focus();
  });

  // Snooze, hide and bring back: one version of the thread's request.
  async function dispose(card: QueueCard, change: { kind: "dismiss" } | { kind: "restore" } | { kind: "snooze"; untilAt: number }, undoable = true) {
    const target = { threadId: card.threadId, ...(card.requestId !== null ? { requestId: card.requestId } : {}), ...(card.version !== null ? { version: card.version } : {}) };
    const tz = deviceTimeZone();
    keepFocusNear(card.threadId);
    try {
      const result =
        change.kind === "dismiss"
          ? await rpc.call("dismiss", target)
          : change.kind === "restore"
            ? await rpc.call("restore", target)
            : await rpc.call("snooze", { ...target, untilAt: change.untilAt, tz });
      if (!result.ok) {
        pendingFocus.current = null;
        toast.error(REFUSALS[result.reason ?? "gone"] ?? "That did not work.");
        await data.refreshOne(card.threadId);
        return;
      }
      await data.refreshOne(card.threadId);
      const current = { ...card, requestId: result.requestId, version: result.version };
      const undo = undoable ? { action: { label: "Undo", onClick: () => void dispose(current, { kind: "restore" }, false) } } : {};
      if (change.kind === "dismiss") toast("Item hidden. No reply sent.", undo);
      else if (change.kind === "snooze") toast(`Snoozed until ${describeUntil(change.untilAt, tz)}.`, undo);
      else toast.success("Restored to queue.");
    } catch (error) {
      pendingFocus.current = null;
      toast.error(message(error, "That did not work: the plugin server did not respond."));
    }
  }

  function archiveThread(thread: Entry["thread"]) {
    const children = descendants(thread.id, threads);
    if (children > 0) setArchiving({ threadId: thread.id, title: thread.displayTitle, children });
    else {
      // Keep bb's archive confirmation and Undo.
      keepFocusNear(thread.id);
      actions.archive(thread.id);
    }
  }

  function menuFor(entry: Entry): MenuItem[] {
    const { card, thread } = entry;
    const items: MenuItem[] = [
      {
        label: thread.isPinned ? "Unpin" : "Pin",
        icon: thread.isPinned ? "PinOff" : "Pin",
        onSelect: () => void actions.setPinned(thread.id, !thread.isPinned).catch((error: unknown) => toast.error(message(error, "That did not work."))),
      },
    ];
    if (card.disposition === null) {
      items.push({
        label: "Hide this item",
        description: "New items from this thread will still appear. The agent receives no reply.",
        icon: "EyeOff",
        onSelect: () => void dispose(card, { kind: "dismiss" }),
      });
    } else {
      items.push({ label: "Restore to queue", icon: "Eye", onSelect: () => void dispose(card, { kind: "restore" }) });
    }
    items.push({ label: "Open full thread", icon: "ExternalLink", onSelect: () => actions.open(thread.id) });
    return items;
  }

  const toggleGroup = (key: string) =>
    setPrefs((prev) => ({ ...prev, collapsed: prev.collapsed.includes(key) ? prev.collapsed.filter((item) => item !== key) : [...prev.collapsed, key] }));
  const collapsed = new Set(prefs.collapsed);

  const listMenu: MenuItem[] = [
    {
      label: showHidden ? "Don't show hidden items" : `Show hidden items${hiddenCount > 0 ? ` (${hiddenCount})` : ""}`,
      icon: showHidden ? "EyeOff" : "Eye",
      onSelect: () => setShowHidden(!showHidden),
    },
    { label: "Refresh", icon: "RotateCcw", onSelect: () => void data.reload() },
  ];

  const chatOpenHere = compact && route.threadId !== null;
  const loading = data.shown === null || (sidebar.status === "loading" && threads.length === 0);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {chatOpenHere ? <ChatView threadId={route.threadId!} onBack={backToQueue} /> : null}
      {/* bb hands a plugin page its body without scrolling; the list scrolls itself. */}
      <div ref={listRef} hidden={chatOpenHere} className="h-full min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 p-3 md:p-6">
          <div role="group" aria-label="Queue tabs" className="flex flex-wrap items-center gap-1 max-md:grid max-md:grid-cols-2">
            {PAGE_VIEWS.map((view) => (
              <button
                key={view}
                type="button"
                aria-current={view === route.view ? "page" : undefined}
                className={cn(button("ghost"), "text-sm max-md:justify-between", view === route.view && "bg-state-active text-foreground")}
                onClick={() => go(view, route.threadId)}
              >
                {VIEW_TITLES[view]}
                <span className="tabular-nums text-muted-foreground">{counts[view]}</span>
              </button>
            ))}
          </div>
          <p className="-mt-1 px-1 text-xs text-muted-foreground">
            {VIEW_HINTS[route.view]}
            {checking > 0 ? ` Checking ${checking} thread ${plural(checking, "status", "statuses")}; more items may appear.` : ""}
          </p>

          <Toolbar
            compact={compact}
            filters={filters}
            setFilters={setFilters}
            entries={all}
            projects={sidebar.projects}
            sections={sidebar.sections}
            listMenu={listMenu}
          />

          {data.offline && data.shown !== null ? (
            <p role="status" className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
              No connection to the bb server. Showing the list as of {data.loadedAt !== null ? clock(data.loadedAt) : "—"}; it updates once bb reconnects.
            </p>
          ) : null}
          {data.error !== null && data.shown !== null ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
              Could not update the queue: {data.error}
              <button type="button" className={button("outline")} onClick={() => void data.reload()}>
                Retry
              </button>
            </div>
          ) : null}
          {heldEntries.length > 0 ? (
            <button type="button" className={cn(button("primary"), "self-start")} onClick={data.applyHeld}>
              <Icon name="ArrowUp" aria-hidden className="size-4" />
              Show {heldEntries.length} {plural(heldEntries.length, "update", "updates")}
            </button>
          ) : null}

          {loading ? (
            data.error !== null ? (
              <div role="alert" className="flex flex-col items-start gap-2 py-8 text-sm">
                <p>Could not load the queue: {data.error}</p>
                <button type="button" className={button("outline")} onClick={() => void data.reload()}>
                  Retry
                </button>
              </div>
            ) : (
              <p role="status" className="py-8 text-sm text-muted-foreground">
                Loading the queue…
              </p>
            )
          ) : sidebar.status === "error" && threads.length === 0 ? (
            <p role="alert" className="py-8 text-sm text-destructive">
              Could not get bb's thread list, so the queue cannot be shown. Reload the page.
            </p>
          ) : inView.length === 0 ? (
            filtersActive(filters) && unfilteredInView > 0 ? (
              <div className="flex flex-col items-start gap-2 py-8 text-sm text-muted-foreground">
                <p>No items match these filters.</p>
                <button type="button" className={button("outline")} onClick={() => setFilters((prev) => ({ ...DEFAULT_FILTERS, sort: prev.sort, groupBy: prev.groupBy }))}>
                  Clear filters
                </button>
              </div>
            ) : !showHidden && hiddenInView > 0 ? (
              <div className="flex flex-col items-start gap-2 py-8 text-sm text-muted-foreground">
                <p>
                  No visible items. {hiddenInView} hidden.
                </p>
                <button type="button" className={button("outline")} onClick={() => setShowHidden(true)}>
                  Show hidden items
                </button>
              </div>
            ) : checking > 0 ? (
              <p className="py-8 text-sm text-muted-foreground">
                Checking {checking} thread {plural(checking, "status", "statuses")}. More items may appear.
              </p>
            ) : (
              <p className="py-8 text-sm text-muted-foreground">{EMPTY[route.view]}</p>
            )
          ) : (
            <div className="flex flex-col gap-4">
              {groups.map((group) => (
                <ProjectBlock
                  key={group.key}
                  group={group}
                  collapsed={collapsed}
                  onToggle={toggleGroup}
                  renderEntry={(entry) => (
                    <Row
                      key={entry.card.threadId}
                      entry={entry}
                      selected={entry.card.threadId === route.threadId}
                      stayNote={entry === stayed && data.stay !== null ? stayNote(data.stay.to, entry.thread) : null}
                      renewed={renewed.has(entry.card.threadId)}
                      now={now}
                      sort={filters.sort}
                      compact={compact}
                      byId={byId}
                      project={filters.groupBy === "section" ? (projectNames.get(entry.thread.projectId) ?? null) : null}
                      onSelect={select}
                      onSnooze={(untilAt) => void dispose(entry.card, { kind: "snooze", untilAt })}
                      onRestore={() => void dispose(entry.card, { kind: "restore" })}
                      onArchive={() => archiveThread(entry.thread)}
                      menu={menuFor(entry)}
                      listRef={listRef}
                    />
                  )}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <AlertDialog.Root open={archiving !== null} onOpenChange={(open) => (open ? null : setArchiving(null))}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay {...portalScope()} className="fixed inset-0 z-50 bg-black/40" />
          <AlertDialog.Content
            {...portalScope()}
            className="fixed top-1/2 left-1/2 z-50 w-[min(28rem,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-4 text-foreground shadow-lg"
          >
            <AlertDialog.Title className="text-base font-semibold">
              Archive this thread and {archiving?.children} child {plural(archiving?.children ?? 0, "thread", "threads")}?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-muted-foreground">
              "{archiving?.title}" and its child {plural(archiving?.children ?? 0, "thread", "threads")} go to the archive. You can restore them from
              the archive.
            </AlertDialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <AlertDialog.Cancel className={button("outline")}>Cancel</AlertDialog.Cancel>
              <AlertDialog.Action
                className={button("primary")}
                onClick={() => {
                  if (archiving) {
                    keepFocusNear(archiving.threadId);
                    actions.archive(archiving.threadId);
                  }
                  setArchiving(null);
                }}
              >
                Archive {(archiving?.children ?? 0) + 1} threads
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filters

function FilterFields({
  filters,
  setFilters,
  entries,
  projects,
  sections,
  stacked,
}: {
  filters: Filters;
  setFilters: (change: (filters: Filters) => Filters) => void;
  entries: readonly Entry[];
  projects: readonly NamedFacts[];
  sections: readonly NamedFacts[];
  stacked: boolean;
}) {
  const projectList = withSelected(projectOptions(entries, projects), filters.projectId, projects, "Project");
  const sectionList = withSelected(sectionOptions(entries, sections, filters.projectId), filters.sectionId, sections, "Section");
  const field = cn(FIELD, stacked ? "w-full" : "max-w-48");
  return (
    <>
      <select
        aria-label="Group by"
        className={field}
        value={filters.groupBy}
        onChange={(event) => {
          const value: GroupBy = event.target.value === "project" ? "project" : "section";
          setFilters((prev) => ({ ...prev, groupBy: value }));
        }}
      >
        <option value="section">Group by section</option>
        <option value="project">Group by project</option>
      </select>
      <select
        aria-label="Project"
        className={field}
        value={filters.projectId ?? ""}
        onChange={(event) => {
          const value = event.target.value || null;
          setFilters((prev) => withProject(prev, value, entries, sections));
        }}
      >
        <option value="">All projects</option>
        {projectList.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <select
        aria-label="Section"
        className={field}
        value={filters.sectionId ?? ""}
        onChange={(event) => {
          const value = event.target.value || null;
          setFilters((prev) => ({ ...prev, sectionId: value }));
        }}
      >
        <option value="">All sections</option>
        {sectionList.map((section) => (
          <option key={section.id} value={section.id}>
            {section.name}
          </option>
        ))}
      </select>
      <select
        aria-label="Sort"
        className={field}
        value={filters.sort}
        onChange={(event) => {
          const value = event.target.value === "old" ? "old" : "new";
          setFilters((prev) => ({ ...prev, sort: value }));
        }}
      >
        {(["new", "old"] as const).map((sort) => (
          <option key={sort} value={sort}>
            {SORT_TITLES[sort]}
          </option>
        ))}
      </select>
    </>
  );
}

function Toolbar(props: {
  compact: boolean;
  filters: Filters;
  setFilters: (change: (filters: Filters) => Filters) => void;
  entries: readonly Entry[];
  projects: readonly NamedFacts[];
  sections: readonly NamedFacts[];
  listMenu: MenuItem[];
}) {
  const { compact, filters, setFilters, projects, sections, listMenu } = props;
  const [open, setOpen] = useState(false);
  const reset = () => setFilters((prev) => ({ ...DEFAULT_FILTERS, sort: prev.sort, groupBy: prev.groupBy }));
  const search = (
    <input
      type="search"
      aria-label="Search titles and requests"
      placeholder="Search titles and requests"
      // In the sheet's column a flex basis of 0 would take the field's height.
      className={cn(FIELD, compact ? "w-full" : "min-w-40 flex-1")}
      value={filters.search}
      onChange={(event) => {
        const value = event.target.value;
        setFilters((prev) => ({ ...prev, search: value }));
      }}
    />
  );
  const more = (
    <Menu label="More" items={listMenu} compact={compact} triggerClassName={button("ghost", "icon")}>
      <Icon name="MoreHorizontal" aria-hidden className="size-4" />
    </Menu>
  );
  if (!compact) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <FilterFields {...props} stacked={false} />
        {search}
        {filtersActive(filters) ? (
          <button type="button" className={button("ghost")} onClick={reset}>
            Clear filters
          </button>
        ) : null}
        {more}
      </div>
    );
  }
  // A phone: one "Filters" button, the choices in a sheet, what is chosen as chips under it.
  const chips: { key: string; label: string; clear: () => void }[] = [];
  if (filters.projectId !== null) {
    chips.push({ key: "project", label: projects.find((item) => item.id === filters.projectId)?.name ?? "Project", clear: () => setFilters((prev) => ({ ...prev, projectId: null, sectionId: null })) });
  }
  if (filters.sectionId !== null) {
    chips.push({
      key: "section",
      label: filters.sectionId === NO_SECTION ? "No section" : (sections.find((item) => item.id === filters.sectionId)?.name ?? "Section"),
      clear: () => setFilters((prev) => ({ ...prev, sectionId: null })),
    });
  }
  if (filters.search.trim() !== "") chips.push({ key: "search", label: `"${filters.search.trim()}"`, clear: () => setFilters((prev) => ({ ...prev, search: "" })) });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Panel
          open={open}
          onOpenChange={setOpen}
          title="Filters"
          compact
          trigger={
            <button type="button" className={button("outline")}>
              <Icon name="FilterHorizontal" aria-hidden className="size-4" />
              Filters{chips.length > 0 ? ` · ${chips.length}` : ""}
            </button>
          }
        >
          <FilterFields {...props} stacked />
          {search}
          <div className="flex gap-2">
            {filtersActive(filters) ? (
              <button type="button" className={cn(button("outline"), "flex-1")} onClick={reset}>
                Clear filters
              </button>
            ) : null}
            <button type="button" className={cn(button("primary"), "flex-1")} onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </Panel>
        <span className="flex-1 truncate text-xs text-muted-foreground">{SORT_TITLES[filters.sort]}</span>
        {more}
      </div>
      {chips.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <button key={chip.key} type="button" className={cn(button("outline"), "max-w-full")} aria-label={`Remove filter ${chip.label}`} onClick={chip.clear}>
              <span className="truncate">{chip.label}</span>
              <Icon name="CircleX" aria-hidden className="size-4 shrink-0" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Groups

function GroupHeader({ groupKey, collapsed, onToggle, level, children }: { groupKey: string; collapsed: boolean; onToggle: (key: string) => void; level: "project" | "section"; children: ReactNode }) {
  return (
    <button
      type="button"
      data-group={groupKey}
      aria-expanded={!collapsed}
      onClick={() => onToggle(groupKey)}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:min-h-11",
        level === "project" ? "text-sm font-semibold" : "text-xs font-medium text-muted-foreground uppercase tracking-wide",
      )}
    >
      <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} aria-hidden className="size-4 shrink-0" />
      {children}
    </button>
  );
}

function ProjectBlock({
  group,
  collapsed,
  onToggle,
  renderEntry,
}: {
  group: ListGroup;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  renderEntry: (entry: Entry) => ReactNode;
}) {
  const closed = collapsed.has(group.key);
  const list = (section: SectionGroup) => <ul className="flex flex-col gap-2">{section.entries.map(renderEntry)}</ul>;
  return (
    <section aria-label={group.name} className="flex flex-col gap-2">
      <GroupHeader groupKey={group.key} collapsed={closed} onToggle={onToggle} level="project">
        <span className="truncate">{group.name}</span>
        <span className="tabular-nums font-normal text-muted-foreground">· {group.count}</span>
      </GroupHeader>
      {closed
        ? null
        : group.sections.map((section) =>
            section.sectionId === null ? (
              <div key={section.key}>{list(section)}</div>
            ) : (
              <div key={section.key} className="flex flex-col gap-2 pl-2 md:pl-3">
                <GroupHeader groupKey={section.key} collapsed={collapsed.has(section.key)} onToggle={onToggle} level="section">
                  <span className="truncate">{section.name}</span>
                  <span className="tabular-nums">· {section.entries.length}</span>
                </GroupHeader>
                {collapsed.has(section.key) ? null : list(section)}
              </div>
            ),
          )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// A card

const LONG_ASK = 180;
const ROW_ACTION = "max-md:min-h-11 max-md:px-3";

function Row({
  entry,
  selected,
  stayNote,
  renewed,
  now,
  sort,
  compact,
  byId,
  project,
  onSelect,
  onSnooze,
  onRestore,
  onArchive,
  menu,
  listRef,
}: {
  entry: Entry;
  selected: boolean;
  /** The selected row left this tab: where its thread went. */
  stayNote: string | null;
  /** A new request in this thread waits behind "Show N updates". */
  renewed: boolean;
  now: number;
  sort: QueueSort;
  compact: boolean;
  byId: ReadonlyMap<string, PluginSidebarThread>;
  /** The thread's project, named when the list is grouped by section. */
  project: string | null;
  onSelect: (threadId: string) => void;
  onSnooze: (untilAt: number) => void;
  onRestore: () => void;
  onArchive: () => void;
  menu: MenuItem[];
  listRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { card, thread } = entry;
  const at = sort === "new" ? (card.attentionAt ?? card.since) : (card.requestedAt ?? card.since);
  const text = card.ask ?? card.reason;
  const left = stayNote !== null;
  const noted = stayNote ?? executionNote(card);
  // "Stopped by you" under "Stopped by you" says nothing new.
  const note = noted !== null && noted.toLowerCase() === text.toLowerCase() ? null : noted;
  const tz = deviceTimeZone();

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []);
    const next = rows[rows.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-md border bg-card p-3 transition-colors",
        selected && "border-ring bg-state-active/40",
        left && "opacity-70",
      )}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          data-row={card.threadId}
          aria-current={selected ? "true" : undefined}
          className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => onSelect(card.threadId)}
          onKeyDown={moveFocus}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {thread.isPinned ? (
              <Icon name="Pin" aria-label="Pinned" className="size-3.5 shrink-0 text-muted-foreground" />
            ) : null}
            {thread.isUnread ? <span aria-label="Unread" role="img" className="size-2 shrink-0 rounded-full bg-foreground" /> : null}
            <span className="truncate text-sm font-medium">{thread.displayTitle}</span>
            {project !== null ? <span title="Project" className="shrink-0 rounded-sm bg-muted px-1 text-[11px] leading-4 text-muted-foreground">{project}</span> : null}
            {card.count > 1 ? (
              <span className="shrink-0 rounded-sm border px-1 text-[11px] leading-4 text-muted-foreground">
                {card.count} {plural(card.count, "question", "questions")}
              </span>
            ) : null}
          </span>
          <span className={cn("mt-1 block text-sm break-words", text.length > LONG_ASK && "line-clamp-3")}>{text}</span>
        </button>
        <time dateTime={new Date(at).toISOString()} title={fullDate(at)} className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
          {ago(at, now)}
        </time>
      </div>

      <Details card={card} note={note} quiet={left} renewed={renewed} tz={tz} byId={byId} onSelect={onSelect} />

      {/* Keep all three actions visible; allow wrapping on narrow screens. */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={cn(button("outline"), ROW_ACTION)} onClick={() => onSelect(card.threadId)}>
          <Icon name="MessageSquare" aria-hidden className="size-4" />
          Reply
        </button>
        {card.disposition === null ? (
          <SnoozeControl compact={compact} onSnooze={onSnooze} />
        ) : (
          <button type="button" className={cn(button("outline"), ROW_ACTION)} onClick={onRestore}>
            <Icon name="Eye" aria-hidden className="size-4" />
            Restore to queue
          </button>
        )}
        <button type="button" className={cn(button("outline"), ROW_ACTION)} onClick={onArchive}>
          <Icon name="Archive" aria-hidden className="size-4" />
          Archive
        </button>
        <Menu label={`Actions: ${thread.displayTitle}`} items={menu} compact={compact} triggerClassName={button("ghost", "icon")}>
          <Icon name="MoreHorizontal" aria-hidden className="size-4" />
        </Menu>
      </div>
    </li>
  );
}

function Details({
  card,
  note,
  quiet,
  renewed,
  tz,
  byId,
  onSelect,
}: {
  card: QueueCard;
  note: string | null;
  /** The note says where the row went, not what went wrong. */
  quiet: boolean;
  renewed: boolean;
  tz: string;
  byId: ReadonlyMap<string, PluginSidebarThread>;
  onSelect: (threadId: string) => void;
}) {
  const lines: ReactNode[] = [];
  if (note !== null) {
    const bad = !quiet && (card.execution === "sendFailed" || card.execution === "failed" || card.execution === "interrupted");
    lines.push(
      <p key="note" className={cn("text-xs", bad ? "text-destructive" : "text-muted-foreground")}>
        {note}
        {card.execution === "sendFailed" && card.ask !== null ? ` — ${card.reason}` : null}
      </p>,
    );
  }
  if (renewed) {
    lines.push(
      <p key="renewed" className="text-xs text-muted-foreground">
        This thread has a new request; press "Show updates" above to see it.
      </p>,
    );
  }
  if (card.sendAt !== null && card.view === "waiting") {
    lines.push(
      <p key="send" className="text-xs text-muted-foreground">
        Scheduled to send {describeUntil(card.sendAt, tz)}
      </p>,
    );
  }
  if (card.disposition?.kind === "snoozed") {
    lines.push(
      <p key="snooze" className="text-xs text-muted-foreground">
        Back in the queue {describeUntil(card.disposition.untilAt, card.disposition.tz)}
      </p>,
    );
  }
  if (card.disposition?.kind === "dismissed") {
    lines.push(
      <p key="hidden" className="text-xs text-muted-foreground">
        Hidden. New items from this thread will still appear.
      </p>,
    );
  }
  if (card.legacyDismissal && card.disposition === null) {
    lines.push(
      <p key="legacy" className="text-xs text-muted-foreground">
        An earlier version of the queue hid this thread; hide it again if you don't need it.
      </p>,
    );
  }
  if (card.waitingOn.length > 0) {
    lines.push(
      <ul key="deps" className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        {card.waitingOn.map((dependency) => {
          const title = byId.get(dependency.threadId)?.displayTitle ?? dependency.title ?? dependency.threadId;
          return (
            <li key={dependency.threadId}>
              Waiting on{" "}
              {dependency.available ? (
                <button type="button" className="text-foreground underline-offset-2 hover:underline" onClick={() => onSelect(dependency.threadId)}>
                  {title}
                </button>
              ) : (
                <span>{title}</span>
              )}{" "}
              —{" "}
              {!dependency.available
                ? "thread unavailable, status unknown"
                : dependency.archived
                  ? "archived"
                  : (STATE_WORDS[dependency.state ?? ""] ?? "no status")}
            </li>
          );
        })}
      </ul>,
    );
  }
  const text = card.ask ?? card.reason;
  const context = [card.done ? `Done: ${card.done}` : null, text.length > LONG_ASK ? text : null].filter((item): item is string => item !== null);
  if (context.length > 0) {
    lines.push(
      <details key="context" className="text-xs">
        <summary className="cursor-pointer text-muted-foreground select-none max-md:py-2">Context</summary>
        <div className="mt-1 flex flex-col gap-1 break-words whitespace-pre-wrap">
          {context.map((item) => (
            <p key={item}>{item}</p>
          ))}
        </div>
      </details>,
    );
  }
  return lines.length > 0 ? <div className="flex flex-col gap-1">{lines}</div> : null;
}

// ---------------------------------------------------------------------------
// "Remind me later…"

const pad = (value: number) => String(value).padStart(2, "0");
const localInput = (at: number) => {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
function tomorrowMorning(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 9, 0).getTime();
}

function SnoozeControl({ compact, onSnooze }: { compact: boolean; onSnooze: (untilAt: number) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const now = Date.now();
  const tz = deviceTimeZone();
  const inHour = now + 60 * 60_000;
  const morning = tomorrowMorning(now);
  const chosen = value === "" ? Number.NaN : new Date(value).getTime();
  const valid = Number.isFinite(chosen) && chosen > now;
  const option = cn(
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
    compact && SHEET_OPTION,
  );
  const choose = (at: number) => {
    setOpen(false);
    setValue("");
    onSnooze(at);
  };
  return (
    <Panel
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setValue("");
      }}
      title="Remind me later"
      compact={compact}
      trigger={
        <button type="button" className={cn(button("outline"), ROW_ACTION)}>
          <Icon name="Clock" aria-hidden className="size-4" />
          Remind me later…
        </button>
      }
    >
      <p className="text-xs text-muted-foreground">
        Moves this item to Snoozed without pausing the agent or sending a reply. A new item from the thread brings it back sooner. Times are in {tz}.
      </p>
      <div className="flex flex-col gap-0.5">
        <button type="button" className={option} onClick={() => choose(inHour)}>
          For 1 hour
          <span className="ml-auto text-muted-foreground">until {clock(inHour)}</span>
        </button>
        <button type="button" className={option} onClick={() => choose(morning)}>
          Tomorrow at 09:00
          <span className="ml-auto text-muted-foreground">{describeUntil(morning, null)}</span>
        </button>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        Date and time
        <input type="datetime-local" className={FIELD} min={localInput(now)} value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
      {value !== "" ? (
        <p className={cn("text-xs", valid ? "text-muted-foreground" : "text-destructive")}>{valid ? `Back in the queue ${describeUntil(chosen, tz)}` : "That time has already passed."}</p>
      ) : null}
      <button type="button" className={button("primary")} disabled={!valid} onClick={() => choose(chosen)}>
        {valid ? `Remind me ${describeUntil(chosen, tz)}` : "Remind me at the chosen time"}
      </button>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// The conversation

function ChatView({ threadId, onBack }: { threadId: string; onBack?: () => void }) {
  const sidebar = experimental_useSidebarThreads();
  const actions = experimental_useSidebarThreadActions();
  const thread = sidebar.threads.find((item) => item.id === threadId);
  const project = sidebar.projects.find((item) => item.id === thread?.projectId);
  const section = thread?.sectionId ? sidebar.sections.find((item) => item.id === thread.sectionId) : undefined;
  const path = [project?.name, section?.name].filter((part): part is string => Boolean(part)).join(" / ");
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        {onBack ? (
          <button type="button" className={button("ghost")} onClick={onBack}>
            <Icon name="ArrowLeft" aria-hidden className="size-4" />Back to list
          </button>
        ) : null}
        <div className="min-w-0 flex-1 px-1">
          {path ? <p className="truncate text-xs text-muted-foreground">{path}</p> : null}
          <p className="truncate text-sm font-medium">{thread?.displayTitle ?? threadId}</p>
        </div>
        <button
          type="button"
          className={button("ghost", "icon")}
          aria-label="Open full thread"
          title="Open full thread"
          onClick={() => actions.open(threadId)}
        >
          <Icon name="ExternalLink" aria-hidden className="size-4" />
        </button>
      </div>
      <ThreadChat key={threadId} threadId={threadId} variant="compact" className="min-h-0 flex-1" />
    </div>
  );
}

/** The page's right-panel tab: the selected thread's conversation. */
export function ChatTab({ subPath }: PluginNavPanelProps) {
  const { threadId } = parseRoute(subPath);
  if (threadId === null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Pick a thread in the queue; its chat opens here.
      </div>
    );
  }
  return <ChatView threadId={threadId} />;
}

/** Beside the page's navigation item: requests to the owner that nobody snoozed or hid. */
export function NeedsYouCount() {
  const rpc = useRpc<typeof rpcContract>();
  const [cards, setCards] = useState<QueueCard[] | null>(null);
  const { run } = useLatestCall(useCallback(() => rpc.call("queue", {}), [rpc]));
  const load = useCallback(
    () => run(({ items }) => setCards(items), (error) => console.warn("thread-card: loading the queue failed", error)),
    [run],
  );
  const soon = useSoon(load);
  useEffect(() => {
    void load();
  }, [load]);
  useReloadOn("card", soon);
  const { threads } = experimental_useSidebarThreads();
  const count = cards === null ? 0 : needsCount(cards, threads);
  return count === 0 ? null : (
    <span className="text-xs tabular-nums text-muted-foreground" aria-label={`${count} waiting for you`}>
      {count}
    </span>
  );
}
