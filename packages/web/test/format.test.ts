import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LogLine, SandboxView } from "@kumiko/shared";
import { matchCommands } from "../src/commands.ts";
import { ago, endedText, formatBytes, formatCost, formatDuration, planName, projectHue, projectHues, resetText, sessionName, sessionTitle } from "../src/format.ts";
import { COLORS, opPill, resources, statusOf } from "../src/status.ts";

describe("format", () => {
  it("titles a session by its /rename name, else the opening prompt cut at a word", () => {
    assert.equal(sessionTitle({ sandbox: "web", prompt: "fix the login bug" }), "web · fix the login bug");
    assert.equal(sessionTitle({ sandbox: "web", prompt: "x", title: "Login" }), "web · Login");
    assert.equal(sessionTitle({ sandbox: "web", prompt: "please refactor the whole payment module today" }), "web · please refactor the whole…");
    assert.equal(sessionTitle({ sandbox: "web", prompt: "a".repeat(40) }), `web · ${"a".repeat(28)}…`);
  });

  it("names a session without its project, for a tab under the project's label", () => {
    assert.equal(sessionName({ prompt: "fix the login bug" }), "fix the login bug");
    assert.equal(sessionName({ prompt: "x", title: "Login" }), "Login");
    assert.equal(sessionName({ prompt: "please refactor the whole payment module today" }), "please refactor the whole…");
  });

  it("gives a project the same hue every time, and different projects mostly different ones", () => {
    assert.equal(projectHue("kumiko"), projectHue("kumiko"));
    const hues = new Set(["kumiko", "web", "api", "docs", "infra"].map(projectHue));
    assert.ok(hues.size >= 4, [...hues].join());
    for (const h of hues) assert.ok(h >= 0 && h < 360);
  });

  it("gives open projects different hues, by name, whatever order their groups are in", () => {
    // These two would both like 270°.
    assert.equal(projectHue("kumiko"), projectHue("webshop"));
    const hues = projectHues(["webshop", "kumiko", "api-server"]);
    assert.equal(hues.get("kumiko"), 270);
    // webshop moves as far as it can from both api-server and kumiko, not to the hue beside kumiko's.
    assert.equal(hues.get("api-server"), 150);
    assert.equal(hues.get("webshop"), 30);
    assert.deepEqual(projectHues(["kumiko", "api-server", "webshop"]), hues);
    assert.equal(new Set(projectHues(Array.from({ length: 12 }, (_, i) => `p${i}`)).values()).size, 12);
  });

  it("says when a limit resets, and nothing once it has", () => {
    assert.equal(resetText(90 * 1000), "resets in 2m");
    assert.equal(resetText((2 * 60 + 5) * 60_000), "resets in 2h 5m");
    assert.equal(resetText((3 * 1440 + 4 * 60) * 60_000), "resets in 3d 4h");
    assert.equal(resetText(0), undefined);
    assert.equal(resetText(NaN), undefined);
  });

  it("says how long ago, in the largest unit that fits", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    assert.equal(ago("2026-10-19T11:59:50Z", now), "just now");
    assert.equal(ago("2026-10-19T11:55:00Z", now), "5 min ago");
    assert.equal(ago("2026-10-19T09:00:00Z", now), "3 hours ago");
    assert.equal(ago("2026-10-17T12:00:00Z", now), "2 days ago");
    assert.equal(ago("2026-10-19T12:05:00Z", now), "just now", "a clock ahead of ours isn't negative");
  });

  it("formats bytes, cost and duration", () => {
    assert.deepEqual([formatBytes(812), formatBytes(4300), formatBytes(50_000), formatBytes(13 * 1024 ** 2)], ["812 B", "4.2 KB", "49 KB", "13 MB"]);
    assert.deepEqual([formatCost(0.0042), formatCost(1.254)], ["$0.0042", "$1.25"]);
    assert.deepEqual([formatDuration(4200), formatDuration(125_000), formatDuration(119_700)], ["4.2s", "2m 5s", "2m 0s"]);
  });

  it("names plans and endings", () => {
    assert.equal(planName("max"), "Max");
    assert.equal(endedText("sandbox"), "Session ended: its sandbox stopped.");
    assert.equal(endedText("exit", 2), "Session ended: Claude exited with code 2.");
    assert.equal(endedText("exit", 0), "Session ended: Claude exited.");
  });
});

describe("matchCommands", () => {
  it("puts names that start with the text first, then ones that contain it, ignoring case", () => {
    assert.deepEqual(matchCommands(["compact", "model", "Mcp", "context"], "c"), ["compact", "context", "Mcp"]);
    assert.deepEqual(matchCommands(["compact", "model"], ""), ["compact", "model"]);
    assert.deepEqual(matchCommands(["compact"], "zz"), []);
  });
});

describe("status", () => {
  const sb = (over: Partial<SandboxView> = {}): SandboxView => ({ name: "web", vm: "km-web", provider: "lima", status: "running", busy: false, sessions: 0, ...over });
  const op = { op: "creating" as const, startedAt: "2026-10-19T12:00:00Z" };
  const meta = (setup: "creating" | "ready" | "provision_failed", provisionExitCode?: number) => ({
    spec: { name: "web", cpus: 2, memoryGiB: 4, diskGiB: 20, mounts: [], env: [] },
    provider: "lima" as const,
    createdAt: "2026-10-19T12:00:00Z",
    setup,
    provisionExitCode,
  });

  it("names the step a create has reached, from its log", () => {
    const log: LogLine[] = [{ text: "$ limactl create", kind: "cmd" }];
    assert.deepEqual(statusOf(sb({ busy: true, operation: op }), log), { text: "Creating…", color: COLORS.busy });
    log.push({ text: "— installing Claude Code —", kind: "note" });
    assert.equal(statusOf(sb({ busy: true, operation: op }), log).text, "Installing Claude Code…");
    log.push({ text: "— provisioning (runs once, as the sandbox user) —", kind: "note" });
    assert.equal(statusOf(sb({ busy: true, operation: op }), log).text, "Provisioning…");
  });

  it("puts a failed or missing setup ahead of the VM's state", () => {
    assert.deepEqual(statusOf(sb({ meta: meta("provision_failed", 3) })), { text: "Provisioning failed", color: COLORS.failed });
    assert.equal(statusOf(sb({ status: "stopped", meta: meta("creating") })).text, "Stopped · not provisioned");
    assert.equal(statusOf(sb({ meta: meta("ready") })).text, "Running");
    assert.equal(statusOf(sb({ status: "unknown" })).text, "Unknown");
  });

  it("sums up the last operation in the log's pill", () => {
    assert.equal(opPill(sb()), undefined);
    assert.equal(opPill(sb({ operation: op }))?.text, "Creating");
    const failed = { ...op, endedAt: "2026-10-19T12:01:00Z", result: "error" as const };
    assert.equal(opPill(sb({ operation: failed, meta: meta("provision_failed", 3) }))?.text, "Provisioning failed · exit 3");
    assert.equal(opPill(sb({ operation: failed }))?.text, "Create failed");
    assert.equal(opPill(sb({ operation: { ...op, endedAt: "x", result: "ok" } }))?.text, "Created");
  });

  it("shows Lima's resources, else the stored spec's", () => {
    assert.equal(resources(sb({ cpus: 4, memoryGiB: 8, diskGiB: 100 })), "4 · 8 GiB · 100 GiB");
    assert.equal(resources(sb({ meta: meta("ready") })), "2 · 4 GiB · 20 GiB");
    assert.equal(resources(sb()), "—");
  });
});
