#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format stream-json --include-partial-messages`,
// emitting the same shapes Claude Code 2.1.303 does. What a prompt does depends on its text:
//   "env NAME"   replies with the value of $NAME, through a Bash tool call
//   "slow"       streams a word every 50ms for ~10s, so it can be interrupted
//   "/model X"   switches the model, with a synthetic reply and a 0-turn result
//   "/rename X"  names the session, as a session_title_changed message
//   "crash"      writes to stderr and exits 3
//   "signed out" answers with an error result, as Claude does without a login
//   "tools"      replies with the tools of the SDK MCP server (see below), as JSON
//   "widget N J" calls that server's tool N with the arguments J (JSON), and replies with what it answered; a call
//                interrupted while waiting is cancelled, as Claude does
//   "write J"    writes a file as Claude's Write tool does, J being its input as JSON ({ file_path, content });
//                a path starting with ~/ is in $HOME. "write-slow J" streams the input over ~3s first
//   anything else is echoed back as "You said: …", followed by " [with …]" naming the files that came with it
// With a `.require-login` file in $CLAUDE_CONFIG_DIR, every prompt is answered as "signed out" until there is a
// `.credentials.json` beside it. `claude auth status` and `claude auth login` work against that folder: the login
// prints a sign-in URL, reads a code from stdin, and logs in for the code "good-code".
// Prompts carrying a uuid are echoed back as `isReplay` user messages, as with --replay-user-messages, and every
// assistant message has a uuid. A `rewind_files` control request is answered with success, or with an error for a uuid
// the session never saw. --resume-session-at <uuid> keeps only the messages up to that one.
// With --mcp-config naming a server of type "sdk", it does that server's MCP handshake over control requests on
// start, as Claude does, and lists its tools in init as mcp__<server>__<tool>. --append-system-prompt is taken and
// replied to by the prompt "system prompt".
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, fstatSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const credentials = join(configDir, ".credentials.json");
const loggedIn = () => existsSync(credentials);
const signedOut = () => existsSync(join(configDir, ".require-login")) && !loggedIn();

if (args[0] === "auth" && args[1] === "status") {
  const status = loggedIn() ? { loggedIn: true, authMethod: "claude.ai", email: "you@example.com", subscriptionType: "max" } : { loggedIn: false, authMethod: "none" };
  process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  process.exit(loggedIn() ? 0 : 1);
}
if (args[0] === "auth" && args[1] === "login") {
  process.stdout.write("Opening browser to sign in…\n");
  process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=fake\n");
  process.stdout.write("Paste code here if prompted > ");
  const rl = createInterface({ input: process.stdin });
  const code = await new Promise((r) => rl.once("line", r));
  rl.close();
  if (String(code).trim() !== "good-code") {
    process.stdout.write("\nOAuth error: Invalid code\n");
    process.exit(1);
  }
  mkdirSync(configDir, { recursive: true });
  writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "fake" } }));
  process.stdout.write("\nLogin successful.\n");
  process.exit(0);
}

// --resume <id> continues that session; with --fork-session it gets a new id instead.
const resumed = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : undefined;
const session_id = resumed && !args.includes("--fork-session") ? resumed : randomUUID();
let model = "claude-sonnet-5-5";
let total = 0;
let msgN = 0;
const queue = [];
const seen = new Set(); // uuids of the prompts this process has been sent
const resumeAt = args.includes("--resume-session-at") ? args[args.indexOf("--resume-session-at") + 1] : undefined;
let current; // { cancel(): void }
const mcpServer = (() => {
  const at = args.indexOf("--mcp-config");
  if (at < 0) return undefined;
  const servers = JSON.parse(args[at + 1]).mcpServers ?? {};
  return Object.keys(servers).find((name) => servers[name].type === "sdk");
})();
const systemPrompt = args.includes("--append-system-prompt") ? args[args.indexOf("--append-system-prompt") + 1] : undefined;
let mcpTools = [];
let mcpRequests = 0;
const answers = new Map(); // control request id -> resolve(response)

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (event, id) => out({ type: "stream_event", event, session_id, parent_tool_use_id: null, uuid: randomUUID(), api_message_id: id });

async function streamText(id, text, index, cancelled, delay = 0) {
  ev({ type: "content_block_start", index, content_block: { type: "text", text: "" } }, id);
  for (const word of text.split(/(?<= )/)) {
    if (cancelled()) return false;
    ev({ type: "content_block_delta", index, delta: { type: "text_delta", text: word } }, id);
    if (delay) await sleep(delay);
  }
  ev({ type: "content_block_stop", index }, id);
  out({ type: "assistant", message: { model, id, type: "message", role: "assistant", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id, uuid: randomUUID() });
  return true;
}

function result(start, { subtype = "success", is_error = false, text = "", cost = 0.01, num_turns = 1 } = {}) {
  total += cost;
  out({ type: "result", subtype, is_error, duration_ms: Date.now() - start, num_turns, result: text, session_id, total_cost_usd: total });
}

/** Sends one MCP message to the SDK server; resolves with its JSON-RPC response, or undefined for a notification. */
function mcp(message, onCancel) {
  const request_id = `mcp-${++mcpRequests}`;
  out({ type: "control_request", request_id, request: { subtype: "mcp_message", server_name: mcpServer, message } });
  return new Promise((resolve) => {
    answers.set(request_id, (r) => resolve(r?.mcp_response));
    onCancel?.(() => {
      answers.delete(request_id);
      mcp({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: message.id, reason: "AbortError: remote-cancel" } });
      resolve(undefined);
    });
  });
}

