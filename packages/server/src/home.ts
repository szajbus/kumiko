import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Another server is using the Kumiko home. */
export class HomeLocked extends Error {}

interface LockRecord {
  pid: number;
  port?: number;
  /** The holder's command line as `ps` shows it, so a pid reused after a crash or a reboot isn't taken for it. */
  command?: string;
}

/** A process's command line from `ps`, or undefined if it isn't running. Rejects if `ps` itself can't run. */
function commandOf(pid: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-o", "command=", "-p", String(pid)], (err, stdout) => {
      // ps exits 1 when no process has the pid.
      if (err && (err as { code?: unknown }).code === 1) return resolve(undefined);
      if (err) return reject(err);
      resolve(stdout.trim() || undefined);
    });
  });
}

/** Whether the lock's holder is still the process that took it. When that can't be told, it is assumed to be. */
async function holds(file: string, lock: LockRecord): Promise<boolean> {
  if (lock.pid === process.pid) return held.has(file);
  try {
    process.kill(lock.pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  if (!lock.command) return true;
  const now = await commandOf(lock.pid).catch(() => lock.command);
  return now === lock.command;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The lock files this process holds: a second server in it (tests run several) is refused like one in another. */
const held = new Set<string>();

/**
 * Makes this server the only one using the Kumiko home: its saved sessions, and the runs of their Claudes, which a
 * second server would attach to and sweep away as well. A lock left by a server that has gone (a crash) is taken
 * over; one held by a live server is waited for up to `waitMs`, which covers a restart's handover, then refused.
 * Returns the release, which only removes the lock if it is still this server's.
 */
export async function lockHome(home: string, opts: { waitMs?: number } = {}): Promise<{ release(): Promise<void>; setPort(port: number): Promise<void> }> {
  const file = join(home, "server.lock");
  await mkdir(home, { recursive: true });
  const command = await commandOf(process.pid).catch(() => undefined);
  const record: LockRecord = { pid: process.pid, command };
  const end = Date.now() + (opts.waitMs ?? 5000);
  for (;;) {
    try {
      await writeFile(file, JSON.stringify(record) + "\n", { flag: "wx" });
      held.add(file);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let holder: LockRecord | undefined;
    try {
      holder = JSON.parse(await readFile(file, "utf8")) as LockRecord;
    } catch {
      // Unreadable: half written by a server starting now, or left broken. Gone by the deadline, it is taken over.
    }
    if (holder && !(await holds(file, holder))) {
      await rm(file, { force: true });
      continue;
    }
    if (Date.now() > end) {
      if (!holder) {
        await rm(file, { force: true });
        continue;
      }
      throw new HomeLocked(
        `Another Kumiko server (pid ${holder.pid}${holder.port ? `, port ${holder.port}` : ""}) is using ${home}. Quit it first, ` +
          `or give this one a home of its own with KUMIKO_HOME. If no Kumiko is running, delete ${file}.`,
      );
    }
    await sleep(100);
  }
  const ours = async () => {
    if (!held.has(file)) return false;
    try {
      return (JSON.parse(await readFile(file, "utf8")) as LockRecord).pid === process.pid;
    } catch {
      return false;
    }
  };
  return {
    async setPort(port) {
      if (await ours()) await writeFile(file, JSON.stringify({ ...record, port }) + "\n");
    },
    async release() {
      if (await ours()) await rm(file, { force: true });
      held.delete(file);
    },
  };
}

/**
 * The Kumiko home's own id, made the first time it is asked for. Runs in a sandbox are tagged with it, so servers on
 * different homes that share VMs (a separate dev instance, say) leave each other's Claudes alone.
 */
export async function homeId(home: string): Promise<string> {
  const file = join(home, "home-id");
  try {
    const id = (await readFile(file, "utf8")).trim();
    if (/^[0-9a-f]{16}$/.test(id)) return id;
  } catch {
    // Not made yet.
  }
  const id = randomBytes(8).toString("hex");
  await mkdir(home, { recursive: true });
  await writeFile(file, id + "\n");
  return id;
}
