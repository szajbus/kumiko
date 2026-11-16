import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RepoUnpushed } from "@kumiko/shared";
import { fromWorkspace, lossGroups, mustConfirm, stillChecking } from "../src/loss.ts";

const repo = (over: Partial<RepoUnpushed> = {}): RepoUnpushed => ({ repo: "acme/api", folder: "api", branches: [], dirty: [], stashes: 0, ...over });

describe("what would be lost", () => {
  it("lists each repo's unpushed branches, uncommitted worktrees and stashes, leaving out repos with nothing", () => {
    const groups = lossGroups([
      repo({ branches: [{ name: "fix-x", ahead: 1, upstream: "origin/fix-x" }, { name: "spike", ahead: 3 }], dirty: [{ worktree: "/workspace/api__worktrees/try", files: 1 }], stashes: 2 }),
      repo({ repo: "acme/web", folder: "web" }),
    ]);
    assert.deepEqual(groups, [
      {
        repo: "acme/api",
        rows: [
          { what: "fix-x", badge: "1 unpushed commit", tone: "sessions" },
          { what: "spike", badge: "3 unpushed commits", tone: "sessions" },
          { what: "api__worktrees/try", badge: "Uncommitted changes · 1 file", tone: "warn" },
          { what: "stash", badge: "2 stashes", tone: "plain" },
        ],
      },
    ]);
  });

  it("keeps a repo Kumiko couldn't look at, with why, and only the repos asked for", () => {
    const repos = [repo({ error: "its folder is gone" }), repo({ repo: "acme/web", folder: "web", stashes: 1 })];
    assert.deepEqual(lossGroups(repos).map((g) => [g.repo, g.error]), [["acme/api", "its folder is gone"], ["acme/web", undefined]]);
    assert.deepEqual(lossGroups(repos, ["ACME/web"]).map((g) => g.repo), ["acme/web"]);
  });

  it("shows worktree paths from /workspace on", () => {
    assert.equal(fromWorkspace("/workspace/api"), "api");
    assert.equal(fromWorkspace("/elsewhere/x"), "/elsewhere/x");
  });

  it("asks the user to confirm only when something would be lost, and holds the button while it looks", () => {
    assert.equal(mustConfirm({ kind: "done", groups: [] }), false);
    assert.equal(mustConfirm({ kind: "done", groups: [{ repo: "a/b", rows: [] }] }), true);
    assert.equal(mustConfirm({ kind: "stopped" }), false);
    assert.equal(mustConfirm({ kind: "error", message: "No answer from web in 60 s." }), true, "a failed look isn't taken for nothing to lose");
    assert.equal(stillChecking({ kind: "checking" }), true);
    assert.equal(stillChecking({ kind: "stopped" }), false);
    assert.equal(stillChecking({ kind: "stopped", starting: true }), true);
    assert.equal(stillChecking({ kind: "error", message: "x" }), false);
  });
});
