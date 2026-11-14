import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { sh } from "./repo.js";

/**
 * A stand-in for github.com's git side: bare repositories under `base`, served by a git daemon of their own over TCP.
 * Not file://: git pushing from inside a mirror's pre-receive hook would hand the quarantine to a local receiving git.
 */
export interface FakeGitHub {
  base: string;
  /** `git://127.0.0.1:<port>`; a repository is `<url>/<owner>/<name>.git`. */
  url: string;
  /** Makes `owner/name` with one commit on main, and a clone of it at `work` to change it from. */
  repo(repo: string): Promise<{ bare: string; work: string }>;
  close(): void;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export async function fakeGitHub(root: string): Promise<FakeGitHub> {
  const base = join(root, "github");
  await mkdir(base, { recursive: true });
  const port = await freePort();
  const daemon: ChildProcess = spawn(
    "git",
    ["daemon", "--reuseaddr", "--listen=127.0.0.1", `--port=${port}`, `--base-path=${base}`, "--export-all", "--enable=receive-pack", "--informative-errors", base],
    { stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
  );
  const url = `git://127.0.0.1:${port}`;
  // Ready once it answers.
  for (let i = 0; i < 50; i++) {
    const up = await new Promise<boolean>((resolve) => {
      const c = createServer().listen(port, "127.0.0.1");
      c.once("listening", () => c.close(() => resolve(false)));
      c.once("error", () => resolve(true));
    });
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    url,
    async repo(repo) {
      const bare = join(base, `${repo}.git`);
      await mkdir(bare, { recursive: true });
      sh(bare, "init", "--bare", "--quiet", "--initial-branch=main");
      const work = join(root, "work", repo);
      await mkdir(join(root, "work"), { recursive: true });
      sh(join(root, "work"), "clone", "--quiet", bare, work);
      await writeFile(join(work, "README"), "hi\n");
      sh(work, "add", "README");
      sh(work, "commit", "--quiet", "-m", "first");
      sh(work, "push", "--quiet", "origin", "main");
      return { bare, work };
    },
    close: () => void daemon.kill(),
  };
}
