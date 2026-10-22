import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CLAUDE_COMMAND, ClaudeDriver, claudeCommand, exitHint, mcpConfig, Runs, RUNS_DIR, userMessage, type AgentEvent, type AgentMessage, type Exec, type ToolCallContext, type ToolHost } from "../src/index.js";
import { localExec } from "./helpers.js";

/** Starts a driver on the fake claude and collects its events. */
async function drive(values: NodeJS.ProcessEnv = {}, opts: { claude?: boolean; env?: string[]; exec?: { exec: Exec; home: string } } = {}) {
  const { exec, home } = opts.exec ?? (await localExec(values, opts));
  const driver = new ClaudeDriver(exec, { graceMs: 1000 });
  const events: AgentEvent[] = [];
  driver.onEvent((e) => events.push(e));
  const messages = () => events.flatMap((e) => (e.kind === "message" ? [e.payload] : []));
  const results = () => messages().filter((m) => m.type === "result");
  const waitFor = async <T>(fn: () => T | undefined, ms = 8000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out; events: ${JSON.stringify(events).slice(-800)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const start = (prompt: string) => driver.start({ sandbox: "test", workdir: home, env: opts.env ?? [], prompt });
  return { driver, events, messages, results, waitFor, start, home, exec };
}

describe("ClaudeDriver", () => {
  it("holds a conversation, survives an interrupt and forwards variables", async () => {
    const d = await drive({ TOKEN: "s3cret value" }, { env: ["TOKEN"] });
    d.start("hello");
    await d.waitFor(() => d.results().length === 1);
    const init = d.messages().find((m) => m.type === "system" && m.subtype === "init")!;
    assert.equal(init.cwd, d.home, "Claude starts in the working directory");
    assert.ok(d.messages().some((m) => m.type === "stream_event"), "partial messages stream");

    d.driver.send("env TOKEN");
    await d.waitFor(() => d.results().length === 2);
    const toolResult = d.messages().find((m): m is AgentMessage => m.type === "user");
    assert.match(JSON.stringify(toolResult), /s3cret value/);

    d.driver.send("slow");
    await d.waitFor(() => d.messages().some((m) => m.type === "stream_event" && JSON.stringify(m).includes('"text":"3 "')));
    d.driver.interrupt();
    const interrupted = await d.waitFor(() => d.results()[2]);
    assert.equal(interrupted.subtype, "error_during_execution");
    assert.ok(d.messages().some((m) => m.type === "control_response"));

    d.driver.send("still here?");
    const after = await d.waitFor(() => d.results()[3]);
    assert.equal(after.result, "You said: still here?");

    await d.driver.stop();
    assert.deepEqual(d.events.at(-1), { kind: "exit", code: 0, requested: true });
    assert.ok(!d.events.some((e) => e.kind === "error"));
  });

  it("reports a crash with the stderr tail", async () => {
    const d = await drive();
    d.start("crash");
    const exit = await d.waitFor(() => d.events.find((e) => e.kind === "exit"));
    assert.deepEqual(exit, { kind: "exit", code: 3, requested: false });
    const err = d.events.find((e) => e.kind === "error");
    assert.ok(err && err.kind === "error");
    assert.equal(err.message, "Claude exited with code 3.");
    assert.deepEqual(err.stderr, ["Error: something broke inside Claude"]);
  });

  it("hints at reinstalling when claude is missing", async () => {
    const d = await drive({}, { claude: false });
    d.start("hello");
    const err = await d.waitFor(() => d.events.find((e) => e.kind === "error"));
    assert.ok(err.kind === "error");
    assert.match(err.message, /code 127/);
    assert.match(err.hint ?? "", /isn't installed/);
  });

  it("says so when Claude has no login, so the UI can offer one", async () => {
    const d = await drive();
    d.start("signed out");
    const err = await d.waitFor(() => d.events.find((e) => e.kind === "error"));
    assert.ok(err.kind === "error");
    assert.match(err.hint ?? "", /Log in/);
    assert.equal(err.signedOut, true);
    await d.driver.stop();
  });

  it("derives hints from exit codes", () => {
    assert.match(exitHint(255, ["ssh: connect to host"]) ?? "", /SSH/);
    assert.equal(exitHint(1, ["boom"]), undefined);
  });

  it("builds the resume command and refuses ids that aren't Claude's", () => {
    const id = "0b1d2c3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
    assert.equal(claudeCommand(), CLAUDE_COMMAND);
    assert.equal(claudeCommand(id), `${CLAUDE_COMMAND} --resume ${id}`);
    assert.equal(claudeCommand(id, true), `${CLAUDE_COMMAND} --resume ${id} --fork-session`);
    assert.throws(() => claudeCommand("x; rm -rf ~"), /Not a Claude session id/);
    const at = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    assert.equal(claudeCommand(id, true, at), `${CLAUDE_COMMAND} --resume ${id} --fork-session --resume-session-at ${at}`);
    assert.throws(() => claudeCommand(id, true, "x; rm -rf ~"), /Not a Claude message id/);
    assert.equal(claudeCommand(undefined, undefined, undefined, "opus"), `${CLAUDE_COMMAND} --model opus`);
    assert.throws(() => claudeCommand(undefined, undefined, undefined, "x; rm -rf ~"), /Not a model/);
  });

  it("tags prompts with ids and restores files by them", async () => {
    const d = await drive();
    const first = "11111111-1111-4111-8111-111111111111";
    d.driver.start({ sandbox: "test", workdir: d.home, env: [], prompt: "hello", promptId: first });
    await d.waitFor(() => d.results().length === 1);
    const echo = d.messages().find((m) => m.type === "user" && m.isReplay === true);
    assert.equal(echo?.uuid, first, "Claude echoes the prompt back under the id it was given");

    await d.driver.rewindFiles(first);
    await assert.rejects(d.driver.rewindFiles("22222222-2222-4222-8222-222222222222"), /No file checkpoint/);
    assert.ok(!d.messages().some((m) => m.type === "control_response"), "answers to requests aren't passed on as messages");

    await d.driver.stop();
    await assert.rejects(d.driver.rewindFiles(first), /isn't running/);
  });

  it("sends files as content blocks before the prompt's text", async () => {
    const png = Buffer.from("\x89PNG fake", "latin1");
    const files = [
      { name: "shot.png", mediaType: "image/png", data: png },
      { name: "spec.pdf", mediaType: "application/pdf", data: Buffer.from("%PDF-1.1") },
      { name: "notes.txt", mediaType: "text/plain", data: Buffer.from("zażółć") },
    ];
    assert.deepEqual(JSON.parse(userMessage("look", "u", files)).message.content, [
      { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
      { type: "document", title: "spec.pdf", source: { type: "base64", media_type: "application/pdf", data: Buffer.from("%PDF-1.1").toString("base64") } },
      { type: "document", title: "notes.txt", source: { type: "text", media_type: "text/plain", data: "zażółć" } },
      { type: "text", text: "look" },
    ]);
    assert.deepEqual(JSON.parse(userMessage("", undefined, files.slice(2))).message.content.map((b: { type: string }) => b.type), ["document"], "files alone, without an empty text block");

    const d = await drive();
    d.driver.start({ sandbox: "test", workdir: d.home, env: [], prompt: "hello", files: files.slice(0, 1) });
    await d.waitFor(() => d.results().length === 1);
    d.driver.send("again", undefined, files.slice(1));
    await d.waitFor(() => d.results().length === 2);
    assert.deepEqual(d.results().map((r) => r.result), [`You said: hello [with image/png (${png.length} bytes)]`, "You said: again [with spec.pdf (8 bytes), notes.txt (10 bytes)]"]);
    await d.driver.stop();
  });

  describe("runs", () => {
    /** The run's files, in the fake sandbox's home. */
    const runFile = (home: string, run: string, file: string) => join(home, RUNS_DIR, run, file);
    const alive = async (home: string, run: string) => {
      const pid = Number(await readFile(runFile(home, run, "pid"), "utf8"));
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    /** The text of every delta of the "slow" turn, in order. */
    const counted = (messages: AgentMessage[]) =>
      messages.flatMap((m) => {
        const delta = (m.event as { delta?: { type?: string; text?: string } } | undefined)?.delta;
        return m.type === "stream_event" && delta?.type === "text_delta" ? [delta.text ?? ""] : [];
      }).join("");

    it("leaves Claude working when it detaches, and picks it up again from where it got to", async () => {
      const d = await drive();
      d.driver.start({ sandbox: "test", workdir: d.home, env: [], prompt: "slow", run: "s1-a" });
      await d.waitFor(() => d.messages().some((m) => JSON.stringify(m).includes('"text":"3 "')));
      await d.driver.detach();
      const at = d.driver.position()!;
      assert.equal(at.run, "s1-a");
      assert.ok(!d.events.some((e) => e.kind === "exit"), "detaching reports nothing");
      assert.ok(await alive(d.home, "s1-a"), "Claude keeps going");
      const before = counted(d.messages());

      // Another driver, as a server that has restarted would, carries on from there: nothing lost, nothing twice.
      await new Promise((r) => setTimeout(r, 500));
      const e = await drive({}, { exec: { exec: d.exec, home: d.home } });
      e.driver.attach({ sandbox: "test", run: at.run, offset: at.offset });
      const result = await e.waitFor(() => e.results()[0], 15000);
      assert.equal(result.result, "counted");
      assert.equal(before + counted(e.messages()), Array.from({ length: 200 }, (_, i) => `${i + 1}`).join(" "));

      e.driver.send("still there?");
      assert.equal((await e.waitFor(() => e.results()[1])).result, "You said: still there?", "the same Claude answers");
      await e.driver.stop();
      assert.deepEqual(e.events.at(-1), { kind: "exit", code: 0, requested: true });
      await e.waitFor(() => !existsSync(join(e.home, RUNS_DIR, "s1-a")) || undefined);
    });

    it("attaches again when its attachment drops, without losing or repeating a line", async () => {
      const d = await drive();
      d.driver.start({ sandbox: "test", workdir: d.home, env: [], prompt: "slow", run: "s2-a" });
      await d.waitFor(() => d.messages().some((m) => JSON.stringify(m).includes('"text":"3 "')));
      // The attachment in the sandbox goes, as when the connection drops.
      process.kill(Number(await readFile(runFile(d.home, "s2-a", "attach.pid"), "utf8")), "SIGTERM");
      const result = await d.waitFor(() => d.results()[0], 15000);
      assert.equal(result.result, "counted");
      assert.equal(counted(d.messages()), Array.from({ length: 200 }, (_, i) => `${i + 1}`).join(" "));
      d.driver.send("again");
      assert.equal((await d.waitFor(() => d.results()[1])).result, "You said: again");
      await d.driver.stop();
    });

    it("reports an exit that happened while nobody was attached, with the stderr tail", async () => {
      const d = await drive();
      d.driver.start({ sandbox: "test", workdir: d.home, env: [], prompt: "hello", run: "s3-a" });
      await d.waitFor(() => d.results()[0]);
      await d.driver.detach();
      const at = d.driver.position()!;
      // Straight into Claude's input, as nobody is attached.
      await appendFile(runFile(d.home, "s3-a", "in"), userMessage("crash"));
      await d.waitFor(() => existsSync(runFile(d.home, "s3-a", "exit")) || undefined);
      const e = await drive({}, { exec: { exec: d.exec, home: d.home } });
      e.driver.attach({ sandbox: "test", run: at.run, offset: at.offset });
      const exit = await e.waitFor(() => e.events.find((x) => x.kind === "exit"));
      assert.deepEqual(exit, { kind: "exit", code: 3, requested: false });
      const err = e.events.find((x) => x.kind === "error");
      assert.ok(err?.kind === "error");
      assert.deepEqual(err.stderr, ["Error: something broke inside Claude"]);
      assert.equal(e.messages().filter((m) => m.type === "result").length, 0, "the turn before isn't reported again");
    });

    it("says so when the run is gone", async () => {
      const d = await drive();
      d.driver.attach({ sandbox: "test", run: "nothing-here", offset: 0 });
      const exit = await d.waitFor(() => d.events.find((e) => e.kind === "exit"));
      assert.equal(exit.kind === "exit" && exit.code, 75);
      const err = d.events.find((e) => e.kind === "error");
      assert.match(err?.kind === "error" ? err.message : "", /gone/);
    });

    it("removes a run whose folder is still being written to as it goes", async () => {
      const d = await drive();
      const dir = join(d.home, RUNS_DIR, "s5-a");
      await mkdir(dir, { recursive: true });
      // As the run's own shell writes its exit while its agent dies: files keep coming for a second.
      const writer = spawn("sh", ["-c", 'end=$(($(date +%s) + 2)); i=0; while [ "$(date +%s)" -lt "$end" ]; do : > "$1/f$i" 2>/dev/null || exit 0; i=$((i + 1)); done', "sh", dir]);
      const written = new Promise((r) => writer.once("exit", r));
      await new Promise((r) => setTimeout(r, 100));
      await new Runs(d.exec).remove("test", ["s5-a"]);
      await written;
      assert.equal(existsSync(dir), false);
    });

    it("lists runs with their state, and removes them", async () => {
      const d = await drive();
      d.driver.start({ sandbox: "test", workdir: d.home, env: [], prompt: "hello", run: "s4-a" });
      await d.waitFor(() => d.results()[0]);
      await d.driver.detach();
      const runs = new Runs(d.exec);
      assert.deepEqual([...(await runs.list("test"))], [["s4-a", "alive"]]);
      const pid = Number(await readFile(runFile(d.home, "s4-a", "pid"), "utf8"));
      await runs.remove("test", ["s4-a"]);
      assert.deepEqual([...(await runs.list("test"))], []);
      await d.waitFor(() => {
        try {
          process.kill(pid, 0);
          return undefined;
        } catch {
          return true;
        }
      });
    });
  });

  describe("tools it hosts for Claude", () => {
    /** An `echo` tool always loaded, a deferred `wait` that answers once let go of, and calls kept to look at. */
    function host() {
      const calls: { name: string; args: Record<string, unknown>; ctx: ToolCallContext }[] = [];
      let release: (() => void) | undefined;
      const tools: ToolHost = {
        list: () => [
          { name: "echo", description: "Echoes.", inputSchema: { type: "object", properties: { text: { type: "string" } } }, alwaysLoad: true },
          { name: "wait", description: "Waits.", inputSchema: { type: "object" } },
          { name: "boom", description: "Fails.", inputSchema: { type: "object" } },
          { name: "slow", description: "Answers after a moment.", inputSchema: { type: "object" } },
        ],
        async call(name, args, ctx) {
          calls.push({ name, args, ctx });
          if (name === "boom") throw new Error("it broke");
          if (name === "slow") await new Promise((r) => setTimeout(r, 300));
          if (name === "wait") await new Promise<void>((r) => ((release = r), ctx.signal.addEventListener("abort", () => r())));
          return { text: `${name}: ${String(args.text ?? "done")}` };
        },
      };
      return { tools, calls, release: () => release?.() };
    }

    it("lists them, with which are deferred, and answers calls", async () => {
      const d = await drive();
      const h = host();
      d.driver.start({ sandbox: "test", workdir: d.home, env: [], prompt: "tools", tools: h.tools, appendSystemPrompt: "You're in Kumiko." });
      const listed = JSON.parse(String((await d.waitFor(() => d.results()[0])).result)) as { name: string; _meta: Record<string, boolean> }[];
      assert.deepEqual(listed.map((t) => [t.name, t._meta["anthropic/alwaysLoad"]]), [["echo", true], ["wait", false], ["boom", false], ["slow", false]]);
      const init = d.messages().find((m) => m.type === "system" && m.subtype === "init");
      assert.ok((init?.tools as string[]).includes("mcp__kumiko__echo"));
      assert.ok(!d.messages().some((m) => m.type === "control_request"), "Claude's MCP messages aren't passed on");

      d.driver.send(`widget echo {"text":"hi"}`);
      assert.equal((await d.waitFor(() => d.results()[1])).result, "echo: hi");
      assert.match(String(h.calls[0].ctx.toolUseId), /^toolu_/);
      d.driver.send("widget boom {}");
      assert.equal((await d.waitFor(() => d.results()[2])).result, "it broke");
      d.driver.send("widget nope {}");
      assert.equal((await d.waitFor(() => d.results()[3])).result, "There is no tool nope.");
      d.driver.send("system prompt");
      assert.equal((await d.waitFor(() => d.results()[4])).result, "You're in Kumiko.");
      await d.driver.stop();
    });

    it("lets go of a call Claude cancels", async () => {
      const d = await drive();
      const h = host();
      d.driver.start({ sandbox: "test", workdir: d.home, env: [], prompt: "widget wait {}", tools: h.tools });
      await d.waitFor(() => h.calls.length === 1);
      d.driver.interrupt();
      assert.equal((await d.waitFor(() => d.results()[0])).subtype, "error_during_execution");
      assert.ok(h.calls[0].ctx.signal.aborted);
      await d.driver.stop();
    });

    it("leaves a call it hasn't answered for the next driver to answer", async () => {
      const d = await drive();
      const h = host();
      d.driver.start({ sandbox: "test", workdir: d.home, env: [], prompt: "widget wait {}", tools: h.tools, run: "t3-a" });
      await d.waitFor(() => h.calls.length === 1);
      await d.driver.detach();
      const pending = d.driver.pendingCalls();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].message.method, "tools/call");
      h.release();

      const e = await drive({}, { exec: { exec: d.exec, home: d.home } });
      const h2 = host();
      e.driver.attach({ sandbox: "test", ...d.driver.position()!, tools: h2.tools, pending });
      await e.waitFor(() => h2.calls.length === 1);
      h2.release();
      assert.equal((await e.waitFor(() => e.results()[0])).result, "wait: done");
      await e.driver.stop();
    });

    it("answers the calls under way before letting go, and hands on only what follows", async () => {
      const d = await drive();
      const h = host();
      d.driver.start({ sandbox: "test", workdir: d.home, env: [], prompt: `widget slow {"text":"drained"}`, tools: h.tools, run: "t4-a" });
      await d.waitFor(() => h.calls.length === 1);
      // Let go while the call is under way: it is answered first, so nothing is left for the next driver.
      await d.driver.detach();
      assert.deepEqual(d.driver.pendingCalls(), []);
      const e = await drive({}, { exec: { exec: d.exec, home: d.home } });
      e.driver.attach({ sandbox: "test", ...d.driver.position()!, tools: host().tools });
      // The answer reached Claude, which finished the turn while no driver was attached.
      assert.equal((await e.waitFor(() => e.results()[0])).result, "slow: drained");
      await e.driver.stop();
    });

    it("puts the config and the system prompt in the command, quoted", () => {
      const cmd = claudeCommand(undefined, undefined, undefined, undefined, { tools: true, appendSystemPrompt: "It's here." });
      assert.ok(cmd.includes(`--mcp-config '${mcpConfig()}'`));
      assert.ok(cmd.includes(`--append-system-prompt 'It'\\''s here.'`));
      assert.equal(claudeCommand(undefined, undefined, undefined, undefined, {}), CLAUDE_COMMAND);
    });
  });
});
