import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { CHAT, chatWindow, artifactsOf, edgeShare, WINDOW, LIVE_SESSION_STATUSES, MIN_RATIO, resize, paneOf, windowState, type ArtifactState, type ReviewState, type SessionEvent, type SessionInfo, type PaneId, type SplitPath, type WidgetId, type WindowState } from "@kumiko/shared";
import { api, onPaneRequest, useSessionEvents, type PaneRequest } from "./api";
import type { ComposerHandle } from "./Composer";
import { ArtifactView } from "./ArtifactView";
import { PaneGrip } from "./PaneGrip";
import { revealablePath } from "./reveal";
import { SessionView } from "./SessionView";
import type { WakeContext } from "./WakeBanner";
import { TasksPane } from "./TasksPane";
import { ReviewPane } from "./ReviewPane";
import { useFold } from "./useFold";
import { columns, dividers, dropPreview, dropZone, lastChanges, paneRects, streamingWrites, windowEdge, type Divider, type DropZone, type PaneRect } from "./widgets";
import { WindowContext, type ArtifactEntry, type WindowApi } from "./windowContext";

interface Props {
  session: SessionInfo;
  /** A fork was started; opens its tab. */
  onForked(id: string): void;
  /** Its tab is the one on screen; a window kept in the background for a quick switch back isn't. */
  active?: boolean;
  /** The open sessions' names, by id; see `WindowApi`. */
  sessionNames?: ReadonlyMap<string, string>;
  /** While the session is asleep, its sandbox and the sandbox's log. */
  wake?: WakeContext;
  /** The places in the sandbox's VM that are folders on this Mac (`SandboxView.shared`). */
  shared?: string[];
}

const NO_NAMES: ReadonlyMap<string, string> = new Map();

/** How narrow a pane can get before the window stacks its panes one above the other. */
const MIN_PANE_WIDTH = 360;

/**
 * A session's tab: its window, a layout of panes each showing a widget. The window owns the session's event stream,
 * folds its state from the stream's `window` events, and passes the stream on to the chat. Panes are placed by the
 * layout but rendered side by side, each under its own key, so the chat stays mounted as panes open and close.
 */
