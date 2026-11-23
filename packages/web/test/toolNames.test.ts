import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toolLine, toolName } from "../src/toolNames.ts";

describe("tool names in the chat", () => {
  it("drop Kumiko's prefix, and name other MCP servers plainly", () => {
    assert.equal(toolName("mcp__kumiko__github_api_get"), "github_api_get");
    assert.equal(toolName("mcp__claude_ai_Claude_Docs__batch"), "Claude Docs · batch");
    assert.equal(toolName("mcp__my_server__do_thing"), "my server · do_thing");
    assert.equal(toolName("Bash"), "Bash");
  });

  it("say in words what Kumiko's GitHub tools and deliver did", () => {
    assert.deepEqual(toolLine("mcp__kumiko__github_api_get", { path: "actions/runs?per_page=5" }), { label: "Read from GitHub", title: "actions/runs?per_page=5", mono: true });
    assert.deepEqual(toolLine("mcp__kumiko__github_api_get", { path: "" }), { label: "Read from GitHub", title: "the repository", mono: true });
    assert.deepEqual(toolLine("mcp__kumiko__github_run_logs", { run_id: 44119423128, tail: 60 }), { label: "Read the failed steps of run", title: "44119423128", mono: true });
    assert.deepEqual(toolLine("mcp__kumiko__github_run_logs", { run_id: 7, job_id: 9, failed_only: false }), { label: "Read the logs of run", title: "7, job 9", mono: true });
    assert.deepEqual(toolLine("mcp__kumiko__github_pr_view", { number: 12 }), { label: "Read pull request", title: "#12" });
    assert.deepEqual(toolLine("mcp__kumiko__github_issue_view", { number: 3, repo: "acme/widget" }), { label: "Read issue", title: "#3 in acme/widget" });
    assert.deepEqual(toolLine("mcp__kumiko__github_issue_list", {}), { label: "Listed open issues", title: undefined });
    assert.deepEqual(toolLine("mcp__kumiko__github_pr_list", { state: "all", search: "tabs" }), { label: "Listed pull requests", title: "matching “tabs”" });
    assert.deepEqual(toolLine("mcp__kumiko__github_issue_create", { title: "Tabs flicker", body: "…" }), { label: "Asked to create an issue", title: "Tabs flicker" });
    assert.deepEqual(toolLine("mcp__kumiko__github_pr_comment", { number: 4, body: "…" }), { label: "Asked to comment on pull request", title: "#4" });
    assert.deepEqual(toolLine("mcp__kumiko__github_pr_edit", { number: 4, title: "T" }), { label: "Asked to edit pull request", title: "#4" });
    assert.deepEqual(toolLine("mcp__kumiko__github_issue_close", { number: 7, reason: "not_planned" }), { label: "Asked to close issue", title: "#7" });
    assert.deepEqual(toolLine("mcp__kumiko__github_pr_reopen", { number: 4, repo: "acme/widget" }), { label: "Asked to reopen pull request", title: "#4 in acme/widget" });
    assert.deepEqual(toolLine("mcp__kumiko__deliver", { branch: "log-tail", title: "T", body: "B" }), { label: "Asked to deliver", title: "log-tail", mono: true });
  });

  it("say which tools were loaded, by their names in the chat", () => {
    assert.deepEqual(toolLine("ToolSearch", { query: "select:mcp__kumiko__github_api_get,mcp__kumiko__github_run_logs", max_results: 2 }), { label: "Loaded tools", title: "github_api_get, github_run_logs", mono: true });
    assert.deepEqual(toolLine("ToolSearch", { query: "select:mcp__kumiko__deliver" }), { label: "Loaded a tool", title: "deliver", mono: true });
    assert.deepEqual(toolLine("ToolSearch", { query: "notebook jupyter" }), { label: "Looked for tools", title: "notebook jupyter" });
  });

  it("name the skill Claude used", () => {
    assert.deepEqual(toolLine("Skill", { skill: "dataviz", args: "a chart" }), { label: "Used skill", title: "dataviz", mono: true });
    assert.deepEqual(toolLine("Skill", { skill: "cowork-plugin-management:create-cowork-plugin" }), { label: "Used skill", title: "cowork-plugin-management:create-cowork-plugin", mono: true });
  });

  it("leave other tools to their names", () => {
    assert.equal(toolLine("Bash", { command: "ls" }), undefined);
    assert.equal(toolLine("mcp__kumiko__artifact_open", { path: "x.md" }), undefined);
    assert.equal(toolLine("mcp__other__deliver", {}), undefined);
  });
});
