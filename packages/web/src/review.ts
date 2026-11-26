// The review pane's logic: a file's diff as rows, with the unchanged lines between hunks as gaps to open; what the
// user marked viewed, kept in the browser per card; the threads of comments and replies on the changes; and the
// reason a request for changes sends Claude.

import { reviewOf, threadUnread, threadWhere, type DeliverCard, type ReviewFile, type ReviewThread, type SessionEvent, type ThreadAnchor } from "@kumiko/shared";
import { marked, type DiffRow } from "./diff.ts";

/** A row of a review diff: a line, or a gap of unchanged lines, which `gap` says where to find. */
export interface ReviewRow extends DiffRow {
  /** For a gap: which one, and where its lines start on each side. `skipped` is undefined for the rest of the file. */
  gap?: { index: number; old: number; new: number };
}

/**
 * The rows of a file's diff. Each gap of unchanged lines (before, between and after the hunks) is a row of its own,
 * unless `open` has it and `lines` (the file's new content) is known, when its lines are shown as context.
 */
export function reviewRows(file: Pick<ReviewFile, "hunks" | "status">, lines?: string[], open: ReadonlySet<number> = new Set()): ReviewRow[] {
  const rows: ReviewRow[] = [];
  let o = 1;
  let n = 1;
  const gap = (index: number, count: number | undefined) => {
    if (count === 0) return;
    if (open.has(index) && lines) {
      const end = count === undefined ? lines.length : n - 1 + count;
      for (let k = n; k <= end; k++) rows.push({ kind: "context", text: lines[k - 1] ?? "", old: o++, new: n++ });
      return;
    }
    rows.push({ kind: "gap", text: "", ...(count !== undefined ? { skipped: count } : {}), gap: { index, old: o, new: n } });
    if (count !== undefined) {
      o += count;
      n += count;
    }
  };
  file.hunks.forEach((h, i) => {
    // A side with no lines starts at the line before it.
    const oldStart = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
    gap(i, Math.max(0, oldStart - o));
    o = oldStart;
    n = h.newLines === 0 ? h.newStart + 1 : h.newStart;
    for (const line of h.lines) {
      const text = line.slice(1);
      if (line[0] === "-") rows.push({ kind: "remove", text, old: o++ });
      else if (line[0] === "+") rows.push({ kind: "add", text, new: n++ });
      else if (line[0] === " ") rows.push({ kind: "context", text, old: o++, new: n++ });
    }
  });
  // After the last hunk: the rest of the file, as long as the content says, or of a length not known yet.
  if (file.hunks.length && file.status !== "added" && file.status !== "deleted") {
    const rest = lines ? Math.max(0, lines.length - (n - 1)) : undefined;
    gap(file.hunks.length, rest);
  }
  return marked(rows) as ReviewRow[];
}

/** One line of a split diff: the old side's row and the new side's, either missing where the other has none. */
export interface SplitRow {
  left?: ReviewRow;
  right?: ReviewRow;
  /** A gap, which spans both sides. */
  gap?: ReviewRow;
}

/** Rows side by side: context on both, a run of removals beside the additions that follow it. */
export function splitRows(rows: ReviewRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  for (let i = 0; i < rows.length; ) {
    const r = rows[i];
    if (r.kind === "gap") {
      out.push({ gap: r });
      i++;
    } else if (r.kind === "context") {
      out.push({ left: r, right: r });
      i++;
    } else {
      const dels: ReviewRow[] = [];
      const adds: ReviewRow[] = [];
      while (i < rows.length && rows[i].kind === "remove") dels.push(rows[i++]);
      while (i < rows.length && rows[i].kind === "add") adds.push(rows[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ left: dels[k], right: adds[k] });
    }
  }
  return out;
}

/**
 * A note the user left on a line before notes became threads, kept in the browser until they are sent as comments
 * or deleted. `side` says which version `line` is in: before or after.
 */
