// A session's window: a layout of panes, as in tmux, each showing one widget.
// Pure functions only, shared by the server, which changes windows, and the UI, which shows them.

import type { SessionEvent } from "./index.js";

export type PaneId = string;
export type WidgetId = string;

/** A binary tree of splits whose leaves are panes. In a split, `a` is left or above, and gets `ratio` of the room. */
export type Layout =
  | { kind: "pane"; id: PaneId }
  | { kind: "split"; dir: "row" | "column"; ratio: number; a: Layout; b: Layout };

export interface Widget {
  /** Which kind of widget: "chat", for now the only one. */
  kind: string;
  state?: unknown;
}

export interface WindowState {
  layout: Layout;
  /** The widget each pane shows. */
  panes: Record<PaneId, WidgetId>;
  /** Every widget in the window, shown or not: closing a pane hides its widget, which can be shown again. */
  widgets: Record<WidgetId, Widget>;
  /** The pane something was last put into, by a split or a show: where the next widget of its kind goes by default. */
  active?: PaneId;
  /** For a widget shown in place of another (by `show`), the one it replaced: what its pane goes back to without it. */
  under?: Record<WidgetId, WidgetId>;
}

/** The chat's pane and widget, which every window has and none can close. */
export const CHAT = "chat";

/** How many panes a window can have. Enough for a large screen; a window too narrow for its panes stacks them. */
export const MAX_PANES = 16;
/** The smallest and largest share of a split that a new pane can ask for. */
export const MIN_SIZE = 0.2;
export const MAX_SIZE = 0.8;

/** A side of a pane: where a new pane goes beside it. */
export type Side = "left" | "right" | "above" | "below";

/** Where a new pane goes: on a side of pane `of` (the chat's by default), taking `size` of its room (half by default). */
export interface Place {
  split: Side;
  of?: PaneId;
  size?: number;
}

/** A change to a window that doesn't fit it, with a reason that can be shown to whoever asked for it. */
export class WindowError extends Error {}

/** A window with only the chat in it: every window, until something is opened beside the chat. */
export function chatWindow(): WindowState {
  return { layout: { kind: "pane", id: CHAT }, panes: { [CHAT]: CHAT }, widgets: { [CHAT]: { kind: "chat" } } };
}

/** The layout's panes, left to right and top to bottom. */
export function paneIds(layout: Layout): PaneId[] {
  return layout.kind === "pane" ? [layout.id] : [...paneIds(layout.a), ...paneIds(layout.b)];
}

/** The pane showing `widget`, if one is. */
export function paneOf(w: WindowState, widget: WidgetId): PaneId | undefined {
  return Object.keys(w.panes).find((s) => w.panes[s] === widget);
}

