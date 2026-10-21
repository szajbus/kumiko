import { useContext, useRef, useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { CHAT, type ArtifactState, type Side, type SlotId } from "@kumiko/shared";
import { stepTowards } from "./widgets";
import { WindowContext, type WindowApi } from "./windowContext";

/** How far the pointer may go between pressing the handle and letting go for it to be a click, not a drag. */
const CLICK_PX = 4;

const STEPS: [Side, string][] = [
  ["left", "Move left"],
  ["right", "Move right"],
  ["above", "Move up"],
  ["below", "Move down"],
];

/**
 * The handle a pane is dragged by to another place in the window; only there while the panes can be rearranged. A
 * click on it, or Enter, opens a menu that does the same from the keyboard: a step in each direction, or a swap.
 */
export function PaneGrip({ slot, floating = false }: { slot: SlotId; floating?: boolean }) {
  const ctx = useContext(WindowContext);
  const [open, setOpen] = useState(false);
  const pressed = useRef<{ x: number; y: number } | undefined>(undefined);
  if (!ctx?.arrange) return null;
  const others = Object.keys(ctx.window.slots).filter((s) => s !== slot && ctx.rects.has(s));
  return (
    <Menu.Root modal={false} open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        className={`pane-grip${floating ? " is-floating" : ""}`}
        title="Drag to move this pane, or click for a menu"
        aria-label="Move this pane"
        // A press starts a drag, rather than opening the menu as a trigger would; letting go where it was is a click.
        onPointerDown={(e) => {
          pressed.current = { x: e.clientX, y: e.clientY };
          ctx.startDrag(slot, e);
        }}
        onClick={(e) => {
          const p = pressed.current;
          pressed.current = undefined;
          // From the keyboard, there was no press.
          if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) <= CLICK_PX) setOpen(true);
        }}
      >
        <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">
          {[2, 7, 12].flatMap((y) => [3, 7].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2" fill="currentColor" />))}
        </svg>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu" align="start" sideOffset={6} collisionPadding={8} aria-label="Move this pane">
          {STEPS.map(([side, label]) => {
            const step = stepTowards(ctx.rects, slot, side);
            return (
              <Menu.Item key={side} className="menu-item" disabled={!step} onSelect={() => step && ctx.move(slot, step.to, step.side)}>
                {label}
              </Menu.Item>
            );
          })}
          {others.length > 0 && <Menu.Separator className="menu-separator" />}
          {others.map((other) => (
            <Menu.Item key={other} className="menu-item" onSelect={() => ctx.move(slot, other, "swap")}>
              Swap with {paneName(ctx, other)}
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** A pane as the menu names it: the chat, or the title of what it shows. */
function paneName(ctx: WindowApi, slot: SlotId): string {
  if (slot === CHAT) return "the chat";
  const w = ctx.window.widgets[ctx.window.slots[slot]];
  return w?.kind === "artifact" ? `“${(w.state as ArtifactState).title}”` : `pane ${slot}`;
}
