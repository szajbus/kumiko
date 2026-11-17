import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pathIn, revealablePath } from "../src/reveal.ts";

describe("pathIn", () => {
  it("takes an absolute path, or one in ~, without the line Claude points at", () => {
    assert.equal(pathIn("/Users/you/.kumiko/sandbox/web/artifacts/abc/plan.md"), "/Users/you/.kumiko/sandbox/web/artifacts/abc/plan.md");
    assert.equal(pathIn("~/.kumiko/shared/setup.md"), "~/.kumiko/shared/setup.md");
    assert.equal(pathIn("/src/app.ts:12"), "/src/app.ts");
    assert.equal(pathIn("/src/app.ts:12:3"), "/src/app.ts");
  });

  it("takes nothing else", () => {
    for (const t of ["src/app.ts", "https://example.com/a", "npm test", "/", "/a\n/b", "/a/../etc/passwd", "~"]) assert.equal(pathIn(t), undefined, t);
  });
});

describe("revealablePath", () => {
  const roots = ["/Users/you/.kumiko/sandbox/web", "~/.kumiko/shared", "/home/you.guest/.kumiko/shared"];

  it("is a path under a folder shared with the Mac", () => {
    assert.equal(revealablePath("/Users/you/.kumiko/sandbox/web/artifacts/abc/plan.md", roots), "/Users/you/.kumiko/sandbox/web/artifacts/abc/plan.md");
    assert.equal(revealablePath("/home/you.guest/.kumiko/shared/setup.md:3", roots), "/home/you.guest/.kumiko/shared/setup.md");
    assert.equal(revealablePath("~/.kumiko/shared", roots), "~/.kumiko/shared");
  });

  it("isn't one anywhere else, or beside a shared folder", () => {
    assert.equal(revealablePath("/workspace/web/README.md", roots), undefined);
    assert.equal(revealablePath("/Users/you/.kumiko/sandbox/web2/x", roots), undefined);
    assert.equal(revealablePath("/Users/you/.kumiko/sandbox/web/x", undefined), undefined);
  });
});
