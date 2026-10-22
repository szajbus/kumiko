import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

/**
 * Files Kumiko reads and changes in folders the agent can change too, from its VM. Checking where a path leads and then using it
 * leaves a moment in which the agent can swap a folder on the way for a link to anywhere on the host. Node has no
 * calls relative to an open folder, so these run in a shell that goes into the folder first, checks that it really is
 * where it should be (`pwd -P` names the folder it is in, wherever the path led), and then names files in it only by
 * their own name, with commands that don't follow a link in its place. Swapping anything after that changes nothing.
 */

/** Runs `script` in `dir`, which must really be at that path: links in it are refused. Resolves with its exit code. */
function inDir(dir: string, script: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const sh = spawn("/bin/sh", ["-c", `cd -P -- "$1" && [ "$(pwd -P)" = "$1" ] || exit 99; shift; ${script}`, "sh", dir, ...args], { stdio: "ignore" });
    sh.on("error", () => resolve(-1));
    sh.on("close", (code) => resolve(code ?? -1));
  });
}

/** A name of a file right in its folder, which the scripts below take on their own. */
function plainName(name: string): string {
  if (!name || name === "." || name === ".." || name.includes("/")) throw new Error(`Not a file's name: ${name}`);
  return name;
}

/**
 * Deletes `name` in `dir`, which must really be there (see `inDir`); a link is deleted itself. With `recursive`, a
 * folder and all in it, without following links inside. Resolves whether something was deleted.
 */
export async function removeIn(dir: string, name: string, opts: { recursive?: boolean } = {}): Promise<boolean> {
  const script = `[ -e "$1" ] || [ -L "$1" ] || exit 1; rm ${opts.recursive ? "-rf" : "-f"} -- "$1"`;
  return (await inDir(dir, script, [plainName(name)])) === 0;
}

/**
 * Writes `data` to `name` in `dir`, which must really be there (see `inDir`). The data goes into a file in `scratch`,
 * a folder of Kumiko's own on the same disk, which is then linked in as `name` (`ln -fn`): that replaces whatever had
 * the name, a link too, and never writes through one. Resolves whether it was written.
 */
export async function writeIn(dir: string, name: string, data: Buffer, scratch: string): Promise<boolean> {
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const file = join(scratch, randomBytes(8).toString("hex"));
  try {
    await writeFile(file, data, { flag: "wx" });
    return (await inDir(dir, `ln -fn -- "$2" "$1"`, [plainName(name), file])) === 0;
  } finally {
    await rm(file, { force: true });
  }
}

/**
 * Opens `name` in `dir`, which must really be there (see `inDir`), as the file it is there: hard-linked into `scratch`
 * first (`ln -P`, which links a link itself rather than what it points to), then opened from there without following
 * a link. Resolves with the open file, which is closed and unlinked by `done`; or undefined if there was no such file.
 */
export async function openIn(dir: string, name: string, scratch: string): Promise<{ fh: FileHandle; done(): Promise<void> } | undefined> {
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const file = join(scratch, randomBytes(8).toString("hex"));
  try {
    if ((await inDir(dir, `ln -P -- "$1" "$2"`, [plainName(name), file])) !== 0) return undefined;
    // Not waiting on a pipe, which isn't a file anyway.
    const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
    return fh && { fh, done: () => fh.close() };
  } finally {
    // Unlinked straight away: the open file stays readable, and nothing is left behind.
    await rm(file, { force: true });
  }
}

/**
 * Writes `data` to `name` in `dir`, a folder the agent can't swap but whose files it can: to a new file that no link
 * can be in the way of, then renamed over `name`, which replaces a link rather than writing through it.
 */
export async function replaceFile(dir: string, name: string, data: string | Buffer): Promise<void> {
  const tmp = join(dir, `.${plainName(name)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, data, { flag: "wx" });
    await rename(tmp, join(dir, name));
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