export interface ReviewNote {
  id: string;
  path: string;
  side: "old" | "new";
  line: number;
  /** The line's text when the note was left, to quote to Claude. */
  quote: string;
  text: string;
  /** The card's commit the note was left at: `line` is a line of that version. */
  head: string;
  /**
   * For a note on a removed line in a view of what changed since a commit, such as what's new on a PR: that commit,
   * which `line` is a line of. Undefined for one left in the view of all changes, where it is the branch's base.
   */
  from?: string;
}

/** Where a note sits: a file's line on one side. */
export const noteKey = (path: string, side: "old" | "new", line: number) => `${side}:${line}:${path}`;

/** A file the user marked viewed: its content then, and the card's commit it was checked against. */
export interface Viewed {
  blob: string;
  head: string;
}

export interface Review {
  viewed: Record<string, Viewed>;
  notes: ReviewNote[];
  /** The card's heads the user opened the pane at, oldest first: "since" compares with the one before this. */
  seen: string[];
}

const EMPTY: Review = { viewed: {}, notes: [], seen: [] };

/** What a file's viewed mark is compared with: its content after the change, or before it for a deleted file. */
export const fileBlob = (f: Pick<ReviewFile, "newBlob" | "oldBlob">) => f.newBlob ?? f.oldBlob ?? "";

/** Whether a file is viewed as it is now (`yes`), was viewed before it changed again (`changed`), or isn't. */
export function viewedState(review: Review, f: Pick<ReviewFile, "path" | "newBlob" | "oldBlob">): "yes" | "changed" | "no" {
  const v = review.viewed[f.path];
  if (!v) return "no";
  return v.blob === fileBlob(f) ? "yes" : "changed";
}

/** How many of the card's files the user viewed at the card's commit. */
export const viewedCount = (review: Review, card: Pick<DeliverCard, "files" | "head">) => card.files.filter((f) => review.viewed[f.path]?.head === card.head).length;

/**
 * The marks that say a file was viewed as it is at `head`. The card lists a renamed file as its old path deleted and
 * its new one added, so the old path is marked too, with the content it had.
 */
export function viewedMarks(f: Pick<ReviewFile, "path" | "oldPath" | "status" | "newBlob" | "oldBlob">, head: string): Record<string, Viewed> {
  return { [f.path]: { blob: fileBlob(f), head }, ...(f.oldPath && f.status === "renamed" ? { [f.oldPath]: { blob: f.oldBlob ?? "", head } } : {}) };
}

/**
 * Viewed marks brought up to the card's commit: a file whose content is the same as when it was viewed is viewed now
 * too; one that changed keeps its old mark, so it shows as changed since.
 */
export function restamp(review: Review, head: string, files: ReviewFile[]): Review {
  let changed = false;
  const viewed = { ...review.viewed };
  for (const f of files) {
    const v = viewed[f.path];
    if (v && v.head !== head && v.blob === fileBlob(f)) {
      Object.assign(viewed, viewedMarks(f, head));
      changed = true;
    }
  }
  return changed ? { ...review, viewed } : review;
}

const short = (sha: string) => sha.slice(0, 7);

// ---- threads -----------------------------------------------------------------------------------

/** Review `review`'s threads, from the session's events, in the order they were started. */
export function reviewThreads(events: readonly SessionEvent[], review: string): ReviewThread[] {
  const threads = new Map<string, ReviewThread>();
  for (const e of events) if (e.kind === "thread" && e.payload.review === review) threads.set(e.payload.id, e.payload);
  return [...threads.values()];
}

/** Where a thread is on a line, by `noteKey`; undefined for one that isn't on a line. */
export const threadKey = (t: ReviewThread) => (t.anchor.kind === "line" ? noteKey(t.anchor.path, t.anchor.side, t.anchor.line) : undefined);

