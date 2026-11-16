import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { execOutput } from "@kumiko/agent";
import { LimaProvider, MetadataStore, shellQuote } from "@kumiko/sandbox";
import { dropScript, findUnpushed, parseUnpushed } from "../src/unpushed.js";
import { sh } from "./repo.js";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../../../sandbox/fixtures");

/** A provider whose exec is the fake ssh, which runs commands here with /workspace in `<root>/lima/workspace`. */
async function fakeVm() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kumiko-unpushed-test-")));
  process.env.FAKE_LIMA_DIR = join(root, "lima");
  const workspace = join(root, "lima", "workspace");
  await mkdir(workspace, { recursive: true });
  const provider = new LimaProvider({ limactl: join(fixtures, "fake-limactl.mjs"), ssh: join(fixtures, "fake-ssh.sh"), metadata: new MetadataStore(join(root, "sandboxes")) });
  return { root, workspace, provider, exec: provider.exec.bind(provider) };
}

describe("unpushed work", () => {
  it("finds branches ahead of their upstream or on no remote, worktrees with changes, and stashes", async () => {
    const { root, workspace, exec } = await fakeVm();
    const origin = join(root, "origin.git");
    await mkdir(origin);
    sh(origin, "init", "--quiet", "--bare", "--initial-branch=main");
    const clone = join(workspace, "api");
    sh(root, "clone", "--quiet", origin, clone);
    const commit = async (cwd: string, file: string) => {
      await writeFile(join(cwd, file), file);
      sh(cwd, "add", file);
      sh(cwd, "commit", "--quiet", "-m", file);
    };
    await commit(clone, "README");
    sh(clone, "push", "--quiet", "-u", "origin", "main");
    // Ahead of its upstream by two.
    sh(clone, "checkout", "--quiet", "-b", "fix-x");
    sh(clone, "push", "--quiet", "-u", "origin", "fix-x");
    await commit(clone, "a");
    await commit(clone, "b");
    // On no remote at all: its one commit is lost with it.
    sh(clone, "checkout", "--quiet", "-b", "spike", "main");
    await commit(clone, "c");
    // A tag of the same name makes the branch's short name ambiguous.
    sh(clone, "tag", "spike", "main");
    // Without an upstream, but all on a remote: nothing to lose.
    sh(clone, "checkout", "--quiet", "-b", "copy", "main");
    // A stash, and a worktree with an untracked file and a change.
    await writeFile(join(clone, "README"), "changed");
    sh(clone, "stash", "--quiet");
    sh(clone, "checkout", "--quiet", "main");
    const wt = join(workspace, "api__worktrees", "try");
    sh(clone, "worktree", "add", "--quiet", wt, "-b", "try");
    await writeFile(join(wt, "new.txt"), "x");
    await writeFile(join(wt, "README"), "edited");
    // A detached HEAD whose commit is on no branch.
    const loose = join(workspace, "api__worktrees", "loose");
    sh(clone, "worktree", "add", "--quiet", "--detach", loose, "main");
    await commit(loose, "d");
    // A folder git can't read: what is in it can't be told, so it isn't taken for nothing.
    await mkdir(join(workspace, "broken", ".git"), { recursive: true });

    const [api, gone, broken] = await findUnpushed(exec, "web", [
      { repo: "acme/api", folder: "api" },
      { repo: "acme/gone", folder: "gone" },
      { repo: "acme/broken", folder: "broken" },
    ]);
    assert.deepEqual(api.branches.sort((a, b) => a.name.localeCompare(b.name)), [
      { name: "fix-x", ahead: 2, upstream: "origin/fix-x" },
      { name: `HEAD, detached in ${loose}`, ahead: 1 },
      { name: "spike", ahead: 1 },
    ]);
    assert.deepEqual(api.dirty, [{ worktree: wt, files: 2 }], "the clone itself is clean");
    assert.equal(api.stashes, 1);
    assert.equal(api.error, undefined);
    assert.match(gone.error ?? "", /There's no clone at \/workspace\/gone/);
    assert.deepEqual([gone.branches, gone.dirty, gone.stashes], [[], [], 0]);
    assert.match(broken.error ?? "", /git for-each-ref failed in \/workspace\/broken/);
  });

  it("reads only lines about the repos it asked for", () => {
    const repos = [{ repo: "acme/api", folder: "api" }];
    const [api] = parseUnpushed(repos, ["branch\tother\t3\tx\t", "branch\tapi\t3\tfeature/a b\t", "dirty\tapi\t1\t/workspace/api__worktrees/with\ttab", "nonsense"]);
    assert.deepEqual(api.branches, [{ name: "feature/a b", ahead: 3 }]);
    assert.deepEqual(api.dirty, [{ worktree: "/workspace/api__worktrees/with\ttab", files: 1 }]);
  });

  it("deletes dropped repos' folders and their worktrees, and nothing else", async () => {
    const { workspace, exec } = await fakeVm();
    for (const f of ["-tools", "-tools__worktrees/x", "web", "web__worktrees"]) await mkdir(join(workspace, f), { recursive: true });
    await execOutput(exec, "web", `bash -c ${shellQuote(dropScript(["-tools"]))}`);
    const there = (f: string) => stat(join(workspace, f)).then(() => true, () => false);
    assert.deepEqual([await there("-tools"), await there("-tools__worktrees"), await there("web"), await there("web__worktrees")], [false, false, true, true]);
  });
});
