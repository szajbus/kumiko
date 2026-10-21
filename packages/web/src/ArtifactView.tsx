import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { imageTypeOf, MAX_ARTIFACT_BYTES, MAX_IMAGE_BYTES, MAX_SLOTS, urlOrigin, type ArtifactState, type ArtifactType, type SlotId, type WidgetId } from "@kumiko/shared";
import { ArtifactIcon, Close, OpenNew, Trash } from "./icons";
import { Diagram } from "./Diagram";
import { Markdown } from "./Markdown";
import { PaneGrip } from "./PaneGrip";
import { QuoteButton } from "./QuoteButton";
import { COLORS } from "./status";
import { withPolicy } from "./htmlPolicy";
import { WindowContext, type WindowApi } from "./windowContext";

/** How long "Updated" shows after the text changes. */
const UPDATED_MS = 4000;

interface Props {
  widget: WidgetId;
  slot: SlotId;
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

/** Artifacts that are web pages: shown in a frame, edge to edge, with a width to show them at and a reload. */
const isPage = (doc: ArtifactState) => doc.type === "html" || doc.type === "preview" || doc.type === "web";

/** The artifact widget: a file Claude keeps up to date, or a page it previews, read here, and quoted from into the chat. */
export function ArtifactView({ widget, slot, doc, writing }: Props) {
  const ctx = useContext(WindowContext)!;
  const [width, setWidth] = useState<(typeof WIDTHS)[number]["id"]>("full");
  const [reloads, setReloads] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const text = writing ?? doc.text;
  const updated = useUpdated(doc.text);
  const [copied, setCopied] = useState(false);
  // While Claude writes, the pane follows the end of the text, as long as the reader is there.
  const follow = useRef(false);

  useLayoutEffect(() => {
    const el = body.current;
    if (el && writing !== undefined && follow.current) el.scrollTop = el.scrollHeight;
  }, [writing]);

  const copy = () => {
    void navigator.clipboard.writeText(doc.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="artifact">
      <div className="artifact-head">
        <div className="artifact-where">
          <PaneGrip slot={slot} />
          <Switcher ctx={ctx} slot={slot} title={doc.title} />
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
          {isPage(doc) && (doc.type !== "web" || doc.approved) && (
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
          {ctx.live && (
            <button type="button" className="artifact-close" aria-label={`Close ${doc.title}`} title="Close" onClick={() => ctx.close(slot)}>
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
        className={`artifact-body${isPage(doc) && writing === undefined ? " is-page" : ""}`}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div className="artifact-inner" style={isPage(doc) && width !== "full" ? { width: `${width}px` } : undefined}>
          {doc.type === "web" && !doc.approved ? (
            <SiteApproval doc={doc} live={ctx.live} onAnswer={(allow) => ctx.approve(widget, allow)} />
          ) : (
            <Rendered key={reloads} doc={doc} text={text} writing={writing !== undefined} />
          )}
          {doc.truncated && writing === undefined && (
            <p className="artifact-note">
              {doc.type === "image"
                ? `The image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB, so it isn't shown.`
                : `The file is longer than ${MAX_ARTIFACT_BYTES / 1024} KB; only its start is shown.`}
            </p>
          )}
        </div>
      </div>
      <QuoteButton root={body} onQuote={ctx.quote} />
    </div>
  );
}

/**
 * The artifact's title, which opens the list of artifacts to show in this pane instead: this one and those no pane
 * shows, by title, each with its type's icon. One can also open in a new pane split off this one, or be removed from
 * the list. A dot marks those that changed while no pane showed them.
 */
function Switcher({ ctx, slot, title }: { ctx: WindowApi; slot: SlotId; title: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // This pane's artifact and those no pane shows: one shown in another pane is there already.
  const listed = ctx.artifacts.filter((d) => !d.slot || d.slot === slot);
  if (!ctx.live) return <span className="artifact-title">{title}</span>;
  const unread = listed.some((d) => d.unread);
  const full = Object.keys(ctx.window.slots).length >= MAX_SLOTS;
  // The new pane goes the way that leaves both halves the roomier: beside a wide pane, below a tall one.
  const pane = trigger.current?.closest(".window-slot")?.getBoundingClientRect();
  const below = pane ? pane.height > pane.width : false;
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
            <Menu.Item key={d.widget} className={`menu-item artifact-menu-item${d.slot === slot ? " is-current" : ""}`} onSelect={() => d.slot !== slot && ctx.showIn(d.widget, slot)}>
              <span className="artifact-menu-check" aria-hidden="true">{d.slot === slot ? "✓" : ""}</span>
              <ArtifactIcon type={d.type} />
              <span className="artifact-menu-title">{d.title}</span>
              {d.unread && <span className="dot dot-small artifact-unread" aria-label="Changed" />}
              {!d.slot && (
                <button
                  type="button"
                  className="artifact-menu-split"
                  disabled={full}
                  aria-label={`Open ${d.title} in a new pane`}
                  title={full ? `A window has at most ${MAX_SLOTS} panes` : "Open in a new pane"}
                  // Its own action, not the item's: the item would show it here instead.
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerUp={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setOpen(false);
                    ctx.showBeside(d.widget, slot, below ? "below" : "right");
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
                // Its own action, not the item's; the menu stays open, for removing several in a row.
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  ctx.remove(d.widget);
                }}
              >
                {hasFile(d.type) ? <Trash /> : <Close />}
              </button>
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** An artifact's text, shown as its type is shown. */
function Rendered({ doc, text, writing }: { doc: ArtifactState; text: string; writing: boolean }) {
  switch (doc.type) {
    case "markdown":
      // Diagrams wait for the text to be written: half a diagram doesn't draw.
      return <Markdown text={text} diagrams={!writing} />;
    case "svg":
      // As an image, so nothing in it runs. Its source shows while it is being written.
      return writing ? <pre className="mono artifact-source">{text}</pre> : <img className="artifact-image is-svg" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`} alt={doc.title} />;
    case "mermaid":
      return writing ? <pre className="mono artifact-source">{text}</pre> : <Diagram source={text} />;
    case "image":
      return doc.truncated ? null : <img className="artifact-image" src={`data:${imageTypeOf(doc.path)};base64,${text}`} alt={doc.title} />;
    case "html":
      // Written in pieces, a page would load again at every one; its source shows until it's written.
      return writing ? <pre className="mono artifact-source">{text}</pre> : <HtmlFrame html={text} title={doc.title} />;
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
  if (code === BLOCKED_BY_CLIENT) return "Blocked: it points to the user's machine or a private network, which websites in Kumiko can't reach.";
  return `${description || `error ${code}`} (${url})`;
}

/**
 * A page in a <webview>: a preview or a website. When it doesn't load, it says why, over the blank it would leave, and
 * keeps the reason on the element (`data-load-error`) for a picture of the pane to pass on to Claude.
 */
function PageView({ url, partition }: { url: string; partition: string }) {
  const ref = useRef<HTMLElement>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
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
    const offBlocked = window.kumiko?.onPageBlocked?.((id) => {
      let mine: number | undefined;
      try {
        mine = (el as HTMLElement & { getWebContentsId(): number }).getWebContentsId();
      } catch {
        return;
      }
      if (id === mine) fail(loadError(BLOCKED_BY_CLIENT, "", ""));
    });
    // And any other load that stops with nothing loaded and nothing said.
    let committed = false;
    const navigating = (e: Event) => {
      if ((e as Event & { isMainFrame: boolean }).isMainFrame) committed = false;
    };
    const navigated = () => (committed = true);
    const stopped = () => {
      if (!committed && !el.dataset.loadError) fail(`Nothing loaded from ${url}.`);
    };
    el.addEventListener("did-start-navigation", navigating);
    el.addEventListener("did-navigate", navigated);
    el.addEventListener("did-stop-loading", stopped);
    return () => {
      offBlocked?.();
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
