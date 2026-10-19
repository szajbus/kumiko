import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SandboxMeta } from "@bentomo/shared";

export function defaultMetadataDir(): string {
  return process.env.BENTOMO_HOME
    ? join(process.env.BENTOMO_HOME, "sandboxes")
    : join(homedir(), ".bentomo", "sandboxes");
}

/** Bentomo's record of a sandbox is there but can't be used: not JSON, edited by hand, or unreadable. */
export class MetadataError extends Error {
  constructor(readonly file: string, why: string) {
    super(`Bentomo's record of this sandbox, ${file}, can't be read (${why}). Fix the file, or delete it to treat the sandbox as one Bentomo didn't create.`);
    this.name = "MetadataError";
  }
}

/** One JSON file per sandbox Bentomo created. Holds variable names only, never values. */
export class MetadataStore {
  constructor(readonly dir: string = defaultMetadataDir()) {}

  private file(name: string): string {
    return join(this.dir, `${name}.json`);
  }

  /** The sandbox's record; undefined when there is none, MetadataError when there is one that can't be used. */
  async read(name: string): Promise<SandboxMeta | undefined> {
    const file = this.file(name);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new MetadataError(file, err instanceof Error ? err.message : String(err));
    }
    let meta: Partial<SandboxMeta> | null;
    try {
      meta = JSON.parse(text) as Partial<SandboxMeta> | null;
    } catch (err) {
      throw new MetadataError(file, err instanceof Error ? err.message : String(err));
    }
    const spec = meta?.spec;
    if (!spec || typeof spec.name !== "string" || !Array.isArray(spec.mounts) || !Array.isArray(spec.env)) {
      throw new MetadataError(file, "it has no valid spec");
    }
    return meta as SandboxMeta;
  }

  /** Every record, by sandbox name, plus the message for each one that can't be used. */
  async readAll(): Promise<{ metas: Map<string, SandboxMeta>; errors: Map<string, string> }> {
    const metas = new Map<string, SandboxMeta>();
    const errors = new Map<string, string>();
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return { metas, errors };
    }
    await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          const name = f.slice(0, -".json".length);
          try {
            const meta = await this.read(name);
            if (meta) metas.set(name, meta);
          } catch (err) {
            if (!(err instanceof MetadataError)) throw err;
            errors.set(name, err.message);
          }
        }),
    );
    return { metas, errors };
  }

  async write(name: string, meta: SandboxMeta): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(name)}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(meta, null, 2) + "\n");
    await rename(tmp, this.file(name));
  }

  async update(name: string, patch: Partial<SandboxMeta>): Promise<void> {
    const cur = await this.read(name);
    if (cur) await this.write(name, { ...cur, ...patch });
  }

  async remove(name: string): Promise<void> {
    await rm(this.file(name), { force: true });
  }
}
