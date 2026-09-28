// The card behind the button in the thread header: the status and why,
// where the thread shows on the Needs-you page, the topic, what is done and
// where it stopped, and the title controls. ⌥⌘R reads the thread again.
import * as Popover from "@radix-ui/react-popover";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { experimental_Icon as Icon, useRealtime, useRpc, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import { VIEW_TITLES } from "../lib/queue.ts";
import { describeUntil } from "../lib/time.ts";
import { portalScope } from "./kit.tsx";
import { message, type Rpc } from "./live.ts";

type CardView = {
  status: {
    state: string;
    reason: string;
    since: number;
    source: string;
    view: string | null;
    execution: string | null;
    freshness: string;
  } | null;
  topic: string | null;
  report: { state: string; done: string; stoppedAt: string; at: number; by: string } | null;
  skipped: string | null;
  policy: "auto" | "owner-words" | "off";
  lockReason: string | null;
  automatic: boolean;
  running: boolean;
  canRevert: boolean;
  lastError: string | null;
  disposition: { kind: "snoozed" | "dismissed"; untilAt: number | null; tz: string | null } | null;
};

const BUTTON_LABEL = "Thread card (⌥⌘R rechecks it)";

const STATUS_LABELS: Record<string, string> = {
  running: "⏳ Working",
  question: "❓ Needs you",
  waiting: "⛔ Waiting on others",
  done: "✅ Done",
  unknown: "Status unknown",
};
/** Known facts name a stop better than the state: an open question still leads. */
const EXECUTION_HEADLINES: Record<string, string> = {
  failed: "⛔ Run failed",
  stoppedByOwner: "Stopped by you",
  interrupted: "⛔ Interrupted",
  sendFailed: "⛔ Message failed to send",
};

function headline(status: NonNullable<CardView["status"]>): string {
  if (status.view === "needs") return STATUS_LABELS.question!;
  if (status.execution !== null && EXECUTION_HEADLINES[status.execution]) return EXECUTION_HEADLINES[status.execution]!;
  if (status.freshness === "unavailable") return "Status unavailable";
  return STATUS_LABELS[status.state] ?? status.state;
}

/** Where the thread shows on the Needs-you page, or null when it is not there. */
function placement(view: CardView): string | null {
  if (view.disposition?.kind === "dismissed") return "Hidden from the queue";
  if (view.disposition?.kind === "snoozed" && view.disposition.untilAt !== null) return `Queue: Snoozed until ${describeUntil(view.disposition.untilAt, view.disposition.tz)}`;
  const tab = view.status?.view;
  return tab && tab in VIEW_TITLES ? `Queue: ${VIEW_TITLES[tab as keyof typeof VIEW_TITLES]}` : null;
}

/** "Working" under "⏳ Working" says nothing new. */
const sameWords = (a: string, b: string) => a.replace(/[^\p{L}\p{N} ]/gu, "").trim().toLowerCase() === b.replace(/[^\p{L}\p{N} ]/gu, "").trim().toLowerCase();

const when = (at: number) => new Date(at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const SOURCE_LABELS: Record<string, string> = { agent: "the agent's report", bb: "bb", helper: "the helper", none: "no report yet" };
const EXECUTION_LABELS: Record<string, string> = {
  active: "the agent is working",
  queued: "a message waits to be sent",
  failed: "the turn failed",
  stoppedByOwner: "stopped by you",
  interrupted: "the work broke off",
  sendFailed: "a message did not send",
};

const POLICY_NOTES: Record<string, string> = {
  manual: "you renamed the thread",
  "legacy-set-title": "its title was set before the plugin",
  "title given at creation": "its title was given when it was created",
  reverted: "you restored the earlier title",
};

let rpcClient: Rpc | null = null;
/** The card's RPC client for the ⌥⌘R command, which runs outside React. */
export const setCardRpc = (rpc: Rpc | null) => {
  rpcClient = rpc;
};
export const cardRpc = () => rpcClient;

/** Read the thread with the helper again and say what happened. */
export async function refreshCard(rpc: Rpc | null, threadId: string): Promise<void> {
  if (rpc === null) {
    toast.error("Thread card is still loading. Try again in a moment.");
    return;
  }
  const id = toast.loading("Rechecking the card…");
  try {
    const result = await rpc.call("refresh", { threadId });
    if (result.status === "failed" || result.status === "skipped") {
      toast.error(result.reason ?? "The card was not updated.", { id });
    } else {
      toast.success(result.title ? `Card updated: "${result.title}"` : "Card updated.", { id });
    }
  } catch (error) {
    toast.error(message(error, "Could not update the card."), { id });
  }
}

const buttonClass =
  "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

export function CardPopover({ threadId }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<CardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await rpc.call("getCard", { threadId }));
      setError(null);
    } catch (loadError) {
      setError(message(loadError, "Could not load the card."));
    }
  }, [rpc, threadId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // The subscription may keep its first handler, so it reads current values through a ref.
  const latest = useRef({ open, load, threadId });
  latest.current = { open, load, threadId };
  useRealtime("card", (payload) => {
    const current = latest.current;
    if (current.open && (payload as { threadId?: string } | null)?.threadId === current.threadId) void current.load();
  });

  const act = async (name: string, run: () => Promise<void>) => {
    setBusy(name);
    try {
      await run();
    } catch (actError) {
      toast.error(message(actError, "That did not work."));
    } finally {
      setBusy(null);
      void load();
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={BUTTON_LABEL}
          title={BUTTON_LABEL}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Icon name="FileText" aria-hidden className="size-4" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...portalScope()}
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 w-96 max-w-[calc(100vw-24px)] rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none"
        >
          {error !== null ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : view === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="flex flex-col gap-3">
              {view.skipped !== null ? (
                <p className="text-xs text-muted-foreground">The plugin does not handle this thread: {view.skipped}.</p>
              ) : (
                <div>
                  <div className="text-sm font-medium">
                    {view.status ? headline(view.status) : "No status yet"}
                  </div>
                  {view.status ? (
                    <>
                      {sameWords(view.status.reason, headline(view.status)) ? null : <p className="mt-1 text-sm">{view.status.reason}</p>}
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Since {when(view.status.since)}, from {SOURCE_LABELS[view.status.source] ?? view.status.source}
                        {view.status.execution ? ` · ${EXECUTION_LABELS[view.status.execution] ?? view.status.execution}` : ""}
                        {view.status.freshness === "checking" ? " · being checked" : view.status.freshness === "unavailable" ? " · could not be read" : ""}
                        {view.running ? " · reading the thread now…" : ""}
                      </p>
                      {placement(view) !== null ? <p className="mt-0.5 text-xs text-muted-foreground">{placement(view)}</p> : null}
                    </>
                  ) : null}
                </div>
              )}

              {view.topic || view.report ? (
                <div className="flex flex-col gap-1.5 text-sm">
                  {view.topic ? (
                    <p>
                      <span className="text-muted-foreground">Topic: </span>
                      {view.topic}
                    </p>
                  ) : null}
                  {view.report ? (
                    <>
                      {view.report.done && view.report.done !== view.status?.reason ? (
                        <p>
                          <span className="text-muted-foreground">Done: </span>
                          {view.report.done}
                        </p>
                      ) : null}
                      {view.report.stoppedAt ? (
                        <p>
                          <span className="text-muted-foreground">Stopped at: </span>
                          {view.report.stoppedAt}
                        </p>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        {view.report.by === "agent" ? "The agent reported" : "The helper read the thread"}{" "}
                        {when(view.report.at)}
                      </p>
                    </>
                  ) : null}
                </div>
              ) : null}

              <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                {view.policy === "off" ? (
                  <p>
                    <Icon name="Lock" aria-hidden className="mr-1 inline size-3" />
                    The title is locked: the plugin does not touch it. The status still updates.
                  </p>
                ) : view.policy === "owner-words" ? (
                  <p>
                    The title keeps your words because {POLICY_NOTES[view.lockReason ?? ""] ?? view.lockReason ?? "you set it"}. The
                    status still updates.
                  </p>
                ) : null}
                {!view.automatic && view.skipped === null ? (
                  <p>Automatic titles and helper checks are off: the card changes only when you press Recheck card. Status tracking stays on.</p>
                ) : null}
                {view.lastError ? <p className="text-destructive">Last helper run failed: {view.lastError}</p> : null}
              </div>

              {view.skipped === null ? (
                <div className="flex flex-col gap-2 border-t pt-3">
                  <Control
                    label="Recheck card"
                    note="The helper rereads this thread and updates its card. An unlocked title may change too."
                    icon="RotateCcw"
                    spinning={busy === "refresh"}
                    disabled={busy !== null || view.running}
                    onClick={() => void act("refresh", () => refreshCard(rpc, threadId))}
                  />
                  {view.policy !== "auto" ? (
                    <Control
                      label="Use topic as title"
                      note="Renames this thread to its topic now and keeps the title following the topic."
                      disabled={busy !== null}
                      onClick={() =>
                        void act("unlock", async () => {
                          await rpc.call("unlock", { threadId });
                          toast.success("The title now follows the topic.");
                        })
                      }
                    />
                  ) : null}
                  {view.policy !== "off" ? (
                    <Control
                      label="Keep current title"
                      note="The plugin stops renaming this thread. The status keeps updating."
                      icon="Lock"
                      disabled={busy !== null}
                      onClick={() =>
                        void act("lock", async () => {
                          await rpc.call("lock", { threadId });
                          toast.success("Title kept as it is.");
                        })
                      }
                    />
                  ) : null}
                  {view.canRevert ? (
                    <Control
                      label="Restore original title"
                      note="Puts back the title from before the plugin renamed this thread."
                      disabled={busy !== null}
                      onClick={() =>
                        void act("revert", async () => {
                          const reverted = await rpc.call("revert", { threadId });
                          toast.success(reverted.title ? `Restored "${reverted.title}"` : "Restored the empty title");
                        })
                      }
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A card button with what it does written under it. */
function Control({
  label,
  note,
  icon,
  spinning = false,
  disabled,
  onClick,
}: {
  label: string;
  note: string;
  icon?: string;
  spinning?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <button type="button" className={`${buttonClass} shrink-0 whitespace-nowrap`} disabled={disabled} onClick={onClick}>
        {icon ? <Icon name={icon} aria-hidden className={spinning ? "size-3.5 animate-spin" : "size-3.5"} /> : null}
        {label}
      </button>
      <p className="pt-1 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}
