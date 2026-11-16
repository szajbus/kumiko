import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sandboxMountRole } from "@kumiko/shared";
import { repoLabels } from "../src/format.ts";
import { guestPathProblem, inWorkspace } from "../src/mounts.ts";

describe("sandboxes", () => {
  it("knows a sandbox's own mounts from the others", () => {
    assert.equal(sandboxMountRole({ hostPath: "/data/claude/web", guestPath: "~/.claude", writable: true }), "claude-home");
    const homes = { claude: "/data/claude/web", kumiko: "/data/sandbox/web" };
    assert.equal(sandboxMountRole({ hostPath: "/other", guestPath: "~/.claude", writable: true }, homes), undefined);
    assert.equal(sandboxMountRole({ hostPath: "/data/sandbox/web", guestPath: "~/.kumiko/shared", writable: true }, homes), "kumiko-home");
    assert.equal(sandboxMountRole({ hostPath: "/other", guestPath: "~/.kumiko/shared", writable: true }, homes), undefined);
    assert.equal(sandboxMountRole({ hostPath: "/src/web", writable: true }), undefined, "any other folder is an extra mount");
  });

  it("names repos by name, and by owner too where two share one", () => {
    assert.deepEqual(repoLabels([{ repo: "acme/api" }, { repo: "szajbus/API" }, { repo: "acme/design-tokens" }]), ["acme/api", "szajbus/API", "design-tokens"]);
    assert.deepEqual(repoLabels([{ repo: "szajbus/webshop" }]), ["webshop"]);
    assert.deepEqual(repoLabels([]), []);
  });

  it("keeps mounts out of /workspace, where the sandbox's own disk is", () => {
    for (const p of ["/workspace", "/workspace/", "/workspace/data", " /workspace/a/b "]) assert.ok(inWorkspace(p), p);
    for (const p of ["/workspaces", "/work", "~/workspace", "/srv/workspace"]) assert.ok(!inWorkspace(p), p);

    const row = (id: number, hostPath: string, guestPath = "") => ({ id, hostPath, guestPath });
    assert.match(guestPathProblem(row(1, "/Users/me/x", "/workspace/x"), [])!, /Not inside \/workspace/);
    // With no path of its own, it goes at the Mac folder's path, which can't be in /workspace either.
    assert.match(guestPathProblem(row(1, "/workspace/data"), [])!, /Not inside \/workspace/);
    assert.equal(guestPathProblem(row(1, "/Users/me/x"), []), undefined);
    assert.equal(guestPathProblem(row(1, "/Users/me/x", "~/data"), []), undefined);
    assert.match(guestPathProblem(row(1, "/a", "/srv/d"), [row(1, "/a", "/srv/d"), row(2, "/b", "/srv/d")])!, /Another mount already uses this path/);
    assert.match(guestPathProblem(row(1, "/a", "relative"), [])!, /absolute path/);
  });
});
