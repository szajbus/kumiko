import { hasUnpushed, WORKSPACE_DIR, type RepoUnpushed } from "@kumiko/shared";

/** "1 file", "3 files"; `many` for words whose plural isn't just an s. */
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line of what would be lost: what it is, and how much. */
export interface LossRow {
  what: string;
  /** The badge beside it, and its tone. */
  badge: string;
  tone: "sessions" | "warn" | "plain";
}

/** A repo's part of what would be lost, as the dialogs list it; `error` when Kumiko couldn't look. */
export interface LossGroup {
  repo: string;
  rows: LossRow[];
  error?: string;
}

/** A worktree's path in the VM as the list shows it: from /workspace on, without the /workspace. */
export const fromWorkspace = (path: string) => (path.startsWith(`${WORKSPACE_DIR}/`) ? path.slice(WORKSPACE_DIR.length + 1) : path);

/** The repos with anything that would be lost, or that couldn't be looked at, each with its lines. `only` keeps those repos. */
export function lossGroups(repos: RepoUnpushed[], only?: string[]): LossGroup[] {
  const keep = only?.map((r) => r.toLowerCase());
  return repos
    .filter((r) => !keep || keep.includes(r.repo.toLowerCase()))
    .filter((r) => hasUnpushed(r) || r.error)
    .map((r) => ({
      repo: r.repo,
      ...(r.error ? { error: r.error } : {}),
      rows: [
        ...r.branches.map((b): LossRow => ({ what: b.name, badge: count(b.ahead, "unpushed commit"), tone: "sessions" })),
        ...r.dirty.map((d): LossRow => ({ what: fromWorkspace(d.worktree), badge: `Uncommitted changes · ${count(d.files, "file")}`, tone: "warn" })),
        ...(r.stashes > 0 ? [{ what: "stash", badge: count(r.stashes, "stash", "stashes"), tone: "plain" } satisfies LossRow] : []),
      ],
    }));
}

/** What a dialog that would lose work knows of it so far. */
export type LossCheck =
  | { kind: "checking" }
  /** The VM isn't running, so nothing can be looked at; `starting` once the user asked to start it and check. */
  | { kind: "stopped"; starting?: boolean }
  | { kind: "error"; message: string }
  | { kind: "done"; groups: LossGroup[] };

/**
 * Whether the user must say they understand before going on: something would be lost, or Kumiko couldn't tell for a
 * repo. A stopped VM asks nothing: the button says it goes on without checking.
 */
export const mustConfirm = (c: LossCheck) => c.kind === "done" && c.groups.length > 0;

/** Whether the dialog can't go on yet: still looking, or starting the VM to look. */
export const stillChecking = (c: LossCheck) => c.kind === "checking" || (c.kind === "stopped" && c.starting === true);