/** The handshake Claude does with an SDK server as it starts, before anything else. */
const handshake = mcpServer
  ? (async () => {
      await mcp({ method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fake-claude" } }, jsonrpc: "2.0", id: 0 });
      await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
      mcpTools = (await mcp({ method: "tools/list", jsonrpc: "2.0", id: 1 }))?.result?.tools ?? [];
    })()
  : Promise.resolve();
let rpcId = 1;

/** One tool call of Claude's, reported as Claude reports it: the tool_use, then the tool_result `run` gives. */
async function toolCall(id, name, input, run, slow = false) {
  const tool = { type: "tool_use", id: `toolu_${msgN}`, name, input };
  ev({ type: "content_block_start", index: 0, content_block: { ...tool, input: {} } }, id);
  const json = JSON.stringify(input);
  const step = slow ? Math.max(1, Math.ceil(json.length / 100)) : json.length;
  for (let i = 0; i < json.length; i += step) {
    ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(i, i + step) } }, id);
    if (slow) await sleep(30);
  }
  ev({ type: "content_block_stop", index: 0 }, id);
  out({ type: "assistant", message: { model, id, type: "message", role: "assistant", content: [tool] }, parent_tool_use_id: null, session_id, uuid: randomUUID() });
  const { text, isError } = await run(tool.id);
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: text, is_error: isError }] }, parent_tool_use_id: null, session_id, uuid: randomUUID() });
  return { text, isError };
}

