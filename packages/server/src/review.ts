// What the review pane reads from a repository's mirror: the changes between two commits, file by file, and a file's
// whole content to show more of it around a change.

import { REVIEW_FILE_MAX_LINES, REVIEW_MAX_BLOB_BYTES, REVIEW_MAX_LINES, type ReviewDiff, type ReviewFile, type ReviewHunk, type ReviewStatus } from "@kumiko/shared";
import { mirrorGit } from "./landing.js";

/** Something the user asked of the review that doesn't fit; the message says what. */
export class ReviewRefused extends Error {}

/** A full object name, SHA-1 or SHA-256. */
export const isObjectName = (s: unknown): s is string => typeof s === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s);

// The user's own diff settings mustn't change what is parsed: prefixes, external diffs, colour, quoted paths.
const DIFF = ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "-M"];

/** The commit `ref` names, or undefined. */
export async function commitOf(dir: string, ref: string): Promise<string | undefined> {
  const r = await mirrorGit(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { ok: [1, 128] });
  return r.code === 0 ? r.out.trim() : undefined;
}

/** Where `a` and `b` meet: what a branch's changes are counted from. */
export async function mergeBase(dir: string, a: string, b: string): Promise<string> {
  const r = await mirrorGit(dir, ["merge-base", a, b], { ok: [1] });
  if (r.code !== 0) throw new ReviewRefused("The branch and the default branch have no commit in common.");
  return r.out.trim();
}

/** A commit's first parent: what it changed is counted from there. */
export async function parentOf(dir: string, commit: string): Promise<string> {
  const parent = await commitOf(dir, `${commit}^`);
  if (!parent) throw new ReviewRefused("That commit has no parent to compare it with.");
  return parent;
}

interface Entry {
  status: ReviewStatus;
  path: string;
  oldPath?: string;
  oldMode: string;
  newMode: string;
  oldBlob: string;
  newBlob: string;
  added?: number;
  deleted?: number;
}

const STATUS: Record<string, ReviewStatus> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type" };
const ZERO = /^0+$/;

/** `git diff --raw -z`: the files, their statuses, modes and blobs. */
export function parseRaw(out: string): Entry[] {
  const parts = out.split("\0");
  const entries: Entry[] = [];
  for (let i = 0; i < parts.length; ) {
    const head = parts[i++];
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(head);
    if (!m) continue;
    const [, oldMode, newMode, oldBlob, newBlob, letter] = m;
    const two = letter === "R" || letter === "C";
    const first = parts[i++];
    const second = two ? parts[i++] : undefined;
    entries.push({ status: STATUS[letter] ?? "modified", path: second ?? first, ...(two ? { oldPath: first } : {}), oldMode, newMode, oldBlob, newBlob });
  }
  return entries;
}

/** `git diff --numstat -z`: lines added and deleted, in the same order as --raw; "-" for a binary file. */
export function parseNumstat(out: string): { added?: number; deleted?: number; path: string }[] {
  const parts = out.split("\0");
  const rows: { added?: number; deleted?: number; path: string }[] = [];
  for (let i = 0; i < parts.length; ) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i++]);
    if (!m) continue;
    // A rename's paths follow, each on its own; otherwise the path is on the line.
    let path = m[3];
    if (path === "") {
      i++;
      path = parts[i++];
    }
    rows.push({ ...(m[1] === "-" ? {} : { added: Number(m[1]), deleted: Number(m[2]) }), path });
  }
  return rows;
}

