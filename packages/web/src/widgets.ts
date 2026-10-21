import { artifactsOf, type Layout, type SessionEvent, type Side, type SlotId, type SplitPath, type WidgetId, type WindowState } from "@kumiko/shared";

/**
 * The string value of `key` in JSON that may still be streaming in, as far as it has got: `complete` once its closing
 * quote has come. Undefined until the value has started. An escape cut in half at the end is left for the next delta.
 */
export function partialJsonString(json: string, key: string): { value: string; complete: boolean } | undefined {
  const start = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
  if (!start) return undefined;
  let i = start.index + start[0].length;
  let raw = "";
  for (; i < json.length; i++) {
    const c = json[i];
    if (c === "\\") {
      raw += json.slice(i, i + 2);
      i++;
    } else if (c === '"') {
      return { value: decode(raw), complete: true };
    } else raw += c;
  }
  // Cut short: drop a lone backslash or a \u escape missing digits.
  return { value: decode(raw.replace(/\\(u[0-9a-fA-F]{0,3})?$/, "")), complete: false };
}

function decode(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/**
 * Files Claude is writing with its Write tool in the turn under way, by path: the text as far as it has streamed, and
 * the `seq` its tool call started at. Only once the path is complete, so a half-streamed path can't match an artifact.
 */
export function streamingWrites(events: readonly SessionEvent[]): Map<string, { text: string; seq: number }> {
  const from = events.findLastIndex((e) => e.kind === "claude" && e.payload.type === "result") + 1;
  const blocks = new Map<string, { json: string; seq: number }>();
  for (let i = from; i < events.length; i++) {
    const e = events[i];
    if (e.kind !== "claude" || e.payload.type !== "stream_event") continue;
    const ev = e.payload.event as { type?: string; index?: number; content_block?: { type?: string; name?: string }; delta?: { type?: string; partial_json?: string } } | undefined;
    const key = `${String(e.payload.api_message_id)}:${ev?.index}`;
    if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use" && ev.content_block.name === "Write") blocks.set(key, { json: "", seq: e.seq });
    else if (ev?.type === "content_block_delta" && ev.delta?.type === "input_json_delta" && blocks.has(key)) blocks.get(key)!.json += ev.delta.partial_json ?? "";
  }
  const writes = new Map<string, { text: string; seq: number }>();
  for (const { json, seq } of blocks.values()) {
    const path = partialJsonString(json, "file_path");
    const content = partialJsonString(json, "content");
    if (path?.complete && content) writes.set(normalize(path.value), { text: content.value, seq });
  }
  return writes;
}

/** The `seq` of the last event that changed each widget's state. */
export function lastChanges(events: readonly SessionEvent[]): Map<WidgetId, number> {
  const at = new Map<WidgetId, number>();
  for (const e of events) {
    if (e.kind !== "window") continue;
    const { op } = e.payload;
    if (op.type === "update" || op.type === "add") at.set(op.widget, e.seq);
    if (op.type === "sync") for (const id of Object.keys(op.widgets ?? {})) at.set(id, e.seq);
  }
  return at;
}

/** A path with `.` and `..` and repeated slashes resolved, as the server keeps artifacts' paths. */
export function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `${path.startsWith("/") ? "/" : ""}${out.join("/")}`;
}

/** Where a slot is in its window, as fractions of the window's width and height. */
export interface SlotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where each slot of a layout goes. Slots are laid out side by side as siblings rather than nested, so a split doesn't
 * move the chat in the page and it stays mounted. With `stack`, every split puts its sides one above the other.
 */
export function slotRects(layout: Layout, stack = false, at: SlotRect = { x: 0, y: 0, w: 1, h: 1 }): Map<SlotId, SlotRect> {
  if (layout.kind === "slot") return new Map([[layout.id, at]]);
  const row = layout.dir === "row" && !stack;
  const a = row ? { ...at, w: at.w * layout.ratio } : { ...at, h: at.h * layout.ratio };
  const b = row ? { ...at, x: at.x + a.w, w: at.w - a.w } : { ...at, y: at.y + a.h, h: at.h - a.h };
  return new Map([...slotRects(layout.a, stack, a), ...slotRects(layout.b, stack, b)]);
}

/** How many slots the layout puts side by side, at most. */
export function columns(l: Layout): number {
  if (l.kind === "slot") return 1;
  return l.dir === "row" ? columns(l.a) + columns(l.b) : Math.max(columns(l.a), columns(l.b));
}

/** A tool call that has to do with the window, as the chat sums it up: what was done, to which artifact. */
export interface WidgetLine {
  label: string;
  title?: string;
  widget?: WidgetId;
}

const TOOL_PREFIX = "mcp__kumiko__";

