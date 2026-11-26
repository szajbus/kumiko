import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { threadUnread, threadWhere, type ApprovalCard, type DeliverCard, type ReviewDiff, type ReviewFile, type ReviewThread, type SessionEvent, type ThreadAnchor } from "@kumiko/shared";
import { api, errorMessage } from "./api";
import { splitLines } from "./diff";
import { Highlighted } from "./Highlighted";
import { rowKey, useRowTokens, type Token } from "./highlight";
import { PaneGrip } from "./PaneGrip";
import {
  byFolder,
  getReview,
  initialScope,
  markable,
  newCommits,
  noteComment,
  noteKey,
  onFocusThread,
  prUpdate,
  requestChanges,
  restamp,
  reviewOf,
  reviewPrefs,
  reviewRows,
  setReview,
  splitRows,
  scopeFrom,
  scopeQuery,
  subscribeReviews,
  takeFocus,
  threadCounts,
  threadFits,
  threadKey,
  threadPath,
  touched,
  unreadOrder,
  viewedMarks,
  viewedState,
  type Scope,
  type ReviewRow,
} from "./review";
import { CommentEditor, ThreadView, type ThreadActions } from "./ReviewThreads";
import { WindowContext } from "./windowContext";

const short = (sha: string) => sha.slice(0, 7);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A card reviewed again from the pane, from the head it was at: the pane opens on what changed since. */
let refreshedFrom: { ask: string; head: string } | undefined;
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
export function ReviewPane({ session, pane, ask, refreshed, events }: { session: string; pane: string; ask: string; refreshed?: string; events: readonly SessionEvent[] }) {
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
  return <ReviewBody key={`${card.id}|${c.head}`} session={session} pane={pane} card={card} c={c} refreshed={refreshed} />;
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

function ReviewBody({ session, pane, card, c, refreshed }: { session: string; pane: string; card: ApprovalCard; c: DeliverCard; refreshed?: string }) {
  const ctx = useContext(WindowContext);
  const rkey = reviewOf(c);
  const review = useSyncExternalStore(subscribeReviews, () => getReview(session, rkey));
  const prefs = useSyncExternalStore(reviewPrefs.subscribe, reviewPrefs.get);
  const [scope, setScope] = useState<Scope>(() => {
    const from = refreshedFrom?.ask === card.id ? refreshedFrom.head : undefined;
    refreshedFrom = undefined;
    return from && from !== c.head ? { kind: "since", sha: from } : initialScope(c);
  });
  const [diff, setDiff] = useState<ReviewDiff>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState("");
  const [current, setCurrent] = useState<string>();
  const sections = useRef(new Map<string, HTMLElement>());
  const open = card.state === "open" || card.state === "stale";
  const decidable = open && Boolean(ctx?.live);
  const root = useRef<HTMLDivElement>(null);
  const allThreads = ctx?.threads;
  const threads = useMemo(() => (allThreads ?? []).filter((t) => t.review === rkey), [allThreads, rkey]);
  const counts = threadCounts(threads);
  const [focused, setFocused] = useState<string>();
  const [target, setTarget] = useState<{ id: string; n: number }>();
  const [topDraft, setTopDraft] = useState(false);
  const [sending, setSending] = useState(false);
  const all = scope.kind === "all";
  // Viewed marks and notes work where the diff ends at the card's commit: all changes, or what changed since one.
  const marks = markable(scope);

  // The heads the user reviewed at, for "since": this one goes last.
  useEffect(() => {
    setReview(session, rkey, (r) => (r.seen.at(-1) === c.head ? r : { ...r, seen: [...r.seen.filter((h) => h !== c.head), c.head].slice(-10) }));
  }, [session, rkey, c.head]);
  // Files viewed at an earlier head that haven't changed since are viewed at this one too. The view of all changes
  // says which those are; when the pane opens on another, they are read from all changes once.
  useEffect(() => {
    if (initialScope(c).kind === "all") return;
    let gone = false;
    api
      .reviewDiff(session, card.id, {})
      .then((d) => !gone && setReview(session, rkey, (r) => restamp(r, c.head, d.files)))
      .catch(() => {});
    return () => {
      gone = true;
    };
    // Once per card: the pane starts over for another head.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const before = review.seen.at(-1) === c.head ? review.seen.at(-2) : review.seen.at(-1);
  // A card that adds to an open PR: what's new is what the PR doesn't show yet.
  const upd = useMemo(() => prUpdate(c), [c]);
  const onlyNew = scope.kind === "since" && scope.sha === upd?.from;
  const fresh = useMemo(() => newCommits(c), [c]);

  useEffect(() => {
    let gone = false;
    setError(undefined);
    api
      .reviewDiff(session, card.id, scopeQuery(scope, prefs.whitespace))
      .then((d) => {
        if (gone) return;
        setDiff(d);
        if (scope.kind === "all") setReview(session, rkey, (r) => restamp(r, c.head, d.files));
      })
      .catch((err) => !gone && setError(errorMessage(err)));
    return () => {
      gone = true;
    };
  }, [session, card.id, rkey, c.head, scope, prefs.whitespace]);

  const files = useMemo(() => (diff ? byFolder(diff.files).flatMap(([, fs]) => fs) : []), [diff]);
  const notes = review.notes;
  const threadsByPath = useMemo(() => {
    const m = new Map<string, ReviewThread[]>();
    for (const t of threads) {
      const p = threadPath(t.anchor);
      if (p) m.set(p, [...(m.get(p) ?? []), t]);
    }
    return m;
  }, [threads]);
  const top = threads.filter((t) => t.anchor.kind === "change" || (t.anchor.kind === "commit" && (scope.kind !== "commit" || scope.sha === t.anchor.sha)));

  // Threads started at an earlier commit: whether what they're on changed since, read from the mirror.
  const [outdated, setOutdated] = useState<ReadonlySet<string>>(new Set());
  const earlier = threads.filter((t) => t.head !== c.head && threadPath(t.anchor) !== undefined && !t.resolved);
  const earlierKey = earlier.map((t) => t.id).join(",");
  useEffect(() => {
    let gone = false;
    const byHead = new Map<string, ReviewThread[]>();
    for (const t of earlier) byHead.set(t.head, [...(byHead.get(t.head) ?? []), t]);
    void Promise.all(
      [...byHead].map(([head, ts]) =>
        api
          .reviewDiff(session, card.id, { since: head, path: [...new Set(ts.map((t) => threadPath(t.anchor)!))] })
          .then((d) => ts.filter((t) => touched(t, d.files.find((f) => f.path === threadPath(t.anchor)))).map((t) => t.id))
          .catch(() => [] as string[]),
      ),
    ).then((ids) => !gone && setOutdated(new Set(ids.flat())));
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, card.id, earlierKey]);

  const actions = useMemo<ThreadActions>(
    () => ({
      reply: (t, text) =>
        api.comment(session, card.id, { thread: t.id, text }).then(
          () => undefined,
          (err: unknown) => errorMessage(err),
        ),
      mark: (t, change) => void api.markThread(session, t.id, change).catch((err) => console.error(err)),
    }),
    [session, card.id],
  );
  const startThread = useCallback(
    (anchor: ThreadAnchor, text: string) =>
      api.comment(session, card.id, { anchor, text }).then(
        () => undefined,
        (err: unknown) => errorMessage(err),
      ),
    [session, card.id],
  );
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
  const viewed = marks ? files.filter((f) => viewedState(review, f) === "yes").length : 0;

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

  /** Shows thread `t`: in the view and the file it is in, unfolded, scrolled to. */
  const goThread = (t: ReviewThread) => {
    const path = threadPath(t.anchor);
    if (t.anchor.kind === "commit" ? scope.kind === "commit" && scope.sha !== t.anchor.sha : scope.kind === "commit" || (path !== undefined && diff !== undefined && !files.some((f) => f.path === path))) setScope({ kind: "all" });
    if (path && filter.trim() && !path.toLowerCase().includes(filter.trim().toLowerCase())) setFilter("");
    if (path) setCurrent(path);
    setFocused(t.id);
    setTarget({ id: t.id, n: Date.now() });
  };
  useEffect(() => {
    if (!target) return;
    const frame = requestAnimationFrame(() => root.current?.querySelector(`[data-thread="${CSS.escape(target.id)}"]`)?.scrollIntoView({ block: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [target, diff]);
  const unreadList = unreadOrder(threads, files.map((f) => f.path), c.commits.map((x) => x.sha));
  const nextReply = (dir: 1 | -1) => {
    if (!unreadList.length) return;
    const i = unreadList.findIndex((t) => t.id === focused);
    goThread(unreadList[i < 0 ? (dir === 1 ? 0 : unreadList.length - 1) : (i + dir + unreadList.length) % unreadList.length]);
  };
  // The chat asks for a thread: shown once the diff is here.
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const goRef = useRef(goThread);
  goRef.current = goThread;
  useEffect(() => {
    if (!diff) return;
    const check = () => {
      const id = takeFocus(card.id);
      const t = id && threadsRef.current.find((x) => x.id === id);
      if (t) goRef.current(t);
    };
    check();
    return onFocusThread(check);
  }, [diff, card.id]);

  const refresh = () => {
    refreshedFrom = { ask: card.id, head: c.head };
    void api.decideCard(session, card.id, { action: "refresh" }).catch((err) => {
      refreshedFrom = undefined;
      setError(errorMessage(err));
    });
  };
  const sendNotes = async () => {
    setSending(true);
    for (const n of notes) {
      const { anchor, text } = noteComment(n, c.head);
      const err = await startThread(anchor, text);
      if (err) {
        setError(err);
        break;
      }
      setReview(session, rkey, (r) => ({ ...r, notes: r.notes.filter((x) => x.id !== n.id) }));
    }
    setSending(false);
  };
  // The keys go through the files the list shows.
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
    const i = shownFiles.findIndex((f) => f.path === current);
    if (e.key === "j" || e.key === "k") {
      if (!shownFiles.length) return;
      e.preventDefault();
      go(shownFiles[i < 0 ? 0 : Math.min(shownFiles.length - 1, Math.max(0, i + (e.key === "j" ? 1 : -1)))].path);
    } else if (e.key === "v" && marks && i >= 0) {
      e.preventDefault();
      setViewed(shownFiles[i], viewedState(review, shownFiles[i]) !== "yes");
    } else if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      nextReply(e.shiftKey ? -1 : 1);
    } else if (e.key === "a") {
      const t = threads.find((x) => x.id === focused);
      if (t) {
        e.preventDefault();
        actions.mark(t, { read: true });
      }
    }
  };

  const commitCount = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;
  const scopeLabel = scope.kind === "all" ? `All ${commitCount(c.commits.length)}` : onlyNew ? `New since PR #${upd!.number} · ${commitCount(upd!.fresh.size)}` : scope.kind === "since" ? `Since ${short(scope.sha)}` : `${short(scope.sha)} · ${c.commits.find((x) => x.sha === scope.sha)?.subject ?? ""}`;
  const scopeId = scope.kind === "all" ? "all" : `${scope.kind}:${scope.sha}`;

  return (
    // Focusable, so a click anywhere in it lets the keys reach it.
    <div className="rv" tabIndex={-1} onKeyDown={onKey} ref={root}>
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
              {upd && (
                <Menu.Item className="menu-item rv-mi" onSelect={() => setScope({ kind: "since", sha: upd.from })}>
                  <span className="rv-ck">{onlyNew ? "✓" : ""}</span>
                  <span>New since PR #{upd.number}</span>
                  <span className="rv-mi-d">what the PR doesn't have yet</span>
                </Menu.Item>
              )}
              {before && before !== upd?.from && (
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
                  {fresh?.has(x.sha) ? <span className="rv-new">new</span> : <span />}
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
        {counts.unread > 0 && (
          <span className="rv-replies">
            <b>{plural(counts.unread, "new reply", "new replies")}</b>
            <button type="button" className="btn btn-secondary btn-compact" onClick={() => nextReply(1)} title="Next unread reply (n)">
              Next reply
            </button>
            <button type="button" className="link-btn" onClick={() => void api.readThreads(session, rkey).catch((err) => console.error(err))}>
              Mark all read
            </button>
          </span>
        )}
        {marks && diff && (
          <span className="rv-prog">
            {viewed} / {files.length} viewed
            <span className="rv-prog-bar">
              <i style={{ width: `${files.length ? (viewed / files.length) * 100 : 0}%` }} />
            </span>
          </span>
        )}
      </div>
      {upd && open && (
        <div className="rv-pr">
          <span>
            {fresh
              ? `PR #${upd.number} has ${commitCount(c.commits.length - upd.fresh.size)} of these already; ${upd.fresh.size === 1 ? "1 is" : `${upd.fresh.size} are`} new.`
              : `${c.branch} was rewritten since PR #${upd.number} got it.`}
          </span>
          <button type="button" className="rv-pr-btn" onClick={() => setScope(onlyNew ? { kind: "all" } : { kind: "since", sha: upd.from })}>
            {onlyNew ? "Show all changes" : fresh ? "Show only what's new" : "Show what changes on the PR"}
          </button>
        </div>
      )}
      {card.state === "stale" && (
        <div className="rv-banner rv-moved">
          <span>
            {card.moved?.commits ? `${plural(card.moved.commits, "new commit")} on ${c.branch} since you opened this.` : `${c.branch} moved since you opened this.`} You're reading {short(c.head)}, the commit this card is for.
          </span>
          {decidable && (
            <button type="button" className="rv-pr-btn" onClick={refresh}>
              Show
            </button>
          )}
        </div>
      )}
      {decidable && notes.length > 0 && (
        <div className="rv-pr">
          <span>{plural(notes.length, "note")} from before comments went to Claude straight away.</span>
          <button type="button" className="rv-pr-btn" disabled={sending} onClick={() => void sendNotes()}>
            {sending ? "Sending…" : notes.length === 1 ? "Send it to Claude" : "Send them to Claude"}
          </button>
          <button type="button" className="rv-pr-btn" disabled={sending} onClick={() => setReview(session, rkey, (r) => ({ ...r, notes: [] }))}>
            Delete {notes.length === 1 ? "it" : "them"}
          </button>
        </div>
      )}
      {!open && <div className="rv-banner">This card is closed.</div>}
      {open && refreshed && (
        <div className="rv-pr">
          <span>Refreshed: Claude delivered {c.branch} again{refreshed === c.head ? "" : `, at ${short(c.head)}`}. This is the new card.</span>
          {refreshed !== c.head && (
            <button type="button" className="rv-pr-btn" onClick={() => setScope(scope.kind === "since" && scope.sha === refreshed ? { kind: "all" } : { kind: "since", sha: refreshed })}>
              {scope.kind === "since" && scope.sha === refreshed ? "Show all changes" : `Show what changed since ${short(refreshed)}`}
            </button>
          )}
        </div>
      )}
      <div className="rv-body">
        <nav className="rv-tree" aria-label="Changed files">
          <input className="rv-filter" placeholder="Filter files" aria-label="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {byFolder(shownFiles).map(([dir, fs]) => (
            <div key={dir}>
              {dir && <div className="rv-dir">{dir}/</div>}
              {fs.map((f) => (
                <TreeFile key={f.path} f={f} current={f.path === current} state={marks ? viewedState(review, f) : "no"} threads={threadsByPath.get(f.path)} onClick={() => go(f.path)} />
              ))}
            </div>
          ))}
          {diff && (
            <div className="rv-sum">
              {files.length} file{files.length === 1 ? "" : "s"} changed in {scope.kind === "commit" ? "1 commit" : commitCount(onlyNew ? upd!.fresh.size : c.commits.length)} ·{" "}
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
          ) : null}
          {!error && diff?.message !== undefined && (scope.kind === "commit" || (all && c.commits.length === 1)) && (
            <CommitMessage sha={scope.kind === "commit" ? scope.sha : c.commits[0].sha} message={diff.message} author={(scope.kind === "commit" ? c.commits.find((x) => x.sha === scope.sha) : c.commits[0])?.author} />
          )}
          {!error && diff && (top.length > 0 || decidable) && (
            <div className="rv-top">
              {top.map((t) => (
                <ThreadView key={t.id} t={t} where={t.anchor.kind === "commit" ? `On ${threadWhere(t.anchor)}` : "On the whole change"} head={c.head} canReply={decidable} actions={actions} focused={focused === t.id} />
              ))}
              {decidable &&
                (topDraft ? (
                  <CommentEditor
                    placeholder={scope.kind === "commit" ? `Ask Claude about commit ${short(scope.sha)}, or ask for a change` : "Ask Claude about the whole change, or ask for a change"}
                    onSend={async (text) => {
                      const err = await startThread(scope.kind === "commit" ? { kind: "commit", sha: scope.sha } : { kind: "change" }, text);
                      if (!err) setTopDraft(false);
                      return err;
                    }}
                    onCancel={() => setTopDraft(false)}
                  />
                ) : (
                  <button type="button" className="rv-thread-reply rv-top-add" onClick={() => setTopDraft(true)}>
                    {scope.kind === "commit" ? "Comment on this commit…" : "Comment on the whole change…"}
                  </button>
                ))}
            </div>
          )}
          {error || !diff ? null : !files.length ? (
            <p className="rv-empty">{onlyNew ? `Nothing new in the branch's own files since PR #${upd!.number}.` : scope.kind === "since" ? "Nothing changed since then." : "No changes."}</p>
          ) : (
            files.map((f) => (
              <FileSection
                // Another scope or whitespace is another diff of the file: its content and open gaps were for this one.
                key={`${scopeId}|${prefs.whitespace}|${f.path}`}
                ref={refFor(f.path)}
                session={session}
                ask={card.id}
                head={c.head}
                scope={scope}
                file={f}
                viewed={marks ? viewedState(review, f) : undefined}
                threads={threadsByPath.get(f.path) ?? NO_THREADS}
                inView={marks}
                canComment={decidable}
                actions={actions}
                startThread={startThread}
                outdated={outdated}
                focused={focused}
                reveal={target}
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
          <kbd>j</kbd> <kbd>k</kbd> next / previous file{marks && (
            <>
              {" "}
              · <kbd>v</kbd> viewed
            </>
          )}
          {threads.length > 0 && (
            <>
              {" "}
              · <kbd>n</kbd> next reply · <kbd>a</kbd> got it
            </>
          )}
        </span>
        <span className="rv-spacer" />
        {decidable && (
          <span className="rv-notes">
            {counts.open ? (
              <>
                <b>{plural(counts.open, "open thread")}</b>
                {counts.willChange > 0 && ` · Claude will change ${plural(counts.willChange, "thing")}`}
              </>
            ) : (
              "Click a line number to ask Claude about it"
            )}
          </span>
        )}
        {decidable && counts.willChange > 0 && (
          <button type="button" className="btn btn-secondary btn-compact" onClick={() => requestChanges(card.id)}>
            Request changes ({counts.willChange})
          </button>
        )}
      </div>
    </div>
  );
}

/** One commit's message, above its diff: its subject, then the rest as written. */
function CommitMessage({ sha, message, author }: { sha: string; message: string; author?: string }) {
  const nl = message.indexOf("\n");
  const subject = nl < 0 ? message : message.slice(0, nl);
  const rest = nl < 0 ? "" : message.slice(nl).replace(/^\n+/, "");
  return (
    <div className="rv-commit">
      <div className="rv-commit-h">
        <b>{subject}</b>
        <span className="rv-spacer" />
        <span className="rv-commit-meta">
          {author ? `${author} · ` : ""}
          <code title={sha}>{short(sha)}</code>
        </span>
      </div>
      {rest && <pre className="rv-commit-b">{rest}</pre>}
    </div>
  );
}

function TreeFile({ f, current, state, threads, onClick }: { f: ReviewFile; current: boolean; state: "yes" | "changed" | "no"; threads?: ReviewThread[]; onClick(): void }) {
  const unread = threads?.some((t) => threadUnread(t) > 0);
  const open = threads?.some((t) => !t.resolved);
  const name = f.path.slice(f.path.lastIndexOf("/") + 1);
  return (
    <button type="button" className={`rv-file${current ? " is-current" : ""}${state === "yes" ? " is-viewed" : ""}${f.flagged ? " is-flagged" : ""}`} onClick={onClick} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
      <span className={`rv-st rv-st-${f.status}`}>{STATUS_LETTER[f.status]}</span>
      <span className="rv-name">{name}</span>
      <span className="rv-fc">
        {unread ? <span className="rv-unread-dot" title="Unread replies" /> : open ? <span className="rv-note-dot" title="Has open threads" /> : null}
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

const NO_THREADS: ReviewThread[] = [];

interface FileProps {
  session: string;
  ask: string;
  /** The card's commit: where new threads start. */
  head: string;
  scope: Scope;
  file: ReviewFile;
  /** Whether it is viewed, where marks count: in a diff that ends at the card's commit. */
  viewed?: "yes" | "changed" | "no";
  /** The file's threads: on its lines, and on all of it. */
  threads: ReviewThread[];
  /** The diff ends at the card's commit, so line threads can go on its lines: not one commit's. */
  inView: boolean;
  canComment: boolean;
  actions: ThreadActions;
  startThread(anchor: ThreadAnchor, text: string): Promise<string | undefined>;
  /** Threads whose line or file changed since they were started. */
  outdated: ReadonlySet<string>;
  focused?: string;
  /** A thread being gone to: its file unfolds. */
  reveal?: { id: string; n: number };
  split: boolean;
  whitespace: boolean;
  onViewed(f: ReviewFile, on: boolean): void;
  onFocus(path: string): void;
}

/** A comment being written that starts a thread: on a line, which it quotes, or on the whole file. */
type Draft = { side: "old" | "new"; line: number; quote: string } | { file: true };

const FileSection = memo(function FileSection({ ref, session, ask, head, scope, file: given, viewed, threads, inView, canComment, actions, startThread, outdated, focused, reveal, split, whitespace, onViewed, onFocus }: FileProps & { ref?: (el: HTMLElement | null) => void }) {
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
  // Threads on this diff's lines go on them; ones started at an earlier commit, in another view, or on lines not shown,
  // above the diff, with the file's own.
  const from = scopeFrom(scope);
  const mine = useMemo(() => (inView ? threads.filter((t) => threadFits(t, head, from)) : []), [threads, inView, head, from]);
  const byKey = useMemo(() => {
    const m = new Map<string, ReviewThread[]>();
    for (const t of mine) m.set(threadKey(t)!, [...(m.get(threadKey(t)!) ?? []), t]);
    return m;
  }, [mine]);
  const shownKeys = useMemo(() => new Set(rows.filter((r) => r.kind !== "gap").map((r) => target(file.path, r))), [rows, file.path]);
  const onLines = new Set(mine.filter((t) => shownKeys.has(threadKey(t)!)).map((t) => t.id));
  const fileThreads = threads.filter((t) => t.anchor.kind === "file");
  const elsewhere = threads.filter((t) => t.anchor.kind === "line" && !onLines.has(t.id));
  // Gone to from the toolbar or the chat: open, so the thread shows.
  useEffect(() => {
    if (reveal && threads.some((t) => t.id === reveal.id)) setFolded(false);
  }, [reveal, threads]);
  const lineWhere = (t: ReviewThread) => {
    const a = t.anchor;
    if (a.kind !== "line") return undefined;
    const line = `${a.side === "old" ? "Removed line" : "Line"} ${a.line}`;
    return t.head !== head ? `${line}, at an earlier commit` : !threadFits(t, head, from) ? `${line}, in another view` : `${line}, not in the diff now`;
  };

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

  const send = async (text: string) => {
    if (!draft) return undefined;
    const anchor: ThreadAnchor = "file" in draft ? { kind: "file", path: file.path } : { kind: "line", path: file.path, side: draft.side, line: draft.line, quote: draft.quote, ...(draft.side === "old" && from ? { from } : {}) };
    const err = await startThread(anchor, text);
    if (!err) setDraft(undefined);
    return err;
  };

  const startComment = (side: "old" | "new", line: number, quote: string) => {
    if (canComment && inView) setDraft({ side, line, quote });
  };
  const view = (t: ReviewThread, where?: string) => <ThreadView key={t.id} t={t} where={where} head={head} canReply={canComment} actions={actions} outdated={outdated.has(t.id)} focused={focused === t.id} />;
  const noteRows = (keys: string[], cols: number) => {
    const out: ReactNode[] = [];
    for (const key of keys) {
      for (const t of byKey.get(key) ?? [])
        out.push(
          <tr key={t.id} className="rv-note-row">
            <td colSpan={cols}>{view(t)}</td>
          </tr>,
        );
      if (draft && !("file" in draft) && noteKey(file.path, draft.side, draft.line) === key)
        out.push(
          <tr key="draft" className="rv-note-row">
            <td colSpan={cols}>
              <CommentEditor placeholder={`Ask Claude about line ${draft.line}, or ask for a change`} onSend={send} onCancel={() => setDraft(undefined)} />
            </td>
          </tr>,
        );
    }
    return out;
  };

  // A line number, which starts a thread on its row's line: the new side's, but for a removed line.
  const lineNo = (n: number | undefined, r: ReviewRow, cls = "") => {
    if (n === undefined) return <td className={`rv-n ${cls}`} />;
    if (!canComment || !inView) return <td className={`rv-n ${cls}`}>{n}</td>;
    const side = r.kind === "remove" ? "old" : "new";
    const line = side === "old" ? r.old! : r.new!;
    return (
      <td className={`rv-n ${cls}`}>
        <button type="button" className="rv-n-btn" aria-label={`Comment on ${side === "old" ? "removed " : ""}line ${line}`} onClick={() => startComment(side, line, r.text)}>
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
        {canComment && (
          <button
            type="button"
            className="rv-fh-comment"
            aria-label={`Comment on ${file.path}`}
            title="Comment on this file"
            onClick={() => {
              setFolded(false);
              setDraft({ file: true });
            }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
          </button>
        )}
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
          {(fileThreads.length > 0 || elsewhere.length > 0 || (draft && "file" in draft)) && (
            <div className="rv-elsewhere">
              {fileThreads.map((t) => view(t, "On the file"))}
              {draft && "file" in draft && <CommentEditor placeholder={`Ask Claude about ${file.path}, or ask for a change`} onSend={send} onCancel={() => setDraft(undefined)} />}
              {elsewhere.map((t) => view(t, lineWhere(t)))}
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
