#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format stream-json --include-partial-messages`,
// emitting the same shapes Claude Code 2.1.303 does. What a prompt does depends on its text:
//   "env NAME"   replies with the value of $NAME, through a Bash tool call
//   "slow"       streams a word every 50ms for ~10s, so it can be interrupted
//   "/model X"   switches the model, with a synthetic reply and a 0-turn result
//   "crash"      writes to stderr and exits 3
//   "signed out" answers with an error result, as Claude does without a login
//   anything else is echoed back as "You said: …"
// Prompts carrying a uuid are echoed back as `isReplay` user messages, as with --replay-user-messages, and every
// assistant message has a uuid. A `rewind_files` control request is answered with success, or with an error for a uuid
// the session never saw. --resume-session-at <uuid> keeps only the messages up to that one.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

// --resume <id> continues that session; with --fork-session it gets a new id instead.
const args = process.argv.slice(2);
const resumed = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : undefined;
const session_id = resumed && !args.includes("--fork-session") ? resumed : randomUUID();
let model = "claude-sonnet-5-5";
let total = 0;
let msgN = 0;
const queue = [];
const seen = new Set(); // uuids of the prompts this process has been sent
const resumeAt = args.includes("--resume-session-at") ? args[args.indexOf("--resume-session-at") + 1] : undefined;
let current; // { cancel(): void }

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

async function turn(text) {
  let cancelled = false;
  current = { cancel: () => (cancelled = true) };
  const start = Date.now();
  out({ type: "system", subtype: "init", cwd: process.cwd(), session_id, model, tools: ["Bash", "Read"], permissionMode: "bypassPermissions", slash_commands: ["compact", "model", "context"] });

  if (text.startsWith("/model ")) {
    model = `claude-${text.slice(7).trim()}-5-5`;
    out({ type: "assistant", message: { model: "<synthetic>", id: randomUUID(), type: "message", role: "assistant", content: [{ type: "text", text: `Set model to ${model}` }] }, parent_tool_use_id: null, session_id, uuid: randomUUID() });
    return result(start, { cost: 0, num_turns: 0 });
  }
  if (text === "crash") {
    process.stderr.write("Error: something broke inside Claude\n");
    process.exit(3);
  }
  if (text === "signed out") {
    out({ type: "assistant", message: { model: "<synthetic>", id: randomUUID(), type: "message", role: "assistant", content: [{ type: "text", text: "Invalid API key · Please run /login" }] }, parent_tool_use_id: null, session_id, uuid: randomUUID() });
    return result(start, { is_error: true, text: "Invalid API key · Please run /login", cost: 0 });
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

  if (text === "where") {
    await streamText(id, `resumed at ${resumeAt ?? "nothing"}`, 0, () => cancelled);
    return result(start, { text: "where" });
  }

  const reply = `You said: ${text}`;
  await streamText(id, reply, 0, () => cancelled);
  return result(start, { text: reply });
}

async function pump() {
  if (current) return;
  while (queue.length) await turn(queue.shift());
  current = undefined;
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === "user") {
    const text = msg.message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    if (msg.uuid) {
      seen.add(msg.uuid);
      out({ type: "user", message: msg.message, parent_tool_use_id: null, session_id, uuid: msg.uuid, isReplay: true });
    }
    queue.push(text);
    void pump();
  } else if (msg.type === "control_request" && msg.request?.subtype === "rewind_files") {
    const ok = seen.has(msg.request.user_message_id);
    out({
      type: "control_response",
      response: ok
        ? { subtype: "success", request_id: msg.request_id, response: { canRewind: true, skippedLinks: 0 } }
        : { subtype: "error", request_id: msg.request_id, error: "No file checkpoint found for this message." },
    });
  } else if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
    current?.cancel();
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { still_queued: [] } } });
  }
});
rl.on("close", async () => {
  while (current) await sleep(10);
  process.exit(0);
});
