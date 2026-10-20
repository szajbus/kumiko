import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ProjectStore } from "../src/projects.js";

describe("ProjectStore", () => {
  it("points a Claude home from Bentomo's days at the renamed managed file", async () => {
    const root = await mkdtemp(join(tmpdir(), "kumiko-projects-test-"));
    try {
      const store = new ProjectStore(root);
      const home = store.claudeHome("web");
      await mkdir(home, { recursive: true });
      await writeFile(join(home, "CLAUDE.md"), "@bentomo.md\n\nMine: keep @bentomo.md in this line.\n");
      await writeFile(join(home, "bentomo.md"), "old");

      await store.writeManaged({ id: "web", clonePath: "/src/web", worktreesPath: "/src/web__worktrees", createdAt: "" });
      assert.equal(await readFile(join(home, "CLAUDE.md"), "utf8"), "@kumiko.md\n\nMine: keep @bentomo.md in this line.\n");
      assert.match(await readFile(join(home, "kumiko.md"), "utf8"), /Written by Kumiko/);
      await assert.rejects(stat(join(home, "bentomo.md")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
