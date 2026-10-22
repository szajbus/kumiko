import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
      assert.match(managed, /## This machine\n\n- You are in a VM made for this project, and it is yours/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replaces a link Claude made of its instructions rather than writing through it", async () => {
    const root = await mkdtemp(join(tmpdir(), "kumiko-projects-test-"));
    try {
      const store = new ProjectStore(root);
      const home = store.claudeHome("web");
      await mkdir(home, { recursive: true });
      // As `ln -sf /Users/you/.zshrc ~/.claude/kumiko.md` in the VM makes it.
      const victim = join(root, "zshrc");
      await writeFile(victim, "keep me");
      await symlink(victim, join(home, "kumiko.md"));

      await store.writeManaged({ id: "web", clonePath: "/src/web", worktreesPath: "/src/web__worktrees", createdAt: "" });
      assert.equal(await readFile(victim, "utf8"), "keep me");
      assert.ok((await lstat(join(home, "kumiko.md"))).isFile());
      assert.match(await readFile(join(home, "kumiko.md"), "utf8"), /Written by Kumiko/);
      assert.deepEqual((await readdir(home)).sort(), ["kumiko.md"], "no temporary file is left behind");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
