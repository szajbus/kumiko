import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import type { ApprovalCard, DeliverCard, ReviewDiff, ReviewFile, SessionEvent } from "@kumiko/shared";
import { api, errorMessage } from "./api";
import { splitLines } from "./diff";
import { Highlighted } from "./Highlighted";
import { rowKey, useRowTokens, type Token } from "./highlight";
import { PaneGrip } from "./PaneGrip";
import {
  byFolder,
  getReview,
  noteKey,
  requestChanges,
  restamp,
  reviewOf,
  reviewPrefs,
  reviewRows,
  setReview,
  splitRows,
  scopeQuery,
  subscribeReviews,
  viewedMarks,
  viewedState,
  type Scope,
  type ReviewNote,
  type ReviewRow,
} from "./review";
import { WindowContext } from "./windowContext";

const short = (sha: string) => sha.slice(0, 7);
const STATUS_LETTER: Record<ReviewFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", type: "T" };

/** The latest state of card `ask`, from the session's events. */
function useCard(events: readonly SessionEvent[], ask: string): ApprovalCard | undefined {
  return useMemo(() => {
    let card: ApprovalCard | undefined;
    for (const e of events) if (e.kind === "card" && e.payload.id === ask) card = e.payload;
    return card;
  }, [events, ask]);
}

/** The review pane: a deliver card's changes, file by file, to read before deciding on the card. */
export function ReviewPane({ session, pane, ask, events }: { session: string; pane: string; ask: string; events: readonly SessionEvent[] }) {
  const card = useCard(events, ask);
  const c = card?.card.kind === "deliver" ? card.card : undefined;
  if (!card || !c) {
    return (
      <div className="rv">
        <Head pane={pane} />
        <p className="rv-empty">{card ? "This card has no changes to review." : "This card isn't in the chat any more."}</p>
      </div>
    );
  }
  // A card worked out again (a stale one reviewed) is another state of the branch: the pane starts over for it.
  return <ReviewBody key={c.head} session={session} pane={pane} card={card} c={c} />;
}

