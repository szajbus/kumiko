import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLAUDE_COMMAND, ClaudeDriver, claudeCommand, exitHint, userMessage, type AgentEvent, type AgentMessage } from "../src/index.js";
import { localExec } from "./helpers.js";

/** Starts a driver on the fake claude and collects its events. */
async function drive(values: NodeJS.ProcessEnv = {}, opts: { claude?: boolean; env?: string[] } = {}) {
  const { exec, home } = await localExec(values, opts);
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
  return { driver, events, messages, results, waitFor, start, home };
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
});