export function Window({ session, onForked, active = true, sessionNames = NO_NAMES, wake, shared }: Props) {
  const stream = useSessionEvents(session.id);
  const win = useWindow(stream.events);
  const composer = useRef<ComposerHandle>(null);
  const live = LIVE_SESSION_STATUSES.includes(session.status);
  const writes = useMemo(() => streamingWrites(stream.events), [stream.events]);
  const changed = useMemo(() => lastChanges(stream.events), [stream.events]);
  const artifacts = useDocuments(win, changed, stream.history);
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  // Too narrow for its panes side by side, the window stacks them, and they can't be rearranged.
  const stack = width !== undefined && width < MIN_PANE_WIDTH * columns(win.layout);
  const arrange = live && !stack && Object.keys(win.panes).length > 1;
  const { drag, startDrag, sizing, startResize } = useArrange(session.id, box, win, arrange);
  usePaneRequests(session.id, box, active);
  // While a divider is dragged, the layout follows it here, and the server hears of it once it is let go.
  const layout = sizing ? resizedLayout(win, sizing.path, sizing.ratio) : win.layout;
  const rects = paneRects(layout, stack);

  const ctx = useMemo<WindowApi>(
    () => ({
      window: win,
      artifacts,
      live,
      active,
      show: (widget) => void api.showWidget(session.id, widget).catch((err) => console.error(err)),
      showIn: (widget, pane) => void api.showWidget(session.id, widget, pane).catch((err) => console.error(err)),
      showBeside: (widget, pane, split) => void api.showWidget(session.id, widget, pane, split).catch((err) => console.error(err)),
      close: (pane) => void api.closePane(session.id, pane).catch((err) => console.error(err)),
      remove: (widget) => void api.removeWidget(session.id, widget).catch((err) => console.error(err)),
      approve: (widget, allow) => void api.approveSite(session.id, widget, allow).catch((err) => console.error(err)),
      quote: (text) => composer.current?.insertQuote(text),
      arrange,
      startDrag: (pane, e) => startDrag(pane, e, rects),
      rects,
      move: (pane, to, side) => void api.movePane(session.id, pane, to, side).catch((err) => console.error(err)),
      sessionNames,
      session: session.id,
      review: (ask, open) => void api.toggleReview(session.id, ask, open).catch((err) => console.error(err)),
      revealable: (text) => revealablePath(text, shared),
      reveal: (path) => api.reveal(session.id, path).then(() => {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [win, artifacts, live, active, session.id, arrange, JSON.stringify([...rects]), sessionNames, JSON.stringify(shared ?? [])],
  );

  const widget = (pane: PaneId) => {
    const id = win.panes[pane];
    const w = win.widgets[id];
    switch (w?.kind) {
      case "chat":
        return <SessionView session={session} stream={stream} onForked={onForked} composerRef={composer} active={active} wake={wake} />;
      case "artifact": {
        const doc = w.state as ArtifactState;
        // What Claude is writing to the file streams in, until the window has read the file it wrote.
        const write = writes.get(doc.path);
        const writing = write && (changed.get(id) ?? 0) < write.seq ? write.text : undefined;
        return <ArtifactView key={id} widget={id} pane={pane} doc={doc} writing={writing} />;
      }
      case "tasks":
        return <TasksPane session={session.id} events={stream.events} pane={pane} live={live} />;
      case "review":
        return <ReviewPane session={session.id} pane={pane} ask={(w.state as ReviewState).ask} events={stream.events} />;
      default:
        return null;
    }
  };

  return (
    <WindowContext.Provider value={ctx}>
      <div className={`window${drag?.moved ? " is-dragging" : ""}`} ref={box}>
        {/* In the panes' own order, not the layout's: moving a pane in the layout doesn't move it in the page, which
            would remount nothing but would lose its scroll position. */}
        {Object.keys(win.panes).flatMap((pane) => {
          const rect = rects.get(pane);
          return rect ? [[pane, rect] as const] : [];
        }).map(([pane, rect]) => (
          <div key={pane} data-pane={pane} className={`window-pane${drag?.pane === pane && drag.moved ? " is-dragged" : ""}`} style={place(rect)}>
            {widget(pane)}
            {pane === CHAT && <PaneGrip pane={pane} floating />}
          </div>
        ))}
        {arrange &&
          dividers(layout).map((d) => (
            <div key={d.path} className={`window-divider is-${d.dir}`} style={dividerPlace(d)} onPointerDown={(e) => startResize(d, e)} />
          ))}
        {drag?.moved && (
          // Over everything while dragging, so no pane (or what is in it) takes the pointer.
          <div className="window-drop">
            {drag.target && (
              <div
                className="window-drop-preview"
                style={place(
                  drag.target.pane === WINDOW
                    ? dropPreview({ x: 0, y: 0, w: 1, h: 1 }, drag.target.zone, edgeShare(Object.keys(win.panes).length))
                    : dropPreview(rects.get(drag.target.pane)!, drag.target.zone),
                )}
              />
            )}
          </div>
        )}
      </div>
    </WindowContext.Provider>
  );
}

/** How long a reloaded page has to load before the window gives up waiting and answers anyway. */
const LOAD_MS = 10_000;

/**
 * Loads the page in `pane` again, if it shows one, and resolves once it has loaded (or LOAD_MS has passed): a preview's
 * <webview> reloads itself; a frame is given its source again, which a frame on another origin allows.
 */
function reloadPage(pane: Element): Promise<void> {
  const webview = pane.querySelector("webview[data-preview]") as (HTMLElement & { reload?(): void; getURL?(): string }) | null;
  const frame = pane.querySelector("iframe.artifact-frame") as HTMLIFrameElement | null;
  const target = webview?.reload ? webview : frame;
  if (!target) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => (clearTimeout(timer), target.removeEventListener(webview ? "did-stop-loading" : "load", done), resolve());
    const timer = setTimeout(done, LOAD_MS);
    target.addEventListener(webview ? "did-stop-loading" : "load", done);
    // A <webview> that never loaded a page can't reload: it is given its address again instead.
    const loadedOnce = (() => {
      try {
        return Boolean(webview?.getURL?.());
      } catch {
        return false;
      }
    })();
    if (webview?.reload && loadedOnce) webview.reload();
    else if (webview) webview.setAttribute("src", webview.getAttribute("src") ?? "");
    else if (frame?.srcdoc) frame.srcdoc = frame.srcdoc;
    else if (frame) frame.src = frame.src;
  });
}

/**
 * Answers the server's requests, for Claude, about one of this window's panes: load its page again, then take a picture
 * of it (what a preview's <webview> shows, or the pane's body as it is on screen). Only the desktop app takes pictures;
 * in a browser, the answer says so. Only the window of the tab on screen answers (others stay mounted, hidden, for a
 * quick switch back); a page without the session's window on screen answers that it lacks it. The server takes the first window that does it, so a browser can't fail it for the app.
 */
function usePaneRequests(id: string, box: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(
    () =>
      onPaneRequest((ev) => {
        // A tab kept in the background isn't on screen, so it has nothing to show.
        if (ev.session !== id || !active) return false;
        void answerPane(id, box, ev);
        return true;
      }),
    [id, box, active],
  );
}

async function answerPane(id: string, box: RefObject<HTMLElement | null>, ev: PaneRequest) {
  const answer = (a: { data?: string; mimeType?: string; error?: string; fallback?: boolean; note?: string }) => void api.answerPane(id, { request: ev.request, ...a }).catch(() => {});
  const pane = box.current?.querySelector(`[data-pane="${CSS.escape(ev.pane)}"]`);
  const k = window.kumiko;
  if (!pane) return answer({ error: "That pane isn't in the user's window.", fallback: true });
  // Whatever goes wrong, the window answers, rather than leaving Claude to wait for nothing.
  try {
    if (ev.reload) await reloadPage(pane);
  } catch (err) {
    return answer({ error: `The window couldn't load the page again: ${err instanceof Error ? err.message : String(err)}` });
  }
  // A page that didn't load says why, for Claude not to take a blank picture for the page.
  const webview = pane.querySelector("webview[data-preview]") as (HTMLElement & { getWebContentsId?(): number }) | null;
  const failed = webview?.dataset.loadError;
  const note = failed ? `The page didn't load: ${failed}` : undefined;
  if (!ev.capture) return answer({ note });
  // For the page to paint what it loaded, or to finish animating, as asked.
  if (ev.wait > 0) await new Promise((r) => setTimeout(r, ev.wait));
  if (!k) return answer({ error: "Capturing needs the Kumiko app; the user has Kumiko open in a browser.", fallback: true });
  if (document.visibilityState !== "visible") return answer({ error: "The Kumiko window is hidden or minimized; ask the user to bring it up." });
  // The pane's area of the window: for a page that didn't load (its <webview> has nothing to capture), and anything
  // that isn't a page.
  const area = () => {
    const r = (pane.querySelector(".artifact-body") ?? pane).getBoundingClientRect();
    const z = k.getZoomFactor();
    return k.capture({ x: Math.round(r.x * z), y: Math.round(r.y * z), width: Math.round(r.width * z), height: Math.round(r.height * z) });
  };
  try {
    let data: string;
    // A <webview> that hasn't drawn a page can leave its capture hanging, not failing: given a few seconds, then
    // the pane's area instead. That one has a limit too, so the window always answers.
    if (webview?.getWebContentsId && !failed) data = await within(k.captureWebview(webview.getWebContentsId()), 3000).catch(() => within(area(), 5000));
    else data = await within(area(), 5000);
    answer({ data, mimeType: "image/png", note });
  } catch (err) {
    answer({ error: `The window couldn't capture it: ${err instanceof Error ? err.message : String(err)}` });
  }
}

/** `p`, or a failure once `ms` have passed without it settling. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e: unknown) => (clearTimeout(timer), reject(e)),
    );
  });
}

/** How small a pane can be dragged down to, in pixels. */
const MIN_PANE = { width: 240, height: 120 };

/** How far the pointer goes before a press on a pane's handle becomes a drag. */
const DRAG_THRESHOLD = 4;

interface Drag {
  pane: PaneId;
  from: { x: number; y: number };
  /** Past the threshold: a drag, not a press. */
  moved: boolean;
  /** The pane under the pointer and where on it the dragged one would land. */
  target?: { pane: PaneId; zone: DropZone };
}

interface Sizing {
  path: SplitPath;
  ratio: number;
}

/**
 * Dragging panes by their handles onto others, and dividers to resize splits. Both follow the pointer on the whole
 * page until it is let go; Escape drops a pane drag. The window's state changes once, on letting go.
 */
function useArrange(id: string, box: RefObject<HTMLElement | null>, win: WindowState, arrange: boolean) {
  const [drag, setDrag] = useState<Drag>();
  const [sizing, setSizing] = useState<Sizing>();
  const dragRef = useRef<Drag | undefined>(undefined);
  const set = (d: Drag | undefined) => setDrag((dragRef.current = d));
  // Fractions of the window from a point on the page.
  const at = (e: PointerEvent | ReactPointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const startDrag = (pane: PaneId, e: ReactPointerEvent, rects: Map<PaneId, PaneRect>) => {
    if (!arrange || e.button !== 0) return;
    e.preventDefault();
    set({ pane, from: { x: e.clientX, y: e.clientY }, moved: false });
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const moved = d.moved || Math.hypot(ev.clientX - d.from.x, ev.clientY - d.from.y) > DRAG_THRESHOLD;
      if (!moved) return;
      const p = at(ev);
      const size = box.current!.getBoundingClientRect();
      // Along the window's border, the window is the target: the pane goes to that side of it, along the whole of it.
      const edge = windowEdge(p.x, p.y, size.width, size.height);
      const over = [...rects].find(([, r]) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h);
      // Over itself, the whole pane is the target, as a drop there leaves it where it is.
      const target = edge ? { pane: WINDOW, zone: edge } : over && { pane: over[0], zone: over[0] === d.pane ? ("swap" as const) : dropZone(over[1], p.x, p.y) };
      set({ ...d, moved, target });
    };
    const end = (drop: boolean) => {
      const d = dragRef.current;
      set(undefined);
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("keydown", key);
      if (drop && d?.target && d.target.pane !== d.pane) void api.movePane(id, d.pane, d.target.pane, d.target.zone).catch((err) => console.error(err));
    };
    const up = () => end(true);
    const key = (ev: KeyboardEvent) => ev.key === "Escape" && end(false);
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("keydown", key);
  };

  const startResize = (d: Divider, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    let ratio = d.ratio;
    // Each side keeps room for its panes: MIN_PANE for each one across, and at least MIN_RATIO.
    const box_ = box.current!.getBoundingClientRect();
    const room = d.dir === "row" ? d.rect.w * box_.width : d.rect.h * box_.height;
    const min = d.dir === "row" ? MIN_PANE.width : MIN_PANE.height;
    const lo = Math.max(MIN_RATIO, (d.across[0] * min) / room);
    const hi = Math.min(1 - MIN_RATIO, 1 - (d.across[1] * min) / room);
    const move = (ev: PointerEvent) => {
      if (lo > hi) return;
      const p = at(ev);
      const share = d.dir === "row" ? (p.x - d.rect.x) / d.rect.w : (p.y - d.rect.y) / d.rect.h;
      ratio = Math.min(hi, Math.max(lo, share));
      setSizing({ path: d.path, ratio });
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      if (ratio === d.ratio) return setSizing(undefined);
      // Kept until the server has it, so the divider doesn't jump back meanwhile.
      void api.resizeSplit(id, d.path, ratio).catch((err) => console.error(err)).finally(() => setSizing(undefined));
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };

  // A layout that changes under a drag (Claude opening a pane, say) ends it, as its places no longer hold.
  useEffect(() => set(undefined), [win.layout]);
  return { drag, startDrag, sizing, startResize };
}

/** The layout with the split at `path` at `ratio`, or as it is if that doesn't fit it any more. */
function resizedLayout(win: WindowState, path: SplitPath, ratio: number) {
  try {
    return resize(win, path, ratio).layout;
  } catch {
    return win.layout;
  }
}

/** A divider's grab area: a strip along the boundary between its split's sides. */
function dividerPlace({ dir, rect, ratio }: Divider): CSSProperties {
  const pct = (n: number) => `${n * 100}%`;
  return dir === "row"
    ? { left: `calc(${pct(rect.x + rect.w * ratio)} - 3px)`, top: pct(rect.y), width: 6, height: pct(rect.h) }
    : { top: `calc(${pct(rect.y + rect.h * ratio)} - 3px)`, left: pct(rect.x), height: 6, width: pct(rect.w) };
}

/** A pane's place in the window, with a divider on the sides it shares with another pane. */
function place({ x, y, w, h }: PaneRect): CSSProperties {
  const pct = (n: number) => `${n * 100}%`;
  return {
    left: pct(x),
    top: pct(y),
    width: pct(w),
    height: pct(h),
    borderLeftWidth: x > 0 ? 1 : 0,
    borderTopWidth: y > 0 ? 1 : 0,
  };
}

/**
 * The window's artifacts for the panes' switchers, by title. One that changes while no pane
 * shows it is unread until one does; changes in the history replayed on opening the tab don't count.
 */
function useDocuments(win: WindowState, changed: Map<WidgetId, number>, history: number | undefined): ArtifactEntry[] {
  const seen = useRef(new Map<WidgetId, number>());
  const docs = artifactsOf(win).map(([widget, d]) => ({ widget, type: d.type, title: d.title, path: d.path, pane: paneOf(win, widget), at: changed.get(widget) ?? 0 }));
  useEffect(() => {
    for (const d of docs) if (d.pane) seen.current.set(d.widget, d.at);
  });
  const key = JSON.stringify(docs);
  return useMemo(
    () =>
      docs
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }))
        .map((d) => ({ ...d, unread: !d.pane && history !== undefined && d.at > history && d.at > (seen.current.get(d.widget) ?? 0) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, history],
  );
}

/** Folds the window incrementally: only new events are applied, unless the stream was reset (a rewind). */
function useWindow(events: SessionEvent[]): WindowState {
  return useFold(events, chatWindow, (state, added) => windowState(added, state));
}

/** The element's width, kept up to date. */
function useWidth(ref: RefObject<HTMLElement | null>): number | undefined {
  const [width, setWidth] = useState<number>();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A tab kept in the background has no width: it keeps the one it had.
    const watch = new ResizeObserver(() => el.clientWidth > 0 && setWidth(el.clientWidth));
    watch.observe(el);
    return () => watch.disconnect();
  }, [ref]);
  return width;
}