/** The file a thread is about, if it is on one: a line of it, or all of it. */
export const threadPath = (a: ThreadAnchor) => (a.kind === "line" || a.kind === "file" ? a.path : undefined);

/** Whether line thread `t` is on a line of the diff from `from` (see `scopeFrom`) to `head`. */
export const threadFits = (t: ReviewThread, head: string, from: string | undefined) => t.anchor.kind === "line" && noteFits({ head: t.head, side: t.anchor.side, from: t.anchor.from }, head, from);

/**
 * Where a thread stands: resolved by the user; marked by Claude as something it will change; waiting for Claude's
 * reply to the user's last comment; or answered.
 */
export function threadState(t: ReviewThread): "resolved" | "requested" | "will-change" | "waiting" | "answered" {
  if (t.resolved) return "resolved";
  if (t.willChange && t.requested) return "requested";
  if (t.willChange) return "will-change";
  return t.messages.at(-1)?.by === "user" ? "waiting" : "answered";
}

/** The threads Claude said it would change something for, and the user hasn't resolved: what a request for changes asks. */
export const toChange = (threads: readonly ReviewThread[]) => threads.filter((t) => t.willChange && !t.requested && !t.resolved);

/** Counts for the card and the pane: open threads, those Claude will change something for, and unread replies. */
export function threadCounts(threads: readonly ReviewThread[]): { open: number; willChange: number; unread: number } {
  return { open: threads.filter((t) => !t.resolved).length, willChange: toChange(threads).length, unread: threads.reduce((n, t) => n + threadUnread(t), 0) };
}

/**
 * The threads with unread replies, in the order the pane shows them: the whole change's, the commits' (in the card's
 * order), then the files' in `files` order, by line.
 */
export function unreadOrder(threads: readonly ReviewThread[], files: readonly string[], commits: readonly string[]): ReviewThread[] {
  const rank = (t: ReviewThread): [number, number, number] => {
    const a = t.anchor;
    if (a.kind === "change") return [0, 0, 0];
    if (a.kind === "commit") return [1, commits.indexOf(a.sha), 0];
    const f = files.indexOf(a.path);
    return [2, f < 0 ? files.length : f, a.kind === "file" ? 0 : a.line];
  };
  return threads
    .filter((t) => threadUnread(t) > 0)
    .map((t) => [t, rank(t)] as const)
    .sort(([, x], [, y]) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2])
    .map(([t]) => t);
}

/**
 * Whether `file`, as a diff since the thread's commit has it, changes what thread `t` is on: the line (on the side
 * after the change, as the thread numbered it), or for a file thread, anything in the file. A removed line's thread
 * counts the file changing. `file` undefined: the file didn't change since.
 */
export function touched(t: ReviewThread, file: Pick<ReviewFile, "hunks"> | undefined): boolean {
  if (!file) return false;
  const a = t.anchor;
  if (a.kind !== "line" || a.side === "old") return true;
  return file.hunks.some((h) => (h.oldLines === 0 ? a.line === h.oldStart || a.line === h.oldStart + 1 : a.line >= h.oldStart && a.line < h.oldStart + h.oldLines));
}

/** A thread's conversation, as Claude reads it: the user's comments and its own replies. */
const conversation = (t: ReviewThread) => t.messages.map((m) => `${m.by === "user" ? "User" : "You"}: ${m.text.trim()}`).join("\n\n");

/**
 * What a request for changes tells Claude: the user's own words, then each thread Claude said it would change
 * something for, with where it is and its conversation, under the commit it was started at.
 */
