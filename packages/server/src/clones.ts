import { eachLine, exitCode, shellQuote, type SandboxProvider } from "@kumiko/sandbox";
import { WORKSPACE_DIR, WORKTREES_SUFFIX, type RepoState, type SandboxRepo } from "@kumiko/shared";

/** How long cloning a sandbox's repos may take, all of them; a big repository over a slow link takes a while. */
const CLONE_MS = 30 * 60_000;

/**
 * The script that clones each repo missing from /workspace, through the relay: `git@github.com:` is rewritten to
 * Kumiko's mirror by the VM's git config, and origin keeps GitHub's URL. A clone is made beside its folder and moved
 * into place only once it is whole, so a folder there is a clone that worked. Each repo's worktrees folder is made
 * too. Prints `ok <folder>` or `fail <folder> <why>` for each, in order.
 */
export function cloneScript(repos: SandboxRepo[]): string {
  return [
    `cd ${shellQuote(WORKSPACE_DIR)} || { echo "fail * ${WORKSPACE_DIR} isn't there"; exit 0; }`,
    `clone() {`,
    `  f="$2"`,
    `  if [ -d "$f/.git" ]; then mkdir -p -- "\${f}${WORKTREES_SUFFIX}"; echo "ok $f"; return; fi`,
    `  if [ -e "$f" ] || [ -L "$f" ]; then echo "fail $f ${WORKSPACE_DIR}/$f is there already, and isn't a git clone. Move it aside, then start the sandbox again."; return; fi`,
    `  tmp=".kumiko-clone-$f"; rm -rf "$tmp"`,
    `  if out=$(git clone --quiet "git@github.com:$1.git" "$tmp" 2>&1 </dev/null); then`,
    `    mv -- "$tmp" "$f" && mkdir -p -- "\${f}${WORKTREES_SUFFIX}" && echo "ok $f"`,
    `  else`,
    `    rm -rf "$tmp"; echo "fail $f $(printf '%s' "$out" | tail -n 3 | tr '\\n' ' ')"`,
    `  fi`,
    `}`,
    ...repos.map((r) => `clone ${shellQuote(r.repo)} ${shellQuote(r.folder)}`),
  ].join("\n");
}

/**
 * How each sandbox's repos are cloned in its VM, as Kumiko last found them, and the work of cloning the missing ones.
 * Kept in memory: Kumiko looks again whenever git in a VM can reach the mirrors (`sync`).
 */
export class Clones {
  private readonly states = new Map<string, Map<string, Omit<RepoState, keyof SandboxRepo>>>();
  /** The sync under way for each sandbox, and whether another was asked for meanwhile. */
  private readonly running = new Map<string, { again?: SandboxRepo[] }>();

  constructor(
    private readonly exec: SandboxProvider["exec"],
    private readonly onChange: () => void,
  ) {}

  /** The sandbox's repos with how each one's clone is. */
  view(sandbox: string, repos: SandboxRepo[]): RepoState[] {
    const known = this.states.get(sandbox);
    return repos.map((r) => ({ ...r, ...(known?.get(r.repo) ?? { state: "pending" as const }) }));
  }

  /** Clones the repos missing from the sandbox's VM, and finds out how the others are. One at a time per sandbox. */
  sync(sandbox: string, repos: SandboxRepo[]): void {
    const run = this.running.get(sandbox);
    if (run) {
      run.again = repos;
      return;
    }
    const entry: { again?: SandboxRepo[] } = {};
    this.running.set(sandbox, entry);
    void (async () => {
      let next: SandboxRepo[] | undefined = repos;
      while (next) {
        entry.again = undefined;
        await this.once(sandbox, next);
        next = entry.again;
      }
      this.running.delete(sandbox);
    })();
  }

  /** Forgets what is known of a sandbox's clones: its VM stopped, or the sandbox is gone. */
  forget(sandbox: string): void {
    if (this.states.delete(sandbox)) this.onChange();
  }

  private async once(sandbox: string, repos: SandboxRepo[]): Promise<void> {
    if (!repos.length) return;
    const known = this.states.get(sandbox) ?? new Map();
    this.states.set(sandbox, known);
    // Those not known to be cloned are being cloned, as far as anyone can tell until the script says.
    for (const r of repos) if (known.get(r.repo)?.state !== "cloned") known.set(r.repo, { state: "cloning" });
    this.onChange();
    const results = new Map<string, Omit<RepoState, keyof SandboxRepo>>();
    let failed: string | undefined;
    try {
      const child = this.exec(sandbox, `bash -c ${shellQuote(cloneScript(repos))}`, []);
      child.stdin!.end();
      const timer = setTimeout(() => child.kill(), CLONE_MS);
      const err: string[] = [];
      eachLine(child.stdout!, (line) => {
        const m = /^(ok|fail) (\S+)(?: (.*))?$/.exec(line);
        if (!m) return;
        if (m[2] === "*") failed = m[3];
        const r = repos.find((x) => x.folder === m[2]);
        if (r) results.set(r.repo, m[1] === "ok" ? { state: "cloned" } : { state: "failed", error: (m[3] ?? "").trim() || "git clone failed." });
      });
      eachLine(child.stderr!, (l) => err.push(l));
      const code = await exitCode(child);
      clearTimeout(timer);
      if (code !== 0 && !results.size) failed = `Kumiko couldn't run git in the sandbox (exit ${code})${err.length ? `: ${err.slice(-2).join(" ")}` : "."}`;
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    }
    for (const r of repos) known.set(r.repo, results.get(r.repo) ?? { state: "failed", error: failed ?? "Cloning stopped before it got to this repo." });
    this.onChange();
  }
}