/** The chat's line for a tool call that opened, changed or closed something in the window; undefined for any other. */
export function widgetLine(name: string, input: Record<string, unknown>, w: WindowState): WidgetLine | undefined {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  // An artifact is named by its path (a file's, or a page's URL), or by its id in the window.
  const ref = str(input.path) ?? str(input.file_path) ?? str(input.url) ?? str(input.artifact);
  const docs = artifactsOf(w);
  const byPath = (p: string) => {
    const n = normalize(p);
    return docs.find(([, d]) => d.path === p || d.path === n) ?? docs.find(([, d]) => d.path.endsWith(`/${n.replace(/^\//, "")}`));
  };
  const doc = ref ? (w.widgets[ref]?.kind === "artifact" ? docs.find(([id]) => id === ref) : byPath(ref)) : undefined;
  // One that is gone from the window (deleted, say) goes by its file's name, or its page's address.
  const named = ref && !w.widgets[ref] ? (/^https?:\/\//.test(ref) ? ref.replace(/^https?:\/\//, "") : ref.split("/").pop()) : undefined;
  const of = doc ? { title: doc[1].title, widget: doc[0] } : { title: named };
  const page = doc ? doc[1].type === "preview" || doc[1].type === "web" : Boolean(ref && /^https?:\/\//.test(ref));
  switch (name) {
    case `${TOOL_PREFIX}artifact_open`:
      return { label: "Opened", ...of };
    case `${TOOL_PREFIX}artifact_capture`:
      return ref ? { label: input.reload === true ? "Reloaded and looked at" : "Looked at", ...of } : { label: input.reload === true ? "Reloaded and looked at a pane" : "Looked at a pane" };
    case `${TOOL_PREFIX}artifact_reload`:
      return ref ? { label: "Reloaded", ...of } : { label: "Reloaded a pane" };
    case `${TOOL_PREFIX}artifact_remove`:
      return { label: page ? "Removed" : "Deleted", ...of };
    case `${TOOL_PREFIX}window_close`:
      return { label: "Closed a pane" };
    case `${TOOL_PREFIX}window_list`:
      return { label: "Looked at the panes" };
    case "Write":
      return doc ? { label: "Wrote", ...of } : undefined;
    case "Edit":
    case "MultiEdit":
      return doc ? { label: "Edited", ...of } : undefined;
    default:
      return undefined;
  }
}

/** Where a dragged pane lands on another: beside it on a side, or in its place, swapping the two. */
export type DropZone = Side | "swap";

/** How much of a pane's width and height, in the middle, means swapping rather than going beside it. */
const SWAP_SHARE = 1 / 3;

/**
 * The zone of `rect` that point (`x`, `y`) is in. The middle swaps; elsewhere the nearest edge wins, which cuts the pane
 * along its diagonals, so every point is in exactly one zone and moving towards an edge always picks it.
 */
export function dropZone(rect: SlotRect, x: number, y: number): DropZone {
  const nx = (x - rect.x) / rect.w;
  const ny = (y - rect.y) / rect.h;
  const lo = (1 - SWAP_SHARE) / 2;
  if (nx > lo && nx < 1 - lo && ny > lo && ny < 1 - lo) return "swap";
  const edges: [DropZone, number][] = [["left", nx], ["right", 1 - nx], ["above", ny], ["below", 1 - ny]];
  return edges.reduce((best, e) => (e[1] < best[1] ? e : best))[0];
}

/** Where a pane dropped in `zone` of `rect` ends up: the half on that side, or the whole of it for a swap. */
export function dropPreview(rect: SlotRect, zone: DropZone, share = 0.5): SlotRect {
  const { x, y, w, h } = rect;
  switch (zone) {
    case "left":
      return { x, y, w: w * share, h };
    case "right":
      return { x: x + w * (1 - share), y, w: w * share, h };
    case "above":
      return { x, y, w, h: h * share };
    case "below":
      return { x, y: y + h * (1 - share), w, h: h * share };
    case "swap":
      return rect;
  }
}

/** How close to the window's border, in pixels, the pointer has to be for a pane to go to the window's edge. */
export const EDGE_PX = 20;

/**
 * The side of the window whose edge point (`x`, `y`) is on, in fractions of the window, which is `width` by `height`
 * pixels; undefined away from the edges. In a corner, the nearer edge.
 */
export function windowEdge(x: number, y: number, width: number, height: number): Side | undefined {
  const edges: [Side, number][] = [["left", x * width], ["right", (1 - x) * width], ["above", y * height], ["below", (1 - y) * height]];
  const [side, d] = edges.reduce((best, e) => (e[1] < best[1] ? e : best));
  return d < EDGE_PX ? side : undefined;
}

/** A boundary between a split's two sides, which can be dragged to resize it. */
export interface Divider {
  /** The split's path; see `resize`. */
  path: SplitPath;
  dir: "row" | "column";
  /** The split's own room, which the divider moves across. */
  rect: SlotRect;
  ratio: number;
  /** How many slots each side has across the divider's direction, for how small each may get. */
  across: [number, number];
}

/** How many slots the layout puts one above the other, at most. */
export function rows(l: Layout): number {
  if (l.kind === "slot") return 1;
  return l.dir === "column" ? rows(l.a) + rows(l.b) : Math.max(rows(l.a), rows(l.b));
}

/** Every split's divider, as fractions of the window. */
export function dividers(layout: Layout, at: SlotRect = { x: 0, y: 0, w: 1, h: 1 }, path: SplitPath = ""): Divider[] {
  if (layout.kind === "slot") return [];
  const row = layout.dir === "row";
  const a = row ? { ...at, w: at.w * layout.ratio } : { ...at, h: at.h * layout.ratio };
  const b = row ? { ...at, x: at.x + a.w, w: at.w - a.w } : { ...at, y: at.y + a.h, h: at.h - a.h };
  const count = row ? columns : rows;
  return [
    { path, dir: layout.dir, rect: at, ratio: layout.ratio, across: [count(layout.a), count(layout.b)] },
    ...dividers(layout.a, a, `${path}a`),
    ...dividers(layout.b, b, `${path}b`),
  ];
}
