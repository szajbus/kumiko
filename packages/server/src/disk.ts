import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** How much the files under `dir` take, links not followed; 0 when there is no such folder. */
export async function dirBytes(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const sizes = await Promise.all(
    entries.map((e) => {
      const path = join(dir, e.name);
      if (e.isDirectory()) return dirBytes(path);
      return e.isFile() ? lstat(path).then((s) => s.size, () => 0) : 0;
    }),
  );
  return sizes.reduce((a, b) => a + b, 0);
}

/** How much the files `names` in `dir` take, each once; one that is gone takes nothing. */
export async function filesBytes(dir: string, names: Iterable<string>): Promise<number> {
  const sizes = await Promise.all([...new Set(names)].map((n) => lstat(join(dir, n)).then((s) => (s.isFile() ? s.size : 0), () => 0)));
  return sizes.reduce((a, b) => a + b, 0);
}