export function changesReason(card: Pick<DeliverCard, "branch" | "head">, threads: readonly ReviewThread[], text: string): string {
  const parts = [text.trim()].filter(Boolean);
  const todo = toChange(threads);
  if (todo.length) {
    parts.push(
      `What you said you'd change, in the review of ${card.branch}:\n\n` +
        todo
          .map((t) => {
            const a = t.anchor;
            const at = t.head === card.head ? "" : ` (at ${short(t.head)}, an earlier commit of the branch)`;
            const quote = a.kind === "line" && a.quote.trim() ? `\n> ${a.quote.trim()}` : "";
            const where = a.kind === "change" ? "The whole change" : a.kind === "commit" ? `Commit ${short(a.sha)}` : threadWhere(a);
            return `${where}${at}, thread ${t.id}${quote}\n${conversation(t)}`;
          })
          .join("\n\n"),
    );
  }
  return parts.join("\n\n");
}

/**
 * A note from before threads, as the comment that starts its thread: on its line, if it was left at the card's
 * commit; else on its file, saying where it was.
 */
export function noteComment(n: ReviewNote, head: string): { anchor: ThreadAnchor; text: string } {
  if (n.head === head) return { anchor: { kind: "line", path: n.path, side: n.side, line: n.line, quote: n.quote, ...(n.from ? { from: n.from } : {}) }, text: n.text };
  const where = `${n.side === "old" ? "removed " : ""}line ${n.line} at ${short(n.head)}`;
  return { anchor: { kind: "file", path: n.path }, text: `On ${where}${n.quote.trim() ? ` (“${n.quote.trim()}”)` : ""}: ${n.text}` };
}

// ---- kept per branch, in the browser ------------------------------------------------------------

export { reviewOf };

const KEY = (session: string, review: string) => `kumiko.review.${session}.${review}`;
const cache = new Map<string, Review>();
const listeners = new Set<() => void>();

function parse(raw: string | null): Review {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<Review>) : {};
    return { viewed: v.viewed && typeof v.viewed === "object" ? v.viewed : {}, notes: Array.isArray(v.notes) ? v.notes.filter((n) => n && typeof n.head === "string") : [], seen: Array.isArray(v.seen) ? v.seen : [] };
  } catch {
    return EMPTY;
  }
}

/** Review `review` (see `reviewOf`): what the user viewed, and notes left from before threads. */
export function getReview(session: string, review: string): Review {
  const key = KEY(session, review);
  let r = cache.get(key);
  if (!r) {
    r = parse(typeof localStorage === "undefined" ? null : localStorage.getItem(key));
    cache.set(key, r);
  }
  return r;
}

export function setReview(session: string, review: string, change: (r: Review) => Review): void {
  const key = KEY(session, review);
  const before = getReview(session, review);
  const next = change(before);
  if (next === before) return;
  cache.set(key, next);
  try {
    if (!next.notes.length && !Object.keys(next.viewed).length && !next.seen.length) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Full or off: it lasts as long as the page.
  }
  for (const l of listeners) l();
}

