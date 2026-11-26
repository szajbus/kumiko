// The review pane: a deliver card's changes, file by file, as the user reads them before approving.

/** The review pane's widget, one per window: it shows the card the user last opened it for. */
export const REVIEW = "review";

/** What the review pane shows: the approval card it is for, by its ask's id. */
export interface ReviewState {
  ask: string;
  /**
   * The head of the card it showed before Kumiko moved it to this one: Claude delivered the same branch again, after a
   * request for changes. Absent when the user opened the pane on this card.
   */
  refreshed?: string;
}

/** One hunk of a file's patch, as git writes it: each line starts with " ", "+", "-" or "\\". */
export interface ReviewHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export type ReviewStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type";

/** One file the branch changes, with its patch. */
export interface ReviewFile {
  path: string;
  /** Where a renamed or copied file came from. */
  oldPath?: string;
  status: ReviewStatus;
  /** Lines added and deleted; undefined for a binary file. */
  added?: number;
  deleted?: number;
  binary?: boolean;
  /** The file's blobs before and after, absent where it doesn't exist: what expanding its context reads. */
  oldBlob?: string;
  newBlob?: string;
  oldMode?: string;
  newMode?: string;
  hunks: ReviewHunk[];
  /** Its patch is longer than the pane shows at once; it can be asked for on its own. */
  tooLarge?: boolean;
  /** Its only changes are in whitespace, which the diff was asked to leave out. */
  whitespaceOnly?: boolean;
  /** Under .github/: what CI runs, with the repository's secrets. */
  flagged?: boolean;
}

/** What changed between two commits of a deliver card's branch. */
export interface ReviewDiff {
  /** The commits compared: `from` is the merge base, a commit's parent, or the head reviewed before. */
  from: string;
  to: string;
  files: ReviewFile[];
  /** For a diff of one commit, or of all a branch that has only one: that commit's whole message. */
  message?: string;
}

/** How many patch lines a review diff holds before the rest of its files come as `tooLarge`. */
export const REVIEW_MAX_LINES = 20_000;
/** How many patch lines one file may have and still come with a diff of the whole branch. */
export const REVIEW_FILE_MAX_LINES = 3_000;
/** The most of a file the pane reads to show more of it around a change. */
export const REVIEW_MAX_BLOB_BYTES = 4 * 1024 * 1024;

// ---- threads: the user's comments on a deliver card's changes, and Claude's replies ----------

/**
 * Which review a deliver card's is: its branch's, in its session. Delivering the branch again makes a new card, which
 * goes on with the same review and its threads.
 */
export const reviewOf = (card: { repo: string; branch: string }) => `${card.repo}#${card.branch}`;

/**
 * Where a thread is. `line`: a line on one side, as the card's diff numbered it at the thread's `head`, with its text
 * then; `from` is the commit a removed line's view compared with, when that wasn't the branch's base. `file`: a whole
 * file. `commit`: one of the card's commits. `change`: all of it.
 */
export type ThreadAnchor =
  | { kind: "line"; path: string; side: "old" | "new"; line: number; quote: string; from?: string }
  | { kind: "file"; path: string }
  | { kind: "commit"; sha: string }
  | { kind: "change" };

export interface ThreadMessage {
  id: string;
  by: "user" | "claude";
  text: string;
  at: string;
}

/**
 * A conversation on a deliver card's changes, kept in the session. `ask` is the card it was started on and `head` that
 * card's commit, which a `line` anchor is a line of. `willChange`: Claude's last reply says it will change something
 * for it, if the user requests changes. `resolved`: the user closed it. Kept local: nothing of it goes to GitHub.
 */
export interface ReviewThread {
  id: string;
  review: string;
  ask: string;
  head: string;
  anchor: ThreadAnchor;
  messages: ThreadMessage[];
  willChange?: boolean;
  /** The user requested changes with it among them: Claude has it to do, and the next request leaves it out. */
  requested?: boolean;
  resolved?: boolean;
  /** The last message the user has read: Claude's replies after it are unread. */
  readTo?: string;
}

/** Claude's replies in `t` that the user hasn't read yet. */
export function threadUnread(t: ReviewThread): number {
  const from = t.readTo ? t.messages.findIndex((m) => m.id === t.readTo) + 1 : 0;
  return t.messages.slice(from).filter((m) => m.by === "claude").length;
}

/** The latest state of each thread in a session's events, by id, in the order they were started. */
export function threadsOf(events: readonly { kind: string; payload?: unknown }[]): Map<string, ReviewThread> {
  const threads = new Map<string, ReviewThread>();
  for (const e of events) if (e.kind === "thread") threads.set((e.payload as ReviewThread).id, e.payload as ReviewThread);
  return threads;
}

/**
 * How many of Claude's replies the user hasn't read, in the threads of reviews with a card still open: once a card is
 * decided, its replies stop waiting on the user, until the branch is delivered again.
 */
export function unreadReplies(events: readonly { kind: string; payload?: unknown }[]): number {
  const cards = new Map<string, { state: string; card: { kind: string; repo?: string; branch?: string } }>();
  for (const e of events) if (e.kind === "card") cards.set((e.payload as { id: string }).id, e.payload as { state: string; card: { kind: string; repo?: string; branch?: string } });
  const open = new Set([...cards.values()].filter((c) => c.card.kind === "deliver" && (c.state === "open" || c.state === "stale")).map((c) => reviewOf(c.card as { repo: string; branch: string })));
  let n = 0;
  for (const t of threadsOf(events).values()) if (open.has(t.review)) n += threadUnread(t);
  return n;
}

/** The longest comment or reply in a thread. */
export const MAX_THREAD_TEXT = 20_000;

const shortSha = (sha: string) => sha.slice(0, 7);

/** Where a thread is, in a few words: "src/a.ts:42", "src/a.ts", "commit abc1234", "the whole change". */
export function threadWhere(a: ThreadAnchor): string {
  switch (a.kind) {
    case "line":
      return a.side === "new" ? `${a.path}:${a.line}` : `${a.path}, removed line ${a.line}`;
    case "file":
      return a.path;
    case "commit":
      return `commit ${shortSha(a.sha)}`;
    case "change":
      return "the whole change";
  }
}

/** `value` as a thread's anchor, if it is a well-formed one; for anchors that come over the API. */
export function parseThreadAnchor(value: unknown): ThreadAnchor | undefined {
  const v = value as Record<string, unknown> | null;
  const path = (p: unknown) => typeof p === "string" && p.length > 0 && p.length <= 4096;
  const sha = (s: unknown) => typeof s === "string" && /^[0-9a-f]{40}$/.test(s);
  switch (v?.kind) {
    case "line":
      if (!path(v.path) || (v.side !== "old" && v.side !== "new") || typeof v.line !== "number" || !Number.isInteger(v.line) || v.line < 1 || typeof v.quote !== "string" || v.quote.length > 4096) return undefined;
      if (v.from !== undefined && !sha(v.from)) return undefined;
      return { kind: "line", path: v.path as string, side: v.side, line: v.line, quote: v.quote, ...(v.from !== undefined ? { from: v.from as string } : {}) };
    case "file":
      return path(v.path) ? { kind: "file", path: v.path as string } : undefined;
    case "commit":
      return sha(v.sha) ? { kind: "commit", sha: v.sha as string } : undefined;
    case "change":
      return { kind: "change" };
    default:
      return undefined;
  }
}
