// Controls in bb's look, from the host-shimmed primitives (Radix, vaul,
// clsx, tailwind-merge; none of them is bundled). The class recipes follow
// bb's registry (button, input, dropdown-menu, drawer); on a narrow screen
// targets grow to 44 px and menus and panels open as bottom sheets, as bb's
// own do.
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { clsx, type ClassValue } from "clsx";
import { cloneElement, useState, type ReactElement, type ReactNode } from "react";
import { twMerge } from "tailwind-merge";
import { Drawer } from "vaul";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

declare const __BB_PLUGIN_ID__: string | undefined;

/** What bb puts on a plugin's portaled overlay, so its styles, focus and dismissal treat it as the plugin's. */
export function portalScope(): Record<string, string> {
  const pluginId = typeof __BB_PLUGIN_ID__ === "string" ? __BB_PLUGIN_ID__ : undefined;
  return { "data-bb-portaled-overlay": "", "data-bb-plugin-root": "", ...(pluginId !== undefined ? { "data-bb-plugin": pluginId } : {}) };
}

const CONTROL =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0";

export function button(variant: "primary" | "outline" | "ghost" = "outline", size: "sm" | "icon" = "sm"): string {
  return cn(
    CONTROL,
    size === "sm" ? "h-8 px-3 text-xs max-md:h-11 max-md:px-4 max-md:text-sm" : "size-8 p-0 max-md:size-11",
    variant === "primary" && "bg-foreground text-background hover:bg-foreground/90",
    variant === "outline" && "border border-input bg-transparent hover:bg-state-hover hover:text-foreground data-[state=open]:bg-state-active",
    variant === "ghost" && "text-muted-foreground hover:bg-state-hover hover:text-foreground data-[state=open]:bg-state-active",
  );
}

export const FIELD =
  "h-8 min-w-0 rounded-md border border-input bg-transparent px-2 text-sm text-foreground transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:h-11 max-md:text-base";

const MENU_CONTENT =
  "z-50 min-w-44 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0";
const MENU_ITEM =
  "relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors focus:bg-state-hover focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50";
const SHEET_ITEM =
  "flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-base outline-none transition-colors focus-visible:bg-state-hover active:bg-state-active disabled:opacity-50";

export interface MenuItem {
  label: string;
  /** One line under the label: what the action does. */
  description?: string;
  icon?: string;
  destructive?: boolean;
  onSelect: () => void;
}

function Sheet({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode }) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay {...portalScope()} className="fixed inset-0 z-50 bg-black/40" />
        <Drawer.Content
          {...portalScope()}
          className="fixed inset-x-0 bottom-0 z-50 mt-24 flex max-h-[85dvh] flex-col rounded-t-xl border bg-background text-foreground"
        >
          <Drawer.Handle className="mx-auto mt-3 mb-1 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/20" />
          <Drawer.Title className="px-4 pt-2 pb-1 text-sm font-medium text-muted-foreground">{title}</Drawer.Title>
          {/* Children keep their height; the sheet scrolls instead of squeezing them. */}
          <div className="flex flex-col gap-1 overflow-y-auto p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] [&>*]:shrink-0">{children}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

/** A menu of actions: a dropdown, or a bottom sheet on a narrow screen. */
function MenuText({ item }: { item: MenuItem }) {
  if (!item.description) return <>{item.label}</>;
  return (
    <span className="flex min-w-0 flex-col py-0.5">
      <span>{item.label}</span>
      <span className="max-w-64 text-xs text-muted-foreground">{item.description}</span>
    </span>
  );
}

export function Menu({ label, items, compact, triggerClassName, children }: { label: string; items: readonly MenuItem[]; compact: boolean; triggerClassName?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (compact) {
    return (
      <>
        <button type="button" aria-label={label} title={label} aria-haspopup="dialog" className={triggerClassName} onClick={() => setOpen(true)}>
          {children}
        </button>
        <Sheet open={open} onOpenChange={setOpen} title={label}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              className={cn(SHEET_ITEM, item.destructive && "text-destructive")}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon ? <Icon name={item.icon} aria-hidden className="size-5 shrink-0" /> : null}
              <MenuText item={item} />
            </button>
          ))}
        </Sheet>
      </>
    );
  }
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger aria-label={label} title={label} className={triggerClassName}>
        {children}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content {...portalScope()} align="end" sideOffset={4} collisionPadding={8} className={MENU_CONTENT}>
          {items.map((item) => (
            <DropdownMenu.Item key={item.label} className={cn(MENU_ITEM, item.destructive && "text-destructive focus:text-destructive")} onSelect={item.onSelect}>
              {item.icon ? <Icon name={item.icon} aria-hidden className={cn("size-4 shrink-0", item.description && "self-start mt-0.5")} /> : null}
              <MenuText item={item} />
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** A small panel beside its trigger, or a bottom sheet on a narrow screen. */
export function Panel({
  open,
  onOpenChange,
  title,
  compact,
  trigger,
  children,
  align = "start",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  compact: boolean;
  /** A button; the panel opens from it. */
  trigger: ReactElement<{ onClick?: () => void }>;
  children: ReactNode;
  align?: "start" | "end";
}) {
  if (compact) {
    return (
      <>
        {cloneElement(trigger, { onClick: () => onOpenChange(true) })}
        <Sheet open={open} onOpenChange={onOpenChange} title={title}>
          <div className="flex flex-col gap-3 p-2 [&>*]:shrink-0">{children}</div>
        </Sheet>
      </>
    );
  }
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...portalScope()}
          align={align}
          sideOffset={6}
          collisionPadding={12}
          aria-label={title}
          className="z-50 flex w-80 max-w-[calc(100vw-24px)] flex-col gap-3 rounded-md border bg-popover p-3 text-popover-foreground shadow-md outline-none"
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export const SHEET_OPTION = SHEET_ITEM;
