// A session's window: a layout of slots, as in tmux, each showing one widget.
// Pure functions only, shared by the server, which changes windows, and the UI, which shows them.

import type { SessionEvent } from "./index.js";

export type SlotId = string;
export type WidgetId = string;

/** A binary tree of splits whose leaves are slots. In a split, `a` is left or above, and gets `ratio` of the room. */
export type Layout =
  | { kind: "slot"; id: SlotId }
  | { kind: "split"; dir: "row" | "column"; ratio: number; a: Layout; b: Layout };

export interface Widget {
  /** Which kind of widget: "chat", for now the only one. */
  kind: string;
  state?: unknown;
}

export interface WindowState {
  layout: Layout;
  /** The widget each slot shows. */
  slots: Record<SlotId, WidgetId>;
  /** Every widget in the window, shown or not: closing a slot hides its widget, which can be shown again. */
  widgets: Record<WidgetId, Widget>;
  /** The slot something was last put into, by a split or a show: where the next widget of its kind goes by default. */
  active?: SlotId;
  /** For a widget shown in place of another (by `show`), the one it replaced: what its slot goes back to without it. */
  under?: Record<WidgetId, WidgetId>;
}

/** The chat's slot and widget, which every window has and none can close. */
export const CHAT = "chat";

export const MAX_SLOTS = 4;
/** The smallest and largest share of a split that a new slot can ask for. */
export const MIN_SIZE = 0.2;
export const MAX_SIZE = 0.8;

/** A side of a slot: where a new slot goes beside it. */
export type Side = "left" | "right" | "above" | "below";

/** Where a new slot goes: on a side of slot `of` (the chat's by default), taking `size` of its room (half by default). */
export interface Place {
  split: Side;
  of?: SlotId;
  size?: number;
}

/** A change to a window that doesn't fit it, with a reason that can be shown to whoever asked for it. */
export class WindowError extends Error {}

/** A window with only the chat in it: every window, until something is opened beside the chat. */
export function chatWindow(): WindowState {
  return { layout: { kind: "slot", id: CHAT }, slots: { [CHAT]: CHAT }, widgets: { [CHAT]: { kind: "chat" } } };
}

/** The layout's slots, left to right and top to bottom. */
export function slotIds(layout: Layout): SlotId[] {
  return layout.kind === "slot" ? [layout.id] : [...slotIds(layout.a), ...slotIds(layout.b)];
}

/** The slot showing `widget`, if one is. */
export function slotOf(w: WindowState, widget: WidgetId): SlotId | undefined {
  return Object.keys(w.slots).find((s) => w.slots[s] === widget);
}

