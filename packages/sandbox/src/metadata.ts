import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SandboxMeta } from "@bentomo/shared";

export function defaultMetadataDir(): string {
  return process.env.BENTOMO_HOME
    ? join(process.env.BENTOMO_HOME, "sandboxes")
    : join(homedir(), ".bentomo", "sandboxes");
}

/** One JSON file per sandbox Bentomo created. Holds variable names only, never values. */
export class MetadataStore {
  constructor(readonly dir: string = defaultMetadataDir()) {}

  private file(name: string): string {
    return join(this.dir, `${name}.json`);
  }

  async read(name: string): Promise<SandboxMeta | undefined> {
    try {
      return JSON.parse(await readFile(this.file(name), "utf8")) as SandboxMeta;
    } catch {
      return undefined;
    }
  }

  async readAll(): Promise<Map<string, SandboxMeta>> {
    const out = new Map<string, SandboxMeta>();
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return out;
    }
    await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          const name = f.slice(0, -".json".length);
          const meta = await this.read(name);
          if (meta) out.set(name, meta);
        }),
    );
    return out;
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
