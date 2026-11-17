import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { REVIEW_FILE_MAX_LINES } from "@kumiko/shared";
import { branchPaths, commitOf, isObjectName, mergeBase, parentOf, parsePatch, parseNumstat, parseRaw, readBlob, ReviewRefused, reviewDiff, unquote } from "../src/review.js";
import { sh } from "./repo.js";

describe("parsing git's output", () => {
  it("reads --raw -z records, renames with both paths", () => {
    const out = ":100644 100644 aaa bbb M\0a.txt\0:100644 100644 ccc ccc R100\0old name\0new name\0:000000 100644 000 ddd A\0added\0";
    assert.deepEqual(
      parseRaw(out).map((e) => [e.status, e.path, e.oldPath]),
      [
        ["modified", "a.txt", undefined],
        ["renamed", "new name", "old name"],
        ["added", "added", undefined],
      ],
    );
  });

  it("reads --numstat -z rows, a rename's paths after it and a binary file's dashes", () => {
    assert.deepEqual(parseNumstat("-\t-\tbin\x000\t0\t\0a\0b\x003\t1\tx y\0"), [{ path: "bin" }, { added: 0, deleted: 0, path: "b" }, { added: 3, deleted: 1, path: "x y" }]);
  });

  it("unquotes C-quoted paths, octal UTF-8 bytes included", () => {
    assert.equal(unquote("plain"), "plain");
    assert.equal(unquote('"a\\"b\\\\c\\td"'), 'a"b\\c\td');
    assert.equal(unquote('"\\303\\251t\\303\\251"'), "été");
  });

  it("splits a patch by file, taking each file's path from its own lines", () => {
    const patch = [
      'diff --git "a/sp ace\\"q" "b/sp ace\\"q"',
      "index 1..2 100644",
      '--- "a/sp ace\\"q"',
      '+++ "b/sp ace\\"q"',
      "@@ -1 +1,2 @@",
      " keep",
      "+more",
      "diff --git a/bin b/bin",
      "index 1..2 100644",
      "Binary files a/bin and b/bin differ",
      "diff --git a/old b/new",
      "similarity index 100%",
      "rename from old",
      "rename to new",
      "diff --git a/x y b/x y",
      "old mode 100644",
      "new mode 100755",
      "diff --git a/gone b/gone",
      "deleted file mode 100644",
      "--- a/gone",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-diff --git a/fake b/fake",
      "-two",
      "",
    ].join("\n");
    const files = parsePatch(patch);
    assert.deepEqual([...files.keys()], ['sp ace"q', "bin", "new", "x y", "gone"]);
    assert.deepEqual(files.get('sp ace"q')!.hunks, [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [" keep", "+more"] }]);
    assert.equal(files.get("bin")!.binary, true);
    // A removed line that looks like a file's header is still the hunk's: the hunk's header says how long it is.
    assert.deepEqual(files.get("gone")!.hunks[0].lines, ["-diff --git a/fake b/fake", "-two"]);
  });
});