/** An id with `prefix` that the window doesn't use yet for a pane or a widget: `p2`, `p3`, … */
export function nextId(w: WindowState, prefix: string): string {
  const taken = new Set([...Object.keys(w.panes), ...Object.keys(w.widgets)]);
  let n = 2;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** Adds a widget to the window without showing it. */
export function addWidget(w: WindowState, id: WidgetId, widget: Widget): WindowState {
  if (w.widgets[id]) throw new WindowError(`There is a widget ${id} already.`);
  return { ...w, widgets: { ...w.widgets, [id]: widget } };
}

/** Splits pane `place.of` and shows `widget`, which isn't shown yet, in the new pane `pane`. */
export function split(w: WindowState, place: Place, pane: PaneId, widget: WidgetId): WindowState {
  const of = place.of ?? CHAT;
  if (!w.widgets[widget]) throw new WindowError(`There is no widget ${widget}.`);
  if (paneOf(w, widget)) throw new WindowError(`Widget ${widget} is shown already, in pane ${paneOf(w, widget)}.`);
  if (w.panes[pane] || w.widgets[pane]) throw new WindowError(`The id ${pane} is taken.`);
  if (!w.panes[of]) throw new WindowError(`There is no pane ${of}. Panes: ${paneIds(w.layout).join(", ")}.`);
  if (paneIds(w.layout).length >= MAX_PANES) throw new WindowError(`A window has at most ${MAX_PANES} panes. Close one first.`);
  const size = place.size ?? 0.5;
  if (!(size >= MIN_SIZE && size <= MAX_SIZE)) throw new WindowError(`A new pane's size is between ${MIN_SIZE} and ${MAX_SIZE}.`);
  const layout = replacePane(w.layout, of, (l) => beside(l, { kind: "pane", id: pane }, place.split, size));
  return { ...w, layout, panes: { ...w.panes, [pane]: widget }, active: pane };
}

/** A split of `target`'s room with `added` on `side` of it, taking `size` of the room. */
function beside(target: Layout, added: Layout, side: Side, size: number): Layout {
  const dir = side === "left" || side === "right" ? "row" : "column";
  return side === "left" || side === "above" ? { kind: "split", dir, ratio: size, a: added, b: target } : { kind: "split", dir, ratio: 1 - size, a: target, b: added };
}

/** The layout with pane `id`'s leaf replaced by what `by` makes of it. */
function replacePane(l: Layout, id: PaneId, by: (leaf: Layout) => Layout): Layout {
  if (l.kind === "pane") return l.id === id ? by(l) : l;
  return { ...l, a: replacePane(l.a, id, by), b: replacePane(l.b, id, by) };
}

/** The layout without pane `id`'s leaf: the split it was in gives its room to the other side. */
function withoutPane(l: Layout, id: PaneId): Layout {
  if (l.kind === "pane") return l;
  if (l.a.kind === "pane" && l.a.id === id) return l.b;
  if (l.b.kind === "pane" && l.b.id === id) return l.a;
  return { ...l, a: withoutPane(l.a, id), b: withoutPane(l.b, id) };
}

/** The window as a whole, as where `move` takes a pane: to one of its sides, spanning its whole width or height. */
export const WINDOW = "window";

/** The share of the window a pane moved to its edge takes: as much as each pane would, shared evenly. */
export const edgeShare = (panes: number) => Math.min(0.5, Math.max(MIN_SIZE, 1 / panes));

/**
 * Moves pane `pane`, with what it shows, to a side of pane `to`, which it splits in halves; its old place goes to the
 * pane beside it. `"swap"` trades the two panes' places instead. With `to` WINDOW, it goes to a side of the window,
 * along the whole of it, taking `edgeShare` of it. The chat moves like any other pane.
 */
export function move(w: WindowState, pane: PaneId, to: PaneId, side: Side | "swap"): WindowState {
  for (const s of to === WINDOW ? [pane] : [pane, to]) if (!w.panes[s]) throw new WindowError(`There is no pane ${s}. Panes: ${paneIds(w.layout).join(", ")}.`);
  if (to === WINDOW) {
    if (side === "swap") throw new WindowError("A pane goes to a side of the window, not in its place.");
    // One of the window's two sides already, along the same way: the two change sides, keeping their sizes.
    const flipped = flipSides(w.layout, pane, side);
    if (flipped) return flipped === w.layout ? w : { ...w, layout: flipped };
    const rest = withoutPane(w.layout, pane);
    if (rest === w.layout) return w;
    return { ...w, layout: beside(rest, { kind: "pane", id: pane }, side, edgeShare(paneIds(w.layout).length)) };
  }
  if (pane === to) return w;
  // The two sides of one split, alone in it: they change places, each keeping its size.
  const pair = siblings(w.layout, pane, to);
  if (pair && (side === "swap" || (pair.dir === "row") === (side === "left" || side === "right"))) {
    const flipped = side === "swap" ? { ...pair, a: pair.b, b: pair.a, ratio: 1 - pair.ratio } : flipSides(pair, pane, side)!;
    return { ...w, layout: replaceSplit(w.layout, pair, flipped) };
  }
  if (side === "swap") {
    const swap = (l: Layout): Layout =>
      l.kind === "pane" ? (l.id === pane ? { kind: "pane", id: to } : l.id === to ? { kind: "pane", id: pane } : l) : { ...l, a: swap(l.a), b: swap(l.b) };
    return { ...w, layout: swap(w.layout) };
  }
  const layout = replacePane(withoutPane(w.layout, pane), to, (l) => beside(l, { kind: "pane", id: pane }, side, 0.5));
  return { ...w, layout };
}

type Split = Extract<Layout, { kind: "split" }>;

/** The split whose two sides are the panes `x` and `y`, if there is one. */
function siblings(l: Layout, x: PaneId, y: PaneId): Split | undefined {
  if (l.kind === "pane") return undefined;
  const is = (side: Layout, id: PaneId) => side.kind === "pane" && side.id === id;
  if ((is(l.a, x) && is(l.b, y)) || (is(l.a, y) && is(l.b, x))) return l;
  return siblings(l.a, x, y) ?? siblings(l.b, x, y);
}

/** `l` with the split `old` (by identity) replaced by `by`. */
function replaceSplit(l: Layout, old: Split, by: Layout): Layout {
  if (l === old) return by;
  if (l.kind === "pane") return l;
  return { ...l, a: replaceSplit(l.a, old, by), b: replaceSplit(l.b, old, by) };
}

/**
 * Split `l` with pane `pane` on `side` of it, keeping the share `pane` has, if `pane` is one of its two sides and it
 * splits the way `side` goes; undefined if not. `l` itself when `pane` is on that side already.
 */
function flipSides(l: Layout, pane: PaneId, side: Side): Layout | undefined {
  if (l.kind !== "split" || (l.dir === "row") !== (side === "left" || side === "right")) return undefined;
  const isPane = (x: Layout) => x.kind === "pane" && x.id === pane;
  if (!isPane(l.a) && !isPane(l.b)) return undefined;
  const first = side === "left" || side === "above";
  if (isPane(first ? l.a : l.b)) return l;
  const share = isPane(l.a) ? l.ratio : 1 - l.ratio;
  const other = isPane(l.a) ? l.b : l.a;
  const leaf: Layout = { kind: "pane", id: pane };
  return first ? { ...l, a: leaf, b: other, ratio: share } : { ...l, a: other, b: leaf, ratio: 1 - share };
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
 * Shows `widget` in pane `pane` in place of what it showed, which stays in the window. A widget shown in another pane
 * already swaps places with it, so a widget is never in two panes. The chat stays where it is.
 */
export function show(w: WindowState, pane: PaneId, widget: WidgetId): WindowState {
  if (!w.panes[pane]) throw new WindowError(`There is no pane ${pane}. Panes: ${paneIds(w.layout).join(", ")}.`);
  if (!w.widgets[widget]) throw new WindowError(`There is no widget ${widget}.`);
  if (pane === CHAT || widget === CHAT) throw new WindowError("The chat stays in its own pane.");
  const was = w.panes[pane];
  if (was === widget) return w.active === pane ? w : { ...w, active: pane };
  const other = paneOf(w, widget);
  // Swapped, each is under nothing new: both are still shown.
  const under = other ? w.under : { ...w.under, [widget]: was };
  return { ...w, panes: { ...w.panes, [pane]: widget, ...(other ? { [other]: was } : {}) }, active: pane, ...(under ? { under } : {}) };
}

/** Takes a widget out of the window for good; the pane showing it, if one does, closes. The chat stays. */
export function remove(w: WindowState, widget: WidgetId): WindowState {
  if (widget === CHAT) throw new WindowError("The chat stays in the window.");
  if (!w.widgets[widget]) throw new WindowError(`There is no widget ${widget}.`);
  const pane = paneOf(w, widget);
  const closed = pane ? close(w, pane) : w;
  const { [widget]: _removed, ...widgets } = closed.widgets;
  const under = Object.fromEntries(Object.entries(closed.under ?? {}).filter(([on, below]) => on !== widget && below !== widget));
  const { under: _under, ...rest } = closed;
  return { ...rest, widgets, ...(Object.keys(under).length ? { under } : {}) };
}

/** Closes a pane: the split it was in gives its room to the other side. Its widget stays in the window. */
export function close(w: WindowState, pane: PaneId): WindowState {
  if (pane === CHAT) throw new WindowError("The chat's pane can't be closed.");
  if (!w.panes[pane]) throw new WindowError(`There is no pane ${pane}. Panes: ${paneIds(w.layout).join(", ")}.`);
  const { [pane]: _closed, ...panes } = w.panes;
  const { active: _active, ...rest } = w;
  return { ...(w.active === pane ? rest : w), layout: withoutPane(w.layout, pane), panes };
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

/** The URL parser every place this runs has, Node and browsers alike; this package names no environment's types. */
interface ParsedUrl {
  protocol: string;
  hostname: string;
  origin: string;
}
declare const URL: { new (url: string): ParsedUrl; canParse(url: string): boolean };

/**
 * An http(s) URL parsed as a browser parses it, or undefined for anything else. Parsed, not matched by pattern: a
 * browser reads `https://evil.example\@good.example/` as evil.example, and so must whatever approves what it loads.
 */
function httpUrl(url: string): ParsedUrl | undefined {
  if (!URL.canParse(url)) return undefined;
  const u = new URL(url);
  return u.protocol === "http:" || u.protocol === "https:" ? u : undefined;
}

/** The host of an http(s) URL, lowercased, with an IPv6 address's brackets; undefined for anything else. */
export function urlHost(url: string): string | undefined {
  return httpUrl(url)?.hostname;
}

/** The origin of an http(s) URL (scheme, host and port, unless it's the scheme's own), lowercased; undefined for anything else. */
export function urlOrigin(url: string): string | undefined {
  return httpUrl(url)?.origin;
}

/**
 * Whether `host` (a name, or an IP address as in a URL) is on this machine or a private network: loopback, private and
 * shared ranges, link-local, and names that only mean something locally. An external site may not reach these; DNS
 * names that resolve to them are checked where they are resolved.
 */
export function isPrivateHost(host: string): boolean {
  const h = hostOf(host);
  if (h === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h) || !h.includes(".") && !h.includes(":")) return true;
  const v4 = ipv4Of(h);
  if (v4) {
    const [a, b] = v4;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  // Unique local (fc00::/7), link-local (fe80::/10) and the old site-local (fec0::/10).
  if (h.includes(":")) return h === "::" || h === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89a-f][0-9a-f]?:/.test(h);
  return false;
}

/** Whether `host` is this machine itself: localhost, or a loopback address. */
export function isLoopbackHost(host: string): boolean {
  const h = hostOf(host);
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || ipv4Of(h)?.[0] === 127;
}

/**
 * Whether a page in a pane may load from `host`: a website only from the web at large, a preview from this machine's
 * pages too, which it shows, but neither from a private network, which the sandbox can't reach.
 */
export function paneMayReach(pane: "preview" | "site", host: string): boolean {
  return !isPrivateHost(host) || (pane === "preview" && isLoopbackHost(host));
}

/** A host as written in a URL or a DNS answer, lowercased, without brackets or a final dot. */
const hostOf = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

/**
 * The first two parts of the IPv4 address `h` is, or has in it: in IPv6, as an IPv4-mapped address (::ffff:7f00:1,
 * as URLs write ::ffff:127.0.0.1) or a NAT64 one (64:ff9b::7f00:1), which reaches the IPv4 address it names.
 */
function ipv4Of(h: string): [number, number] | undefined {
  const prefix = "(?:::(?:ffff:)?|64:ff9b::)";
  const hex = new RegExp(`^${prefix}([0-9a-f]{1,4}):([0-9a-f]{1,4})$`).exec(h);
  if (hex) return [parseInt(hex[1], 16) >> 8, parseInt(hex[1], 16) & 255];
  const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h.replace(new RegExp(`^${prefix}`), ""));
  return dotted ? [Number(dotted[1]), Number(dotted[2])] : undefined;
}

/** Whether `url` is an external site an artifact may show: http(s), not on this machine or a private network. */
export function isExternalUrl(url: string): boolean {
  const host = urlHost(url);
  return host !== undefined && !/\s/.test(url) && !isPrivateHost(host);
}

/**
 * What becomes of a page in a pane going to `target`, by navigating or opening a window: a preview stays on this
 * machine's pages, a website on external sites. Anywhere else isn't opened, as a page's script can ask for it without
 * a click, and the user's browser would load it with their logins, on their network: the user is asked, for a web or
 * mail link, and anything else is dropped.
 */
export function paneNavigation(pane: "preview" | "site", target: string): "stay" | "ask" | "drop" {
  if (pane === "preview" ? isPreviewUrl(target) : isExternalUrl(target)) return "stay";
  return /^(https?|mailto):/i.test(target) ? "ask" : "drop";
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
 * - `sync`: the layout and panes, when given, the active pane (null for none), the widgets listed, as they are now,
 *   and the widgets `removed`. What a turn's ops come down to.
 */
export type WindowOp =
  | { type: "add"; widget: WidgetId; kind: string; state?: unknown }
  | { type: "split"; place: Place; pane: PaneId; widget: WidgetId }
  | { type: "close"; pane: PaneId }
  | { type: "show"; pane: PaneId; widget: WidgetId }
  | { type: "move"; pane: PaneId; to: PaneId; side: Side | "swap" }
  | { type: "resize"; path: SplitPath; ratio: number }
  | { type: "remove"; widget: WidgetId }
  | { type: "update"; widget: WidgetId; op: unknown }
  | { type: "sync"; layout?: Layout; panes?: Record<PaneId, WidgetId>; active?: PaneId | null; under?: Record<WidgetId, WidgetId>; widgets?: Record<WidgetId, Widget>; removed?: WidgetId[] };

/** The window after `op`; throws WindowError if it doesn't fit. */
/** The ops that name a pane. */
const PANE_OPS: readonly WindowOp["type"][] = ["split", "show", "move", "close"];

export function applyWindowOp(w: WindowState, op: WindowOp): WindowState {
  // An op that names a pane names it by its id; one saved in another shape doesn't, and doesn't fit.
  if (PANE_OPS.includes(op.type)) {
    const pane = (op as { pane?: unknown }).pane;
    if (typeof pane !== "string" || !pane) throw new WindowError("Which pane?");
  }
  switch (op.type) {
    case "add":
      if (!WIDGET_KINDS[op.kind]) throw new WindowError(`There is no kind of widget ${op.kind}.`);
      return addWidget(w, op.widget, op.state === undefined ? { kind: op.kind } : { kind: op.kind, state: op.state });
    case "split":
      return split(w, op.place, op.pane, op.widget);
    case "close":
      return close(w, op.pane);
    case "show":
      return show(w, op.pane, op.widget);
    case "move":
      return move(w, op.pane, op.to, op.side);
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
      const widgets = { ...w.widgets, ...op.widgets };
      for (const id of op.removed ?? []) delete widgets[id];
      const under = op.under ?? w.under;
      // A layout that doesn't hold together (one saved in another shape) is left out; the widgets still come.
      const panes = op.panes ?? w.panes;
      const fits = !op.layout || wellFormed(op.layout, panes);
      const active = !fits || op.active === undefined ? w.active : (op.active ?? undefined);
      return {
        layout: fits ? (op.layout ?? w.layout) : w.layout,
        panes: fits ? panes : w.panes,
        widgets,
        ...(active ? { active } : {}),
        ...(under && Object.keys(under).length ? { under } : {}),
      };
    }
  }
}

/** Whether `l` is a layout of panes that `panes` all name, each once, with the chat among them. */
function wellFormed(l: unknown, panes: Record<PaneId, WidgetId>): boolean {
  const seen: PaneId[] = [];
  const walk = (x: unknown): boolean => {
    if (!x || typeof x !== "object") return false;
    const n = x as { kind?: unknown; id?: unknown; dir?: unknown; ratio?: unknown; a?: unknown; b?: unknown };
    if (n.kind === "pane") return typeof n.id === "string" && n.id in panes && (seen.push(n.id), true);
    return n.kind === "split" && (n.dir === "row" || n.dir === "column") && typeof n.ratio === "number" && walk(n.a) && walk(n.b);
  };
  return walk(l) && seen.includes(CHAT) && new Set(seen).size === seen.length && seen.length === Object.keys(panes).length;
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
  const layoutChanged = !same(before.layout, after.layout) || !same(before.panes, after.panes);
  const widgets = Object.fromEntries(Object.entries(after.widgets).filter(([id, widget]) => !same(before.widgets[id], widget)));
  const activeChanged = before.active !== after.active;
  const underChanged = !same(before.under ?? {}, after.under ?? {});
  const removed = Object.keys(before.widgets).filter((id) => !after.widgets[id]);
  if (!layoutChanged && !activeChanged && !underChanged && !Object.keys(widgets).length && !removed.length) return undefined;
  return {
    type: "sync",
    ...(layoutChanged ? { layout: after.layout, panes: after.panes } : {}),
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
