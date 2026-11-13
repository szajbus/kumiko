import { chunksLength, keepEnds, mergeChunks, SHELL_KEEP_HEAD, SHELL_KEEP_TAIL, shellDuration, type SessionEvent, type ShellChunk } from "@kumiko/shared";

type Ended = Extract<SessionEvent, { kind: "user_shell_end" }>["payload"];

/** A command the user ran in the sandbox, as its events tell it. */
export interface UserShell {
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  /** What it printed: its start and end as it streams in while it runs, then what the chat keeps of it. */
  output: ShellChunk[];
  /** Characters left out between the start and the end of `output`. */
  cut: number;
  /** How it ended, once it has. */
  end?: Ended;
}

/** The commands of a session by run id. */
export type UserShells = Record<string, UserShell>;

/** Applies one event; returns `s` itself for any event that isn't a command's. */
export function applyShellEvent(s: UserShells, ev: SessionEvent): UserShells {
  switch (ev.kind) {
    case "user_shell":
      return { ...s, [ev.payload.id]: { ...ev.payload, output: [], cut: 0 } };
    case "user_shell_output": {
      const shell = s[ev.payload.id];
      if (!shell || shell.end) return s;
      // The server keeps only the latest of a long run's output: what it dropped before this is left out too.
      const gap = Math.max(0, ev.payload.at - chunksLength(shell.output) - shell.cut);
      const kept = keepEnds([...shell.output, ev.payload.chunk], SHELL_KEEP_HEAD, SHELL_KEEP_TAIL);
      return { ...s, [shell.id]: { ...shell, output: kept.chunks, cut: shell.cut + gap + kept.cut } };
    }
    case "user_shell_end": {
      const shell = s[ev.payload.id];
      if (!shell) return s;
      return { ...s, [shell.id]: { ...shell, output: ev.payload.output, cut: ev.payload.cut, end: ev.payload } };
    }
    default:
      return s;
  }
}

/** Where a command is: running, done (exit 0), failed (another exit code, or it couldn't run) or stopped. */
export type ShellState = "running" | "ok" | "failed" | "stopped";

export function shellState(shell: UserShell): ShellState {
  const { end } = shell;
  if (!end) return "running";
  if (end.stopped) return "stopped";
  return end.code === 0 && !end.error ? "ok" : "failed";
}

/** The word at the right of a finished command's line: "exit 1", "Stopped", "Couldn't run". */
export function shellStatusText(shell: UserShell): string | undefined {
  const { end } = shell;
  if (!end) return undefined;
  if (end.error) return "Couldn't run";
  if (end.stopped === "lost") return "Stopped: Kumiko restarted";
  if (end.stopped) return "Stopped";
  return end.code === 0 ? undefined : `exit ${end.code ?? "?"}`;
}

/** How long it ran, or has run until `now`. */
export function shellElapsed(shell: UserShell, now = Date.now()): string {
  return shellDuration(shell.end ? shell.end.durationMs : Math.max(0, now - Date.parse(shell.startedAt)));
}

/** The output to show: the start and end the chat kept, with what was left out between them, if anything. */
export function shellOutputParts(shell: UserShell): { head: ShellChunk[]; cut: number; tail: ShellChunk[] } {
  const { cut } = shell;
  if (!cut) return { head: shell.output, cut: 0, tail: [] };
  // The chat keeps the first SHELL_KEEP_HEAD characters, then the end.
  const head: ShellChunk[] = [];
  const tail: ShellChunk[] = [];
  let at = 0;
  for (const c of shell.output) {
    const split = SHELL_KEEP_HEAD - at;
    if (split >= c.text.length) head.push(c);
    else if (split <= 0) tail.push(c);
    else {
      head.push({ stream: c.stream, text: c.text.slice(0, split) });
      tail.push({ stream: c.stream, text: c.text.slice(split) });
    }
    at += c.text.length;
  }
  return { head, cut, tail };
}

/**
 * What the line under a command says of what Claude got of it: nothing while it runs or when Claude got all of it;
 * that it got part when it couldn't get all, naming the log with the rest; that it gets it once Claude has its answer,
 * when `prompted` it isn't yet; that it got none when it never will.
 */
export function shellNote(shell: UserShell, prompted: boolean): string | undefined {
  const { end } = shell;
  if (!end) return undefined;
  if (end.alone) return end.stopped === "lost" ? "Claude didn't get this: Kumiko restarted while it ran." : "Claude didn't get this: the session ended, or was closing.";
  if (!prompted) return "Claude gets this once you've answered its question.";
  if (end.log) return `Claude got its start and its end; all of it is in ${end.log}`;
  return undefined;
}

/**
 * The entry of `history` that Up (or Down) goes to from entry `from` (`history.length` being the box's own message):
 * the one before (or after), or with `commands`, the command before (or after), commands being kept with their "!".
 * Undefined when there is none.
 */
export function historyStep(history: readonly string[], from: number, up: boolean, commands: boolean): number | undefined {
  for (let i = from + (up ? -1 : 1); i >= 0 && i <= history.length; i += up ? -1 : 1) {
    if (i === history.length || !commands || history[i]!.startsWith("!")) return i;
  }
  return undefined;
}
