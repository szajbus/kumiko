// The review pane's logic: a file's diff as rows, with the unchanged lines between hunks as gaps to open; what the
// user marked viewed and the notes they left, kept in the browser per card; and the reason a request for changes
// sends Claude.

import type { DeliverCard, ReviewFile } from "@kumiko/shared";
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

/** A note the user left on a line, for Claude. `side` says which version `line` is in: before or after. */
export interface ReviewNote {
  id: string;
  path: string;
  side: "old" | "new";
  line: number;
  /** The line's text when the note was left, to quote to Claude. */
  quote: string;
  text: string;
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
 * Viewed marks brought up to the card's commit: a file whose content is the same as when it was viewed is viewed now
 * too; one that changed keeps its old mark, so it shows as changed since.
 */
export function restamp(review: Review, head: string, files: ReviewFile[]): Review {
  let changed = false;
  const viewed = { ...review.viewed };
  for (const f of files) {
    const v = viewed[f.path];
    if (v && v.head !== head && v.blob === fileBlob(f)) {
      viewed[f.path] = { ...v, head };
      changed = true;
    }
  }
  return changed ? { ...review, viewed } : review;
}

const short = (sha: string) => sha.slice(0, 7);

/** What a request for changes tells Claude: the user's own words, then each note with the line it is on. */
export function changesReason(card: Pick<DeliverCard, "branch" | "head">, notes: ReviewNote[], text: string): string {
  const parts = [text.trim()].filter(Boolean);
  if (notes.length) {
    const sorted = [...notes].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    parts.push(
      `Notes on ${card.branch} at ${short(card.head)}:\n\n` +
        sorted
          .map((n) => {
            const where = n.side === "new" ? `${n.path}:${n.line}` : `${n.path}, line ${n.line} before the change`;
            return `${where}\n> ${n.quote.trim()}\n${n.text.trim()}`;
          })
          .join("\n\n"),
    );
  }
  return parts.join("\n\n");
}

// ---- kept per card, in the browser --------------------------------------------------------------

const KEY = (session: string, ask: string) => `kumiko.review.${session}.${ask}`;
const cache = new Map<string, Review>();
const listeners = new Set<() => void>();

function parse(raw: string | null): Review {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<Review>) : {};
    return { viewed: v.viewed && typeof v.viewed === "object" ? v.viewed : {}, notes: Array.isArray(v.notes) ? v.notes : [], seen: Array.isArray(v.seen) ? v.seen : [] };
  } catch {
    return EMPTY;
  }
}

/** The review of card `ask`: what the user viewed and the notes they left. */
export function getReview(session: string, ask: string): Review {
  const key = KEY(session, ask);
  let r = cache.get(key);
  if (!r) {
    r = parse(typeof localStorage === "undefined" ? null : localStorage.getItem(key));
    cache.set(key, r);
  }
  return r;
}

export function setReview(session: string, ask: string, change: (r: Review) => Review): void {
  const key = KEY(session, ask);
  const before = getReview(session, ask);
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

// ---- the pane asking the card to send the notes ---------------------------------------------

const asking = new Set<(ask: string) => void>();

/** The pane's Request changes: the card opens its box for a message to go with the notes. */
export function requestChanges(ask: string): void {
  for (const l of asking) l(ask);
}

export function onRequestChanges(listener: (ask: string) => void): () => void {
  asking.add(listener);
  return () => asking.delete(listener);
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
