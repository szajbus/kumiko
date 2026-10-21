import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ProjectStore } from "../src/projects.js";

describe("ProjectStore", () => {
  it("rewrites its own instructions in a Claude home and leaves CLAUDE.md alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "kumiko-projects-test-"));
    try {
      const store = new ProjectStore(root);
      const home = store.claudeHome("web");
      await mkdir(home, { recursive: true });
      await writeFile(join(home, "CLAUDE.md"), "@kumiko.md\n\nMine.\n");
      await writeFile(join(home, "kumiko.md"), "stale");

      await store.writeManaged({ id: "web", clonePath: "/src/web", worktreesPath: "/src/web__worktrees", createdAt: "" });
      assert.equal(await readFile(join(home, "CLAUDE.md"), "utf8"), "@kumiko.md\n\nMine.\n");
      const managed = await readFile(join(home, "kumiko.md"), "utf8");
      assert.match(managed, /Written by Kumiko/);
      assert.match(managed, /\/src\/web__worktrees/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
