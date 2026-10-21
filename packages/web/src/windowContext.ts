import { createContext, type PointerEvent } from "react";
import type { ArtifactType, SlotId, WidgetId, WindowState } from "@kumiko/shared";

/** What the widgets of a session's window can do with it; given by `Window`. */
/** One of the window's artifacts, as an artifact pane's switcher lists it. */
export interface ArtifactEntry {
  widget: WidgetId;
  type: ArtifactType;
  title: string;
  path: string;
  /** The slot showing it, if one is. */
  slot?: SlotId;
  /** It changed since it was last shown, while it wasn't. */
  unread: boolean;
}

export interface WindowApi {
  window: WindowState;
  /** The artifacts, by title. */
  artifacts: ArtifactEntry[];
  /** Shows a widget in a slot, swapping with the slot that shows it now, if any. */
  showIn(widget: WidgetId, slot: SlotId): void;
  /** Shows a widget in a new slot split off `slot`, right of it or below it. */
  showBeside(widget: WidgetId, slot: SlotId, split: "right" | "below"): void;
  /** The session is live, so its window can be changed. */
  live: boolean;
  /** Shows a hidden widget again, beside the chat. */
  show(widget: WidgetId): void;
  close(slot: SlotId): void;
  /** Takes a widget out of the window for good. */
  remove(widget: WidgetId): void;
  /** Allows or denies an external site Claude opened. */
  approve(widget: WidgetId, allow: boolean): void;
  /** Quotes text into the chat's message. */
  quote(text: string): void;
  /** The panes can be rearranged now: there is more than one, the session is live, and they aren't stacked. */
  arrange: boolean;
  /** Starts dragging a slot's pane by its handle. */
  startDrag(slot: SlotId, e: PointerEvent): void;
}

export const WindowContext = createContext<WindowApi | undefined>(undefined);
