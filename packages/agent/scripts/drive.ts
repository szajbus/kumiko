// Build step 1 check: start Claude in a sandbox, hold a conversation over stream-json and print every event.
//
//   node packages/agent/dist/scripts/drive.js --sandbox <name> [--workdir /workspace] [--local]
//
// Sends two prompts (the second reads a forwarded variable through Bash), interrupts a third mid-tool-call,
// then sends a fourth to show the process is still usable. Done when all of that holds.
// --local runs `claude` on this machine through the same `bash -s` preamble, for trying it from inside a VM.
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { WORKSPACE_DIR } from "@bentomo/shared";
import { execScript, LimaProvider, MetadataStore } from "@bentomo/sandbox";
import { ClaudeDriver, type AgentMessage, type Exec } from "../src/index.js";

const { values } = parseArgs({
  options: {
    sandbox: { type: "string" },
    workdir: { type: "string" },
    local: { type: "boolean", default: false },
  },
});
if (!values.sandbox && !values.local) {
  console.error("usage: drive.js --sandbox <name> [--workdir <path>] [--local]");
  process.exit(2);
}

const token = `drive-${Math.random().toString(36).slice(2)}`;
process.env.BENTOMO_DRIVE_TOKEN = token;

let exec: Exec;
let workdir = values.workdir;
if (values.local) {
  exec = (_s, cmd, env, o = {}) => {
    const child = spawn("bash", ["-s"], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin!.write(execScript(cmd, env, process.env, o.cwd));
    return child;
  };
  workdir ??= process.cwd();
} else {
  const provider = new LimaProvider();
  exec = provider.exec.bind(provider);
  workdir ??= (await new MetadataStore().read(values.sandbox!))?.spec.workdir ?? WORKSPACE_DIR;
}

const driver = new ClaudeDriver(exec);
const results: AgentMessage[] = [];
const messages: AgentMessage[] = [];
let interruptSent = false;
let next: (() => void) | undefined;

/** One line per event; stream deltas are summarised so the output stays readable. */
function show(m: AgentMessage) {
  if (m.type === "stream_event") {
    const e = m.event as { type: string; delta?: { type: string; text?: string; thinking?: string; partial_json?: string } };
    const d = e.delta;
    if (d?.type === "text_delta") return process.stdout.write(d.text ?? "");
    if (d?.type === "thinking_delta") return process.stdout.write(`\x1b[2m${d.thinking ?? ""}\x1b[0m`);
    if (e.type === "message_stop") return process.stdout.write("\n");
    return;
  }
  const sub = typeof m.subtype === "string" ? `/${m.subtype}` : "";
  console.log(`\x1b[36m[${m.type}${sub}]\x1b[0m ${JSON.stringify(m).slice(0, 240)}`);
}

driver.onEvent((ev) => {
  if (ev.kind === "error") console.log(`\x1b[31m[error] ${ev.message}${ev.hint ? ` (${ev.hint})` : ""}\x1b[0m${ev.stderr ? `\n${ev.stderr.join("\n")}` : ""}`);
  if (ev.kind === "exit") console.log(`[exit ${ev.code}${ev.requested ? ", requested" : ""}]`);
  if (ev.kind !== "message") return;
  const m = ev.payload;
  messages.push(m);
  show(m);
  if (m.type === "result") {
    results.push(m);
    next?.();
  }
  // Interrupt the third turn once its tool call is under way.
  if (results.length === 2 && !interruptSent && m.type === "assistant" && JSON.stringify(m).includes('"tool_use"')) {
    interruptSent = true;
    setTimeout(() => {
      console.log("\x1b[33m>>> interrupt\x1b[0m");
      driver.interrupt();
    }, 1500);
  }
});

const turn = (prompt: string, first = false) =>
  new Promise<void>((resolve) => {
    next = resolve;
    console.log(`\x1b[33m>>> ${prompt}\x1b[0m`);
    if (first) driver.start({ sandbox: values.sandbox ?? "local", workdir: workdir!, env: ["BENTOMO_DRIVE_TOKEN"], prompt });
    else driver.send(prompt);
  });

const checks: [string, boolean][] = [];
try {
  await turn("Say hi in three words.", true);
  await turn("Run `echo $BENTOMO_DRIVE_TOKEN` with Bash and reply with its output only.");
  await turn("Run `sleep 30 && echo finished` with Bash, then say done.");
  await turn("Reply with just the word ok.");
} finally {
  await driver.stop();
}

const toolResults = messages.filter((m) => m.type === "user").map((m) => JSON.stringify(m)).join("\n");
checks.push(["both turns complete", results[0]?.subtype === "success" && results[1]?.subtype === "success"]);
checks.push(["a forwarded variable is visible to Claude", toolResults.includes(token)]);
checks.push(["the interrupt ends the third turn early", interruptSent && results[2]?.subtype !== "success"]);
checks.push(["the process is usable after the interrupt", results[3]?.subtype === "success"]);
console.log();
for (const [what, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${what}`);
const ok = checks.every(([, v]) => v);
console.log(ok ? "\ndrive OK" : "\ndrive FAILED");
process.exit(ok ? 0 : 1);