export function subscribeReviews(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---- the pane asking the card to send what Claude will change ----------------------------------

const asking = new Set<(ask: string) => void>();

/** The pane's Request changes: the card opens its box for a message to go with the threads. */
export function requestChanges(ask: string): void {
  for (const l of asking) l(ask);
}

export function onRequestChanges(listener: (ask: string) => void): () => void {
  asking.add(listener);
  return () => asking.delete(listener);
}

// ---- the chat asking the pane to show a thread ------------------------------------------------

let focusing: { ask: string; thread: string } | undefined;
const focusListeners = new Set<() => void>();

/** Asks the review pane for card `ask` to show thread `thread`, once it shows that card. */
export function focusThread(ask: string, thread: string): void {
  focusing = { ask, thread };
  for (const l of focusListeners) l();
}

/** The thread the pane for card `ask` is asked to show, taken: undefined if none. */
export function takeFocus(ask: string): string | undefined {
  if (focusing?.ask !== ask) return undefined;
  const t = focusing.thread;
  focusing = undefined;
  return t;
}

export function onFocusThread(listener: () => void): () => void {
  focusListeners.add(listener);
  return () => focusListeners.delete(listener);
}

// ---- how the pane shows diffs, one choice for every review ------------------------------------

export interface ReviewPrefs {
  split: boolean;
  wrap: boolean;
  /** Leave out changes in whitespace. */
  whitespace: boolean;
}

const PREFS = "kumiko.review.prefs";
let prefs: ReviewPrefs | undefined;
const prefListeners = new Set<() => void>();

export const reviewPrefs = {
  get(): ReviewPrefs {
    if (!prefs) {
      let v: Partial<ReviewPrefs> = {};
      try {
        v = JSON.parse(localStorage.getItem(PREFS) ?? "{}") as Partial<ReviewPrefs>;
      } catch {
        // As if never chosen.
      }
      prefs = { split: v.split === true, wrap: v.wrap === true, whitespace: v.whitespace === true };
    }
    return prefs;
  },
  set(change: Partial<ReviewPrefs>): void {
    prefs = { ...reviewPrefs.get(), ...change };
    try {
      localStorage.setItem(PREFS, JSON.stringify(prefs));
    } catch {
      // Lasts as long as the page.
    }
    for (const l of prefListeners) l();
  },
  subscribe(listener: () => void): () => void {
    prefListeners.add(listener);
    return () => prefListeners.delete(listener);
  },
};

/** Files grouped by folder, folders in order, for the pane's list. */
export function byFolder<T extends { path: string }>(files: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const f of files) {
    const i = f.path.lastIndexOf("/");
    const dir = i < 0 ? "" : f.path.slice(0, i);
    groups.set(dir, [...(groups.get(dir) ?? []), f]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * A card that adds to an open PR: where the PR's branch is on GitHub, what its new commits go on, and the card's
 * commits that the PR doesn't show yet. Undefined for a card with no PR, or one that adds nothing to it.
 */
export function prUpdate(c: Pick<DeliverCard, "pr" | "github" | "head" | "commits">): { number: number; from: string; fresh: Set<string> } | undefined {
  if (!c.pr || !c.github || c.github === c.head) return undefined;
  return { number: c.pr.number, from: c.github, fresh: new Set(c.commits.filter((x) => !x.onGithub).map((x) => x.sha)) };
}

/** The card's commits that its open PR doesn't show yet, when the PR shows some of the others: what to mark new. */
export function newCommits(c: Pick<DeliverCard, "pr" | "github" | "head" | "commits">): Set<string> | undefined {
  const u = prUpdate(c);
  return u && u.fresh.size < c.commits.length ? u.fresh : undefined;
}

/** What the pane shows of the branch: all it changes, one commit, or what changed since the head reviewed before. */
export type Scope = { kind: "all" } | { kind: "commit"; sha: string } | { kind: "since"; sha: string };

/** What a scope's diff compares with, where notes on removed lines are: undefined for the branch's base. */
export const scopeFrom = (scope: Scope) => (scope.kind === "since" ? scope.sha : undefined);

/** Whether a scope's diff ends at the card's commit, so that viewed marks and notes work in it: not one commit's. */
export const markable = (scope: Scope) => scope.kind !== "commit";

/** Whether note `n` is on a line of the diff from `from` (see `scopeFrom`) to `head`. */
export const noteFits = (n: Pick<ReviewNote, "head" | "side" | "from">, head: string, from: string | undefined) => n.head === head && (n.side === "new" || n.from === from);

/**
 * What the pane opens on: what's new, for a card that adds commits to a PR that has some of the others already;
 * else all changes.
 */
export function initialScope(c: Pick<DeliverCard, "pr" | "github" | "head" | "commits">): Scope {
  const u = prUpdate(c);
  return u && newCommits(c) ? { kind: "since", sha: u.from } : { kind: "all" };
}

/** The diff request for `scope`. */
export const scopeQuery = (scope: Scope, whitespace: boolean) => ({
  ...(scope.kind === "commit" ? { commit: scope.sha } : scope.kind === "since" ? { since: scope.sha } : {}),
  ...(whitespace ? { w: true } : {}),
});