function Head({ pane, c, children }: { pane: string; c?: DeliverCard; children?: ReactNode }) {
  const ctx = useContext(WindowContext);
  return (
    <div className="rv-head">
      <PaneGrip pane={pane} />
      <div className="rv-title">
        Review
        {c && (
          <>
            <code className="ac-ref">{c.base}</code>
            <span className="ac-arrow">←</span>
            <code className="ac-ref">{c.branch}</code>
          </>
        )}
      </div>
      {children}
      <span className="rv-spacer" />
      {ctx?.live && (
        <button type="button" className="artifact-close" aria-label="Close the review" title="Close" onClick={() => ctx.close(pane)}>
          <svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

function ReviewBody({ session, pane, card, c }: { session: string; pane: string; card: ApprovalCard; c: DeliverCard }) {
  const ctx = useContext(WindowContext);
  const rkey = reviewOf(c);
  const review = useSyncExternalStore(subscribeReviews, () => getReview(session, rkey));
  const prefs = useSyncExternalStore(reviewPrefs.subscribe, reviewPrefs.get);
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [diff, setDiff] = useState<ReviewDiff>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState("");
  const [current, setCurrent] = useState<string>();
  const sections = useRef(new Map<string, HTMLElement>());
  const open = card.state === "open" || card.state === "stale";
  const decidable = open && Boolean(ctx?.live);
  const all = scope.kind === "all";

  // The heads the user reviewed at, for "since": this one goes last.
  useEffect(() => {
    setReview(session, rkey, (r) => (r.seen.at(-1) === c.head ? r : { ...r, seen: [...r.seen.filter((h) => h !== c.head), c.head].slice(-10) }));
  }, [session, rkey, c.head]);
  const before = review.seen.at(-1) === c.head ? review.seen.at(-2) : review.seen.at(-1);

  useEffect(() => {
    let gone = false;
    setError(undefined);
    api
      .reviewDiff(session, card.id, scopeQuery(scope, prefs.whitespace))
      .then((d) => {
        if (gone) return;
        setDiff(d);
        // Files viewed at an earlier head that haven't changed since are viewed at this one too.
        if (scope.kind === "all") setReview(session, rkey, (r) => restamp(r, c.head, d.files));
      })
      .catch((err) => !gone && setError(errorMessage(err)));
    return () => {
      gone = true;
    };
  }, [session, card.id, rkey, c.head, scope, prefs.whitespace]);

  const files = useMemo(() => (diff ? byFolder(diff.files).flatMap(([, fs]) => fs) : []), [diff]);
  const notes = review.notes;
  const notesByPath = useMemo(() => {
    const m = new Map<string, ReviewNote[]>();
    for (const n of notes) m.set(n.path, [...(m.get(n.path) ?? []), n]);
    return m;
  }, [notes]);
  // One ref callback per file, kept, so the files' sections aren't drawn again for a new one each time.
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const refFor = (path: string) => {
    let r = refs.current.get(path);
    if (!r) {
      r = (el) => {
        if (el) sections.current.set(path, el);
        else sections.current.delete(path);
      };
      refs.current.set(path, r);
    }
    return r;
  };
  const viewed = all ? files.filter((f) => viewedState(review, f) === "yes").length : 0;

  const go = useCallback((path: string) => {
    setCurrent(path);
    sections.current.get(path)?.scrollIntoView({ block: "start" });
  }, []);
  const setViewed = useCallback(
    (f: ReviewFile, on: boolean) =>
      setReview(session, rkey, (r) => {
        const v = { ...r.viewed };
        if (on) Object.assign(v, viewedMarks(f, c.head));
        else for (const p of Object.keys(viewedMarks(f, c.head))) delete v[p];
        return { ...r, viewed: v };
      }),
    [session, rkey, c.head],
  );

  const shownFiles = filter.trim() ? files.filter((f) => f.path.toLowerCase().includes(filter.trim().toLowerCase())) : files;
  // The keys go through the files the list shows.
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
    const i = shownFiles.findIndex((f) => f.path === current);
    if (e.key === "j" || e.key === "k") {
      if (!shownFiles.length) return;
      e.preventDefault();
      go(shownFiles[i < 0 ? 0 : Math.min(shownFiles.length - 1, Math.max(0, i + (e.key === "j" ? 1 : -1)))].path);
    } else if (e.key === "v" && all && i >= 0) {
      e.preventDefault();
      setViewed(shownFiles[i], viewedState(review, shownFiles[i]) !== "yes");
    }
  };

  const scopeLabel = scope.kind === "all" ? `All ${c.commits.length} commit${c.commits.length === 1 ? "" : "s"}` : scope.kind === "since" ? `Since ${short(scope.sha)}` : `${short(scope.sha)} · ${c.commits.find((x) => x.sha === scope.sha)?.subject ?? ""}`;
  const scopeId = scope.kind === "all" ? "all" : `${scope.kind}:${scope.sha}`;

  return (
    // Focusable, so a click anywhere in it lets the keys reach it.
    <div className="rv" tabIndex={-1} onKeyDown={onKey}>
      <Head pane={pane} c={c}>
        <span className="rv-at" title={c.head}>
          at <code>{short(c.head)}</code>
          {card.state === "open" ? ", the commit approving lands" : ""}
        </span>
      </Head>
      <div className="rv-bar">
        <Menu.Root modal={false}>
          <Menu.Trigger className="rv-scope" aria-label="What to show">
            <span className="rv-scope-label">{scopeLabel}</span>
            <span className="rv-chev" aria-hidden="true">▾</span>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content className="menu rv-scope-menu" align="start" sideOffset={6} collisionPadding={8}>
              <Menu.Item className="menu-item rv-mi" onSelect={() => setScope({ kind: "all" })}>
                <span className="rv-ck">{all ? "✓" : ""}</span>
                <span>All changes</span>
                <span className="rv-mi-d">what lands on {c.base}</span>
              </Menu.Item>
              {before && (
                <Menu.Item className="menu-item rv-mi" onSelect={() => setScope({ kind: "since", sha: before })}>
                  <span className="rv-ck">{scope.kind === "since" ? "✓" : ""}</span>
                  <span>Since you last looked</span>
                  <span className="rv-mi-d">from {short(before)}</span>
                </Menu.Item>
              )}
              <Menu.Separator className="menu-separator" />
              <Menu.Label className="rv-mi-label">One commit</Menu.Label>
              {c.commits.map((x) => (
                <Menu.Item key={x.sha} className="menu-item rv-mi" onSelect={() => setScope({ kind: "commit", sha: x.sha })}>
                  <span className="rv-ck">{scope.kind === "commit" && scope.sha === x.sha ? "✓" : ""}</span>
                  <code className="rv-mi-sha">{short(x.sha)}</code>
                  <span className="rv-mi-subject">{x.subject}</span>
                </Menu.Item>
              ))}
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
        <span className="rv-seg" role="group" aria-label="Layout">
          <button type="button" aria-pressed={!prefs.split} onClick={() => reviewPrefs.set({ split: false })}>
            Unified
          </button>
          <button type="button" aria-pressed={prefs.split} onClick={() => reviewPrefs.set({ split: true })}>
            Split
          </button>
        </span>
        <label className="rv-chk">
          <input type="checkbox" checked={prefs.wrap} onChange={(e) => reviewPrefs.set({ wrap: e.target.checked })} /> Wrap
        </label>
        <label className="rv-chk">
          <input type="checkbox" checked={prefs.whitespace} onChange={(e) => reviewPrefs.set({ whitespace: e.target.checked })} /> Hide whitespace
        </label>
        <span className="rv-spacer" />
        {all && diff && (
          <span className="rv-prog">
            {viewed} / {files.length} viewed
            <span className="rv-prog-bar">
              <i style={{ width: `${files.length ? (viewed / files.length) * 100 : 0}%` }} />
            </span>
          </span>
        )}
      </div>
      {card.state === "stale" && <div className="rv-banner">{c.branch} moved after the card was shown. This is the commit the card is for; review again on the card to see the new one.</div>}
      {!open && <div className="rv-banner">This card is closed. The changes are as it showed them.</div>}
      <div className="rv-body">
        <nav className="rv-tree" aria-label="Changed files">
          <input className="rv-filter" placeholder="Filter files" aria-label="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {byFolder(shownFiles).map(([dir, fs]) => (
            <div key={dir}>
              {dir && <div className="rv-dir">{dir}/</div>}
              {fs.map((f) => (
                <TreeFile key={f.path} f={f} current={f.path === current} state={all ? viewedState(review, f) : "no"} notes={notes.some((n) => n.path === f.path)} onClick={() => go(f.path)} />
              ))}
            </div>
          ))}
          {diff && (
            <div className="rv-sum">
              {files.length} file{files.length === 1 ? "" : "s"} changed in {scope.kind === "commit" ? "1 commit" : `${c.commits.length} commit${c.commits.length === 1 ? "" : "s"}`} ·{" "}
              <span className="rv-nowrap">
                <span className="ac-add">+{files.reduce((n, f) => n + (f.added ?? 0), 0)}</span> <span className="ac-del">−{files.reduce((n, f) => n + (f.deleted ?? 0), 0)}</span>
              </span>
            </div>
          )}
        </nav>
        <div className={`rv-diffs${prefs.wrap ? " is-wrapped" : ""}`}>
          {error ? (
            <p className="rv-error">{error}</p>
          ) : !diff ? (
            <p className="rv-empty">Reading the changes…</p>
          ) : !files.length ? (
            <p className="rv-empty">{scope.kind === "since" ? "Nothing changed since then." : "No changes."}</p>
          ) : (
            files.map((f) => (
              <FileSection
                // Another scope or whitespace is another diff of the file: its content and open gaps were for this one.
                key={`${scopeId}|${prefs.whitespace}|${f.path}`}
                ref={refFor(f.path)}
                session={session}
                ask={card.id}
                review={rkey}
                head={c.head}
                scope={scope}
                file={f}
                viewed={all ? viewedState(review, f) : undefined}
                notes={all ? (notesByPath.get(f.path) ?? NO_NOTES) : undefined}
                canNote={all && decidable}
                split={prefs.split}
                whitespace={prefs.whitespace}
                onViewed={setViewed}
                onFocus={setCurrent}
              />
            ))
          )}
        </div>
      </div>
      <div className="rv-foot">
        <span className="rv-keys">
          <kbd>j</kbd> <kbd>k</kbd> next / previous file{all && (
            <>
              {" "}
              · <kbd>v</kbd> viewed
            </>
          )}
        </span>
        <span className="rv-spacer" />
        {all && decidable && (
          <span className="rv-notes">{notes.length ? <><b>{notes.length === 1 ? "1 note" : `${notes.length} notes`}</b> for Claude</> : "Click a line number to leave a note for Claude"}</span>
        )}
        {decidable && notes.length > 0 && (
          <button type="button" className="btn btn-secondary btn-compact" onClick={() => requestChanges(card.id)}>
            Request changes
          </button>
        )}
      </div>
    </div>
  );
}

