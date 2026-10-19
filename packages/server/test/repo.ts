import { execFileSync } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** git with a fixed identity and no user config, so tests don't depend on the machine they run on. */
export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

/** A clone of a bare "origin" with one commit on main, pushed. Returns the clone's real path. */
export async function makeClone(root: string, name: string): Promise<string> {
  const origin = join(root, `${name}-origin.git`);
  const clone = join(root, name);
  await mkdir(origin, { recursive: true });
  sh(origin, "init", "--bare", "--initial-branch=main");
  sh(root, "clone", "--quiet", origin, clone);
  await writeFile(join(clone, "README"), "hi\n");
  sh(clone, "add", "README");
  sh(clone, "commit", "--quiet", "-m", "first");
  sh(clone, "push", "--quiet", "-u", "origin", "main");
  sh(clone, "remote", "set-head", "origin", "main");
  return realpath(clone);
}
