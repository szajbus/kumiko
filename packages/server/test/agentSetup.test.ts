import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AGENT_SCRIPT_MAX_BYTES, AGENT_SETUP_DIR } from "@kumiko/shared";
import { deleteAgentScripts, readAgentScripts, withExitCodes } from "../src/agentSetup.js";

const tmp = async () => realpath(await mkdtemp(join(tmpdir(), "kumiko-agent-setup-")));

describe("the agent's setup scripts", () => {
  it("are the plain *.sh files in the folder, in byte order", async () => {
    const root = await tmp();
    const home = join(root, "kumiko");
    const dir = join(home, AGENT_SETUP_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "20-b.sh"), "echo b\n");
    await writeFile(join(dir, "10-a.sh"), "echo a\n");
    await writeFile(join(dir, "B-upper.sh"), "echo B\n");
    await writeFile(join(dir, "notes.md"), "not a script");
    await writeFile(join(dir, ".hidden.sh"), "echo hidden\n");
    await writeFile(join(dir, "30-big.sh"), "#".repeat(AGENT_SCRIPT_MAX_BYTES + 1));
    await mkdir(join(dir, "40-dir.sh"));
    // A link out to the host, as `ln -s /Users/you/.ssh/id_ed25519 ~/.kumiko/shared/provision.d/50-key.sh` in the VM makes it.
    await writeFile(join(root, "secret"), "do not read\n");
    await symlink(join(root, "secret"), join(dir, "50-key.sh"));

    const { scripts, ignored } = await readAgentScripts(home, join(root, "scratch"));
    assert.deepEqual(scripts, [
      { file: "10-a.sh", script: "echo a\n" },
      { file: "20-b.sh", script: "echo b\n" },
      { file: "B-upper.sh", script: "echo B\n" },
    ]);
    assert.deepEqual(ignored, [".hidden.sh", "30-big.sh", "40-dir.sh", "50-key.sh", "notes.md"]);
  });

  it("aren't read through a folder that leads elsewhere", async () => {
    const root = await tmp();
    const home = join(root, "kumiko");
    await mkdir(join(root, "elsewhere"), { recursive: true });
    await writeFile(join(root, "elsewhere", "10-a.sh"), "echo a\n");
    await mkdir(join(home, AGENT_SETUP_DIR, ".."), { recursive: true });
    await symlink(join(root, "elsewhere"), join(home, AGENT_SETUP_DIR));
    assert.deepEqual(await readAgentScripts(home, join(root, "scratch")), { scripts: [], ignored: [] });
    assert.deepEqual(await readAgentScripts(join(root, "missing"), join(root, "scratch")), { scripts: [], ignored: [] });
  });

  it("are deleted folder and all, but never through a link in its place", async () => {
    const root = await tmp();
    const home = join(root, "kumiko");
    const dir = join(home, AGENT_SETUP_DIR);
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "10-a.sh"), "echo a\n");
    await writeFile(join(dir, "sub", "x"), "x");
    await mkdir(join(home, "artifacts"));
    assert.equal(await deleteAgentScripts(home), true);
    assert.deepEqual(await readdir(home), ["artifacts"], "only the setup folder goes");
    assert.equal(await deleteAgentScripts(home), true, "nothing to delete is fine");
    assert.equal(await deleteAgentScripts(join(root, "missing")), true);

    // The folder itself a link to one of the user's, as `ln -s /Users/you/work ~/.kumiko/shared/provision.d` in the VM makes
    // it: the link goes, what it points to stays.
    const theirs = join(root, "theirs");
    await mkdir(theirs);
    await writeFile(join(theirs, "keep.txt"), "mine");
    await symlink(theirs, dir);
    assert.equal(await deleteAgentScripts(home), true);
    assert.deepEqual(await readdir(home), ["artifacts"]);
    assert.equal(await readFile(join(theirs, "keep.txt"), "utf8"), "mine");
  });

  it("say how each went when the VM was created, if it ran then as it is now", () => {
    const run = {
      scripts: [
        { file: "10-a.sh", script: "a", exitCode: 0 },
        { file: "20-b.sh", script: "b", exitCode: 2 },
        { file: "30-gone.sh", script: "g", exitCode: 0 },
      ],
    };
    const now = { scripts: [{ file: "10-a.sh", script: "a" }, { file: "20-b.sh", script: "b2" }, { file: "40-new.sh", script: "n" }], ignored: ["x"] };
    assert.deepEqual(withExitCodes(run, now), {
      scripts: [
        { file: "10-a.sh", script: "a", exitCode: 0 },
        { file: "20-b.sh", script: "b2" },
        { file: "40-new.sh", script: "n" },
      ],
      ignored: ["x"],
    });
    assert.deepEqual(withExitCodes(undefined, now).scripts.map((s) => s.exitCode), [undefined, undefined, undefined]);
  });
});
