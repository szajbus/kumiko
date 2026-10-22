import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AGENT_SETUP_DIR } from "@kumiko/shared";
import { compareAgentScripts, MAX_AGENT_SCRIPT_BYTES, readAgentScripts } from "../src/agentSetup.js";

const tmp = async () => realpath(await mkdtemp(join(tmpdir(), "kumiko-agent-setup-")));

describe("the agent's setup scripts", () => {
  it("are the plain *.sh files in the folder, in byte order", async () => {
    const root = await tmp();
    const home = join(root, "claude");
    const dir = join(home, AGENT_SETUP_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "20-b.sh"), "echo b\n");
    await writeFile(join(dir, "10-a.sh"), "echo a\n");
    await writeFile(join(dir, "B-upper.sh"), "echo B\n");
    await writeFile(join(dir, "notes.md"), "not a script");
    await writeFile(join(dir, ".hidden.sh"), "echo hidden\n");
    await writeFile(join(dir, "30-big.sh"), "#".repeat(MAX_AGENT_SCRIPT_BYTES + 1));
    await mkdir(join(dir, "40-dir.sh"));
    // A link out to the host, as `ln -s /Users/you/.ssh/id_ed25519 ~/.claude/sandbox/provision.d/50-key.sh` in the VM makes it.
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
    const home = join(root, "claude");
    await mkdir(join(root, "elsewhere"), { recursive: true });
    await writeFile(join(root, "elsewhere", "10-a.sh"), "echo a\n");
    await mkdir(join(home, AGENT_SETUP_DIR, ".."), { recursive: true });
    await symlink(join(root, "elsewhere"), join(home, AGENT_SETUP_DIR));
    assert.deepEqual(await readAgentScripts(home, join(root, "scratch")), { scripts: [], ignored: [] });
    assert.deepEqual(await readAgentScripts(join(root, "missing"), join(root, "scratch")), { scripts: [], ignored: [] });
  });

  it("are compared with the ones the VM was created with", () => {
    const run = {
      scripts: [
        { file: "10-a.sh", script: "a", exitCode: 0 },
        { file: "20-b.sh", script: "b", exitCode: 2 },
        { file: "30-gone.sh", script: "g", exitCode: 0 },
      ],
    };
    const now = { scripts: [{ file: "10-a.sh", script: "a" }, { file: "20-b.sh", script: "b2" }, { file: "40-new.sh", script: "n" }], ignored: ["x"] };
    assert.deepEqual(compareAgentScripts(run, now), {
      scripts: [
        { file: "10-a.sh", script: "a", state: "same", exitCode: 0 },
        { file: "20-b.sh", script: "b2", state: "changed" },
        { file: "40-new.sh", script: "n", state: "new" },
      ],
      removed: ["30-gone.sh"],
      ignored: ["x"],
      skipped: false,
    });
    assert.deepEqual(compareAgentScripts(undefined, now).scripts.map((s) => s.state), ["new", "new", "new"]);
    assert.equal(compareAgentScripts({ scripts: [], skipped: true }, now).skipped, true);
  });
});
