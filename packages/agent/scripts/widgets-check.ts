// Checks the tools the driver hosts for Claude against a real Claude: in a project's sandbox, or with --local on this
// machine, through the same run (FIFO and log) either way.
//
//   node packages/agent/dist/scripts/widgets-check.js --sandbox <name> [--workdir <path>] [--local]
//
// 1. Claude calls a tool that is always loaded.
// 2. It calls a deferred one; says whether it loaded it with its tool search first.
// 3. A call is under way when the driver detaches; another driver attaches and answers it.
// 4. Claude writes a file under its Claude home, then changes it; rewinding the files of the second prompt says
//    whether Claude's checkpoints cover that folder.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { WORKSPACE_DIR } from "@kumiko/shared";
import { execScript, LimaProvider, MetadataStore } from "@kumiko/sandbox";
import { ClaudeDriver, execOutput, type AgentEvent, type AgentMessage, type Exec, type ToolHost } from "../src/index.js";

const { values } = parseArgs({
  options: {
    sandbox: { type: "string" },
    workdir: { type: "string" },
    local: { type: "boolean", default: false },
  },
});
if (!values.sandbox && !values.local) {
  console.error("usage: widgets-check.js --sandbox <name> [--workdir <path>] [--local]");
  process.exit(2);
}

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
const sandbox = values.sandbox ?? "local";

/** Tools that record their calls; `wait` answers only once let go of. */
const calls: string[] = [];
let release: (() => void) | undefined;
const tools: ToolHost = {
  list: () => [
    { name: "echo", description: "Echoes text back, prefixed with 'echo:'.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, alwaysLoad: true },
    { name: "later", description: "Echoes text back, prefixed with 'later:'. Loaded on demand.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "wait", description: "Waits for the user, then says 'waited'.", inputSchema: { type: "object", properties: {} }, alwaysLoad: true },
  ],
  async call(name, args) {
    calls.push(name);
    if (name === "wait") await new Promise<void>((r) => (release = r));
    return { text: `${name === "wait" ? "waited" : `${name}: ${String(args.text)}`}` };
  },
};

const messages: AgentMessage[] = [];
let results = 0;
let next: (() => void) | undefined;
const listen = (ev: AgentEvent) => {
  if (ev.kind === "error") console.log(`\x1b[31m[error] ${ev.message}\x1b[0m${ev.stderr ? `\n${ev.stderr.join("\n")}` : ""}`);
  if (ev.kind === "exit") console.log(`[exit ${ev.code}]`);
  if (ev.kind !== "message") return;
  const m = ev.payload;
  messages.push(m);
  if (m.type === "assistant") {
    for (const b of (m.message as { content?: { type: string; name?: string; input?: unknown; text?: string }[] }).content ?? []) {
      if (b.type === "tool_use") console.log(`\x1b[36m[tool_use]\x1b[0m ${b.name} ${JSON.stringify(b.input).slice(0, 160)}`);
      if (b.type === "text") console.log(`\x1b[2m${b.text}\x1b[0m`);
    }
  }
  if (m.type === "result") {
    results++;
    next?.();
  }
};

let driver = new ClaudeDriver(exec);
driver.onEvent(listen);
const turn = (prompt: string, opts: { first?: boolean; id?: string } = {}) =>
  new Promise<void>((resolve) => {
    next = resolve;
    console.log(`\x1b[33m>>> ${prompt}\x1b[0m`);
    if (opts.first) driver.start({ sandbox, workdir: workdir!, env: [], prompt, promptId: opts.id, tools });
    else driver.send(prompt, opts.id);
  });
const usedSince = (from: number, name: string) =>
  messages.slice(from).some((m) => m.type === "assistant" && JSON.stringify(m.message).includes(`"name":"${name}"`));
const resultText = () => String(messages.findLast((m) => m.type === "result")?.result ?? "");

const checks: [string, boolean][] = [];
const notes: string[] = [];
const token = randomUUID().slice(0, 8);
const file = `$HOME/.claude/kumiko/widgets-check-${token}.md`;
try {
  await turn("Call the mcp__kumiko__echo tool with the text 'one', then reply with exactly what it returned.", { first: true });
  checks.push(["an always-loaded tool is called", calls.includes("echo") && resultText().includes("echo: one")]);

  let from = messages.length;
  await turn("Call the kumiko tool named `later` with the text 'two', then reply with exactly what it returned.");
  checks.push(["a deferred tool is called", calls.includes("later") && resultText().includes("later: two")]);
  notes.push(usedSince(from, "ToolSearch") ? "the deferred tool was loaded with ToolSearch first" : "the deferred tool was called without ToolSearch: tool search may be off here");

  // Detaches while the call waits, as a server going away does; the next driver answers it.
  from = messages.length;
  const waiting = turn("Call the mcp__kumiko__wait tool, then reply with exactly what it returned.");
  for (let i = 0; !calls.includes("wait") && i < 600; i++) await new Promise((r) => setTimeout(r, 100));
  await driver.detach();
  const pending = driver.pendingCalls();
  const at = driver.position()!;
  release?.();
  console.log(`\x1b[33m>>> detached with ${pending.length} call(s) pending; attaching another driver\x1b[0m`);
  calls.length = 0;
  driver = new ClaudeDriver(exec);
  driver.onEvent(listen);
  driver.attach({ sandbox, ...at, tools, pending });
  for (let i = 0; !calls.includes("wait") && i < 100; i++) await new Promise((r) => setTimeout(r, 100));
  release?.();
  await waiting;
  checks.push(["a call pending across a detach is answered by the next driver", pending.length === 1 && resultText().includes("waited")]);

  const p2 = randomUUID();
  await turn(`Run \`mkdir -p ~/.claude/kumiko && printf A > ${file}\` with Bash. Then reply ok.`);
  await turn(`Use your Write tool to replace the whole contents of the file ${file.replace("$HOME", (await execOutput(exec, sandbox, `printf %s "$HOME"`)).trim())} with the single letter B. Then reply ok.`, { id: p2 });
  const before = (await execOutput(exec, sandbox, `cat ${file}`)).trim();
  let restored = "";
  try {
    await driver.rewindFiles(p2);
    restored = (await execOutput(exec, sandbox, `cat ${file}`)).trim();
  } catch (err) {
    restored = `(rewind failed: ${err instanceof Error ? err.message : String(err)})`;
  }
  notes.push(`a file under ~/.claude written by Write was "${before}", and after rewinding its prompt "${restored}": ${restored === "A" ? "checkpoints cover the Claude home" : "checkpoints don't cover it, so Kumiko writes documents back itself"}`);
} finally {
  await execOutput(exec, sandbox, `rm -f ${file}`).catch(() => {});
  await driver.stop();
}

console.log();
for (const [what, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${what}`);
for (const n of notes) console.log(`· ${n}`);
const ok = checks.every(([, v]) => v);
console.log(ok ? "\nwidgets-check OK" : "\nwidgets-check FAILED");
process.exit(ok ? 0 : 1);
