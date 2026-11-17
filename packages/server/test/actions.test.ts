import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apiPath, apiText, compact, logText, MAX_API_TEXT, ReadRefused } from "../src/actions.js";

describe("github_api_get's paths", () => {
  const repo = "acme/widget";

  it("are always under the sandbox's repo, however they're given", () => {
    assert.equal(apiPath(repo, "actions/runs?branch=main&per_page=5"), "repos/acme/widget/actions/runs?branch=main&per_page=5");
    assert.equal(apiPath(repo, "/repos/acme/widget/actions/runs"), "repos/acme/widget/actions/runs");
    assert.equal(apiPath(repo, "repos/ACME/Widget/commits/abc/check-runs"), "repos/acme/widget/commits/abc/check-runs");
    assert.equal(apiPath(repo, ""), "repos/acme/widget");
    assert.equal(apiPath(repo, "?x=1"), "repos/acme/widget?x=1");
  });

  it("can't lead out of the repo", () => {
    for (const bad of ["/repos/acme/other/actions/runs", "repos/acme/widgetx", "repos", "../../user", "actions/../../../other/x", "a/%2e%2e/b", "a/%2F/b", "a//b", "a/./b", "a/", "{owner}/x", "a b", "a\nb", "a\\b", "x#y", "a/%zz"]) {
      assert.throws(() => apiPath(repo, bad), ReadRefused, bad);
    }
    // A leading slash is only that: /user is the repo's, not GitHub's /user.
    assert.equal(apiPath(repo, "/user"), "repos/acme/widget/user");
    assert.throws(() => apiPath(repo, 3), /path must be a string/);
  });

  it("send archives and logs to github_run_logs", () => {
    for (const p of ["actions/runs/1/logs", "actions/jobs/2/logs", "zipball/main", "tarball", "actions/artifacts/3/zip"]) assert.throws(() => apiPath(repo, p), /github_run_logs/, p);
  });
});

describe("GitHub's answers, for the agent", () => {
  it("come down to names, without API URLs or node ids", () => {
    const owner = { login: "acme", id: 1, avatar_url: "https://a", url: "https://api", html_url: "https://github.com/acme" };
    const repository = { id: 9, full_name: "acme/widget", owner, url: "https://api/r" };
    const run = { id: 5, node_id: "x", name: "CI", url: "https://api/run", html_url: "https://github.com/run", jobs_url: "https://api/jobs", actor: owner, repository, head_repository: repository, pull_requests: [{ url: "https://api/pr", number: 3 }] };
    assert.deepEqual(compact({ total_count: 1, workflow_runs: [run] }), {
      total_count: 1,
      workflow_runs: [{ id: 5, name: "CI", html_url: "https://github.com/run", actor: "acme", repository: "acme/widget", head_repository: "acme/widget", pull_requests: [{ url: "https://api/pr", number: 3 }] }],
    });
    // The repository asked for itself stays whole; with no html_url, its API url stays too.
    assert.deepEqual(compact(repository), { id: 9, full_name: "acme/widget", owner: "acme", url: "https://api/r" });
  });

  it("are cut when long, and text that isn't JSON comes as it is", () => {
    assert.equal(apiText("plain text\n", false), "plain text");
    assert.equal(apiText('{"a_url":"x","b":1}', true), '{"a_url":"x","b":1}');
    const long = apiText(JSON.stringify("x".repeat(MAX_API_TEXT + 10)), false);
    assert.match(long, /\[Kumiko cut the rest: 12 more characters\. Ask for fewer, with per_page=/);
    assert.throws(() => apiText("PK\0\0", false), /binary/);
  });
});

describe("a run's logs, for the agent", () => {
  it("come a step at a time, without timestamps or colours, cut to their last lines", () => {
    const log = [
      "build\tSet up job\t2026-11-18T10:00:00.1234567Z Runner 2.3",
      "build\tRun tests\t2026-11-18T10:00:01.0000000Z \x1b[31mnot ok 1\x1b[0m - adds",
      "build\tRun tests\t2026-11-18T10:00:02.0000000Z # fail 1",
      "build\tRun tests\t2026-11-18T10:00:03.0000000Z ##[error]Process completed with exit code 1.",
      "",
    ].join("\n");
    assert.equal(logText(log, 2), "=== build / Set up job ===\nRunner 2.3\n\n=== build / Run tests (last 2 of 3 lines) ===\n# fail 1\n##[error]Process completed with exit code 1.");
  });
});
