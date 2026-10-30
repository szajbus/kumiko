import { isWaiting, type LogLine, type ResumableSession, type SandboxView, type SessionInfo } from "@kumiko/shared";
import { statusOf } from "./status.ts";

/** A step of starting an asleep session's sandbox and Claude in it. */
export interface WakeStep {
  label: string;
  state: "done" | "now" | "todo";
}

/** What the banner of an asleep session says while its sandbox starts. */
export interface WakeProgress {
  /** The step under way, as the project page says it: `Starting the sandbox…`, `Provisioning…`, then `Starting Claude…`. */
  text: string;
  steps: WakeStep[];
  /** The log's last line, while the sandbox starts. */
  line?: string;
}

/**
 * Where starting an asleep session is: the sandbox's operation until the sandbox runs, then Claude, which the server
 * starts once it does. Booting is done once the sandbox runs and nothing else is under way in it.
 */
export function wakeProgress(sandbox: SandboxView | undefined, log: readonly LogLine[]): WakeProgress {
  const booted = sandbox?.status === "running" && !sandbox.busy;
  const line = booted ? undefined : [...log].reverse().find((l) => l.text.trim())?.text.trim();
  return {
    text: booted || !sandbox ? "Starting Claude…" : sandbox.busy ? busyText(sandbox, log) : "Starting the sandbox…",
    steps: [
      { label: "Booting the sandbox", state: booted ? "done" : "now" },
      { label: "Starting Claude", state: booted ? "now" : "todo" },
    ],
    ...(line ? { line } : {}),
  };
}

/** The project page's status for the sandbox's operation, naming the sandbox when it only says it starts. */
const busyText = (sandbox: SandboxView, log: readonly LogLine[]) => {
  const text = statusOf(sandbox, [...log]).text;
  return text === "Starting…" ? "Starting the sandbox…" : text;
};

/** The sessions a project's page lists: its open ones, those waiting on the user first, then its closed ones. */
export interface ProjectSessions {
  open: SessionInfo[];
  /** Closed with nothing more to finish, most recent first. */
  closed: ResumableSession[];
}

/**
 * Splits a project's sessions into the open ones and the saved ones that have no tab. The saved list has those whose
 * tab closed while Claude finishes too; they are open sessions still, shown as such, so they aren't among the closed.
 */
export function projectSessions(sandbox: string, open: readonly SessionInfo[], saved: readonly ResumableSession[]): ProjectSessions {
  const mine = open.filter((s) => s.sandbox === sandbox);
  const ids = new Set(mine.map((s) => s.id));
  return {
    open: mine.filter((s) => !s.closing).sort((a, b) => Number(isWaiting(b)) - Number(isWaiting(a))),
    closed: saved
      .filter((s) => s.sandbox === sandbox && !ids.has(s.id))
      .sort((a, b) => (b.updatedAt ?? b.startedAt).localeCompare(a.updatedAt ?? a.startedAt)),
  };
}