/** A path as git writes it in a patch: as it is, or in double quotes with C escapes when it has odd characters. */
export function unquote(s: string): string {
  if (!s.startsWith('"')) return s;
  const bytes: number[] = [];
  const ESC: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') break;
    if (ch !== "\\") {
      bytes.push(...new TextEncoder().encode(ch));
      continue;
    }
    const next = s[++i];
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(ESC[next] ?? next.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The quoted string at the start of `s` and what follows it. */
function quotedPrefix(s: string): [string, string] {
  let i = 1;
  while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
  return [s.slice(0, i + 1), s.slice(i + 1)];
}

const strip = (p: string, prefix: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);

/** A patch section's file: from its rename or copy line, its +++ or --- line, or else its diff --git line. */
function sectionPath(lines: string[]): string {
  let plus: string | undefined;
  let minus: string | undefined;
  for (const l of lines) {
    if (l.startsWith("@@")) break;
    if (l.startsWith("rename to ") || l.startsWith("copy to ")) return unquote(l.slice(l.indexOf(" to ") + 4));
    if (l.startsWith("+++ ")) plus = unquote(l.slice(4));
    if (l.startsWith("--- ")) minus = unquote(l.slice(4));
  }
  if (plus && plus !== "/dev/null") return strip(plus, "b/");
  if (minus && minus !== "/dev/null") return strip(minus, "a/");
  // No rename, so both sides name the same file: "a/P b/P", or each quoted.
  const rest = lines[0].slice("diff --git ".length);
  if (rest.startsWith('"')) return strip(unquote(quotedPrefix(rest)[0]), "a/");
  return rest.slice(2, 2 + (rest.length - 5) / 2);
}

/** A patch, by file: its hunks, and whether git found it binary. */
export function parsePatch(out: string): Map<string, { hunks: ReviewHunk[]; binary: boolean }> {
  const files = new Map<string, { hunks: ReviewHunk[]; binary: boolean }>();
  const lines = out.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("diff --git ")) {
      i++;
      continue;
    }
    const start = i++;
    while (i < lines.length && !lines[i].startsWith("diff --git ") && !lines[i].startsWith("@@")) i++;
    const header = lines.slice(start, i);
    const hunks: ReviewHunk[] = [];
    while (i < lines.length && lines[i].startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i++]);
      const hunk: ReviewHunk = m ? { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]), lines: [] } : { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines: [] };
      // A hunk is as long as its header says: a removed line can itself start with "diff --git".
      let olds = hunk.oldLines;
      let news = hunk.newLines;
      while (i < lines.length && (olds > 0 || news > 0 || lines[i].startsWith("\\"))) {
        const l = lines[i++];
        if (l[0] === "-") olds--;
        else if (l[0] === "+") news--;
        else if (l[0] === " " || l === "") {
          olds--;
          news--;
        }
        hunk.lines.push(l === "" ? " " : l);
      }
      hunks.push(hunk);
    }
    files.set(sectionPath(header), { hunks, binary: header.some((l) => l.startsWith("Binary files ") || l === "GIT binary patch") });
  }
  return files;
}

const literal = (path: string) => `:(literal)${path}`;
const excluded = (path: string) => `:(exclude,literal)${path}`;

/**
 * What changed from `from` to `to`, file by file. Files whose patches are long come without them, marked `tooLarge`,
 * as do all files once the diff holds REVIEW_MAX_LINES; `paths` asks for those files alone, whole.
 */
