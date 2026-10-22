import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectMountRole, suggestProjectId, type Project } from "@kumiko/shared";

describe("projects", () => {
  it("suggests an id from the clone's folder name", () => {
    assert.equal(suggestProjectId("/Users/me/src/My_App.v2/"), "my-app-v2");
    assert.equal(suggestProjectId("/x/--a--"), "a");
    assert.equal(suggestProjectId(`/x/${"a".repeat(29)}-b`), "a".repeat(29));
    assert.equal(suggestProjectId(""), "");
  });

  it("knows a project's own mounts from the others", () => {
    const p: Project = { id: "web", clonePath: "/src/web", worktreesPath: "/src/web__worktrees", createdAt: "" };
    assert.equal(projectMountRole(p, { hostPath: "/src/web", writable: true }), "clone");
    assert.equal(projectMountRole(p, { hostPath: "/src/web__worktrees", guestPath: "/src/web__worktrees", writable: true }), "worktrees");
    assert.equal(projectMountRole(p, { hostPath: "/src/web", guestPath: "/workspace/web", writable: true }), undefined, "the clone elsewhere is an extra mount");
    assert.equal(projectMountRole(p, { hostPath: "/data/claude/web", guestPath: "~/.claude", writable: true }), "claude-home");
    const homes = { claude: "/data/claude/web", kumiko: "/data/sandbox/web" };
    assert.equal(projectMountRole(p, { hostPath: "/other", guestPath: "~/.claude", writable: true }, homes), undefined);
    assert.equal(projectMountRole(p, { hostPath: "/data/sandbox/web", guestPath: "~/.kumiko/shared", writable: true }, homes), "kumiko-home");
    assert.equal(projectMountRole(p, { hostPath: "/other", guestPath: "~/.kumiko/shared", writable: true }, homes), undefined);
  });
});
