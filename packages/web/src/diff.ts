import { blocksOf, partialString, type Block, type Hunk, type Subagent } from "./chat.ts";

/** One row of a unified diff. `old` and `new` are line numbers, where they are known; `mark` is the changed part. */
export interface DiffRow {
  kind: "context" | "add" | "remove" | "gap";
  text: string;
  old?: number;
  new?: number;
  /** Characters `[from, to)` of `text` that differ from the line it pairs with. */
  mark?: [number, number];
  /** For a gap: how many unchanged lines it stands for. */
  skipped?: number;
}

/** What a file edit changed, as its tool line shows it. */
export interface FileDiff {
  path: string;
  rows: DiffRow[];
  added: number;
  removed: number;
  /** Rows have line numbers: they come from Claude's patch, or from a whole file Write made. */
  numbered: boolean;
  /** Claude's own patch, rather than a diff of the call's input. */
  fromPatch: boolean;
  created?: boolean;
  /** A Write over a file whose old content isn't known. */
  rewrote?: boolean;
  replaceAll?: boolean;
  userModified?: boolean;
  /** Kumiko kept only the start of Claude's patch. */
  truncated?: boolean;
  /** A NotebookEdit's cell. */
  cell?: string;
  /** The error a failed call gave, without Claude's tags. */
  error?: string;
}

/** Diffs longer than this are cut to their first SHOWN_ROWS rows, with a way to see the rest. */
export const MAX_ROWS = 40;
export const SHOWN_ROWS = 30;

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

// Blocks are never changed, only replaced, and the chat asks again on every message that streams in.
const diffs = new WeakMap<Block, FileDiff | undefined>();

/** The diff a file edit's tool line shows: from Claude's patch when it sent one, else from the call's input. */
export function fileDiff(block: Extract<Block, { type: "tool" }>): FileDiff | undefined {
  if (!EDIT_TOOLS.has(block.name)) return undefined;
  if (!diffs.has(block)) diffs.set(block, diffOf(block));
  return diffs.get(block);
}

function diffOf(block: Extract<Block, { type: "tool" }>): FileDiff {
  const input = block.input;
  const streaming = !Object.keys(input).length;
  const field = (k: string) => (streaming ? partialString(block.partialInput ?? "", k) : typeof input[k] === "string" ? (input[k] as string) : undefined);
  const path = field(block.name === "NotebookEdit" ? "notebook_path" : "file_path") ?? "";
  const { result } = block;
  const change = result?.change;
  const base = {
    path,
    ...(change?.userModified ? { userModified: true } : {}),
    ...(change?.truncated ? { truncated: true } : {}),
    ...(result?.isError ? { error: errorText(result.text) } : {}),
  };
  const fromPatch = !result?.isError && change?.hunks;
  if (fromPatch && (change.hunks!.length || !change.created)) {
    return withCounts({ ...base, rows: patchRows(change.hunks!), numbered: true, fromPatch: true, ...(input.replace_all === true ? { replaceAll: true } : {}) });
  }

  if (block.name === "Write") {
    const content = field("content") ?? "";
    const created = change?.created || (!result?.isError && result?.text.startsWith("File created")) || undefined;
    // A Write over a file says so, but only the main thread's carries the patch that says what was there.
    const rewrote = !created && result && !result.isError ? true : undefined;
    const rows = splitLines(content).map((text, i): DiffRow => ({ kind: "add", text, new: i + 1 }));
    return withCounts({ ...base, rows, numbered: !result?.isError, fromPatch: false, ...(created ? { created } : {}), ...(rewrote ? { rewrote } : {}) });
  }

  if (block.name === "NotebookEdit") {
    const mode = field("edit_mode");
    const before = mode === "insert" ? "" : (change?.oldSource ?? "");
    const after = mode === "delete" ? "" : (field("new_source") ?? "");
    const cell = field("cell_id");
    return withCounts({ ...base, rows: stringRows(before, after), numbered: false, fromPatch: false, ...(cell ? { cell } : {}) });
  }

  const replaceAll = (streaming ? /"replace_all"\s*:\s*true/.test(block.partialInput ?? "") : input.replace_all === true) || undefined;
  return withCounts({ ...base, rows: stringRows(field("old_string") ?? "", field("new_string") ?? ""), numbered: false, fromPatch: false, ...(replaceAll ? { replaceAll } : {}) });
}

function withCounts(d: Omit<FileDiff, "added" | "removed">): FileDiff {
  // A failed edit changed nothing; its rows are what it tried.
  if (d.error !== undefined) return { ...d, added: 0, removed: 0 };
  return { ...d, added: d.rows.filter((r) => r.kind === "add").length, removed: d.rows.filter((r) => r.kind === "remove").length };
}

/** A tool error's text, without the tags Claude wraps it in. */
export function errorText(text: string): string {
  return text.replace(/^\s*<tool_use_error>/, "").replace(/<\/tool_use_error>\s*$/, "").trim();
}

/** A file's lines, as Claude counts them: a last newline ends the last line rather than starting one. */
export function splitLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

