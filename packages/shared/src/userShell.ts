// Shell commands the user runs from the composer: a message starting with "!" runs in the sandbox, its output shows
// in the chat, and Claude gets the command and its output as a prompt, the way Claude Code's own `!` does.

/** Some of what a command printed, on its standard output (`out`) or error (`err`). */
export interface ShellChunk {
  stream: "out" | "err";
  text: string;
}

/**
 * How a command ended, when it didn't end by itself: stopped by the user, by the session ending, or lost with the
 * server that ran it.
 */
export type ShellStop = "user" | "ended" | "lost";

/** The longest command that can be run, in characters, as with Claude Code's own `!`. */
export const SHELL_COMMAND_MAX = 65_536;

/** How much of a command's output Claude gets: as much as its Bash tool gives it of one of its own commands. */
export const SHELL_PROMPT_CHARS = 30_000;

/** How much of a command's output the chat keeps, in characters: its start, and its end. */
export const SHELL_KEEP_HEAD = 32 * 1024;
export const SHELL_KEEP_TAIL = 224 * 1024;

/** The command in a message to run as one: what follows a leading "!", or undefined for a prompt. */
export function shellCommand(text: string): string | undefined {
  return text.startsWith("!") ? text.slice(1).trim() : undefined;
}

/** Characters in some chunks. */
export const chunksLength = (chunks: readonly ShellChunk[]) => chunks.reduce((n, c) => n + c.text.length, 0);

/**
 * Keeps the first `head` and last `tail` characters of `chunks`, in order, merging neighbours on the same stream.
 * Returns what was kept, and how many characters were left out between the two (0 when nothing was).
 */
export function keepEnds(chunks: readonly ShellChunk[], head: number, tail: number): { chunks: ShellChunk[]; cut: number } {
  const merged = mergeChunks(chunks);
  const total = chunksLength(merged);
  if (total <= head + tail) return { chunks: merged, cut: 0 };
  const take = (from: number, to: number): ShellChunk[] => {
    const out: ShellChunk[] = [];
    let at = 0;
    for (const c of merged) {
      const start = Math.max(from, at);
      const end = Math.min(to, at + c.text.length);
      if (start < end) out.push({ stream: c.stream, text: c.text.slice(start - at, end - at) });
      at += c.text.length;
    }
    return out;
  };
  return { chunks: [...take(0, head), ...take(total - tail, total)], cut: total - head - tail };
}

/** Chunks with neighbours on the same stream joined, and empty ones dropped. */
export function mergeChunks(chunks: readonly ShellChunk[]): ShellChunk[] {
  const out: ShellChunk[] = [];
  for (const c of chunks) {
    if (!c.text) continue;
    const last = out.at(-1);
    if (last?.stream === c.stream) out[out.length - 1] = { stream: c.stream, text: last.text + c.text };
    else out.push({ ...c });
  }
  return out;
}

/** How a finished command ended, for Claude and the chat. */
export interface ShellEnd {
  code?: number;
  stopped?: ShellStop;
  durationMs: number;
  /** Why it couldn't run, if it couldn't: the sandbox couldn't be reached, say. */
  error?: string;
}

/** "3m 12s", "4.1s", "0.3s". */
export function shellDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

const STOPPED: Record<ShellStop, string> = {
  user: "Stopped by the user",
  ended: "Stopped as the session ended",
  lost: "Stopped: Kumiko restarted while it ran",
};

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Cuts `text` to about `budget` characters by taking lines out of its middle, keeping a tenth of the room for its
 * start and the rest for its end, where errors and summaries are. `note` says what was cut, given how many lines.
 */
export function cutMiddle(text: string, budget: number, note: (lines: number) => string): string {
  if (text.length <= budget) return text;
  const headRoom = Math.floor(budget / 10);
  // Whole lines where there are any: the start up to a line's end, the end from a line's start.
  let head = text.lastIndexOf("\n", headRoom);
  head = head > 0 ? head + 1 : headRoom;
  let tail = text.indexOf("\n", text.length - (budget - headRoom));
  tail = tail >= 0 && tail < text.length - 1 ? tail + 1 : text.length - (budget - headRoom);
  if (tail <= head) return text;
  const lines = text.slice(head, tail).split("\n").length - 1 || 1;
  return `${text.slice(0, head)}${note(lines)}\n${text.slice(tail)}`;
}

/**
 * What Claude gets of a command the user ran: Claude Code's own tags for a `!` command, which Claude knows as the
 * user's. Output past `SHELL_PROMPT_CHARS` is cut in the middle, with a note naming `log`, the file in the sandbox
 * with all of it, when there is one.
 */
export function shellPrompt(command: string, chunks: readonly ShellChunk[], end: ShellEnd, log?: string): string {
  const join = (stream: ShellChunk["stream"]) => chunks.filter((c) => c.stream === stream).map((c) => c.text).join("");
  let out = join("out");
  let err = join("err");
  if (end.error) err += `${err && !err.endsWith("\n") ? "\n" : ""}Command failed: ${end.error}`;
  if (end.stopped) err += `${err && !err.endsWith("\n") ? "\n" : ""}${STOPPED[end.stopped]} after ${shellDuration(end.durationMs)}.`;
  if (out.length + err.length > SHELL_PROMPT_CHARS) {
    const note = (lines: number) => `[… ${lines.toLocaleString("en-US")} line${lines === 1 ? "" : "s"} cut${log ? `; all of the output is in ${log}` : ""}]`;
    // Errors are usually short and say what went wrong, so they keep their room unless they are most of it.
    const errBudget = Math.min(err.length, Math.max(SHELL_PROMPT_CHARS - out.length, Math.floor(SHELL_PROMPT_CHARS / 3)));
    out = cutMiddle(out, SHELL_PROMPT_CHARS - errBudget, note);
    err = cutMiddle(err, errBudget, note);
  }
  const code = end.code !== undefined && end.code !== 0 ? `<bash-exit-code>${end.code}</bash-exit-code>` : "";
  return `<bash-input>${escape(command)}</bash-input><bash-stdout>${escape(out.replace(/\n$/, ""))}</bash-stdout><bash-stderr>${escape(err.replace(/\n$/, ""))}</bash-stderr>${code}`;
}
