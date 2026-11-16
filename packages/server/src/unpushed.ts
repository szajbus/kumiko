import { execOutput } from "@kumiko/agent";
import { shellQuote, type SandboxProvider } from "@kumiko/sandbox";
import { WORKSPACE_DIR, WORKTREES_SUFFIX, type RepoUnpushed, type SandboxRepo } from "@kumiko/shared";

/** How long looking through a sandbox's repos may take. */
const LOOK_MS = 60_000;

/**
 * The script that finds, in each repo's clone in /workspace, what only the VM has, as tab-separated lines:
 * `branch <folder> <ahead> <name> <upstream>` for a branch with commits its upstream lacks (or, with none, that no
 * remote has), and for a detached HEAD in a worktree with commits on no branch or remote, `dirty <folder> <files>
 * <worktree>` for a worktree with uncommitted changes, `stashes <folder> <n>`, and `error <folder> <why>` for a repo
 * it can't look at, or where git failed: a failure is never taken for nothing to lose. Nothing the repos' config
 * names runs: no hooks, no fsmonitor.
 */
export function unpushedScript(repos: SandboxRepo[]): string {
  return [
    `cd ${shellQuote(WORKSPACE_DIR)} || exit 0`,
    `t="$(printf '\\t')"`,
    `g() { git -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"; }`,
    `bad() { printf 'error\\t%s\\t%s\\n' "$f" "git $1 failed in ${WORKSPACE_DIR}/$f, so Kumiko can't tell what isn't pushed there."; }`,
    `look() {`,
    `  f="$1"`,
    `  if [ ! -d "$f/.git" ]; then printf 'error\\t%s\\t%s\\n' "$f" "There's no clone at ${WORKSPACE_DIR}/$f."; return; fi`,
    // Full ref names: a short one is ambiguous when a tag shares the branch's name.
    `  refs=$(g -C "$f" for-each-ref --format='%(refname:lstrip=2)%09%(upstream)%09%(upstream:short)' refs/heads) || { bad for-each-ref; return; }`,
    `  while IFS="$t" read -r b ur up; do`,
    `    [ -n "$b" ] || continue`,
    `    case "$ur" in refs/remotes/*) g -C "$f" rev-parse --verify --quiet "$ur" >/dev/null || ur="" ;; *) ur="" ;; esac`,
    `    if [ -n "$ur" ]; then n=$(g -C "$f" rev-list --count "$ur..refs/heads/$b") || { bad rev-list; continue; }`,
    `    else up=""; n=$(g -C "$f" rev-list --count "refs/heads/$b" --not --remotes) || { bad rev-list; continue; }; fi`,
    `    [ "$n" -gt 0 ] && printf 'branch\\t%s\\t%s\\t%s\\t%s\\n' "$f" "$n" "$b" "$up"`,
    `  done <<< "$refs"`,
    `  wts=$(g -C "$f" worktree list --porcelain) || { bad "worktree list"; return; }`,
    `  w=""`,
    `  while IFS= read -r l; do`,
    `    case "$l" in`,
    `      "worktree "*)`,
    `        w="\${l#worktree }"; [ -d "$w" ] || { w=""; continue; }`,
    `        s=$(GIT_OPTIONAL_LOCKS=0 g -C "$w" status --porcelain) || { bad status; continue; }`,
    `        [ -n "$s" ] && printf 'dirty\\t%s\\t%s\\t%s\\n' "$f" "$(printf '%s\\n' "$s" | wc -l | tr -d ' ')" "$w" ;;`,
    `      detached)`,
    `        [ -n "$w" ] || continue`,
    `        n=$(g -C "$w" rev-list --count HEAD --not --branches --remotes) || { bad rev-list; continue; }`,
    `        [ "$n" -gt 0 ] && printf 'branch\\t%s\\t%s\\t%s\\t\\n' "$f" "$n" "HEAD, detached in $w" ;;`,
    `    esac`,
    `  done <<< "$wts"`,
    `  s=$(g -C "$f" stash list) || { bad "stash list"; return; }`,
    `  printf 'stashes\\t%s\\t%s\\n' "$f" "$([ -n "$s" ] && printf '%s\\n' "$s" | wc -l | tr -d ' ' || echo 0)"`,
    `}`,
    ...repos.map((r) => `look ${shellQuote(r.folder)}`),
  ].join("\n");
}

/** Reads `unpushedScript`'s lines into what each repo has that isn't pushed. */
export function parseUnpushed(repos: SandboxRepo[], lines: string[]): RepoUnpushed[] {
  const out = new Map(repos.map((r) => [r.folder, { ...r, branches: [], dirty: [], stashes: 0 } as RepoUnpushed]));
  for (const line of lines) {
    const [kind, folder, ...rest] = line.split("\t");
    const r = out.get(folder);
    if (!r) continue;
    if (kind === "branch" && rest.length >= 2) r.branches.push({ name: rest[1], ahead: Number(rest[0]), ...(rest[2] ? { upstream: rest[2] } : {}) });
    else if (kind === "dirty" && rest.length >= 2) r.dirty.push({ worktree: rest.slice(1).join("\t"), files: Number(rest[0]) });
    else if (kind === "stashes") r.stashes = Number(rest[0]) || 0;
    else if (kind === "error") r.error ??= rest.join("\t");
  }
  return [...out.values()];
}

/** Finds, through an exec in the sandbox's running VM, what its repos have that isn't pushed. */
export async function findUnpushed(exec: SandboxProvider["exec"], sandbox: string, repos: SandboxRepo[]): Promise<RepoUnpushed[]> {
  if (!repos.length) return [];
  const out = await execOutput(exec, sandbox, `bash -c ${shellQuote(unpushedScript(repos))}`, LOOK_MS).catch((err: unknown) => {
    throw new Error(`Kumiko couldn't look through the sandbox's repos: ${err instanceof Error ? err.message : String(err)}`);
  });
  return parseUnpushed(repos, out.split("\n"));
}

/** The script that deletes repos' folders and their worktrees folders from /workspace. */
export function dropScript(folders: string[]): string {
  return [`cd ${shellQuote(WORKSPACE_DIR)} || exit 1`, ...folders.map((f) => `rm -rf -- ${shellQuote(f)} ${shellQuote(`${f}${WORKTREES_SUFFIX}`)}`)].join("\n");
}
