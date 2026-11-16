import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AGENT_SCRIPT_MAX_BYTES, AGENT_SCRIPT_PATTERN, AGENT_SETUP_DIR, type AgentScript, type AgentSetupResponse, type AgentSetupRun } from "@kumiko/shared";
import { openIn, removeIn } from "./files.js";

/**
 * The agent's setup scripts in a sandbox's Kumiko folder, in the order they run: by name, byte by byte, so `10-…` comes before `20-…`
 * whatever the locale. The folder is the agent's to change, so each file is opened as it really is there (see `openIn`):
 * a link, or a folder on the way that leads elsewhere, is ignored rather than followed out to the host.
 */
export async function readAgentScripts(kumikoHome: string, scratch: string): Promise<{ scripts: AgentScript[]; ignored: string[] }> {
  const home = await realpath(kumikoHome).catch(() => undefined);
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
    if (!st.isFile() || st.size > AGENT_SCRIPT_MAX_BYTES) return undefined;
    return (await opened.fh.readFile()).toString("utf8");
  } finally {
    await opened.done();
  }
}

/**
 * Deletes the agent's setup folder and all in it, so the next VM starts with only the user's setup. The folder is the
 * agent's to change, so it is deleted as it really is in the Kumiko folder (see `removeIn`): a link in its place is deleted
 * itself, and nothing is deleted through a folder on the way that leads elsewhere. Resolves whether it is gone.
 */
export async function deleteAgentScripts(kumikoHome: string): Promise<boolean> {
  const home = await realpath(kumikoHome).catch(() => undefined);
  if (!home) return true;
  const parent = join(home, dirname(AGENT_SETUP_DIR));
  const name = basename(AGENT_SETUP_DIR);
  if (!(await lstat(join(parent, name)).then(() => true, () => false))) return true;
  return removeIn(parent, name, { recursive: true });
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
