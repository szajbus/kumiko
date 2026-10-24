import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ATTACHMENTS_TOTAL_LIMIT, checkAttachment, formatBytes, type Attachment, type SessionEvent } from "@kumiko/shared";
import type { AgentFile } from "@kumiko/agent";

const HASH = /^[0-9a-f]{64}$/;
const MAX_NAME = 200;

/** The hashes of the files the prompts in `events` were sent with. */
export function attachmentHashes(events: Iterable<SessionEvent>): Set<string> {
  const hashes = new Set<string>();
  for (const e of events) if (e.kind === "user_prompt") for (const a of e.payload.attachments ?? []) hashes.add(a.hash);
  return hashes;
}

/** Files that can't go with a prompt: not a kind Claude reads, too big, or gone from the server. */
export class AttachmentRefused extends Error {}

/**
 * The files sent with prompts, one per content, named by its SHA-256. Sessions' events only name them, so the events
 * stay small; a prompt sent again (a retry, or after a rewind) finds its files here.
 */
export class AttachmentStore {
  constructor(readonly dir: string) {}

  private file(hash: string): string {
    if (!HASH.test(hash)) throw new Error(`Not a file hash: ${hash}`);
    return join(this.dir, hash);
  }

  /**
   * Checks the files of a prompt, from a request body, and keeps the new ones. Returns them as the session records
   * them and as the agent gets them.
   */
  async take(inputs: unknown): Promise<{ attachments: Attachment[]; files: AgentFile[] }> {
    if (inputs === undefined) return { attachments: [], files: [] };
    if (!Array.isArray(inputs)) throw new AttachmentRefused("Attachments must be a list.");
    // Sized from the base64 first, so too much is refused before it is decoded.
    const encoded = inputs.reduce((n: number, i: { data?: unknown }) => n + (typeof i?.data === "string" ? Math.floor((i.data.length * 3) / 4) : 0), 0);
    if (encoded > ATTACHMENTS_TOTAL_LIMIT) throw new AttachmentRefused(`That's ${formatBytes(encoded)} of files; one message can take ${formatBytes(ATTACHMENTS_TOTAL_LIMIT)} at most.`);
    const read = await Promise.all(
      inputs.map(async (input: { name?: unknown; data?: unknown; hash?: unknown }) => {
        const name = typeof input?.name === "string" && input.name.trim() ? input.name.trim().slice(0, MAX_NAME) : "file";
        if (typeof input?.data === "string") return { name, data: Buffer.from(input.data, "base64"), known: false };
        if (typeof input?.hash === "string" && HASH.test(input.hash)) return { name, data: await this.read(input.hash, name), known: true };
        throw new AttachmentRefused(`${name}: an attachment needs its data or the hash of one sent before.`);
      }),
    );
    const total = read.reduce((n, f) => n + f.data.length, 0);
    if (total > ATTACHMENTS_TOTAL_LIMIT) throw new AttachmentRefused(`That's ${formatBytes(total)} of files; one message can take ${formatBytes(ATTACHMENTS_TOTAL_LIMIT)} at most.`);

    const attachments: Attachment[] = [];
    const files: AgentFile[] = [];
    for (const { name, data, known } of read) {
      const checked = checkAttachment(name, data);
      if ("error" in checked) throw new AttachmentRefused(checked.error);
      const hash = createHash("sha256").update(data).digest("hex");
      if (!known) await this.write(hash, data);
      attachments.push({ name, kind: checked.kind, mediaType: checked.mediaType, size: data.length, hash });
      files.push({ name, mediaType: checked.mediaType, data });
    }
    return { attachments, files };
  }

  /** The files of a prompt that was sent before, for the agent. */
  async load(attachments: Attachment[] = []): Promise<AgentFile[]> {
    return Promise.all(attachments.map(async (a) => ({ name: a.name, mediaType: a.mediaType, data: await this.read(a.hash, a.name) })));
  }

  /** Deletes every file none of `events` name. For startup, before any prompt can bring new ones. */
  async sweep(events: Iterable<SessionEvent>): Promise<void> {
    const keep = attachmentHashes(events);
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    await Promise.all(names.filter((n) => !keep.has(n)).map((n) => rm(join(this.dir, n), { force: true })));
  }

  private async read(hash: string, name: string): Promise<Buffer> {
    try {
      return await readFile(this.file(hash));
    } catch {
      throw new AttachmentRefused(`${name} is no longer on the server; attach it again.`);
    }
  }

  private async write(hash: string, data: Buffer): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(hash)}.${process.pid}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, this.file(hash));
  }
}
