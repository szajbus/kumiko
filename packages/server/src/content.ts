import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEvent } from "@kumiko/shared";

const HASH = /^[0-9a-f]{64}$/;

export const contentHash = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/**
 * What windows have shown of their artifacts' files, one file per version, named by its SHA-256. Windows' events only
 * name them, so the events stay small however large the artifacts; a rewind puts files back from here. Shared by all
 * sessions, so a fork names the same ones.
 */
export class ArtifactContent {
  constructor(readonly dir: string) {}

  private file(hash: string): string {
    if (!HASH.test(hash)) throw new Error(`Not a content hash: ${hash}`);
    return join(this.dir, hash);
  }

  /** Keeps `data`, unless it is kept already; returns its hash. */
  async put(data: Buffer): Promise<string> {
    const hash = contentHash(data);
    const file = this.file(hash);
    if (existsSync(file)) return hash;
    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
    return hash;
  }

  /** The content with `hash`, or undefined if it isn't kept (or `hash` isn't one). */
  async get(hash: string): Promise<Buffer | undefined> {
    if (!HASH.test(hash)) return undefined;
    return readFile(this.file(hash)).catch(() => undefined);
  }

  /** Deletes every version none of `events` name. For startup, before any window can keep new ones. */
  async sweep(events: Iterable<SessionEvent>): Promise<void> {
    const keep = new Set<string>();
    for (const e of events) if (e.kind === "window") hashesIn(e.payload.op, keep);
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    await Promise.all(names.filter((n) => !keep.has(n)).map((n) => rm(join(this.dir, n), { force: true })));
  }
}

/** Every `content` hash in a window op, wherever its shape puts it: an added widget, an update, a sync's widgets. */
function hashesIn(v: unknown, into: Set<string>) {
  if (Array.isArray(v)) for (const x of v) hashesIn(x, into);
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      if (k === "content" && typeof x === "string" && HASH.test(x)) into.add(x);
      else hashesIn(x, into);
    }
}