function TreeFile({ f, current, state, notes, onClick }: { f: ReviewFile; current: boolean; state: "yes" | "changed" | "no"; notes: boolean; onClick(): void }) {
  const name = f.path.slice(f.path.lastIndexOf("/") + 1);
  return (
    <button type="button" className={`rv-file${current ? " is-current" : ""}${state === "yes" ? " is-viewed" : ""}${f.flagged ? " is-flagged" : ""}`} onClick={onClick} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
      <span className={`rv-st rv-st-${f.status}`}>{STATUS_LETTER[f.status]}</span>
      <span className="rv-name">{name}</span>
      <span className="rv-fc">
        {notes && <span className="rv-note-dot" title="Has notes" />}
        {state === "yes" ? <span className="rv-tick" aria-label="viewed">✓</span> : state === "changed" ? <span className="rv-changed" title="Changed since you viewed it">●</span> : null}
        {state !== "yes" && (f.binary ? <span>bin</span> : <Counts f={f} />)}
      </span>
    </button>
  );
}

const Counts = ({ f }: { f: Pick<ReviewFile, "added" | "deleted"> }) => (
  <>
    {(f.added ?? 0) > 0 && <span className="ac-add">+{f.added}</span>}
    {(f.deleted ?? 0) > 0 && <span className="ac-del">−{f.deleted}</span>}
  </>
);

