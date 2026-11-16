import { eachLine, exitCode, shellQuote, type SandboxProvider } from "@kumiko/sandbox";
import { WORKSPACE_DIR, WORKTREES_SUFFIX, type RepoUnpushed, type SandboxRepo } from "@kumiko/shared";

/** How long looking through a sandbox's repos may take. */
const LOOK_MS = 60_000;

/**
 * The script that finds, in each repo's clone in /workspace, what only the VM has, as tab-separated lines:
 * `branch <folder> <ahead> <name> <upstream>` for a branch with commits its upstream lacks (or, with none, that no
 * remote has), `dirty <folder> <files> <worktree>` for a worktree with uncommitted changes, `stashes <folder> <n>`, and
 * `error <folder> <why>` for a repo it can't look at. Nothing the repos' config names runs: no hooks, no fsmonitor.
 */
export function unpushedScript(repos: SandboxRepo[]): string {
  return [
    `cd ${shellQuote(WORKSPACE_DIR)} || exit 0`,
    `t="$(printf '\\t')"`,
    `g() { git -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"; }`,
    `look() {`,
    `  f="$1"`,
    `  if [ ! -d "$f/.git" ]; then printf 'error\\t%s\\t%s\\n' "$f" "There's no clone at ${WORKSPACE_DIR}/$f."; return; fi`,
    `  g -C "$f" for-each-ref --format='%(refname:short)%09%(upstream:short)' refs/heads | while IFS="$t" read -r b up; do`,
    `    if [ -n "$up" ] && g -C "$f" rev-parse --verify --quiet "refs/remotes/$up" >/dev/null; then n=$(g -C "$f" rev-list --count "refs/remotes/$up..refs/heads/$b")`,
    `    else up=""; n=$(g -C "$f" rev-list --count "refs/heads/$b" --not --remotes); fi`,
    `    [ "\${n:-0}" -gt 0 ] && printf 'branch\\t%s\\t%s\\t%s\\t%s\\n' "$f" "$n" "$b" "$up"`,
    `  done`,
    `  g -C "$f" worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r w; do`,
    `    [ -d "$w" ] || continue`,
    `    n=$(GIT_OPTIONAL_LOCKS=0 g -C "$w" status --porcelain 2>/dev/null | wc -l | tr -d ' ')`,
    `    [ "\${n:-0}" -gt 0 ] && printf 'dirty\\t%s\\t%s\\t%s\\n' "$f" "$n" "$w"`,
    `  done`,
    `  printf 'stashes\\t%s\\t%s\\n' "$f" "$(g -C "$f" stash list 2>/dev/null | wc -l | tr -d ' ')"`,
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
    else if (kind === "error") r.error = rest.join("\t");
  }
  return [...out.values()];
}

/** Finds, through an exec in the sandbox's running VM, what its repos have that isn't pushed. */
export async function findUnpushed(exec: SandboxProvider["exec"], sandbox: string, repos: SandboxRepo[]): Promise<RepoUnpushed[]> {
  if (!repos.length) return [];
  const child = exec(sandbox, `bash -c ${shellQuote(unpushedScript(repos))}`, []);
  child.stdin!.end();
  const timer = setTimeout(() => child.kill(), LOOK_MS);
  const lines: string[] = [];
  const err: string[] = [];
  eachLine(child.stdout!, (l) => lines.push(l));
  eachLine(child.stderr!, (l) => err.push(l));
  const code = await exitCode(child);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`Kumiko couldn't look through the sandbox's repos (exit ${code})${err.length ? `: ${err.slice(-2).join(" ")}` : "."}`);
  return parseUnpushed(repos, lines);
}

/** The script that deletes repos' folders and their worktrees folders from /workspace. */
export function dropScript(folders: string[]): string {
  return [`cd ${shellQuote(WORKSPACE_DIR)} || exit 1`, ...folders.map((f) => `rm -rf -- ${shellQuote(f)} ${shellQuote(`${f}${WORKTREES_SUFFIX}`)}`)].join("\n");
}
