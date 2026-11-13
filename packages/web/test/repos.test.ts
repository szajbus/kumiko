import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GitHubRepo, MirrorView } from "@kumiko/shared";
import { filterRepos, highlight, mirrorStatus } from "../src/repos.ts";

const repo = (name: string, description?: string): GitHubRepo => ({ repo: name, private: false, fork: false, archived: false, ...(description ? { description } : {}) });

describe("the repository picker", () => {
  const repos = [repo("szajbus/kumiko", "Sandboxed Claude Code sessions"), repo("acme/kumquat"), repo("acme/api", "The Kumiko-facing API")];

  it("keeps the repos with every word of the query in their name or description, ignoring case", () => {
    assert.deepEqual(filterRepos(repos, "").map((r) => r.repo), ["szajbus/kumiko", "acme/kumquat", "acme/api"]);
    assert.deepEqual(filterRepos(repos, "KUM").map((r) => r.repo), ["szajbus/kumiko", "acme/kumquat", "acme/api"]);
    assert.deepEqual(filterRepos(repos, "acme kumiko").map((r) => r.repo), ["acme/api"]);
    assert.deepEqual(filterRepos(repos, "  sandboxed ").map((r) => r.repo), ["szajbus/kumiko"]);
    assert.deepEqual(filterRepos(repos, "nothing"), []);
  });

  it("highlights the query's first word in a name", () => {
    assert.deepEqual(highlight("szajbus/Kumiko", "kum"), ["szajbus/", "Kum", "iko"]);
    assert.deepEqual(highlight("acme/api", "zzz"), ["acme/api", "", ""]);
    assert.deepEqual(highlight("acme/api", ""), ["acme/api", "", ""]);
  });
});

describe("a mirror's status", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  const base: MirrorView = { repo: "acme/api", path: "/m/acme/api.git", addedAt: "2026-11-13T09:00:00Z", state: "ready" };

  it("says when it was fetched, with its branches and tags", () => {
    assert.deepEqual(mirrorStatus({ ...base, fetchedAt: "2026-11-13T11:58:00Z", branches: 1, tags: 2 }, now), { text: "2 min ago", sub: "1 branch · 2 tags", color: "#4CC38A", busy: false });
  });

  it("says when it failed, and when it last worked", () => {
    const failed = { ...base, state: "failed" as const, error: { message: "nope", at: "2026-11-13T11:59:00Z" } };
    assert.equal(mirrorStatus({ ...failed, fetchedAt: "2026-11-13T09:00:00Z" }, now).sub, "last good fetch 3 hours ago");
    assert.equal(mirrorStatus(failed, now).sub, "never fetched");
    assert.equal(mirrorStatus(failed, now).text, "Failed 1 min ago");
  });

  it("spins while it is cloned or fetched", () => {
    assert.equal(mirrorStatus({ ...base, state: "cloning" }, now).busy, true);
    assert.equal(mirrorStatus({ ...base, state: "fetching", fetchedAt: "2026-11-13T11:00:00Z" }, now).sub, "last 1 hour ago");
  });
});