const NO_NOTES: ReviewNote[] = [];

interface FileProps {
  session: string;
  ask: string;
  /** The review it is part of, by `reviewOf`. */
  review: string;
  /** The card's commit: where new notes are left. */
  head: string;
  scope: Scope;
  file: ReviewFile;
  /** Whether it is viewed, where marks count: in the review of all changes. */
  viewed?: "yes" | "changed" | "no";
  /** The file's notes, where notes show: in the review of all changes. */
  notes?: ReviewNote[];
  canNote: boolean;
  split: boolean;
  whitespace: boolean;
  onViewed(f: ReviewFile, on: boolean): void;
  onFocus(path: string): void;
}

/** A note being written: where it goes, and the line it quotes. */
interface Draft {
  side: "old" | "new";
  line: number;
  quote: string;
  /** The note it changes, if it is one already. */
  id?: string;
}

const FileSection = memo(function FileSection({ ref, session, ask, review, head, scope, file: given, viewed, notes, canNote, split, whitespace, onViewed, onFocus }: FileProps & { ref?: (el: HTMLElement | null) => void }) {
  const [file, setFile] = useState(given);
  const [folded, setFolded] = useState(viewed === "yes");
  const [lines, setLines] = useState<string[]>();
  const [openGaps, setOpenGaps] = useState<ReadonlySet<number>>(new Set());
  const [loading, setLoading] = useState<string>();
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<Draft>();
  useEffect(() => setFile(given), [given]);
  // Marked viewed, here or with the keyboard, it folds; unmarked, it opens.
  const was = useRef(viewed);
  useEffect(() => {
    if (was.current !== viewed && (viewed === "yes" || was.current === "yes")) setFolded(viewed === "yes");
    was.current = viewed;
  }, [viewed]);

  const rows = useMemo(() => reviewRows(file, lines, openGaps), [file, lines, openGaps]);
  const tokens = useRowTokens(file.path, rows);
  // Notes at this commit go on their lines; ones left at an earlier commit, or on lines not shown, above the diff.
  const mine = useMemo(() => (notes ?? []).filter((n) => n.head === head), [notes, head]);
  const byKey = useMemo(() => {
    const m = new Map<string, ReviewNote[]>();
    for (const n of mine) m.set(noteKey(n.path, n.side, n.line), [...(m.get(noteKey(n.path, n.side, n.line)) ?? []), n]);
    return m;
  }, [mine]);
  const shownKeys = useMemo(() => new Set(rows.filter((r) => r.kind !== "gap").map((r) => target(file.path, r))), [rows, file.path]);
  const elsewhere = (notes ?? []).filter((n) => n.head !== head || !shownKeys.has(noteKey(n.path, n.side, n.line)));

  const expand = async (index: number) => {
    if (!lines) {
      if (!file.newBlob) return;
      setLoading("gap");
      try {
        const blob = await api.reviewBlob(session, ask, file.newBlob);
        if (blob.binary || blob.text === undefined) throw new Error("It's a binary file.");
        setLines(splitLines(blob.text));
      } catch (err) {
        setError(errorMessage(err));
        return;
      } finally {
        setLoading(undefined);
      }
    }
    setOpenGaps((s) => new Set([...s, index]));
  };
  const loadWhole = async () => {
    setLoading("file");
    setError(undefined);
    try {
      const d = await api.reviewDiff(session, ask, { ...scopeQuery(scope, whitespace), path: [file.path, ...(file.oldPath ? [file.oldPath] : [])] });
      const f = d.files.find((x) => x.path === file.path);
      if (f?.tooLarge) setError("It's too long to show here.");
      else if (f) setFile(f);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(undefined);
    }
  };

  const save = (text: string) => {
    if (!draft) return;
    const t = text.trim();
    setReview(session, review, (r) => {
      const rest = r.notes.filter((n) => n.id !== draft.id);
      if (!t) return { ...r, notes: rest };
      const note: ReviewNote = { id: draft.id ?? crypto.randomUUID(), path: file.path, side: draft.side, line: draft.line, quote: draft.quote, text: t, head };
      return { ...r, notes: [...rest, note] };
    });
    setDraft(undefined);
  };
  const remove = (id: string) => setReview(session, review, (r) => ({ ...r, notes: r.notes.filter((n) => n.id !== id) }));

  const startNote = (side: "old" | "new", line: number, quote: string) => {
    if (canNote) setDraft({ side, line, quote });
  };
  const noteRows = (keys: string[], cols: number) => {
    const out: ReactNode[] = [];
    for (const key of keys) {
      for (const n of byKey.get(key) ?? [])
        out.push(
          <tr key={n.id} className="rv-note-row">
            <td colSpan={cols}>{draft?.id === n.id ? <NoteEditor initial={n.text} line={n.line} onSave={save} onCancel={() => setDraft(undefined)} /> : <NoteView n={n} canEdit={canNote} onEdit={() => setDraft({ side: n.side, line: n.line, quote: n.quote, id: n.id })} onDelete={() => remove(n.id)} />}</td>
          </tr>,
        );
      if (draft && !draft.id && noteKey(file.path, draft.side, draft.line) === key)
        out.push(
          <tr key="draft" className="rv-note-row">
            <td colSpan={cols}>
              <NoteEditor line={draft.line} onSave={save} onCancel={() => setDraft(undefined)} />
            </td>
          </tr>,
        );
    }
    return out;
  };

  // A line number, which leaves a note on its row's line: the new side's, but for a removed line.
  const lineNo = (n: number | undefined, r: ReviewRow, cls = "") => {
    if (n === undefined) return <td className={`rv-n ${cls}`} />;
    if (!canNote) return <td className={`rv-n ${cls}`}>{n}</td>;
    const side = r.kind === "remove" ? "old" : "new";
    const line = side === "old" ? r.old! : r.new!;
    return (
      <td className={`rv-n ${cls}`}>
        <button type="button" className="rv-n-btn" aria-label={`Leave a note on ${side === "old" ? "removed " : ""}line ${line}`} onClick={() => startNote(side, line, r.text)}>
          {n}
        </button>
      </td>
    );
  };

  const gapRow = (r: ReviewRow, cols: number) => (
    <tr key={`gap${r.gap!.index}`} className="rv-gap">
      <td colSpan={cols}>
        {file.newBlob && !file.binary ? (
          <button type="button" className="rv-gap-btn" disabled={loading === "gap"} onClick={() => void expand(r.gap!.index)}>
            {r.skipped === undefined ? "↓ Show the rest of the file" : `↕ Show ${r.skipped} unchanged line${r.skipped === 1 ? "" : "s"}`}
          </button>
        ) : (
          <span>{r.skipped ?? ""} unchanged lines</span>
        )}
      </td>
    </tr>
  );

  const body = () => {
    if (file.binary) return <p className="rv-note-line">Binary file{file.status === "added" ? ", added" : file.status === "deleted" ? ", deleted" : ""}.</p>;
    if (file.tooLarge)
      return (
        <p className="rv-note-line">
          {(file.added ?? 0) + (file.deleted ?? 0)} changed lines, more than the review shows at once.{" "}
          <button type="button" className="link-btn" disabled={loading === "file"} onClick={() => void loadWhole()}>
            {loading === "file" ? "Loading…" : "Show them"}
          </button>
        </p>
      );
    if (file.whitespaceOnly) return <p className="rv-note-line">Only whitespace changed.</p>;
    if (!file.hunks.length) return <p className="rv-note-line">{file.status === "renamed" ? "Renamed, with no changes." : file.oldMode ? "Only its mode changed." : "No changes to its lines."}</p>;
    if (split)
      return (
        <table className="rv-d is-split">
          <colgroup>
            <col className="rv-col-n" />
            <col className="rv-col-s" />
            <col />
            <col className="rv-col-n" />
            <col className="rv-col-s" />
            <col />
          </colgroup>
          <tbody>
            {splitRows(rows).map((s, k) => {
              if (s.gap) return gapRow(s.gap, 6);
              const { left: l, right: r } = s;
              const keys = [...new Set([l, r].filter((x): x is ReviewRow => Boolean(x)).map((x) => target(file.path, x)))];
              const cls = (row: ReviewRow | undefined) => (!row ? "is-empty" : row.kind === "remove" ? "is-del" : row.kind === "add" ? "is-add" : "");
              return [
                <tr key={k}>
                  {l ? lineNo(l.old, l, cls(l)) : <td className="rv-n is-empty" />}
                  <td className={`rv-s ${cls(l)}`}>{l?.kind === "remove" ? "−" : ""}</td>
                  <td className={`rv-code ${cls(l)}`}>{l && <Code r={l} tokens={tokens} />}</td>
                  {r ? lineNo(r.new, r, `rv-mid ${cls(r)}`) : <td className="rv-n rv-mid is-empty" />}
                  <td className={`rv-s ${cls(r)}`}>{r?.kind === "add" ? "+" : ""}</td>
                  <td className={`rv-code ${cls(r)}`}>{r && <Code r={r} tokens={tokens} />}</td>
                </tr>,
                ...noteRows(keys, 6),
              ];
            })}
          </tbody>
        </table>
      );
    return (
      <table className="rv-d">
        <colgroup>
          <col className="rv-col-n" />
          <col className="rv-col-n" />
          <col className="rv-col-s" />
          <col />
        </colgroup>
        <tbody>
          {rows.map((r, k) => {
            if (r.kind === "gap") return gapRow(r, 4);
            const cls = r.kind === "remove" ? "is-del" : r.kind === "add" ? "is-add" : "";
            return [
              <tr key={k} className={cls}>
                {lineNo(r.old, r)}
                {lineNo(r.new, r)}
                <td className="rv-s">{r.kind === "remove" ? "−" : r.kind === "add" ? "+" : ""}</td>
                <td className="rv-code">
                  <Code r={r} tokens={tokens} />
                </td>
              </tr>,
              ...noteRows([target(file.path, r)], 4),
            ];
          })}
        </tbody>
      </table>
    );
  };

  const i = file.path.lastIndexOf("/");
  return (
    <section ref={ref} className={`rv-file-sec${folded ? " is-folded" : ""}`} onFocusCapture={() => onFocus(file.path)} onClickCapture={() => onFocus(file.path)}>
      <div className="rv-fh">
        <button type="button" className="rv-caret" aria-expanded={!folded} aria-label={folded ? "Show the diff" : "Hide the diff"} onClick={() => setFolded((f) => !f)}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 3h8L5 8z" fill="currentColor" />
          </svg>
        </button>
        <span className="rv-path" title={file.path}>
          {file.oldPath && <span className="rv-old-path">{file.oldPath} → </span>}
          <span className="rv-path-dir">{file.path.slice(0, i + 1)}</span>
          <b>{file.path.slice(i + 1)}</b>
        </span>
        {file.status === "added" && <span className="tool-tag tool-tag-new">new</span>}
        {file.status === "deleted" && <span className="tool-tag rv-tag-del">deleted</span>}
        {file.oldMode && <span className="tool-tag">{file.oldMode} → {file.newMode}</span>}
        {file.flagged && <span className="tool-tag rv-tag-warn">⚠ CI config</span>}
        {viewed === "changed" && <span className="tool-tag rv-tag-warn">changed since viewed</span>}
        <span className="rv-spacer" />
        <span className="line-counts">{file.binary ? <span className="dim">binary</span> : <Counts f={file} />}</span>
        {viewed !== undefined && (
          <label className={`rv-viewed${viewed === "yes" ? " is-on" : ""}`}>
            <input
              type="checkbox"
              checked={viewed === "yes"}
              onChange={(e) => onViewed(file, e.target.checked)}
            />{" "}
            Viewed
          </label>
        )}
      </div>
      {!folded && (
        <div className="rv-fbody">
          {file.flagged && (
            <div className="rv-flag">
              <span className="ac-warn">⚠</span> GitHub runs this branch's own workflows when it's pushed, with the repository's secrets.
            </div>
          )}
          {error && <p className="rv-error">{error}</p>}
          {elsewhere.length > 0 && (
            <div className="rv-elsewhere">
              {elsewhere.map((n) => (
                <NoteView key={n.id} n={n} canEdit={false} onDelete={canNote ? () => remove(n.id) : undefined} where={n.head === head ? "hidden" : "earlier"} />
              ))}
            </div>
          )}
          {body()}
        </div>
      )}
    </section>
  );
});

