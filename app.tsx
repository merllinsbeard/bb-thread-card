// bb-plugin-thread-card — frontend.
//
// Where the plugin shows who makes the next step in a thread:
//   - an icon on its sidebar row (ui/rows.ts): a request to the owner always,
//     a stop or a wait over bb's unread dot, done only where bb shows nothing;
//   - the Needs-you page (ui/page.tsx): requests to the owner, waits and
//     stopped work, grouped project → section → thread, with the selected
//     thread's conversation in the page's right panel (bb's ThreadChat); the
//     number of open requests sits beside its navigation item;
//   - the card behind the button in the thread header (ui/card.tsx);
//   - "By status" in the sidebar's Sort menu, on a bb that offers plugin
//     orders to its thread list (ui/rows.ts).
// ⌥⌘R reads the current thread again. Command callbacks run outside React,
// so an app overlay with no UI hands them the RPC client; the same overlay
// keeps the row icons in step with the server.
import { useEffect } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.ts";
import { CardPopover, cardRpc, refreshCard, setCardRpc } from "./ui/card.tsx";
import { CHAT_TAB, ChatTab, NeedsYouCount, NeedsYouPage, PANEL_PATH } from "./ui/page.tsx";
import { RowIcons, mountRowStatus, registerStatusSort } from "./ui/rows.ts";

function AppOverlay() {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => {
    setCardRpc(rpc);
    return () => {
      if (cardRpc() === rpc) setCardRpc(null);
    };
  }, [rpc]);
  return <RowIcons />;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "rpc-bridge", component: AppOverlay });
  // "By status" in the thread list's Sort menu, where bb offers plugin orders.
  registerStatusSort(app);

  app.contentScripts.register({
    id: "row-status",
    mount: (context) => mountRowStatus(context.experimental_setThreadRowStatus ?? null),
  });

  app.slots.navPanel({
    id: CHAT_TAB.panelId,
    title: "Needs you",
    icon: "CircleQuestion",
    path: PANEL_PATH,
    component: NeedsYouPage,
    experimental_sidebarAccessory: NeedsYouCount,
    fixedTabs: [{ ...CHAT_TAB, title: "Chat", icon: "MessageSquare", component: ChatTab, layout: "flush" }],
  });

  app.slots.experimental_threadHeaderAction({
    id: "thread-card",
    title: "Thread card",
    component: CardPopover,
  });

  app.commands.register({
    id: "refresh-card",
    title: "Thread card: read this thread again",
    defaultShortcut: { key: "r", mod: true, alt: true },
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId }) => {
      if (threadId !== null) void refreshCard(cardRpc(), threadId);
    },
  });
});
