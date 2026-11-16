import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoFolders } from "@kumiko/shared";
import { checkRepos, managedInstructions, SandboxStore } from "../src/sandboxes.js";

const WEB = { name: "web", createdAt: "", repos: [{ repo: "acme/web", folder: "web" }] };

describe("SandboxStore", () => {
  it("rewrites its own instructions in a Claude home and leaves CLAUDE.md alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "kumiko-sandboxes-test-"));
    try {
      const store = new SandboxStore(root);
      const home = store.claudeHome("web");
      await mkdir(home, { recursive: true });
      await writeFile(join(home, "CLAUDE.md"), "@kumiko.md\n\nMine.\n");
      await writeFile(join(home, "kumiko.md"), "stale");

      await store.writeManaged(WEB);
      assert.equal(await readFile(join(home, "CLAUDE.md"), "utf8"), "@kumiko.md\n\nMine.\n");
      const managed = await readFile(join(home, "kumiko.md"), "utf8");
      assert.match(managed, /Written by Kumiko/);
      assert.match(managed, /`\/workspace\/web__worktrees\/`/);
      assert.match(managed, /## This machine\n\n- You are in a VM made for this sandbox, and it is yours/);
      assert.match(managed, /## Setup that survives a rebuild\n[^]*`~\/\.kumiko\/shared\/provision\.d\/`/);
      assert.match(managed, /Read `~\/\.kumiko\/shared\/setup\.md` before you add or change one/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replaces a link Claude made of its instructions rather than writing through it", async () => {
    const root = await mkdtemp(join(tmpdir(), "kumiko-sandboxes-test-"));
    try {
      const store = new SandboxStore(root);
      const home = store.claudeHome("web");
      await mkdir(home, { recursive: true });
      // As `ln -sf /Users/you/.zshrc ~/.claude/kumiko.md` in the VM makes it.
      const victim = join(root, "zshrc");
      await writeFile(victim, "keep me");
      await symlink(victim, join(home, "kumiko.md"));

      await store.writeManaged(WEB);
      assert.equal(await readFile(victim, "utf8"), "keep me");
      assert.ok((await lstat(join(home, "kumiko.md"))).isFile());
      assert.match(await readFile(join(home, "kumiko.md"), "utf8"), /Written by Kumiko/);
      assert.deepEqual((await readdir(home)).sort(), ["kumiko.md"], "no temporary file is left behind");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes the setup guide with a copy of the user's provisioning script and the forwarded variables' names", async () => {
    const root = await mkdtemp(join(tmpdir(), "kumiko-sandboxes-test-"));
    try {
      const store = new SandboxStore(root);
      const folder = store.kumikoHome("web");

      await store.writeManaged(WEB, { provision: "sudo apt-get install -y ripgrep", env: ["GITHUB_TOKEN", "NPM_TOKEN"], mounts: [] });
      const guide = await readFile(join(folder, "setup.md"), "utf8");
      assert.match(guide, /# Setup scripts/);
      assert.match(guide, /in `\/workspace`, stopping at its first failing command/);
      assert.match(guide, /It is in `user-provision\.sh` here/);
      assert.match(guide, /by name: `GITHUB_TOKEN`, `NPM_TOKEN`\./);
      assert.equal(await readFile(join(folder, "user-provision.sh"), "utf8"), "sudo apt-get install -y ripgrep\n");

      // The user drops the script and the variables: the copy goes, and the guide says so.
      await store.writeManaged(WEB, { env: [], mounts: [] });
      const after = await readFile(join(folder, "setup.md"), "utf8");
      assert.match(after, /The user has no provisioning script\./);
      assert.match(after, /No variables are forwarded from it\./);
      assert.deepEqual(await readdir(folder), ["setup.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replaces links Claude made of the setup guide and the script's copy rather than writing through them", async () => {
    const root = await mkdtemp(join(tmpdir(), "kumiko-sandboxes-test-"));
    try {
      const store = new SandboxStore(root);
      const folder = store.kumikoHome("web");
      await mkdir(folder, { recursive: true });
      // As `ln -sf /Users/you/notes.md ~/.kumiko/shared/setup.md` in the VM makes it.
      const victim = join(root, "notes.md");
      await writeFile(victim, "keep me");
      await symlink(victim, join(folder, "setup.md"));
      await symlink(victim, join(folder, "user-provision.sh"));

      await store.writeManaged(WEB, { provision: "true", env: [], mounts: [] });
      assert.equal(await readFile(victim, "utf8"), "keep me");
      assert.ok((await lstat(join(folder, "setup.md"))).isFile());
      assert.ok((await lstat(join(folder, "user-provision.sh"))).isFile());

      // Without a script, the link to it is deleted, not what it points to.
      await symlink(victim, join(folder, "link"));
      await rm(join(folder, "user-provision.sh"));
      await symlink(victim, join(folder, "user-provision.sh"));
      await store.writeManaged(WEB, { env: [], mounts: [] });
      assert.equal(await readFile(victim, "utf8"), "keep me");
      assert.deepEqual((await readdir(folder)).sort(), ["link", "setup.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("makes a record with the repos' folders, adds repos with folders of their own, and keeps the ones given", async () => {
    const root = await mkdtemp(join(tmpdir(), "kumiko-sandboxes-test-"));
    try {
      const store = new SandboxStore(root);
      const checked = await store.check("platform", ["szajbus/api", "acme/design-tokens"], ["szajbus/api", "acme/design-tokens", "acme/api"]);
      assert.deepEqual(checked.errors, []);
      await store.create("platform", checked.repos);
      assert.deepEqual((await store.get("platform"))?.repos, [{ repo: "szajbus/api", folder: "api" }, { repo: "acme/design-tokens", folder: "design-tokens" }]);
      assert.match(await readFile(join(store.claudeHome("platform"), "kumiko.md"), "utf8"), /`\/workspace\/api`: `szajbus\/api` on GitHub/);

      // acme/api shares a name with szajbus/api, whose folder stays as it is.
      const updated = await store.addRepos("platform", ["acme/api", "szajbus/api"]);
      assert.deepEqual(updated.repos.map((r) => r.folder), ["api", "design-tokens", "acme-api"]);
      assert.deepEqual(await store.get("platform"), updated);

      assert.match((await store.check("platform", [], [])).errors.join(), /already a sandbox called platform/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("undoes a create without deleting a Claude home or Kumiko folder that was there before it", async () => {
    const root = await mkdtemp(join(tmpdir(), "kumiko-sandboxes-test-"));
    try {
      const store = new SandboxStore(root);
      // As a project of the same name left them, from before sandboxes.
      await mkdir(store.claudeHome("web"), { recursive: true });
      await writeFile(join(store.claudeHome("web"), ".claude.json"), "{\"login\":true}");
      await mkdir(store.kumikoHome("web"), { recursive: true });
      await writeFile(join(store.kumikoHome("web"), "keep.sh"), "keep");
      const { rollback } = await store.create("web", []);
      await rollback();
      assert.equal(await store.get("web"), undefined, "the record goes");
      assert.equal(await readFile(join(store.claudeHome("web"), ".claude.json"), "utf8"), "{\"login\":true}");
      assert.equal(await readFile(join(store.kumikoHome("web"), "keep.sh"), "utf8"), "keep");

      const fresh = await store.create("api", []);
      await fresh.rollback();
      assert.deepEqual((await readdir(store.claudeRoot)).sort(), ["web"], "what a create made, it takes back");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a removed repo's folder as dropped until it is deleted, and gives its name to no other repo meanwhile", async () => {
    const root = await mkdtemp(join(tmpdir(), "kumiko-sandboxes-test-"));
    try {
      const store = new SandboxStore(root);
      await store.create("web", [{ repo: "acme/api", folder: "api" }]);
      let s = await store.removeRepos("web", ["ACME/api"]);
      assert.deepEqual([s.repos, s.dropped], [[], ["api"]]);
      s = await store.addRepos("web", ["other/api"]);
      assert.deepEqual(s.repos, [{ repo: "other/api", folder: "other-api" }], "api is still on the disk");
      s = (await store.dropped("web", ["api"]))!;
      assert.equal(s.dropped, undefined);
      assert.deepEqual(await store.get("web"), s);
      // Deleted at once, a folder isn't dropped at all.
      s = await store.removeRepos("web", ["other/api"], { deleted: true });
      assert.deepEqual([s.repos, s.dropped], [[], undefined]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses repos without a mirror, twice over, or that aren't repositories", async () => {
    const mirrors = ["acme/Web"];
    assert.deepEqual(checkRepos(["ACME/web"], mirrors), { errors: [], repos: ["acme/Web"] }, "spelled as the mirror is");
    assert.match(checkRepos(["acme/other"], mirrors).errors.join(), /acme\/other has no mirror\. Add it on the Repos page first/);
    assert.match(checkRepos(["acme/web", "acme/WEB"], mirrors).errors.join(), /picked twice/);
    assert.match(checkRepos(["../etc"], mirrors).errors.join(), /isn't a repository/);
    assert.match(checkRepos("acme/web", mirrors).errors.join(), /must be a list/);
  });

  it("reads a record whose repos were edited into something else as unreadable", async () => {
    const root = await mkdtemp(join(tmpdir(), "kumiko-sandboxes-test-"));
    try {
      const store = new SandboxStore(root);
      await mkdir(store.dir, { recursive: true });
      await writeFile(join(store.dir, "web.json"), JSON.stringify({ name: "web", createdAt: "", repos: [{ repo: "acme/web", folder: "../../etc" }] }));
      const { sandboxes, errors } = await store.list();
      assert.deepEqual(sandboxes, []);
      assert.match(errors.join(), /its repos aren't a list of repositories and folders/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("repo folders", () => {
  it("are the repos' names, with the owner in front for repos picked together that share one", () => {
    assert.deepEqual(repoFolders(["szajbus/api", "acme/api", "acme/web"]).map((r) => r.folder), ["szajbus-api", "acme-api", "web"]);
    assert.deepEqual(repoFolders(["acme/Web", "other/web"]).map((r) => r.folder), ["acme-Web", "other-web"], "case doesn't make names different");
  });

  it("never change once given: only a newcomer whose name is taken gets the prefix, or a number", () => {
    const kept = [{ repo: "szajbus/api", folder: "api" }, { repo: "acme/acme-api", folder: "acme-api" }];
    assert.deepEqual(repoFolders(["szajbus/api", "acme/acme-api", "acme/api"], kept).map((r) => r.folder), ["api", "acme-api", "acme-api-2"]);
  });

  it("never land on another repo's worktrees folder, nor put theirs on another repo's folder", () => {
    const kept = [{ repo: "acme/web", folder: "web" }];
    assert.deepEqual(repoFolders(["acme/web", "acme/web__worktrees"], kept).map((r) => r.folder), ["web", "acme-web__worktrees"]);
    const keptWorktreesNamed = [{ repo: "acme/web__worktrees", folder: "web__worktrees" }];
    assert.deepEqual(repoFolders(["acme/web__worktrees", "other/web"], keptWorktreesNamed).map((r) => r.folder), ["web__worktrees", "other-web"]);
  });
});

describe("kumiko.md", () => {
  it("describes the sandbox: its repos where they are, the folders shared with the user, and no repo's own instructions", () => {
    const md = managedInstructions(
      { name: "platform", repos: [{ repo: "szajbus/api", folder: "api" }, { repo: "acme/api", folder: "acme-api" }] },
      [{ hostPath: "/Users/you/data", guestPath: "/Users/you/data", writable: false }],
    );
    assert.match(md, /This is the sandbox platform\. Sessions start in `\/workspace`/);
    assert.match(md, /- `\/workspace\/acme-api`: `acme\/api` on GitHub\. Worktrees in `\/workspace\/acme-api__worktrees\/`\./);
    assert.match(md, /`~\/\.claude`, `~\/\.kumiko\/shared` and `\/Users\/you\/data` \(read-only\)/);
    assert.match(md, /tell `deliver` and the `github_\*` tools which one with `repo`/);
    assert.doesNotMatch(md, /@\/workspace|@.*CLAUDE\.md/, "no import pulls a repo's CLAUDE.md in");
  });

  it("says so when there are no repos, and leaves GitHub out", () => {
    const md = managedInstructions({ name: "notes", repos: [] });
    assert.match(md, /This sandbox has no repos\./);
    assert.doesNotMatch(md, /## GitHub/);
  });
});
