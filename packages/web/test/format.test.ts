import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBusy, isWaiting, type LogLine, type VmView, type SessionInfo } from "@kumiko/shared";
import { matchCommands } from "../src/commands.ts";
import { ago, endedText, formatBytes, formatCost, formatDuration, planName, sandboxHue, sandboxHues, resetText, sessionName, sessionTitle } from "../src/format.ts";
import { COLORS, failedAgentScripts, finishingState, meters, opPill, resources, sandboxCreatedAt, sessionState, statusOf } from "../src/status.ts";

describe("format", () => {
  it("titles a session by its /rename name, else the opening prompt cut at a word", () => {
    assert.equal(sessionTitle({ sandbox: "web", prompt: "fix the login bug" }), "web · fix the login bug");
    assert.equal(sessionTitle({ sandbox: "web", prompt: "x", title: "Login" }), "web · Login");
    assert.equal(sessionTitle({ sandbox: "web", prompt: "please refactor the whole payment module today" }), "web · please refactor the whole…");
    assert.equal(sessionTitle({ sandbox: "web", prompt: "a".repeat(40) }), `web · ${"a".repeat(28)}…`);
  });

  it("names a session without its sandbox, for a tab under the sandbox's label", () => {
    assert.equal(sessionName({ prompt: "fix the login bug" }), "fix the login bug");
    assert.equal(sessionName({ prompt: "x", title: "Login" }), "Login");
    assert.equal(sessionName({ prompt: "please refactor the whole payment module today" }), "please refactor the whole…");
  });

  it("gives a sandbox the same hue every time, and different sandboxes mostly different ones", () => {
    assert.equal(sandboxHue("kumiko"), sandboxHue("kumiko"));
    const hues = new Set(["kumiko", "web", "api", "docs", "infra"].map(sandboxHue));
    assert.ok(hues.size >= 4, [...hues].join());
    for (const h of hues) assert.ok(h >= 0 && h < 360);
  });

  it("gives open sandboxes different hues, by name, whatever order their groups are in", () => {
    // These two would both like 270°.
    assert.equal(sandboxHue("kumiko"), sandboxHue("webshop"));
    const hues = sandboxHues(["webshop", "kumiko", "api-server"]);
    assert.equal(hues.get("kumiko"), 270);
    // webshop moves as far as it can from both api-server and kumiko, not to the hue beside kumiko's.
    assert.equal(hues.get("api-server"), 150);
    assert.equal(hues.get("webshop"), 30);
    assert.deepEqual(sandboxHues(["kumiko", "api-server", "webshop"]), hues);
    assert.equal(new Set(sandboxHues(Array.from({ length: 12 }, (_, i) => `p${i}`)).values()).size, 12);
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
    assert.deepEqual([formatBytes(812), formatBytes(4300), formatBytes(50_000), formatBytes(13 * 1024 ** 2), formatBytes(2.5 * 1024 ** 3)], ["812 B", "4.2 KB", "49 KB", "13 MB", "2.5 GB"]);
    assert.deepEqual([formatCost(0.0042), formatCost(1.254)], ["$0.0042", "$1.25"]);
    assert.deepEqual([formatDuration(4200), formatDuration(125_000), formatDuration(119_700)], ["4.2s", "2m 5s", "2m 0s"]);
  });

  it("shows a sandbox's reading as CPU, memory and disk bars, amber from 80% and red from 95%", () => {
    const GiB = 1024 ** 3;
    const reading = { cpuPercent: 38.4, load: 1.62, memTotalBytes: 4 * GiB, memUsedBytes: 3.3 * GiB, diskUsedBytes: 97 * GiB, diskFreeBytes: 3 * GiB };
    assert.deepEqual(meters(reading), [
      { label: "CPU", percent: 38, text: "38% busy · load 1.6", color: COLORS.running },
      { label: "Memory", percent: 83, text: "3.3 GiB used · 83%", color: COLORS.warn },
      { label: "Disk", percent: 97, text: "97 GiB used · 97%", color: COLORS.failed },
    ]);
    const first = meters({ ...reading, cpuPercent: undefined })[0];
    assert.deepEqual([first.percent, first.text, first.color], [undefined, "— · load 1.6", COLORS.stopped]);
    assert.deepEqual(meters({ ...reading, workspaceUsedBytes: 18 * GiB, workspaceFreeBytes: 32 * GiB })[3], { label: "Workspace", percent: 36, text: "18 GiB used · 36%", color: COLORS.running });
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
  it("shows a session whose Claude asks something as waiting on the user, not working", () => {
    const s: SessionInfo = { id: "a1b2c3", sandbox: "web", workdir: "/w", status: "running", prompt: "x", startedAt: "2026-10-23T00:00:00Z" };
    assert.deepEqual(sessionState(s), { text: "Working…", color: COLORS.busy });
    const asking = { ...s, asking: "questions" as const };
    assert.deepEqual(sessionState(asking), { text: "Has a question for you", color: COLORS.warn });
    assert.deepEqual(sessionState({ ...s, asking: "plan" }), { text: "Plan to review", color: COLORS.warn });
    assert.ok(isWaiting(asking) && !isBusy(asking));
  });

  it("says a session finishing after its tab closed needs attention while Claude waits on the user", () => {
    const s: SessionInfo = { id: "a1b2c3", sandbox: "web", workdir: "/w", status: "running", prompt: "x", startedAt: "2026-10-23T00:00:00Z", closing: { delete: false, until: "2026-10-23T00:30:00Z" } };
    assert.deepEqual(finishingState(s), { text: "Finishing…", color: COLORS.busy, pulse: true });
    assert.deepEqual(finishingState({ ...s, asking: "questions" }), { text: "Needs attention", color: COLORS.warn, pulse: false });
    assert.deepEqual(finishingState({ ...s, asking: "plan" }), { text: "Needs attention", color: COLORS.warn, pulse: false });
  });

  const sb = (over: Partial<VmView> = {}): VmView => ({ name: "web", vm: "kumiko-web", provider: "lima", status: "running", busy: false, sessions: 0, ...over });
  const op = { op: "creating" as const, startedAt: "2026-10-19T12:00:00Z" };
  const meta = (setup: "creating" | "ready" | "provision_failed", provisionExitCode?: number) => ({
    spec: { name: "web", cpus: 2, memoryGiB: 4, diskGiB: 20, workspaceGiB: 50, mounts: [], env: [], workdir: "/workspace" },
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
    log.push({ text: "— agent setup: 10-a.sh —", kind: "note" });
    assert.equal(statusOf(sb({ busy: true, operation: op }), log).text, "Running the agent's setup…");
  });

  it("says when the agent's setup failed in a sandbox that is otherwise ready", () => {
    const agentSetup = { scripts: [{ file: "10-a.sh", script: "", exitCode: 0 }, { file: "20-b.sh", script: "", exitCode: 7 }, { file: "30-c.sh", script: "" }] };
    const ready = { ...meta("ready"), agentSetup };
    assert.deepEqual(failedAgentScripts(sb({ meta: ready })), ["20-b.sh"]);
    assert.deepEqual(statusOf(sb({ meta: ready })), { text: "Running · agent setup failed", color: COLORS.warn });
    assert.equal(statusOf(sb({ meta: { ...ready, agentSetup: { scripts: agentSetup.scripts.slice(0, 1) } } })).text, "Running");
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

  it("shows Lima's resources, else the stored spec's, with the workspace disk", () => {
    assert.deepEqual(resources(sb({ cpus: 4, memoryGiB: 8, diskGiB: 100, workspaceGiB: 80 })), ["4", "8 GiB", "80 GiB"]);
    assert.deepEqual(resources(sb({ cpus: 4, memoryGiB: 8, diskGiB: 100, meta: meta("ready") })), ["4", "8 GiB", "50 GiB"], "the disk's size as recorded until Lima lists it");
    assert.deepEqual(resources(sb({ cpus: 4, memoryGiB: 8, diskGiB: 100 })), ["4", "8 GiB", "—"], "no workspace disk");
    assert.deepEqual(resources(sb({ meta: meta("ready") })), ["2", "4 GiB", "50 GiB"]);
    assert.equal(resources(sb()), undefined);
  });

  it("dates a sandbox by its own record, which a recreate renews, not by its sandbox", () => {
    const sandbox = { id: "web", clonePath: "/src/web", worktreesPath: "/src/web__worktrees", createdAt: "2026-01-01T00:00:00Z" };
    const view = { ...sb({ meta: { ...meta("ready"), createdAt: "2026-10-20T09:00:00Z" } }), sandbox };
    assert.equal(sandboxCreatedAt(view), "2026-10-20T09:00:00Z");
    assert.equal(sandboxCreatedAt(sb()), undefined);
  });
});
