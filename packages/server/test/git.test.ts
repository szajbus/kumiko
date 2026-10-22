import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { worktreeStatuses } from "../src/git.js";
import { makeClone, sh } from "./repo.js";

describe("git on the host", () => {
  it("runs nothing the clone's config names, as the agent can write it", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kumiko-git-test-")));
    const clone = await makeClone(root, "one");
    const ran = (what: string) => join(root, `${what}-ran`);
    const touch = (what: string) => `touch '${ran(what)}'`;

    // A submodule with a filter of its own.
    const sub = await makeClone(root, "sub");
    await writeFile(join(sub, ".gitattributes"), "README filter=subf\n");
    sh(sub, "add", ".gitattributes");
    sh(sub, "commit", "--quiet", "-m", "attributes");
    sh(clone, "-c", "protocol.file.allow=always", "submodule", "--quiet", "add", sub, "sub");
    sh(clone, "commit", "--quiet", "-m", "submodule");
    sh(join(clone, "sub"), "config", "filter.subf.clean", `sh -c "${touch("submodule-filter")}; cat"`);

    // What the agent sets in the clone: an fsmonitor, and filters .gitattributes picks, with dotted names too.
    await writeFile(join(clone, ".gitattributes"), "README filter=clean-only\n*.txt filter=a.b\n");
    await writeFile(join(clone, "x.txt"), "x\n");
    sh(clone, "add", ".gitattributes", "x.txt");
    sh(clone, "commit", "--quiet", "-m", "attributes");
    sh(clone, "config", "core.fsmonitor", `sh -c "${touch("fsmonitor")}"`);
    sh(clone, "config", "filter.clean-only.clean", `sh -c "${touch("clean")}; cat"`);
    sh(clone, "config", "filter.a.b.process", `sh -c "${touch("process")}"`);
    sh(clone, "config", "filter.a.b.required", "true");

    // Files whose stat changed, which status reads again through their filters; README's content changed too.
    const later = new Date(Date.now() + 5000);
    await writeFile(join(clone, "README"), "changed\n");
    for (const f of ["README", "x.txt", "sub/README"]) await utimes(join(clone, f), later, later);

    const { worktrees } = await worktreeStatuses(clone);
    for (const what of ["fsmonitor", "clean", "process", "submodule-filter"]) assert.equal(existsSync(ran(what)), false, `${what} ran`);
    assert.equal(worktrees[0].error, undefined);
    assert.equal(worktrees[0].dirty, true, "a change still shows");

    // A filter name -c can't carry: git isn't run there at all.
    sh(clone, "config", "filter.a=b.clean", `sh -c "${touch("odd-name")}; cat"`);
    await assert.rejects(worktreeStatuses(clone), /can't turn off/);
    assert.equal(existsSync(ran("odd-name")), false);
  });
});
