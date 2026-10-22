import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_SCRIPT_PATTERN, AGENT_SETUP_DIR, type AgentScript, type AgentSetupResponse, type AgentSetupRun } from "@kumiko/shared";
import { openIn } from "./files.js";

/** The largest setup script Kumiko runs; anything bigger is more likely a mistake than a script. */
export const MAX_AGENT_SCRIPT_BYTES = 64 * 1024;

/**
 * The agent's setup scripts in a Claude home, in the order they run: by name, byte by byte, so `10-…` comes before `20-…`
 * whatever the locale. The folder is the agent's to change, so each file is opened as it really is there (see `openIn`):
 * a link, or a folder on the way that leads elsewhere, is ignored rather than followed out to the host.
 */
export async function readAgentScripts(claudeHome: string, scratch: string): Promise<{ scripts: AgentScript[]; ignored: string[] }> {
  const home = await realpath(claudeHome).catch(() => undefined);
  if (!home) return { scripts: [], ignored: [] };
  const dir = join(home, AGENT_SETUP_DIR);
  // Not listing a folder that leads somewhere else; `openIn` checks again for each file.
  if ((await realpath(dir).catch(() => undefined)) !== dir) return { scripts: [], ignored: [] };
  const names = (await readdir(dir).catch(() => [])).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const scripts: AgentScript[] = [];
  const ignored: string[] = [];
  for (const file of names) {
    const script = AGENT_SCRIPT_PATTERN.test(file) ? await readScript(dir, file, scratch) : undefined;
    if (script === undefined) ignored.push(file);
    else scripts.push({ file, script });
  }
  return { scripts, ignored };
}

/** A script's text, or undefined if it isn't a plain file in `dir`, or is too big. */
async function readScript(dir: string, file: string, scratch: string): Promise<string | undefined> {
  const opened = await openIn(dir, file, scratch).catch(() => undefined);
  if (!opened) return undefined;
  try {
    const st = await opened.fh.stat();
    if (!st.isFile() || st.size > MAX_AGENT_SCRIPT_BYTES) return undefined;
    return (await opened.fh.readFile()).toString("utf8");
  } finally {
    await opened.done();
  }
}

/**
 * The agent's scripts as they are now, each with how it went when the VM was created: only if it ran then as it is now,
 * since a script changed since hasn't run in this VM.
 */
export function withExitCodes(run: AgentSetupRun | undefined, now: { scripts: AgentScript[]; ignored: string[] }): AgentSetupResponse {
  const ran = new Map((run?.scripts ?? []).map((s) => [s.file, s]));
  return {
    scripts: now.scripts.map(({ file, script }) => {
      const code = ran.get(file)?.script === script ? ran.get(file)?.exitCode : undefined;
      return { file, script, ...(code !== undefined ? { exitCode: code } : {}) };
    }),
    ignored: now.ignored,
  };
}
