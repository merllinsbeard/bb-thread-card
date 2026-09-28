// Live data for the frontend: the RPC client type, a reload that runs once
// per burst of announcements, calls whose older answers never overwrite
// newer ones, the queue as the owner reads it (new requests wait behind a
// button), preferences kept on this device, and the viewport.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc, type PluginRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import { DEFAULT_FILTERS, applyOne, mergeIncoming, parsePrefs, type PageView, type Prefs, type QueueCard, type Stay } from "./model.ts";

export type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

export const message = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/** Run `load` half a second after the first of a burst of calls, once. */
export function useSoon(load: () => Promise<void>): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(load);
  latest.current = load;
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void latest.current();
    }, 500);
  }, []);
}

/**
 * Reload on every change the server announces on `channel`, after a
 * reconnection (announcements are not replayed) and when the page shows
 * again after being hidden.
 */
export function useReloadOn(channel: string, soon: () => void): PluginRealtimeConnectionState {
  useRealtime(channel, soon);
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef<boolean | null>(null);
  useEffect(() => {
    const connected = connection === "connected";
    if (connected && wasConnected.current === false) soon();
    wasConnected.current = connected;
  }, [connection, soon]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") soon();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [soon]);
  return connection;
}

export interface QueueData {
  /** What the list shows; null until the first load. */
  shown: QueueCard[] | null;
  /** The newest cards from the server: the counts beside the tabs. */
  latest: QueueCard[];
  /** New rows for the tab the owner reads, waiting behind a button. */
  held: QueueCard[];
  /** The selected thread's row that left the tab, kept there marked. */
  stay: Stay | null;
  error: string | null;
  loadedAt: number | null;
  /** The connection to bb dropped after it was up: announcements are missed. */
  offline: boolean;
  loading: boolean;
  reload: () => Promise<void>;
  /** Show the held rows: the list takes the newest order. */
  applyHeld: () => void;
  /** After the owner's own action on a thread: take its card from the server now. */
  refreshOne: (threadId: string) => Promise<void>;
}

/**
 * Answers to the queue call, newest request wins: a slow answer to an older
 * call is dropped when a newer one was already applied.
 */
export function useLatestCall<T>(call: () => Promise<T>): {
  /** `started` gets the call's number; `apply` gets the answer and the number of the call it answers. */
  run: (apply: (value: T, seq: number) => void, fail?: (error: unknown) => void, started?: (seq: number) => void) => Promise<void>;
  busy: boolean;
} {
  const sent = useRef(0);
  const applied = useRef(0);
  const inFlight = useRef(0);
  const [busy, setBusy] = useState(false);
  const latestCall = useRef(call);
  latestCall.current = call;
  const run = useCallback(async (apply: (value: T, seq: number) => void, fail?: (error: unknown) => void, started?: (seq: number) => void) => {
    const seq = ++sent.current;
    started?.(seq);
    inFlight.current += 1;
    setBusy(true);
    try {
      const value = await latestCall.current();
      if (seq < applied.current) return;
      applied.current = seq;
      apply(value, seq);
    } catch (error) {
      if (seq >= applied.current) fail?.(error);
    } finally {
      inFlight.current -= 1;
      if (inFlight.current === 0) setBusy(false);
    }
  }, []);
  return { run, busy };
}

interface QueueState {
  shown: QueueCard[] | null;
  held: QueueCard[];
  latest: QueueCard[];
  stay: Stay | null;
  error: string | null;
  loadedAt: number | null;
}

/**
 * The page's cards: the first load and every change of tab show everything,
 * later loads keep the owner's place on the tab they read.
 */
export function useQueueData(rpc: Rpc, selected: string | null, view: PageView): QueueData {
  const [state, setState] = useState<QueueState>({ shown: null, held: [], latest: [], stay: null, error: null, loadedAt: null });
  const where = useRef({ selected, view });
  where.current = { selected, view };
  const { run, busy } = useLatestCall(useCallback(() => rpc.call("queue", {}), [rpc]));
  // Threads the owner just acted on, with the number of the call made after
  // the action: the first answer at least that new applies the action, even
  // when it answers another call.
  const acted = useRef(new Map<string, number>());

  const fetchCards = useCallback(
    (mode: "merge" | "all" | { one: string }) =>
      run(
        ({ items }, seq) => {
          const ones = [...acted.current].filter(([, after]) => after <= seq).map(([threadId]) => threadId);
          for (const threadId of ones) acted.current.delete(threadId);
          setState((prev) => {
            const base = { latest: items, error: null, loadedAt: Date.now() };
            // Nothing on screen to keep in place: take everything.
            if (prev.shown === null || mode === "all" || !prev.shown.some((card) => card.view !== null)) {
              return { ...base, shown: items, held: [], stay: null };
            }
            // The owner's own action on a row: it takes its new state, and leaves the tab if that is where it goes.
            let shown = prev.shown;
            let stay = prev.stay;
            for (const threadId of ones) {
              shown = applyOne(shown, items, threadId);
              if (stay?.threadId === threadId) stay = null;
            }
            return { ...base, ...mergeIncoming(shown, items, { ...where.current, stay }) };
          });
        },
        (error) => setState((prev) => ({ ...prev, error: message(error, "the plugin server did not respond") })),
        typeof mode === "object" ? (seq) => acted.current.set(mode.one, seq) : undefined,
      ),
    [run],
  );

  const reload = useCallback(() => fetchCards("merge"), [fetchCards]);
  const soon = useSoon(reload);
  useEffect(() => {
    void fetchCards("all");
  }, [fetchCards]);
  // A startup pass announces hundreds of cards: one reload per burst.
  const connection = useReloadOn("card", soon);
  const wasConnected = useRef(false);
  if (connection === "connected") wasConnected.current = true;

  // Another tab is another list: it shows what is there now.
  const shownView = useRef(view);
  useEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    setState((prev) => (prev.shown === null ? prev : { ...prev, shown: prev.latest, held: [], stay: null }));
  }, [view]);
  // Moving on from a selected row that left the tab lets it go.
  useEffect(() => {
    setState((prev) => (prev.stay === null || prev.stay.threadId === selected ? prev : { ...prev, stay: null }));
  }, [selected]);

  const applyHeld = useCallback(() => {
    setState((prev) => ({ ...prev, shown: prev.latest, held: [] }));
  }, []);
  const refreshOne = useCallback((threadId: string) => fetchCards({ one: threadId }), [fetchCards]);

  return {
    shown: state.shown,
    latest: state.latest,
    held: state.held,
    stay: state.stay,
    error: state.error,
    loadedAt: state.loadedAt,
    offline: connection !== "connected" && wasConnected.current,
    loading: busy,
    reload,
    applyHeld,
    refreshOne,
  };
}

const PREFS_KEY = "thread-card:needs-you:v1";

function readPrefs(): Prefs {
  try {
    return parsePrefs(window.localStorage.getItem(PREFS_KEY));
  } catch {
    return { filters: DEFAULT_FILTERS, collapsed: [] };
  }
}

/** Filters, order and collapsed groups, kept on this device. */
export function usePrefs(): [Prefs, (update: (prefs: Prefs) => Prefs) => void] {
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  const update = useCallback((change: (prefs: Prefs) => Prefs) => {
    setPrefs((prev) => {
      const next = change(prev);
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // Private mode or a full store: the choice lasts until the page closes.
      }
      return next;
    });
  }, []);
  return [prefs, update];
}

/** bb's compact viewport (its drawer layout) starts below 768 px. */
const COMPACT_QUERY = "(max-width: 767px)";

export function useCompact(): boolean {
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(COMPACT_QUERY);
    const onChange = () => setCompact(query.matches);
    query.addEventListener("change", onChange);
    onChange();
    return () => query.removeEventListener("change", onChange);
  }, []);
  return compact;
}

/** The clock for relative times, once a minute. */
export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

export const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
