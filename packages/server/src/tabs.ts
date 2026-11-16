import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseSavedTabs, type SavedTabs } from "@kumiko/shared";
import { defaultKumikoHome } from "./sandboxes.js";

/** The window's tabs, in `tabs.json` in Kumiko's home. One file: there is one window. */
export class TabsStore {
  readonly file: string;
  /** Writes go one after another, so an older save can't land over a newer one. */
  private writing: Promise<void> = Promise.resolve();

  constructor(home: string = defaultKumikoHome()) {
    this.file = join(home, "tabs.json");
  }

  async read(): Promise<SavedTabs | undefined> {
    try {
      return parseSavedTabs(JSON.parse(await readFile(this.file, "utf8")));
    } catch {
      return undefined;
    }
  }

  write(tabs: SavedTabs): Promise<void> {
    const next = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(tabs) + "\n");
      await rename(tmp, this.file);
    });
    this.writing = next.catch(() => {});
    return next;
  }
}
