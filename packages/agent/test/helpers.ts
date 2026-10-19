import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execScript, shellQuote } from "@bentomo/sandbox";
import type { Exec } from "../src/index.js";

export const FAKE_CLAUDE = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/fake-claude.mjs");

/** Puts a `claude` that runs the fake into `<home>/.local/bin`, where execScript's PATH looks first. */
export async function installFakeClaude(home: string): Promise<void> {
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "claude"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(FAKE_CLAUDE)} "$@"\n`);
  await chmod(join(bin, "claude"), 0o755);
}

/**
 * An `exec` that runs the command locally the way the Lima provider does in the VM: `bash -s` fed the same
 * preamble. HOME is a temp dir and PATH is minimal, so only a `claude` installed there is found.
 */
export async function localExec(values: NodeJS.ProcessEnv = {}, opts: { claude?: boolean } = {}): Promise<{ exec: Exec; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "bentomo-agent-test-"));
  if (opts.claude !== false) await installFakeClaude(home);
  const exec: Exec = (_sandbox, cmd, env, o = {}) => {
    const child = spawn("bash", ["-s"], { stdio: ["pipe", "pipe", "pipe"], env: { HOME: home, PATH: "/usr/bin:/bin" } });
    child.stdin!.write(execScript(cmd, env, values, o.cwd));
    return child;
  };
  return { exec, home };
}
