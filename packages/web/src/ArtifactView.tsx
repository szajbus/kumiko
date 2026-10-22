import { useContext, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { imageTypeOf, MAX_ARTIFACT_BYTES, MAX_IMAGE_BYTES, MAX_PANES, urlOrigin, type ArtifactState, type ArtifactType, type PaneId, type WidgetId } from "@kumiko/shared";
import { ArtifactIcon, Close, OpenNew, Trash } from "./icons";
import { Diagram } from "./Diagram";
import { Markdown } from "./Markdown";
import { PaneGrip } from "./PaneGrip";
import { QuoteButton } from "./QuoteButton";
import { quoteFrom } from "./quote";
import { COLORS } from "./status";
import { withPolicy } from "./htmlPolicy";
import { api } from "./api";
import { WindowContext, type ArtifactEntry, type WindowApi } from "./windowContext";

/** How long "Updated" shows after the text changes. */
const UPDATED_MS = 4000;

interface Props {
  widget: WidgetId;
  pane: PaneId;
  doc: ArtifactState;
  /** The text Claude is writing to the file right now, as far as it has streamed. */
  writing?: string;
}

/** Widths a page can be shown at, to see how it lays out on smaller screens; "full" is the pane's. */
const WIDTHS = [
  { id: "full", label: "Full width" },
  { id: "1280", label: "Desktop · 1280" },
  { id: "768", label: "Tablet · 768" },
  { id: "390", label: "Phone · 390" },
] as const;

/** Artifacts that are files in the session's folder, as opposed to pages served elsewhere. */
const hasFile = (type: ArtifactType) => type !== "preview" && type !== "web";

/** Artifacts drawn from a source that can be shown instead, by the language it is in. */
const SOURCE_LANG: Partial<Record<ArtifactType, string>> = { mermaid: "mermaid", svg: "xml", html: "html" };
/** What the button that goes back from the source says: what it shows. */
const DRAWN_LABEL: Partial<Record<ArtifactType, string>> = { mermaid: "Diagram", svg: "Image", html: "Page" };

/** Artifacts that are web pages: shown in a frame, edge to edge, with a width to show them at and a reload. */
const isPage = (doc: ArtifactState) => doc.type === "html" || doc.type === "preview" || doc.type === "web";

/** The artifact widget: a file Claude keeps up to date, or a page it previews, read here, and quoted from into the chat. */
export function ArtifactView({ widget, pane, doc, writing }: Props) {
  const ctx = useContext(WindowContext)!;
  const [width, setWidth] = useState<(typeof WIDTHS)[number]["id"]>("full");
  const [reloads, setReloads] = useState(0);
  // Its source as text instead of what it draws, to read or quote from.
  const [source, setSource] = useState(false);
  const page = isPage(doc) && !(source && SOURCE_LANG[doc.type]);
  const body = useRef<HTMLDivElement>(null);
  const shown = useContent(doc);
  // What Claude wrote stays until the version the window has of it has come, rather than the one before it.
  const wrote = useRef<string | undefined>(undefined);
  if (writing !== undefined) wrote.current = writing;
  else if (!shown.stale) wrote.current = undefined;
  const text = writing ?? wrote.current ?? shown.text;
  const updated = useUpdated(doc.content ?? doc.text ?? "");
  const [copied, setCopied] = useState(false);
  // While Claude writes, the pane follows the end of the text, as long as the reader is there.
  const follow = useRef(false);

  useLayoutEffect(() => {
    const el = body.current;
    if (el && writing !== undefined && follow.current) el.scrollTop = el.scrollHeight;
  }, [writing]);

  const copy = () => {
    void navigator.clipboard.writeText(shown.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="artifact">
      <div className="artifact-head">
        <div className="artifact-where">
          <PaneGrip pane={pane} />
          <Switcher ctx={ctx} pane={pane} title={doc.title} />
          <span className="artifact-path mono" title={doc.path}>
            {doc.type === "preview" || doc.type === "web" ? doc.path.replace(/^https?:\/\//, "") : doc.path.split("/").pop()}
          </span>
        </div>
        <div className="artifact-controls">
          {writing !== undefined ? (
            <span className="artifact-state">
              <span className="dot dot-small dot-pulse" style={{ background: COLORS.running }} aria-hidden="true" /> Claude is writing
            </span>
          ) : (
            updated && <span className="artifact-state">Updated</span>
          )}
          {SOURCE_LANG[doc.type] && writing === undefined && (
            <button type="button" className="artifact-copy" onClick={() => setSource((v) => !v)} title={source ? "Show it drawn" : "Show its source, to read or quote from"}>
              {source ? DRAWN_LABEL[doc.type] : "Source"}
            </button>
          )}
          {page && (doc.type !== "web" || doc.approved) && (
            <>
              <select className="artifact-width" value={width} onChange={(e) => setWidth(e.target.value as typeof width)} aria-label="Width to show the page at" title="Width to show the page at">
                {WIDTHS.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
              <button type="button" className="artifact-copy" onClick={() => setReloads((n) => n + 1)} title="Load the page again">
                Reload
              </button>
            </>
          )}
          {(doc.type === "preview" || doc.type === "web") && (
            <a className="artifact-copy" href={doc.path} target="_blank" rel="noreferrer" title="Open in your browser">
              Open
            </a>
          )}
          {doc.type !== "image" && doc.type !== "preview" && doc.type !== "web" && (
            <button type="button" className="artifact-copy" onClick={copy} title={doc.type === "markdown" ? "Copy the Markdown" : "Copy the source"}>
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          {ctx.live && hasFile(doc.type) && <DeleteButton title={doc.title} onDelete={() => ctx.remove(widget)} />}
          {ctx.live && (
            <button type="button" className="artifact-close" aria-label={`Close ${doc.title}`} title="Close" onClick={() => ctx.close(pane)}>
              <svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {doc.missing && <div className="banner banner-warn artifact-banner">The file isn't there any more. This is how it was when last read.</div>}
      <div
        ref={body}
        className={`artifact-body${page && writing === undefined ? " is-page" : ""}`}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div className="artifact-inner" style={page && width !== "full" ? { width: `${width}px` } : undefined}>
          {doc.type === "web" && !doc.approved ? (
            <SiteApproval doc={doc} live={ctx.live} onAnswer={(allow) => ctx.approve(widget, allow)} />
          ) : (
            <Rendered key={reloads} doc={doc} text={text} writing={writing !== undefined} source={source} loading={writing === undefined && !wrote.current && Boolean(shown.loading)} />
          )}
          {shown.failed && writing === undefined && <p className="artifact-note">Couldn't get it from Kumiko: {shown.failed}</p>}
          {doc.truncated && writing === undefined && (
            <p className="artifact-note">
              {doc.type === "image"
                ? `The image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB, so it isn't shown.`
                : `The file is longer than ${MAX_ARTIFACT_BYTES / 1024} KB; only its start is shown.`}
            </p>
          )}
        </div>
      </div>
      <QuoteButton root={body} onQuote={(quoted) => ctx.quote(quoteFrom(quoted, doc.title, hasFile(doc.type) ? (doc.path.split("/").pop() ?? "") : doc.path))} />
    </div>
  );
}

/**
 * The artifact's title, which opens the list of artifacts to show in this pane instead: this one and those no pane
 * shows, by title, each with its type's icon. One can also open in a new pane split off this one, or be removed from
 * the list. A dot marks those that changed while no pane showed them.
 */
function Switcher({ ctx, pane, title }: { ctx: WindowApi; pane: PaneId; title: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // This pane's artifact and those no pane shows: one shown in another pane is there already.
  const listed = ctx.artifacts.filter((d) => !d.pane || d.pane === pane);
  if (!ctx.live) return <span className="artifact-title">{title}</span>;
  const unread = listed.some((d) => d.unread);
  const full = Object.keys(ctx.window.panes).length >= MAX_PANES;
  // The new pane goes the way that leaves both halves the roomier: beside a wide pane, below a tall one.
  const box = trigger.current?.closest(".window-pane")?.getBoundingClientRect();
  const below = box ? box.height > box.width : false;
  return (
    <Menu.Root modal={false} open={open} onOpenChange={setOpen}>
      <Menu.Trigger ref={trigger} className="artifact-switch" title="Show another artifact here">
        <span className="artifact-title">{title}</span>
        {unread && <span className="dot dot-small artifact-unread" aria-label="Another artifact changed" />}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu artifact-menu" align="start" sideOffset={6} collisionPadding={8} aria-label="Artifacts">
          {listed.map((d) => (
            <ArtifactItem
              key={d.widget}
              ctx={ctx}
              entry={d}
              current={d.pane === pane}
              onSelect={() => d.pane !== pane && ctx.showIn(d.widget, pane)}
              split={
                d.pane
                  ? undefined
                  : {
                      full,
                      open: () => {
                        setOpen(false);
                        ctx.showBeside(d.widget, pane, below ? "below" : "right");
                      },
                    }
              }
            />
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * One artifact in a list of them: its type's icon, its title, a dot if it changed unseen, and buttons to open it in a
 * new pane (`split`) and to delete it, which leave the menu open.
 */
function ArtifactItem({ ctx, entry: d, current, onSelect, split, hint }: { ctx: WindowApi; entry: ArtifactEntry; current: boolean; onSelect(e: Event): void; split?: { full: boolean; open(): void }; hint?: string }) {
  // Its own action, not the item's.
  const own = { onPointerDown: (e: PointerEvent) => e.stopPropagation(), onPointerUp: (e: PointerEvent) => e.stopPropagation() };
  return (
    <Menu.Item className={`menu-item artifact-menu-item${current ? " is-current" : ""}`} onSelect={onSelect} title={hint}>
      <span className="artifact-menu-check" aria-hidden="true">{current ? "✓" : ""}</span>
      <ArtifactIcon type={d.type} />
      <span className="artifact-menu-title">{d.title}</span>
      {d.unread && <span className="dot dot-small artifact-unread" aria-label="Changed" />}
      {split && (
        <button
          type="button"
          className="artifact-menu-split"
          disabled={split.full}
          aria-label={`Open ${d.title} in a new pane`}
          title={split.full ? `A window has at most ${MAX_PANES} panes` : "Open in a new pane"}
          {...own}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            split.open();
          }}
        >
          <OpenNew />
        </button>
      )}
      <button
        type="button"
        className="artifact-menu-remove"
        // A file artifact is the session's own: removing it deletes it. A preview or a site only leaves the list.
        aria-label={hasFile(d.type) ? `Delete ${d.title}` : `Remove ${d.title} from this list`}
        title={hasFile(d.type) ? "Delete" : "Remove from this list"}
        // The menu stays open, for removing several in a row.
        {...own}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          ctx.remove(d.widget);
        }}
      >
        {hasFile(d.type) ? <Trash /> : <Close />}
      </button>
    </Menu.Item>
  );
}

/**
 * The composer's list of the window's artifacts, ticked where a pane shows them: picking one opens it in a pane of its
 * own, or closes the pane showing it, and the list stays open for more. Cmd+Shift+A opens it from the keyboard. A dot
 * marks those that changed while no pane showed them.
 */
export function ArtifactsButton() {
  const ctx = useContext(WindowContext);
  const [open, setOpen] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  // Only the tab on screen takes the shortcut.
  const shown = Boolean(ctx?.live && ctx.active && ctx.artifacts.length);
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || e.code !== "KeyA") return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [shown]);
  // Once open, the first artifact is highlighted, for the arrows and Enter to go on from.
  useEffect(() => {
    if (!open) return;
    const f = requestAnimationFrame(() => content.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
    return () => cancelAnimationFrame(f);
  }, [open]);
  if (!ctx || !shown) return null;
  const unread = ctx.artifacts.some((d) => d.unread);
  const full = Object.keys(ctx.window.panes).length >= MAX_PANES;
  const near = lastArtifactPane(ctx);
  const replaced = full && near ? ctx.artifacts.find((d) => d.pane === near)?.title : undefined;
  const toggle = (d: ArtifactEntry) => {
    if (d.pane) return ctx.close(d.pane);
    // Full: in place of the artifact in the pane used last. Otherwise a pane of its own, beside that one or the chat.
    if (full || !near) return ctx.show(d.widget);
    const r = document.querySelector(`[data-pane="${CSS.escape(near)}"]`)?.getBoundingClientRect();
    ctx.showBeside(d.widget, near, r && r.height > r.width ? "below" : "right");
  };
  return (
    <Menu.Root modal={false} open={open} onOpenChange={setOpen}>
      <Menu.Trigger className="select-trigger select-compact artifacts-button" title={`Show or hide artifacts (${MOD}+Shift+A)`}>
        <span>Artifacts · {ctx.artifacts.length}</span>
        {unread && <span className="dot dot-small artifact-unread" aria-label="An artifact changed" />}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          ref={content}
          className="menu artifact-menu"
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          aria-label="Artifacts"
        >
          {ctx.artifacts.map((d) => (
            <ArtifactItem
              key={d.widget}
              ctx={ctx}
              entry={d}
              current={Boolean(d.pane)}
              hint={d.pane ? "Close its pane" : replaced ? `A window has at most ${MAX_PANES} panes: this takes the place of “${replaced}”` : "Open it in a pane"}
              onSelect={(e) => {
                // The list stays open, to show or hide several.
                e.preventDefault();
                toggle(d);
              }}
            />
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The artifact pane used last: the active pane if it shows an artifact, else the last one that does. */
function lastArtifactPane(ctx: WindowApi): PaneId | undefined {
  const { window: w } = ctx;
  const showsArtifact = (pane: PaneId | undefined) => pane !== undefined && w.widgets[w.panes[pane]]?.kind === "artifact";
  return showsArtifact(w.active) ? w.active : Object.keys(w.panes).filter(showsArtifact).at(-1);
}

/** The key that goes with Shift+A, as the user's platform names it. */
const MOD = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "Cmd" : "Ctrl";

/** How long Delete waits for its second click. */
const CONFIRM_MS = 3000;

/**
 * Deletes the artifact, file and all, on a second click: the first, which may have been meant for Close beside it, only
 * asks. Moving away or waiting a few seconds takes the question back.
 */
function DeleteButton({ title, onDelete }: { title: string; onDelete(): void }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const t = setTimeout(() => setAsking(false), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [asking]);
  return asking ? (
    <button type="button" className="artifact-delete is-asking" autoFocus onClick={onDelete} onBlur={() => setAsking(false)} title="Click again to delete the file">
      Delete?
    </button>
  ) : (
    <button type="button" className="artifact-close" aria-label={`Delete ${title}`} title="Delete" onClick={() => setAsking(true)}>
      <Trash />
    </button>
  );
}

/** An artifact's text, shown as its type is shown. */
function Rendered({ doc, text, writing, source, loading }: { doc: ArtifactState; text: string; writing: boolean; source: boolean; loading: boolean }) {
  // Nothing to draw until the text has come: an empty diagram or page is an error, or a flash of nothing.
  if (loading) return <div className="diagram-wait">Loading…</div>;
  // While it is written, and when asked for, the source of what is drawn shows instead, marked with its language so a
  // quote of it is fenced as code.
  const lang = SOURCE_LANG[doc.type];
  if (lang && (writing || source)) {
    return (
      <pre className="mono artifact-source">
        <code className={`language-${lang}`}>{text}</code>
      </pre>
    );
  }
  switch (doc.type) {
    case "markdown":
      // Diagrams wait for the text to be written: half a diagram doesn't draw.
      return <Markdown text={text} diagrams={!writing} />;
    case "svg":
      // As an image, so nothing in it runs. Its source shows while it is being written.
      return <img className="artifact-image is-svg" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`} alt={doc.title} />;
    case "mermaid":
      return <Diagram source={text} />;
    case "image": {
      // Older sessions have the image in the window, in base64.
      const src = doc.content ? api.artifactUrl(doc.content, imageTypeOf(doc.path)) : doc.text && `data:${imageTypeOf(doc.path)};base64,${doc.text}`;
      return doc.truncated || !src ? null : <img className="artifact-image" src={src} alt={doc.title} />;
    }
    case "html":
      // Written in pieces, a page would load again at every one; its source shows until it's written.
      return <HtmlFrame html={text} title={doc.title} />;
    case "preview":
      return <Preview url={doc.path} title={doc.title} />;
    case "web":
      return <Site url={doc.path} />;
  }
}

/**
 * An HTML artifact, in a sandboxed frame: scripts run, but with an origin of their own (no allow-same-origin), so the
 * page can't reach the app, its storage or the server, which refuses its requests; and under HTML_POLICY.
 */
function HtmlFrame({ html, title }: { html: string; title: string }) {
  return <iframe className="artifact-frame" title={title} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals" srcDoc={withPolicy(html)} />;
}

/**
 * A live preview of a page the sandbox serves. In the app, a <webview>: a process and storage of its own, shared with
 * nothing of the app's; the main process checks what it may load. In a browser, a frame on the page's own origin,
 * which the server doesn't take requests from.
 */
function Preview({ url, title }: { url: string; title: string }) {
  if (window.kumiko) return <PageView url={url} partition="km-preview" />;
  return <iframe className="artifact-frame" title={title} src={url} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals" />;
}

/**
 * An external site, once allowed. In the app, a <webview> with storage of its own (km-web), which the main process
 * keeps off this machine and its private networks. A browser can't keep it off them, so there it only opens outside.
 */
function Site({ url }: { url: string }) {
  if (window.kumiko) return <PageView url={url} partition="km-web" />;
  return (
    <div className="artifact-ask">
      <p>External sites show in the Kumiko app, which keeps them off your network. Here, open it in a tab of its own.</p>
      <a className="btn btn-secondary btn-compact" href={url} target="_blank" rel="noreferrer">
        Open {url.replace(/^https?:\/\//, "")}
      </a>
    </div>
  );
}

/** Chromium's code for a request the app cancelled: here, Kumiko keeping a site off this machine and its networks. */
const BLOCKED_BY_CLIENT = -20;
/** And for a load replaced by another (a redirect, a reload): not a failure. */
const ABORTED = -3;

/** Why a page didn't load, in words for the user and for Claude. */
function loadError(code: number, description: string, url: string): string {
  if (code === BLOCKED_BY_CLIENT) return "Blocked: it points to a private network, or, for a website, the user's machine. Pages in Kumiko can't reach those.";
  return `${description || `error ${code}`} (${url})`;
}

/**
 * A page in a <webview>: a preview or a website. When it doesn't load, it says why, over the blank it would leave, and
 * keeps the reason on the element (`data-load-error`) for a picture of the pane to pass on to Claude.
 */
function PageView({ url, partition }: { url: string; partition: string }) {
  const ref = useRef<HTMLElement>(null);
  const [error, setError] = useState<string>();
  // Where the page last wanted to go that it may not: the app doesn't open it without the user.
  const [wants, setWants] = useState<string>();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWants(undefined);
    const failed = (e: Event) => {
      const f = e as Event & { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean };
      if (!f.isMainFrame || f.errorCode === ABORTED) return;
      const why = loadError(f.errorCode, f.errorDescription, f.validatedURL);
      el.dataset.loadError = why;
      setError(why);
    };
    // Cleared once a page really loads: one the server answered. Not when a load starts, as putting up Chromium's own
    // error page after a failure counts as one, which would clear the error as soon as it is set.
    const loaded = (e: Event) => {
      if ((e as Event & { httpResponseCode: number }).httpResponseCode <= 0) return;
      delete el.dataset.loadError;
      setError(undefined);
    };
    // A navigation that fails before anything loads (a name that doesn't resolve) is a provisional failure; one that
    // fails while loading isn't. Both say why.
    el.addEventListener("did-fail-load", failed);
    el.addEventListener("did-fail-provisional-load", failed);
    el.addEventListener("did-navigate", loaded);
    // A page the app blocked goes away without a word from Chromium: the app says so itself.
    const fail = (why: string) => {
      el.dataset.loadError = why;
      setError(why);
    };
    const isMine = (id: number) => {
      try {
        return id === (el as HTMLElement & { getWebContentsId(): number }).getWebContentsId();
      } catch {
        return false;
      }
    };
    const offBlocked = window.kumiko?.onPageBlocked?.((id) => {
      if (isMine(id)) fail(loadError(BLOCKED_BY_CLIENT, "", ""));
    });
    const offWants = window.kumiko?.onPageWants?.((id, target) => {
      if (isMine(id)) setWants(target);
    });
    // And any other load that stops with nothing loaded and nothing said.
    // Only before any page has: a navigation away that stops (one the app blocked, say) leaves the page there was.
    let committed = false;
    let shown = false;
    const navigating = (e: Event) => {
      if ((e as Event & { isMainFrame: boolean }).isMainFrame) committed = false;
    };
    const navigated = () => (committed = shown = true);
    const stopped = () => {
      if (!committed && !shown && !el.dataset.loadError) fail(`Nothing loaded from ${url}.`);
    };
    el.addEventListener("did-start-navigation", navigating);
    el.addEventListener("did-navigate", navigated);
    el.addEventListener("did-stop-loading", stopped);
    return () => {
      offBlocked?.();
      offWants?.();
      el.removeEventListener("did-start-navigation", navigating);
      el.removeEventListener("did-navigate", navigated);
      el.removeEventListener("did-stop-loading", stopped);
      el.removeEventListener("did-fail-load", failed);
      el.removeEventListener("did-fail-provisional-load", failed);
      el.removeEventListener("did-navigate", loaded);
    };
  }, [url]);
  return (
    <>
      <webview ref={ref} className="artifact-frame" src={url} partition={partition} allowpopups data-preview="" />
      {error && (
        <div className="artifact-ask artifact-failed" role="alert">
          <p className="artifact-ask-title">This page didn't load</p>
          <p>{error}</p>
        </div>
      )}
      {wants && (
        <div className="artifact-wants" role="status">
          <span>
            The page wants to open <span className="mono artifact-wants-url">{wants}</span>
          </span>
          {/* Opened by the app's window, which sends http(s) and mail links to the browser. */}
          <a className="btn btn-secondary btn-compact" href={wants} target="_blank" rel="noreferrer" onClick={() => setWants(undefined)}>
            Open in browser
          </a>
          <button type="button" className="btn btn-secondary btn-compact" onClick={() => setWants(undefined)}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}

/** What a site Claude opened shows until the user allows it: which site, and Allow or Deny. */
function SiteApproval({ doc, live, onAnswer }: { doc: ArtifactState; live: boolean; onAnswer(allow: boolean): void }) {
  const origin = urlOrigin(doc.path) ?? doc.path;
  return (
    <div className="artifact-ask" role="dialog" aria-label="Allow this site?">
      <p className="artifact-ask-title">Claude wants to open a website here</p>
      <p className="mono artifact-ask-url">{doc.path}</p>
      <p>
        It loads in a sandbox with nothing of yours: no logins, no access to your machine or network. Allowing it lets Claude open other pages of{" "}
        <strong>{origin.replace(/^https?:\/\//, "")}</strong> in this session, and see them.
      </p>
      {live && (
        <div className="artifact-ask-actions">
          <button type="button" className="btn btn-primary btn-compact" onClick={() => onAnswer(true)}>
            Allow
          </button>
          <button type="button" className="btn btn-secondary btn-compact" onClick={() => onAnswer(false)}>
            Deny
          </button>
        </div>
      )}
    </div>
  );
}

/** Whether `text` changed in the last few seconds; not when the widget first shows. */
/** Versions of artifacts fetched lately, by hash, so switching back and forth doesn't fetch them again. */
const fetched = new Map<string, Promise<string>>();
const FETCHED_MAX = 64;

function fetchContent(hash: string): Promise<string> {
  let p = fetched.get(hash);
  if (!p) {
    p = api.artifactText(hash);
    p.catch(() => fetched.delete(hash));
    fetched.set(hash, p);
    if (fetched.size > FETCHED_MAX) fetched.delete(fetched.keys().next().value!);
  }
  return p;
}

/**
 * The text of the artifact as the window has it: the server keeps it, and the window names it by hash. The version
 * shown stays until the next has come, so the pane doesn't flash empty. An image isn't fetched as text: it loads itself.
 */
function useContent(doc: ArtifactState): { text: string; stale?: boolean; loading?: boolean; failed?: string } {
  const [got, setGot] = useState<{ hash?: string; text: string; failed?: string }>({ text: "" });
  const hash = doc.type === "image" ? undefined : doc.content;
  useEffect(() => {
    if (!hash) return;
    let live = true;
    fetchContent(hash).then(
      (text) => live && setGot({ hash, text }),
      (err: unknown) => live && setGot((g) => ({ ...g, failed: err instanceof Error ? err.message : String(err) })),
    );
    return () => {
      live = false;
    };
  }, [hash]);
  if (!hash) return { text: doc.text ?? "" };
  // Loading: no version of it has come yet, so there is nothing to show.
  return { ...got, stale: got.hash !== hash, loading: got.hash === undefined && !got.failed };
}

function useUpdated(text: string): boolean {
  const first = useRef(text);
  const [updated, setUpdated] = useState(false);
  useEffect(() => {
    if (text === first.current) return;
    first.current = text;
    setUpdated(true);
    const t = setTimeout(() => setUpdated(false), UPDATED_MS);
    return () => clearTimeout(t);
  }, [text]);
  return updated;
}