async function turn({ text, files }) {
  let cancelled = false;
  let onCancel;
  current = { cancel: () => ((cancelled = true), onCancel?.()) };
  const start = Date.now();
  await handshake;
  const mcpNames = mcpTools.map((t) => `mcp__${mcpServer}__${t.name}`);
  out({ type: "system", subtype: "init", cwd: process.cwd(), session_id, model, tools: ["Bash", "Read", "Write", ...mcpNames], permissionMode: "bypassPermissions", slash_commands: ["compact", "model", "context"] });

  if (text.startsWith("/model ")) {
    model = `claude-${text.slice(7).trim()}-5-5`;
    out({ type: "assistant", message: { model: "<synthetic>", id: randomUUID(), type: "message", role: "assistant", content: [{ type: "text", text: `Set model to ${model}` }] }, parent_tool_use_id: null, session_id, uuid: randomUUID() });
    return result(start, { cost: 0, num_turns: 0, text: "Set model to `" + text.slice(7).trim() + "` for this session only" });
  }
  if (text.startsWith("/rename ")) {
    out({ type: "system", subtype: "session_title_changed", title: text.slice(8).trim(), session_id });
    return result(start, { cost: 0, num_turns: 0 });
  }
  if (text === "crash") {
    process.stderr.write("Error: something broke inside Claude\n");
    process.exit(3);
  }
  if (text === "signed out" || signedOut()) {
    out({ type: "assistant", message: { model: "<synthetic>", id: randomUUID(), type: "message", role: "assistant", content: [{ type: "text", text: "Not logged in · Please run /login" }] }, parent_tool_use_id: null, session_id, uuid: randomUUID() });
    return result(start, { is_error: true, text: "Not logged in · Please run /login", cost: 0 });
  }

  const id = `msg_${++msgN}`;
  ev({ type: "message_start", message: { model, id, type: "message", role: "assistant", content: [] } }, id);

  if (text.startsWith("env ")) {
    const name = text.slice(4).trim();
    const tool = { type: "tool_use", id: `toolu_${msgN}`, name: "Bash", input: { command: `echo $${name}`, description: `Print ${name}` } };
    ev({ type: "content_block_start", index: 0, content_block: { ...tool, input: {} } }, id);
    ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } }, id);
    ev({ type: "content_block_stop", index: 0 }, id);
    out({ type: "assistant", message: { model, id, type: "message", role: "assistant", content: [tool] }, parent_tool_use_id: null, session_id, uuid: randomUUID() });
    const value = process.env[name] ?? "";
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: value, is_error: false }] }, parent_tool_use_id: null, session_id });
    const id2 = `msg_${++msgN}`;
    ev({ type: "message_start", message: { model, id: id2, type: "message", role: "assistant", content: [] } }, id2);
    await streamText(id2, `${name} is ${value}`, 0, () => cancelled);
    return result(start, { text: `${name} is ${value}` });
  }

  if (text === "slow") {
    ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, id);
    ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Counting slowly.", estimated_tokens: 5 } }, id);
    ev({ type: "content_block_stop", index: 0 }, id);
    out({ type: "assistant", message: { model, id, type: "message", role: "assistant", content: [{ type: "thinking", thinking: "Counting slowly." }] }, parent_tool_use_id: null, session_id, uuid: randomUUID() });
    const done = await streamText(id, Array.from({ length: 200 }, (_, i) => `${i + 1}`).join(" "), 1, () => cancelled, 50);
    if (!done) return result(start, { subtype: "error_during_execution", is_error: false });
    return result(start, { text: "counted" });
  }

  if (text === "tools" || text === "system prompt") {
    const reply = text === "tools" ? JSON.stringify(mcpTools) : String(systemPrompt);
    await streamText(id, reply, 0, () => cancelled);
    return result(start, { text: reply });
  }

  if (text.startsWith("widget ")) {
    const [, name, json] = /^widget (\S+)\s*(.*)$/s.exec(text);
    const call = await toolCall(id, `mcp__${mcpServer}__${name}`, JSON.parse(json || "{}"), async (toolUseId) => {
      const message = { method: "tools/call", params: { name, arguments: JSON.parse(json || "{}"), _meta: { "claudecode/toolUseId": toolUseId } }, jsonrpc: "2.0", id: ++rpcId };
      const res = await mcp(message, (cancel) => (onCancel = cancel));
      if (!res) return { text: "The user doesn't want to proceed with this tool use.", isError: true };
      const parts = res.result?.content?.map((c) => (c.type === "image" ? ` [image ${c.mimeType}, ${Buffer.from(c.data, "base64").length} bytes]` : c.text));
      return { text: parts?.join("") ?? res.error?.message ?? "", isError: Boolean(res.result?.isError || res.error) };
    });
    if (cancelled) return result(start, { subtype: "error_during_execution" });
    const id2 = `msg_${++msgN}`;
    await streamText(id2, call.text, 0, () => cancelled);
    return result(start, { text: call.text });
  }

  if (text.startsWith("write ") || text.startsWith("write-slow ")) {
    const slow = text.startsWith("write-slow ");
    const input = JSON.parse(text.slice(text.indexOf(" ") + 1));
    await toolCall(id, "Write", input, async () => {
      const path = input.file_path.startsWith("~/") ? join(homedir(), input.file_path.slice(2)) : resolve(input.file_path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, input.content);
      return { text: `File created successfully at: ${input.file_path}`, isError: false };
    }, slow);
    return result(start, { text: "written" });
  }

  if (text === "where") {
    await streamText(id, `resumed at ${resumeAt ?? "nothing"}`, 0, () => cancelled);
    return result(start, { text: "where" });
  }

  const reply = `You said: ${text}${files.length ? ` [with ${files.join(", ")}]` : ""}`;
  await streamText(id, reply, 0, () => cancelled);
  return result(start, { text: reply });
}

async function pump() {
  if (current) return;
  while (queue.length) await turn(queue.shift());
  current = undefined;
}

// A run's stdin is a FIFO, and on macOS node never sees its EOF; a cat reading it for us does. (Claude itself runs in
// the Linux VM; only the fake meets this, when the tests run on a Mac.)
const input = process.platform === "darwin" && fstatSync(0).isFIFO() ? spawn("cat", [], { stdio: [0, "pipe", "inherit"] }).stdout : process.stdin;
const rl = createInterface({ input });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === "user") {
    const text = msg.message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    // An image as its type and size, a document as its title and size: enough to tell they arrived whole.
    const files = msg.message.content
      .filter((b) => b.type !== "text")
      .map((b) => `${b.title ?? b.source.media_type} (${b.source.type === "base64" ? Buffer.from(b.source.data, "base64").length : Buffer.byteLength(b.source.data)} bytes)`);
    if (msg.uuid) {
      seen.add(msg.uuid);
      out({ type: "user", message: msg.message, parent_tool_use_id: null, session_id, uuid: msg.uuid, isReplay: true });
    }
    queue.push({ text, files });
    void pump();
  } else if (msg.type === "control_request" && msg.request?.subtype === "rewind_files") {
    const ok = seen.has(msg.request.user_message_id);
    out({
      type: "control_response",
      response: ok
        ? { subtype: "success", request_id: msg.request_id, response: { canRewind: true, skippedLinks: 0 } }
        : { subtype: "error", request_id: msg.request_id, error: "No file checkpoint found for this message." },
    });
  } else if (msg.type === "control_response" && answers.has(msg.response?.request_id)) {
    const answer = answers.get(msg.response.request_id);
    answers.delete(msg.response.request_id);
    answer(msg.response.response);
  } else if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
    current?.cancel();
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { still_queued: [] } } });
  }
});
rl.on("close", async () => {
  while (current) await sleep(10);
  process.exit(0);
});
