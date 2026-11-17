import { createContext, type PointerEvent } from "react";
import type { ArtifactType, Side, PaneId, WidgetId, WindowState } from "@kumiko/shared";
import type { PaneRect } from "./widgets";

/** One of the window's artifacts, as an artifact pane's switcher lists it. */
export interface ArtifactEntry {
  widget: WidgetId;
  type: ArtifactType;
  title: string;
  path: string;
  /** The pane showing it, if one is. */
  pane?: PaneId;
  /** It changed since it was last shown, while it wasn't. */
  unread: boolean;
  /** When it changed last, as the seq of the event that changed it. */
  at: number;
}

/** What the widgets of a session's window can do with it; given by `Window`. */
export interface WindowApi {
  window: WindowState;
  /** The artifacts, by title. */
  artifacts: ArtifactEntry[];
  /** Shows a widget in a pane, swapping with the pane that shows it now, if any. */
  showIn(widget: WidgetId, pane: PaneId): void;
  /** Shows a widget in a new pane split off `pane`, right of it or below it. */
  showBeside(widget: WidgetId, pane: PaneId, split: "right" | "below"): void;
  /** The session is live, so its window can be changed. */
  live: boolean;
  /** Its tab is the one on screen. */
  active: boolean;
  /** Shows a hidden widget again, beside the chat. */
  show(widget: WidgetId): void;
  close(pane: PaneId): void;
  /** Takes a widget out of the window for good. */
  remove(widget: WidgetId): void;
  /** Allows or denies an external site Claude opened. */
  approve(widget: WidgetId, allow: boolean): void;
  /** Quotes text into the chat's message. */
  quote(text: string): void;
  /** The panes can be rearranged now: there is more than one, the session is live, and they aren't stacked. */
  arrange: boolean;
  /** Starts dragging a pane by its handle. */
  startDrag(pane: PaneId, e: PointerEvent): void;
  /** Where each pane is, as fractions of the window. */
  rects: ReadonlyMap<PaneId, PaneRect>;
  /** Moves a pane beside another (or the window, WINDOW), or swaps the two. */
  move(pane: PaneId, to: PaneId, side: Side | "swap"): void;
  /** The open sessions' names as their tabs show them, by id, for the chat to name a session Claude names by its id. */
  sessionNames: ReadonlyMap<string, string>;
  /** The session's id. */
  session: string;
  /** Shows the review pane for deliver card `ask` beside the chat, or closes it if it shows that card; `open` only shows it. */
  review(ask: string, open?: boolean): void;
}

export const WindowContext = createContext<WindowApi | undefined>(undefined);
