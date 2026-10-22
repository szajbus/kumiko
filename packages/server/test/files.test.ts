import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openIn, removeIn, writeIn } from "../src/files.js";

describe("files in folders the agent can change", () => {
  let root: string;
  let folder: string;
  let outside: string;
  let scratch: string;

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "kumiko-files-test-")));
    scratch = join(root, "scratch");
  });
  after(() => rm(root, { recursive: true, force: true }));

  /** A folder of the agent's, and one of the user's on the host with a file it mustn't touch. */
  const setUp = async (name: string) => {
    folder = join(root, name);
    outside = join(root, `${name}-host`);
    await mkdir(folder, { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "x.md"), "keep me");
  };

  it("write a file in place of a link to a file or a folder, never through it", async () => {
    await setUp("write-links");
    await symlink(join(outside, "x.md"), join(folder, "x.md"));
    await symlink(outside, join(folder, "dir.md"));
    assert.equal(await writeIn(folder, "x.md", Buffer.from("new"), scratch), true);
    assert.equal(await writeIn(folder, "dir.md", Buffer.from("new"), scratch), true);
    for (const f of ["x.md", "dir.md"]) {
      assert.ok((await lstat(join(folder, f))).isFile(), f);
      assert.equal(await readFile(join(folder, f), "utf8"), "new");
    }
    assert.deepEqual(await readdir(outside), ["x.md"]);
    assert.equal(await readFile(join(outside, "x.md"), "utf8"), "keep me");
    assert.deepEqual(await readdir(scratch), [], "the data's own file is gone");
  });

  it("delete a link itself, and a folder without following links in it", async () => {
    await setUp("remove-links");
    await symlink(join(outside, "x.md"), join(folder, "x.md"));
    await mkdir(join(folder, "sub"));
    await symlink(outside, join(folder, "sub", "host"));
    assert.equal(await removeIn(folder, "x.md"), true);
    assert.equal(await removeIn(root, "remove-links", { recursive: true }), true);
    assert.equal(await readFile(join(outside, "x.md"), "utf8"), "keep me");
    assert.equal(await removeIn(root, "remove-links", { recursive: true }), false, "nothing left to delete");
  });

  it("do nothing in a folder that a link now leads to, as when Claude swaps one after the check", async () => {
    await setUp("swapped");
    await writeFile(join(folder, "x.md"), "mine");
    // The folder that was checked is now a link to the user's, and so is one above another.
    await rm(folder, { recursive: true });
    await symlink(outside, folder);
    await mkdir(join(root, "real", "sub"), { recursive: true });
    await symlink(join(root, "real"), join(root, "above"));
    assert.equal(await writeIn(folder, "x.md", Buffer.from("overwritten"), scratch), false);
    assert.equal(await removeIn(folder, "x.md"), false);
    assert.equal(await removeIn(join(root, "above"), "sub", { recursive: true }), false);
    assert.equal(await readFile(join(outside, "x.md"), "utf8"), "keep me");
    assert.ok((await lstat(join(root, "real", "sub"))).isDirectory());
  });

  it("open the file that is in the folder, not one a link there or a link instead of the folder leads to", async () => {
    await setUp("open");
    await writeFile(join(folder, "mine.md"), "mine");
    await symlink(join(outside, "x.md"), join(folder, "x.md"));
    const mine = await openIn(folder, "mine.md", scratch);
    assert.equal((await mine!.fh.readFile()).toString(), "mine");
    await mine!.done();
    assert.equal(await openIn(folder, "x.md", scratch), undefined);
    assert.equal(await openIn(folder, "nope.md", scratch), undefined);
    await symlink(outside, join(root, "open-swapped"));
    assert.equal(await openIn(join(root, "open-swapped"), "x.md", scratch), undefined);
    assert.deepEqual(await readdir(scratch), [], "nothing is left in the scratch folder");
  });

  it("refuse names with a folder in them", async () => {
    await setUp("names");
    await assert.rejects(writeIn(folder, "../x.md", Buffer.from("x"), scratch));
    await assert.rejects(removeIn(folder, ".."));
  });
});