/** An id with `prefix` that the window doesn't use yet for a slot or a widget: `s2`, `s3`, … */
export function nextId(w: WindowState, prefix: string): string {
  const taken = new Set([...Object.keys(w.slots), ...Object.keys(w.widgets)]);
  let n = 2;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** Adds a widget to the window without showing it. */
export function addWidget(w: WindowState, id: WidgetId, widget: Widget): WindowState {
  if (w.widgets[id]) throw new WindowError(`There is a widget ${id} already.`);
  return { ...w, widgets: { ...w.widgets, [id]: widget } };
}

/** Splits slot `place.of` and shows `widget`, which isn't shown yet, in the new slot `slot`. */
export function split(w: WindowState, place: Place, slot: SlotId, widget: WidgetId): WindowState {
  const of = place.of ?? CHAT;
  if (!w.widgets[widget]) throw new WindowError(`There is no widget ${widget}.`);
  if (slotOf(w, widget)) throw new WindowError(`Widget ${widget} is shown already, in slot ${slotOf(w, widget)}.`);
  if (w.slots[slot] || w.widgets[slot]) throw new WindowError(`The id ${slot} is taken.`);
  if (!w.slots[of]) throw new WindowError(`There is no slot ${of}. Slots: ${slotIds(w.layout).join(", ")}.`);
  if (slotIds(w.layout).length >= MAX_SLOTS) throw new WindowError(`A window has at most ${MAX_SLOTS} slots. Close one first.`);
  const size = place.size ?? 0.5;
  if (!(size >= MIN_SIZE && size <= MAX_SIZE)) throw new WindowError(`A new slot's size is between ${MIN_SIZE} and ${MAX_SIZE}.`);
  const layout = replaceSlot(w.layout, of, (l) => beside(l, { kind: "slot", id: slot }, place.split, size));
  return { ...w, layout, slots: { ...w.slots, [slot]: widget }, active: slot };
}

/** A split of `target`'s room with `added` on `side` of it, taking `size` of the room. */
function beside(target: Layout, added: Layout, side: Side, size: number): Layout {
  const dir = side === "left" || side === "right" ? "row" : "column";
  return side === "left" || side === "above" ? { kind: "split", dir, ratio: size, a: added, b: target } : { kind: "split", dir, ratio: 1 - size, a: target, b: added };
}

/** The layout with slot `id`'s leaf replaced by what `by` makes of it. */
function replaceSlot(l: Layout, id: SlotId, by: (leaf: Layout) => Layout): Layout {
  if (l.kind === "slot") return l.id === id ? by(l) : l;
  return { ...l, a: replaceSlot(l.a, id, by), b: replaceSlot(l.b, id, by) };
}

/** The layout without slot `id`'s leaf: the split it was in gives its room to the other side. */
function withoutSlot(l: Layout, id: SlotId): Layout {
  if (l.kind === "slot") return l;
  if (l.a.kind === "slot" && l.a.id === id) return l.b;
  if (l.b.kind === "slot" && l.b.id === id) return l.a;
  return { ...l, a: withoutSlot(l.a, id), b: withoutSlot(l.b, id) };
}

/** The window as a whole, as where `move` takes a slot: to one of its sides, spanning its whole width or height. */
export const WINDOW = "window";

/** The share of the window a slot moved to its edge takes: as much as each slot would, shared evenly. */
export const edgeShare = (slots: number) => Math.min(0.5, Math.max(MIN_SIZE, 1 / slots));

/**
 * Moves slot `slot`, with what it shows, to a side of slot `to`, which it splits in halves; its old place goes to the
 * slot beside it. `"swap"` trades the two slots' places instead. With `to` WINDOW, it goes to a side of the window,
 * along the whole of it, taking `edgeShare` of it. The chat moves like any other slot.
 */
export function move(w: WindowState, slot: SlotId, to: SlotId, side: Side | "swap"): WindowState {
  for (const s of to === WINDOW ? [slot] : [slot, to]) if (!w.slots[s]) throw new WindowError(`There is no slot ${s}. Slots: ${slotIds(w.layout).join(", ")}.`);
  if (to === WINDOW) {
    if (side === "swap") throw new WindowError("A slot goes to a side of the window, not in its place.");
    const rest = withoutSlot(w.layout, slot);
    if (rest === w.layout) return w;
    return { ...w, layout: beside(rest, { kind: "slot", id: slot }, side, edgeShare(slotIds(w.layout).length)) };
  }
  if (slot === to) return w;
  if (side === "swap") {
    const swap = (l: Layout): Layout =>
      l.kind === "slot" ? (l.id === slot ? { kind: "slot", id: to } : l.id === to ? { kind: "slot", id: slot } : l) : { ...l, a: swap(l.a), b: swap(l.b) };
    return { ...w, layout: swap(w.layout) };
  }
  const layout = replaceSlot(withoutSlot(w.layout, slot), to, (l) => beside(l, { kind: "slot", id: slot }, side, 0.5));
  return { ...w, layout };
}

/** Where a split is in a layout: the sides taken from the root to reach it, "" for the root. */
export type SplitPath = string;

/** The smallest share of a split either side can be dragged down to. */
export const MIN_RATIO = 0.1;

/** Sets the share of the room the first side of the split at `path` takes. */
export function resize(w: WindowState, path: SplitPath, ratio: number): WindowState {
  if (!/^[ab]*$/.test(path)) throw new WindowError(`Not a split's path: ${path}.`);
  if (!(ratio >= MIN_RATIO && ratio <= 1 - MIN_RATIO)) throw new WindowError(`A split's ratio is between ${MIN_RATIO} and ${1 - MIN_RATIO}.`);
  const at = (l: Layout, rest: string): Layout => {
    if (l.kind !== "split") throw new WindowError(`There is no split at ${path || "the root"}.`);
    if (!rest) return { ...l, ratio };
    return rest[0] === "a" ? { ...l, a: at(l.a, rest.slice(1)) } : { ...l, b: at(l.b, rest.slice(1)) };
  };
  return { ...w, layout: at(w.layout, path) };
}

/**
 * Shows `widget` in slot `slot` in place of what it showed, which stays in the window. A widget shown in another slot
 * already swaps places with it, so a widget is never in two slots. The chat stays where it is.
 */
export function show(w: WindowState, slot: SlotId, widget: WidgetId): WindowState {
  if (!w.slots[slot]) throw new WindowError(`There is no slot ${slot}. Slots: ${slotIds(w.layout).join(", ")}.`);
  if (!w.widgets[widget]) throw new WindowError(`There is no widget ${widget}.`);
  if (slot === CHAT || widget === CHAT) throw new WindowError("The chat stays in its own slot.");
  const was = w.slots[slot];
  if (was === widget) return w.active === slot ? w : { ...w, active: slot };
  const other = slotOf(w, widget);
  // Swapped, each is under nothing new: both are still shown.
  const under = other ? w.under : { ...w.under, [widget]: was };
  return { ...w, slots: { ...w.slots, [slot]: widget, ...(other ? { [other]: was } : {}) }, active: slot, ...(under ? { under } : {}) };
}

/** Takes a widget out of the window for good; the slot showing it, if one does, closes. The chat stays. */
export function remove(w: WindowState, widget: WidgetId): WindowState {
  if (widget === CHAT) throw new WindowError("The chat stays in the window.");
  if (!w.widgets[widget]) throw new WindowError(`There is no widget ${widget}.`);
  const slot = slotOf(w, widget);
  const closed = slot ? close(w, slot) : w;
  const { [widget]: _removed, ...widgets } = closed.widgets;
  const under = Object.fromEntries(Object.entries(closed.under ?? {}).filter(([on, below]) => on !== widget && below !== widget));
  const { under: _under, ...rest } = closed;
  return { ...rest, widgets, ...(Object.keys(under).length ? { under } : {}) };
}

/** Closes a slot: the split it was in gives its room to the other side. Its widget stays in the window. */
export function close(w: WindowState, slot: SlotId): WindowState {
  if (slot === CHAT) throw new WindowError("The chat's slot can't be closed.");
  if (!w.slots[slot]) throw new WindowError(`There is no slot ${slot}. Slots: ${slotIds(w.layout).join(", ")}.`);
  const { [slot]: _closed, ...slots } = w.slots;
  const { active: _active, ...rest } = w;
  return { ...(w.active === slot ? rest : w), layout: withoutSlot(w.layout, slot), slots };
}

/** What a kind of widget does with the ops sent to it. Kinds without `apply` take none: the chat, for now. */
export interface WidgetKind {
  apply?(state: unknown, op: unknown): unknown;
}

/** What kind of file an artifact is, which decides how it is shown. */
export type ArtifactType = "markdown" | "svg" | "mermaid" | "image" | "html" | "preview" | "web";

/** The types of artifact by file extension; images by their media type. */
const ARTIFACT_EXTENSIONS: Record<string, ArtifactType> = { md: "markdown", markdown: "markdown", svg: "svg", mmd: "mermaid", mermaid: "mermaid", html: "html", htm: "html" };
export const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** The type of artifact a file is, by its extension; undefined for one Kumiko can't show. */
export function artifactTypeOf(path: string): ArtifactType | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() ?? "";
  return ARTIFACT_EXTENSIONS[ext] ?? (IMAGE_TYPES[ext] ? "image" : undefined);
}