/** Where a note on a row goes: the line on the new side, or the old side's for a removed line. */
const target = (path: string, r: ReviewRow) => (r.kind === "remove" ? noteKey(path, "old", r.old!) : noteKey(path, "new", r.new!));

function Code({ r, tokens }: { r: ReviewRow; tokens: ReadonlyMap<string, Token[]> }) {
  return <Highlighted text={r.text} tokens={tokens.get(rowKey(r))} mark={r.mark} markClass="rv-mark" />;
}

/** A note; `where` says why it isn't on its line: left at an earlier commit, or on a line the diff doesn't show. */
function NoteView({ n, canEdit, onEdit, onDelete, where }: { n: ReviewNote; canEdit: boolean; onEdit?(): void; onDelete?(): void; where?: "earlier" | "hidden" }) {
  const line = `${n.side === "old" ? "removed " : ""}line ${n.line}`;
  return (
    <div className="rv-note">
      <div className="rv-note-h">
        <b>You</b> on {where === "earlier" ? `${line} at ${short(n.head)}, an earlier commit` : where === "hidden" ? `${line}, not in the diff now` : line}
        <span className="rv-spacer" />
        {canEdit && onEdit && (
          <button type="button" className="link-btn" onClick={onEdit}>
            Edit
          </button>
        )}
        {onDelete && (canEdit || where) && (
          <button type="button" className="link-btn" onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
      <div className="rv-note-b">{n.text}</div>
    </div>
  );
}

function NoteEditor({ initial = "", line, onSave, onCancel }: { initial?: string; line: number; onSave(text: string): void; onCancel(): void }) {
  const [text, setText] = useState(initial);
  return (
    <div className="rv-note is-editing">
      <textarea
        className="rv-note-ta"
        autoFocus
        value={text}
        placeholder={`A note for Claude on line ${line}`}
        aria-label={`Note on line ${line}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSave(text);
          }
        }}
      />
      <div className="rv-note-f">
        <span className="rv-note-hint">Goes to Claude when you request changes</span>
        <button type="button" className="btn btn-secondary btn-compact" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary btn-compact" disabled={!text.trim() && !initial} onClick={() => onSave(text)}>
          {initial ? "Save" : "Add note"}
        </button>
      </div>
    </div>
  );
}

