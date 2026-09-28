// The icon on each thread's sidebar row, and the keys of the "By status"
// order for bb's thread list. The content script owns bb's row setter; an
// app overlay with no UI loads the statuses and decides what to draw
// (model.rowIcon) and where each thread goes (model.statusRank), on load and
// on every change the server announces.
import { useCallback, useEffect, useState } from "react";
import {
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
  type PluginComposerThreadRowStatus,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import { useReloadOn, useSoon, type Rpc } from "./live.ts";
import { rowIcon, statusRank, type RowView } from "./model.ts";

export type Rows = { display: "row" | "title"; rows: Record<string, RowView> };

type SetRowStatus = (threadId: string, status: PluginComposerThreadRowStatus | null) => void;
let setRowStatus: SetRowStatus | null = null;
const drawn = new Map<string, string>();
/** What the overlay last asked to draw, for a content script that mounts after it. */
let lastDraw: { rows: Rows | null; threads: readonly PluginSidebarThread[] } = { rows: null, threads: [] };

export function drawRows(rows: Rows | null, threads: readonly PluginSidebarThread[]) {
  lastDraw = { rows, threads };
  if (setRowStatus === null) return;
  const wanted = new Map<string, PluginComposerThreadRowStatus>();
  if (rows !== null && rows.display === "row") {
    for (const thread of threads) {
      const status = rowIcon(rows.rows[thread.id], thread);
      if (status) wanted.set(thread.id, status);
    }
  }
  for (const threadId of drawn.keys()) {
    if (!wanted.has(threadId)) {
      setRowStatus(threadId, null);
      drawn.delete(threadId);
    }
  }
  for (const [threadId, status] of wanted) {
    const key = JSON.stringify(status);
    if (drawn.get(threadId) === key) continue;
    setRowStatus(threadId, status);
    drawn.set(threadId, key);
  }
}

/** The content script's mount: take bb's setter and draw what the overlay already knows. */
export function mountRowStatus(setter: SetRowStatus | null): () => void {
  setRowStatus = setter;
  drawRows(lastDraw.rows, lastDraw.threads);
  return () => {
    setRowStatus = null;
    drawn.clear();
  };
}

/**
 * bb's thread list orders threads by a plugin's keys through
 * `app.experimental_sidebarThreadSorts` (a bb newer than 0.43; the list
 * falls back to its own order without it). Detected at runtime: on a bb
 * without it the plugin offers no such order.
 */
interface SortKey {
  rank: number;
  at: number;
}
interface SortController {
  setKeys(keys: Record<string, SortKey | null>): void;
}
interface SortRegistry {
  register(registration: { id: string; title: string; description?: string }): SortController;
}
let sortController: SortController | null = null;

export function registerStatusSort(app: object): void {
  const sorts = (app as { experimental_sidebarThreadSorts?: SortRegistry }).experimental_sidebarThreadSorts;
  if (sorts === undefined) return;
  try {
    sortController = sorts.register({
      id: "status",
      title: "By status",
      description: "Threads that need you first, then errors, work in progress and waits; stopped by you and done last. Newest activity first within each.",
    });
  } catch (error) {
    console.warn("thread-card: the status order was not registered", error);
  }
}

function publishSortKeys(rows: Rows | null, threads: readonly PluginSidebarThread[]) {
  if (sortController === null || rows === null) return;
  const keys: Record<string, SortKey> = {};
  for (const thread of threads) {
    if (!thread.isHidden) keys[thread.id] = statusRank(rows.rows[thread.id], thread);
  }
  try {
    sortController.setKeys(keys);
  } catch (error) {
    console.warn("thread-card: publishing the status order failed", error);
  }
}

/** Every tracked thread's status, reloaded on each change and after a reconnection. */
export function useRows(rpc: Rpc): Rows | null {
  const [rows, setRows] = useState<Rows | null>(null);
  const load = useCallback(async () => {
    try {
      setRows(await rpc.call("rows", {}));
    } catch (error) {
      console.warn("thread-card: loading statuses failed", error);
    }
  }, [rpc]);
  const soon = useSoon(load);
  useEffect(() => {
    void load();
  }, [load]);
  useReloadOn("card", soon);
  // The status display setting changed.
  useRealtime("rows", soon);
  return rows;
}

/** Draws the row icons and publishes the status order; renders nothing. */
export function RowIcons() {
  const rpc = useRpc<typeof rpcContract>();
  const rows = useRows(rpc);
  const { threads } = experimental_useSidebarThreads();
  useEffect(() => {
    drawRows(rows, threads);
    // The order is there whether or not the icons are drawn.
    publishSortKeys(rows, threads);
  }, [rows, threads]);
  return null;
}