describe("a branch's changes, from a repository", () => {
  let root: string;
  let repo: string;
  let dir: string;
  let base: string;
  let head: string;
  let first: string;

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "kumiko-review-")));
    repo = join(root, "r");
    sh(root, "init", "--quiet", "--initial-branch=main", repo);
    dir = join(repo, ".git");
    await writeFile(join(repo, "a.txt"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    await writeFile(join(repo, "ws.txt"), "x\ny\n");
    await writeFile(join(repo, "moved.txt"), "same\n");
    await writeFile(join(repo, "gone.txt"), "bye\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "--quiet", "-m", "base");
    base = sh(repo, "rev-parse", "HEAD").trim();
    sh(repo, "checkout", "--quiet", "-b", "work");
    await writeFile(join(repo, "a.txt"), Array.from({ length: 30 }, (_, i) => (i === 4 ? "line five" : `line ${i + 1}`)).join("\n") + "\n");
    sh(repo, "commit", "--quiet", "-am", "one");
    first = sh(repo, "rev-parse", "HEAD").trim();
    await writeFile(join(repo, "ws.txt"), "x  \ny\n");
    await writeFile(join(repo, 'odd "name".txt'), "new\n");
    await writeFile(join(repo, "with space.txt"), "spaced\n");
    await writeFile(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(repo, "big.txt"), Array.from({ length: REVIEW_FILE_MAX_LINES + 1 }, (_, i) => `${i}`).join("\n") + "\n");
    await chmod(join(repo, "moved.txt"), 0o644);
    sh(repo, "mv", "moved.txt", "renamed.txt");
    sh(repo, "rm", "--quiet", "gone.txt");
    sh(repo, "add", "-A");
    sh(repo, "commit", "--quiet", "-m", "two");
    head = sh(repo, "rev-parse", "HEAD").trim();
  });

  after(() => rm(root, { recursive: true, force: true }));

  it("finds where the branch left main, and a commit's parent", async () => {
    assert.equal(await mergeBase(dir, "refs/heads/main", head), base);
    assert.equal(await parentOf(dir, first), base);
    assert.equal(await commitOf(dir, "nope"), undefined);
    assert.ok(isObjectName(head));
    assert.ok(!isObjectName("HEAD"));
  });

  it("lists every file with its status, counts, blobs and hunks", async () => {
    const d = await reviewDiff(dir, base, head);
    const by = new Map(d.files.map((f) => [f.path, f]));
    assert.deepEqual([...by.keys()].sort(), ["a.txt", "big.txt", "bin.dat", "gone.txt", 'odd "name".txt', "renamed.txt", "with space.txt", "ws.txt"]);
    const a = by.get("a.txt")!;
    assert.equal(a.status, "modified");
    assert.deepEqual([a.added, a.deleted], [1, 1]);
    assert.deepEqual(a.hunks[0].lines.filter((l) => l[0] !== " "), ["-line 5", "+line five"]);
    assert.ok(a.oldBlob && a.newBlob);
    assert.equal(by.get("renamed.txt")!.status, "renamed");
    assert.equal(by.get("renamed.txt")!.oldPath, "moved.txt");
    assert.equal(by.get("gone.txt")!.status, "deleted");
    assert.equal(by.get("gone.txt")!.newBlob, undefined);
    assert.equal(by.get('odd "name".txt')!.hunks[0].lines[0], "+new");
    // git ends a name with a space in it with a tab, on its --- and +++ lines.
    assert.equal(by.get("with space.txt")!.hunks[0].lines[0], "+spaced");
    assert.equal(by.get("bin.dat")!.binary, true);
    assert.equal(by.get("big.txt")!.tooLarge, true, "a long patch comes without its lines");
    assert.deepEqual(by.get("big.txt")!.hunks, []);
  });

  it("gives a long file whole when asked for it alone", async () => {
    const d = await reviewDiff(dir, base, head, { paths: ["big.txt"], whole: true });
    assert.equal(d.files.length, 1);
    assert.equal(d.files[0].tooLarge, undefined);
    assert.equal(d.files[0].hunks[0].lines.length, REVIEW_FILE_MAX_LINES + 1);
  });

  it("marks a file whose only changes are whitespace, when whitespace is left out", async () => {
    const d = await reviewDiff(dir, base, head, { ignoreWhitespace: true });
    const ws = d.files.find((f) => f.path === "ws.txt")!;
    assert.equal(ws.whitespaceOnly, true);
    assert.deepEqual(ws.hunks, []);
    assert.equal(d.files.find((f) => f.path === "a.txt")!.hunks.length, 1, "the other files keep their patches");
  });

  it("keeps a diff to the files a branch changes, leaving out what came in from main", async () => {
    sh(repo, "checkout", "--quiet", "main");
    await writeFile(join(repo, "upstream.txt"), "theirs\n");
    sh(repo, "add", "upstream.txt");
    sh(repo, "commit", "--quiet", "-m", "upstream");
    sh(repo, "checkout", "--quiet", "work");
    sh(repo, "merge", "--quiet", "--no-edit", "main");
    const merged = sh(repo, "rev-parse", "HEAD").trim();
    const all = await reviewDiff(dir, head, merged);
    assert.deepEqual(all.files.map((f) => f.path), ["upstream.txt"], "head to head, main's file shows");
    const own = await branchPaths(dir, await mergeBase(dir, "refs/heads/main", merged), merged);
    assert.ok(own && !own.includes("upstream.txt") && own.includes("a.txt") && own.includes("moved.txt"), "both sides of a rename");
    assert.deepEqual((await reviewDiff(dir, head, merged, { paths: own })).files, []);
  });

  it("reads a blob's text, and refuses what isn't one", async () => {
    const d = await reviewDiff(dir, base, head);
    const a = d.files.find((f) => f.path === "a.txt")!;
    assert.match((await readBlob(dir, a.newBlob!)).text!, /^line 1\nline 2\n/);
    assert.deepEqual(await readBlob(dir, d.files.find((f) => f.path === "bin.dat")!.newBlob!), { binary: true });
    await assert.rejects(readBlob(dir, head), ReviewRefused);
  });
});
