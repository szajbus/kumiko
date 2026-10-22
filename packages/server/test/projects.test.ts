import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ProjectStore } from "../src/projects.js";

const WEB = { id: "web", clonePath: "/src/web", worktreesPath: "/src/web__worktrees", createdAt: "" };

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
      assert.match(managed, /## Setup that survives a rebuild\n[^]*`~\/\.kumiko\/shared\/provision\.d\/`/);
      assert.match(managed, /Read `~\/\.kumiko\/shared\/setup\.md` before you add or change one/);
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

  it("writes the setup guide with a copy of the user's provisioning script and the forwarded variables' names", async () => {
    const root = await mkdtemp(join(tmpdir(), "kumiko-projects-test-"));
    try {
      const store = new ProjectStore(root);
      const folder = store.kumikoHome("web");

      await store.writeManaged(WEB, { provision: "sudo apt-get install -y ripgrep", env: ["GITHUB_TOKEN", "NPM_TOKEN"] });
      const guide = await readFile(join(folder, "setup.md"), "utf8");
      assert.match(guide, /# Setup scripts/);
      assert.match(guide, /in `\/src\/web`, stopping at its first failing command/);
      assert.match(guide, /It is in `user-provision\.sh` here/);
      assert.match(guide, /by name: `GITHUB_TOKEN`, `NPM_TOKEN`\./);
      assert.equal(await readFile(join(folder, "user-provision.sh"), "utf8"), "sudo apt-get install -y ripgrep\n");

      // The user drops the script and the variables: the copy goes, and the guide says so.
      await store.writeManaged(WEB, { env: [] });
      const after = await readFile(join(folder, "setup.md"), "utf8");
      assert.match(after, /The user has no provisioning script\./);
      assert.match(after, /No variables are forwarded from it\./);
      assert.deepEqual(await readdir(folder), ["setup.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replaces links Claude made of the setup guide and the script's copy rather than writing through them", async () => {
    const root = await mkdtemp(join(tmpdir(), "kumiko-projects-test-"));
    try {
      const store = new ProjectStore(root);
      const folder = store.kumikoHome("web");
      await mkdir(folder, { recursive: true });
      // As `ln -sf /Users/you/notes.md ~/.kumiko/shared/setup.md` in the VM makes it.
      const victim = join(root, "notes.md");
      await writeFile(victim, "keep me");
      await symlink(victim, join(folder, "setup.md"));
      await symlink(victim, join(folder, "user-provision.sh"));

      await store.writeManaged(WEB, { provision: "true", env: [] });
      assert.equal(await readFile(victim, "utf8"), "keep me");
      assert.ok((await lstat(join(folder, "setup.md"))).isFile());
      assert.ok((await lstat(join(folder, "user-provision.sh"))).isFile());

      // Without a script, the link to it is deleted, not what it points to.
      await symlink(victim, join(folder, "link"));
      await rm(join(folder, "user-provision.sh"));
      await symlink(victim, join(folder, "user-provision.sh"));
      await store.writeManaged(WEB, { env: [] });
      assert.equal(await readFile(victim, "utf8"), "keep me");
      assert.deepEqual((await readdir(folder)).sort(), ["link", "setup.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
