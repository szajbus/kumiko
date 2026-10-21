import { useContext } from "react";
import type { SlotId } from "@kumiko/shared";
import { WindowContext } from "./windowContext";

/** The handle a pane is dragged by to another place in the window; only there while the panes can be rearranged. */
export function PaneGrip({ slot, floating = false }: { slot: SlotId; floating?: boolean }) {
  const ctx = useContext(WindowContext);
  if (!ctx?.arrange) return null;
  return (
    <span
      className={`pane-grip${floating ? " is-floating" : ""}`}
      title="Drag to move this pane"
      aria-label="Move this pane"
      role="button"
      onPointerDown={(e) => ctx.startDrag(slot, e)}
    >
      <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">
        {[2, 7, 12].flatMap((y) => [3, 7].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2" fill="currentColor" />))}
      </svg>
    </span>
  );
}
