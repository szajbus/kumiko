import { execFile } from "node:child_process";
import { homedir } from "node:os";

const TIMEOUT_MS = 10_000;

export class GitError extends Error {
  /** Everything git printed on stderr; the message is only its first line. */
  constructor(message: string, readonly stderr = "") {
    super(message);
  }
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/** Runs git on the host as it is, without a shell, so paths and branch names are only ever arguments or output. */
export function runGit(cwd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: opts.timeoutMs ?? TIMEOUT_MS, signal: opts.signal, maxBuffer: 16 * 1024 * 1024, env: opts.env ?? { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return reject(new GitError("git isn't installed on this machine, or isn't on PATH."));
        const all = String(stderr).trim();
        reject(new GitError(all.split("\n")[0] || err.message, all));
      },
    );
  });
}

/** The user's git identity on the host, from their global config; what isn't set is left out. */
export async function hostIdentity(): Promise<{ name?: string; email?: string }> {
  const get = (key: string) => runGit(homedir(), ["config", "--global", "--get", key]).then((v) => v.trim() || undefined, () => undefined);
  const [name, email] = await Promise.all([get("user.name"), get("user.email")]);
  return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
}