/** The rows of Claude's patch, numbered, with a gap row between hunks for the lines it leaves out. */
export function patchRows(hunks: Hunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let after = 0;
  hunks.forEach((h, i) => {
    let o = h.oldStart;
    let n = h.newStart;
    if (i > 0) rows.push({ kind: "gap", text: "", skipped: Math.max(0, h.oldStart - after) });
    for (const line of h.lines) {
      const text = line.slice(1);
      if (line[0] === "-") rows.push({ kind: "remove", text, old: o++ });
      else if (line[0] === "+") rows.push({ kind: "add", text, new: n++ });
      else rows.push({ kind: "context", text, old: o++, new: n++ });
    }
    after = o;
  });
  return marked(rows);
}

/** Past this many lines on each side, the middle of a diff of two strings isn't searched for common lines. */
const MAX_DIFF_CELLS = 1_000_000;

/** A line diff of `before` against `after`, unnumbered: where they are in the file isn't known. */
export function stringRows(before: string, after: string): DiffRow[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const head = a.slice(0, start).map((text): DiffRow => ({ kind: "context", text }));
  const tail = a.slice(a.length - end).map((text): DiffRow => ({ kind: "context", text }));
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);
  return marked([...head, ...middle(x, y), ...tail]);
}

/** The changed middle of two texts as rows: by longest common subsequence, or all removed then all added when it's big. */
function middle(a: string[], b: string[]): DiffRow[] {
  const remove = (text: string): DiffRow => ({ kind: "remove", text });
  const add = (text: string): DiffRow => ({ kind: "add", text });
  if (!a.length || !b.length || a.length * b.length > MAX_DIFF_CELLS) return [...a.map(remove), ...b.map(add)];
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  // Removals before additions where either would do, as Claude's patches have them.
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ kind: "context", text: a[i++] });
      j++;
    } else if (j < b.length && (i === a.length || lcs[i * w + j + 1] > lcs[(i + 1) * w + j])) rows.push(add(b[j++]));
    else rows.push(remove(a[i++]));
  }
  return rows;
}

/**
 * Marks what changed within lines: a run of removed lines followed by as many added ones pairs them up, and each pair
 * marks what lies between their common start and end. A line that changed all through is left unmarked.
 */
export function marked(rows: DiffRow[]): DiffRow[] {
  for (let i = 0; i < rows.length; ) {
    if (rows[i].kind !== "remove") {
      i++;
      continue;
    }
    let r = i;
    while (r < rows.length && rows[r].kind === "remove") r++;
    let e = r;
    while (e < rows.length && rows[e].kind === "add") e++;
    if (e - r === r - i) {
      for (let k = 0; k < r - i; k++) {
        const [x, y] = [rows[i + k], rows[r + k]];
        let p = 0;
        while (p < x.text.length && p < y.text.length && x.text[p] === y.text[p]) p++;
        let s = 0;
        while (s < x.text.length - p && s < y.text.length - p && x.text[x.text.length - 1 - s] === y.text[y.text.length - 1 - s]) s++;
        if (p + s === 0) continue;
        if (p < x.text.length - s) x.mark = [p, x.text.length - s];
        if (p < y.text.length - s) y.mark = [p, y.text.length - s];
      }
    }
    i = e;
  }
  return rows;
}

/**
 * The rows to show: all of them, or for a long diff its first SHOWN_ROWS, cut before a gap between hunks when one
 * falls in the last third of those, so a hunk isn't split.
 */
export function shownRows(rows: DiffRow[], all: boolean): DiffRow[] {
  if (all || rows.length <= MAX_ROWS) return rows;
  for (let k = SHOWN_ROWS; k > (SHOWN_ROWS * 2) / 3; k--) if (rows[k]?.kind === "gap") return rows.slice(0, k);
  return rows.slice(0, SHOWN_ROWS);
}

/** How many lines `rows` holds of the file, gaps aside. */
export const lineCount = (rows: DiffRow[]) => rows.filter((r) => r.kind !== "gap").length;

/** The new side of a diff, as text to copy. */
export const newText = (rows: DiffRow[]) => rows.filter((r) => r.kind === "context" || r.kind === "add").map((r) => r.text).join("\n");

/** A path under the session's working folder relative to it, split into its folder and its name. */
export function shortPath(path: string, workdir?: string): { dir: string; name: string } {
  const root = workdir?.replace(/\/+$/, "");
  const rel = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const cut = rel.lastIndexOf("/") + 1;
  return { dir: rel.slice(0, cut), name: rel.slice(cut) };
}

/** The files that work changed, its subagents' included, and its lines added and removed in all. */
export interface Changes {
  files: number;
  added: number;
  removed: number;
}

export function workChanges(blocks: Block[], agents: Record<string, Subagent>): Changes | undefined {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  const walk = (bs: Block[], seen: Set<string>) => {
    for (const b of bs) {
      if (b.type !== "tool") continue;
      const agent = agents[b.id];
      if (agent && !seen.has(b.id)) walk(agent.items.flatMap(blocksOf), new Set([...seen, b.id]));
      // Only what was done: a call still running, or one that failed, changed nothing yet.
      if (!b.result || b.result.isError) continue;
      const d = fileDiff(b);
      if (!d) continue;
      files.add(d.path);
      added += d.added;
      removed += d.removed;
    }
  };
  walk(blocks, new Set());
  return files.size ? { files: files.size, added, removed } : undefined;
}