export async function reviewDiff(dir: string, from: string, to: string, opts: { ignoreWhitespace?: boolean; paths?: string[] } = {}): Promise<ReviewDiff> {
  const only = opts.paths?.length ? ["--", ...opts.paths.map(literal)] : [];
  const [raw, numstat] = await Promise.all([mirrorGit(dir, [...DIFF, "--raw", "-z", "--no-abbrev", from, to, ...only]), mirrorGit(dir, [...DIFF, "--numstat", "-z", from, to, ...only])]);
  const entries = parseRaw(raw.out);
  const counts = parseNumstat(numstat.out);
  entries.forEach((e, k) => {
    const c = counts[k];
    if (c && c.added !== undefined) Object.assign(e, { added: c.added, deleted: c.deleted });
  });

  // Long patches are left out of the one git writes: lines are counted from --numstat first.
  const fileMax = opts.paths?.length ? REVIEW_MAX_LINES * 2 : REVIEW_FILE_MAX_LINES;
  const tooLarge = new Set<string>();
  let total = 0;
  for (const e of entries) {
    const n = (e.added ?? 0) + (e.deleted ?? 0);
    if (n > fileMax || total + n > REVIEW_MAX_LINES * (opts.paths?.length ? 2 : 1)) tooLarge.add(e.path);
    else total += n;
  }
  const shown = entries.filter((e) => !tooLarge.has(e.path));
  const pathspec = !shown.length
    ? undefined
    : opts.paths?.length
      ? ["--", ...shown.flatMap((e) => [literal(e.path), ...(e.oldPath ? [literal(e.oldPath)] : [])])]
      : tooLarge.size
        ? ["--", ".", ...[...tooLarge].flatMap((p) => [excluded(p), ...entryOld(entries, p)])]
        : [];
  const patch = pathspec
    ? parsePatch(
        (
          await mirrorGit(dir, [...DIFF, "-p", "--src-prefix=a/", "--dst-prefix=b/", ...(opts.ignoreWhitespace ? ["-w"] : []), from, to, ...pathspec]).catch((err: Error) => {
            // Few lines can still be many bytes: minified files, say.
            if (/maxBuffer/i.test(err.message)) throw new ReviewRefused("These changes are too large to show in the pane.");
            throw err;
          })
        ).out,
      )
    : new Map<string, { hunks: ReviewHunk[]; binary: boolean }>();

  const files = entries.map((e): ReviewFile => {
    const p = patch.get(e.path);
    const binary = e.added === undefined || p?.binary;
    return {
      path: e.path,
      ...(e.oldPath ? { oldPath: e.oldPath } : {}),
      status: e.status,
      ...(e.added !== undefined ? { added: e.added, deleted: e.deleted } : {}),
      ...(binary ? { binary: true } : {}),
      ...(ZERO.test(e.oldBlob) ? {} : { oldBlob: e.oldBlob }),
      ...(ZERO.test(e.newBlob) ? {} : { newBlob: e.newBlob }),
      ...(e.oldMode !== e.newMode && !ZERO.test(e.oldMode) && !ZERO.test(e.newMode) ? { oldMode: e.oldMode, newMode: e.newMode } : {}),
      hunks: p?.hunks ?? [],
      ...(tooLarge.has(e.path) ? { tooLarge: true } : {}),
      ...(opts.ignoreWhitespace && !tooLarge.has(e.path) && !binary && !p?.hunks.length && (e.added ?? 0) + (e.deleted ?? 0) > 0 ? { whitespaceOnly: true } : {}),
      ...(e.path === ".github" || e.path.startsWith(".github/") ? { flagged: true } : {}),
    };
  });
  return { from, to, files };
}

/** A renamed file's old path, left out with it: else git would show it deleted. */
const entryOld = (entries: Entry[], path: string) => {
  const old = entries.find((e) => e.path === path)?.oldPath;
  return old ? [excluded(old)] : [];
};

/** A blob's text, for showing more of a file around a change; undefined for a binary one. */
export async function readBlob(dir: string, blob: string): Promise<{ text?: string; binary?: boolean }> {
  const type = await mirrorGit(dir, ["cat-file", "-t", blob], { ok: [1, 128] });
  if (type.code !== 0 || type.out.trim() !== "blob") throw new ReviewRefused("There is no such file content in the mirror.");
  const size = Number((await mirrorGit(dir, ["cat-file", "-s", blob])).out.trim());
  if (size > REVIEW_MAX_BLOB_BYTES) throw new ReviewRefused(`The file is ${Math.round(size / 1024 / 1024)} MB, more than the pane reads.`);
  const out = await mirrorGit(dir, ["cat-file", "blob", blob]);
  if (out.out.slice(0, 8000).includes("\0")) return { binary: true };
  return { text: out.out };
}