/** The file extensions artifacts can have, for saying which are shown. */
export const ARTIFACT_FILES = [...Object.keys(ARTIFACT_EXTENSIONS), ...Object.keys(IMAGE_TYPES)].map((e) => `.${e}`);

/**
 * Whether `url` is one a preview may show: a page served on this machine over http(s), such as a dev server's, which
 * Lima forwards from the sandbox. Only those, so a preview can't be pointed at the web at large.
 */
export function isPreviewUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?([/?#][^\s]*)?$/i.test(url);
}

/** The host of an http(s) URL, lowercased, with an IPv6 address's brackets; undefined for anything else. */
export function urlHost(url: string): string | undefined {
  return /^https?:\/\/(?:[^/?#@]*@)?(\[[0-9a-f:.]+\]|[^/?#:]+)/i.exec(url)?.[1].toLowerCase();
}

/** The origin of an http(s) URL (scheme, host and port), lowercased; undefined for anything else. */
export function urlOrigin(url: string): string | undefined {
  return /^(https?:\/\/(?:[^/?#@]*@)?(?:\[[0-9a-f:.]+\]|[^/?#:]+)(?::\d+)?)/i.exec(url)?.[1].replace(/\/\/[^/?#@]*@/, "//").toLowerCase();
}

/**
 * Whether `host` (a name, or an IP address as in a URL) is on this machine or a private network: loopback, private and
 * shared ranges, link-local, and names that only mean something locally. An external site may not reach these; DNS
 * names that resolve to them are checked where they are resolved.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h) || !h.includes(".") && !h.includes(":")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h.replace(/^::ffff:/, ""));
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (h.includes(":")) return h === "::" || h === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
  return false;
}

/** Whether `url` is an external site an artifact may show: http(s), not on this machine or a private network. */
export function isExternalUrl(url: string): boolean {
  const host = urlHost(url);
  return host !== undefined && !/\s/.test(url) && !isPrivateHost(host);
}

/** An image artifact's media type, by its file's extension. */
export const imageTypeOf = (path: string): string => IMAGE_TYPES[/\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() ?? ""] ?? "application/octet-stream";

/** An artifact widget: a file Claude makes for the user to look at, as Kumiko last read it. */
export interface ArtifactState {
  /** Where the file is in the VM, absolute; for a preview, the URL it shows. */
  path: string;
  type: ArtifactType;
  title: string;
  /**
   * What is shown of the file, named by its SHA-256: its first MAX_ARTIFACT_BYTES, or an image whole if under
   * MAX_IMAGE_BYTES. The server keeps it and serves it to the window, so the window's events stay small. Unset for a
   * page, or a file never read.
   */
  content?: string;
  /** Sessions saved before the content was kept apart have it here: the text, or an image's bytes in base64. */
  text?: string;
  /** The file is longer than what is shown. */
  truncated?: boolean;
  /** The file wasn't there when it was last read. */
  missing?: boolean;
  /** An external site (`web`) loads only once the user has allowed it. */
  approved?: boolean;
}

/** What changed in an artifact: its content as read again, or its title. */
export type ArtifactOp = Partial<Pick<ArtifactState, "title" | "content" | "text" | "truncated" | "missing" | "approved">>;

/** How much of an artifact's file a window keeps and shows. A safety limit, not one on what Claude writes. */
export const MAX_ARTIFACT_BYTES = 256 * 1024;
/** The largest image artifact a window keeps and shows; a larger one isn't shown at all. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Every kind of widget a window can show. */
export const WIDGET_KINDS: Record<string, WidgetKind> = {
  chat: {},
  artifact: {
    apply: (state, op) => ({ ...(state as ArtifactState), ...(op as ArtifactOp) }),
  },
};

/** The window's artifact widgets, by id. */
export function artifactsOf(w: WindowState): [WidgetId, ArtifactState][] {
  return Object.entries(w.widgets).flatMap(([id, x]) => (x.kind === "artifact" ? [[id, x.state as ArtifactState] as [WidgetId, ArtifactState]] : []));
}

/**
 * One change to a window, as a session's `window` event records it.
 * - `add`: a widget, not shown yet. `split`, `show`, `move`, `resize`, `close`, `remove`: see the functions of those names.
 * - `update`: an op for one widget, which its kind applies.
 * - `sync`: the layout and slots, when given, the active slot (null for none), the widgets listed, as they are now,
 *   and the widgets `removed`. What a turn's ops come down to.
 */
export type WindowOp =
  | { type: "add"; widget: WidgetId; kind: string; state?: unknown }
  | { type: "split"; place: Place; slot: SlotId; widget: WidgetId }
  | { type: "close"; slot: SlotId }
  | { type: "show"; slot: SlotId; widget: WidgetId }
  | { type: "move"; slot: SlotId; to: SlotId; side: Side | "swap" }
  | { type: "resize"; path: SplitPath; ratio: number }
  | { type: "remove"; widget: WidgetId }
  | { type: "update"; widget: WidgetId; op: unknown }
  | { type: "sync"; layout?: Layout; slots?: Record<SlotId, WidgetId>; active?: SlotId | null; under?: Record<WidgetId, WidgetId>; widgets?: Record<WidgetId, Widget>; removed?: WidgetId[] };

/** The window after `op`; throws WindowError if it doesn't fit. */
export function applyWindowOp(w: WindowState, op: WindowOp): WindowState {
  switch (op.type) {
    case "add":
      if (!WIDGET_KINDS[op.kind]) throw new WindowError(`There is no kind of widget ${op.kind}.`);
      return addWidget(w, op.widget, op.state === undefined ? { kind: op.kind } : { kind: op.kind, state: op.state });
    case "split":
      return split(w, op.place, op.slot, op.widget);
    case "close":
      return close(w, op.slot);
    case "show":
      return show(w, op.slot, op.widget);
    case "move":
      return move(w, op.slot, op.to, op.side);
    case "resize":
      return resize(w, op.path, op.ratio);
    case "remove":
      return remove(w, op.widget);
    case "update": {
      const widget = w.widgets[op.widget];
      if (!widget) throw new WindowError(`There is no widget ${op.widget}.`);
      const apply = WIDGET_KINDS[widget.kind]?.apply;
      if (!apply) throw new WindowError(`A ${widget.kind} widget takes no changes.`);
      return { ...w, widgets: { ...w.widgets, [op.widget]: { ...widget, state: apply(widget.state, op.op) } } };
    }
    case "sync": {
      const active = op.active === undefined ? w.active : (op.active ?? undefined);
      const widgets = { ...w.widgets, ...op.widgets };
      for (const id of op.removed ?? []) delete widgets[id];
      const under = op.under ?? w.under;
      return {
        layout: op.layout ?? w.layout,
        slots: op.slots ?? w.slots,
        widgets,
        ...(active ? { active } : {}),
        ...(under && Object.keys(under).length ? { under } : {}),
      };
    }
  }
}

type WindowEvent = Extract<SessionEvent, { kind: "window" }>;

/** `op` applied to `w`, or `w` as it was if `op` doesn't fit: a log replayed from disk shouldn't break the window. */
function applyOrKeep(w: WindowState, op: WindowOp): WindowState {
  try {
    return applyWindowOp(w, op);
  } catch {
    return w;
  }
}

/** The window as a session's events leave it, from the chat alone. */
export function windowState(events: readonly SessionEvent[], from: WindowState = chatWindow()): WindowState {
  let w = from;
  for (const e of events) if (e.kind === "window") w = applyOrKeep(w, e.payload.op);
  return w;
}

/** A `sync` op that takes `before` to `after`, or undefined if they don't differ. */
function syncOp(before: WindowState, after: WindowState): WindowOp | undefined {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const layoutChanged = !same(before.layout, after.layout) || !same(before.slots, after.slots);
  const widgets = Object.fromEntries(Object.entries(after.widgets).filter(([id, widget]) => !same(before.widgets[id], widget)));
  const activeChanged = before.active !== after.active;
  const underChanged = !same(before.under ?? {}, after.under ?? {});
  const removed = Object.keys(before.widgets).filter((id) => !after.widgets[id]);
  if (!layoutChanged && !activeChanged && !underChanged && !Object.keys(widgets).length && !removed.length) return undefined;
  return {
    type: "sync",
    ...(layoutChanged ? { layout: after.layout, slots: after.slots } : {}),
    ...(activeChanged ? { active: after.active ?? null } : {}),
    ...(underChanged ? { under: after.under ?? {} } : {}),
    ...(Object.keys(widgets).length ? { widgets } : {}),
    ...(removed.length ? { removed } : {}),
  };
}

/**
 * The events with the window ops between each two prompts brought down to one `sync`, in the place (and with the
 * `seq`) of the last of them, so a long session keeps one state per turn rather than every change. Cut only at
 * prompts, which is where a rewind or a fork cuts, so either still finds the window as it was there. A tab that
 * replays from a `seq` within a run of ops still ends up right: the `sync` comes last and has all of the run's changes.
 */
export function compactWindow<E extends SessionEvent>(events: readonly E[]): E[] {
  const out: (E | undefined)[] = [];
  let w = chatWindow();
  /** The window before the run of ops since the last prompt, and where those ops are in `out`. */
  let run: { start: WindowState; at: number[] } | undefined;
  const flush = () => {
    if (!run || run.at.length < 2) return void (run = undefined);
    const last = run.at[run.at.length - 1];
    const sync = syncOp(run.start, w);
    for (const i of run.at) out[i] = undefined;
    if (sync) out[last] = { ...(events[last] as E & WindowEvent), payload: { op: sync } };
    run = undefined;
  };
  events.forEach((e, i) => {
    if (e.kind === "user_prompt") flush();
    out.push(e);
    if (e.kind !== "window") return;
    run ??= { start: w, at: [] };
    run.at.push(i);
    w = applyOrKeep(w, e.payload.op);
  });
  flush();
  return out.filter((e): e is E => e !== undefined);
}
