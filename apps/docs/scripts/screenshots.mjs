#!/usr/bin/env node
// Takes the docs' screenshots of the real UI, against the fake limactl, ssh and claude the tests use, so they can be
// taken again whenever the UI changes. Needs the app built (npm run build) and a headless Chrome.
//   node apps/docs/scripts/screenshots.mjs
// DEMO_ROOT is where the demo's GitHub stand-in and Kumiko home go, and shows in the screenshots; it defaults to /Users/you,
// which has to exist and be writable (sudo mkdir /Users/you && sudo chown $USER /Users/you). CHROME names the browser;
// by default Playwright's headless shell, then Google Chrome. Screenshots land in apps/docs/src/assets/screenshots.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = join(repo, "apps/docs/src/assets/screenshots");
const root = process.env.DEMO_ROOT ?? "/Users/you";
const kumikoHome = join(root, ".kumiko");
const port = Number(process.env.KUMIKO_PORT ?? 4319);
const api = `http://127.0.0.1:${port}/api`;
const token = randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  accessSync(root, constants.W_OK);
} catch {
  console.error(`${root} must exist and be writable, or set DEMO_ROOT.`);
  process.exit(1);
}

function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  for (const dir of existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell")).sort().reverse() : []) {
    for (const sub of readdirSync(join(cache, dir))) {
      const bin = join(cache, dir, sub, "chrome-headless-shell");
      if (existsSync(bin)) return bin;
    }
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(mac)) return mac;
  console.error("No headless Chrome found; set CHROME.");
  process.exit(1);
}

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=demo@example.com", "-c", "user.name=Demo", ...args], { cwd, stdio: "pipe" });

/** A repository with one commit, which the stand-in GitHub's repositories are copies of. */
function makeOrigin() {
  for (const name of [".kumiko", "origin.git", "github", "gh", "seed"]) rmSync(join(root, name), { recursive: true, force: true });
  git(root, "init", "-q", "--bare", "origin.git");
  git(root, "clone", "-q", join(root, "origin.git"), "seed");
  const seed = join(root, "seed");
  writeFileSync(join(seed, "README.md"), "# webshop\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "Start the shop");
  git(seed, "branch", "-M", "main");
  git(seed, "push", "-q", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
}

async function call(method, path, body) {
  const res = await fetch(api + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${json.error}`);
  return json;
}

async function waitFor(check, what) {
  for (let i = 0; i < 100; i++) {
    if (await check().catch(() => false)) return;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/** A saved session with a believable conversation; the fake claude can only echo, which makes for a poor picture. */
function seedSession(id) {
  const claudeId = randomUUID();
  const wt = "/workspace/webshop__worktrees/add-checkout";
  const events = [];
  const add = (kind, payload) => events.push({ kind, payload, seq: events.length + 1 });
  const base = { parent_tool_use_id: null, session_id: claudeId };
  let messages = 0;
  let tools = 0;
  const prompt = (text) => {
    const uuid = randomUUID();
    add("user_prompt", { text, id: uuid });
    add("claude", { type: "user", message: { role: "user", content: [{ type: "text", text }] }, ...base, uuid, isReplay: true });
  };
  const assistant = (content) =>
    add("claude", { type: "assistant", message: { model: "claude-opus-5-5", id: `msg_${++messages}`, type: "message", role: "assistant", content }, ...base, uuid: randomUUID() });
  // `structured` is the tool_use_result Claude sends beside a result, as for a file edit.
  const tool = (name, input, output, structured) => {
    const id = `toolu_${++tools}`;
    assistant([{ type: "tool_use", id, name, input }]);
    add("claude", { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] }, ...base, uuid: randomUUID(), ...(structured ? { tool_use_result: structured } : {}) });
  };
  const write = (path, content) => tool("Write", { file_path: path, content }, `File created successfully at: ${path}`, { type: "create", structuredPatch: [], userModified: false });
  const result = (ms, cost, output, cached) =>
    add("claude", { type: "result", subtype: "success", is_error: false, duration_ms: ms, num_turns: 6, result: "", ...base, total_cost_usd: cost, usage: { input_tokens: 1200, output_tokens: output, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 } });

  prompt("Add a checkout page in a worktree, with tests for the cart total");
  assistant([{ type: "text", text: "This changes code, so I'll work in a worktree." }]);
  tool("Bash", { command: `git -C /workspace/webshop worktree add ${wt} -b add-checkout`, description: "Create a worktree for the checkout page" }, "Preparing worktree (new branch 'add-checkout')");
  tool("Read", { file_path: `${wt}/src/cart.ts` }, "export function cartTotal(items: Item[]) { … }");
  tool(
    "Edit",
    { file_path: `${wt}/src/cart.ts`, old_string: "    total = applyDiscount(total + line, discount);", new_string: "    total += line;", replace_all: false },
    `The file ${wt}/src/cart.ts has been updated successfully.`,
    {
      structuredPatch: [{ oldStart: 9, oldLines: 7, newStart: 9, newLines: 7, lines: [" export function cartTotal(items: Item[], discount?: Discount) {", "   let total = 0;", "   for (const line of items.map(lineTotal)) {", "-    total = applyDiscount(total + line, discount);", "+    total += line;", "   }", "-  return total;", "+  return applyDiscount(total, discount);", " }"] }],
      userModified: false,
      replaceAll: false,
    },
  );
  write(`${wt}/src/pages/checkout.tsx`, 'import { cartTotal } from "../cart";\nimport { useCart } from "../useCart";\n\nexport function Checkout() {\n  const { items, discount } = useCart();\n  return (\n    <main>\n      <h1>Checkout</h1>\n      <ul>\n        {items.map((i) => (\n          <li key={i.id}>{i.name} × {i.quantity}</li>\n        ))}\n      </ul>\n      <p>Total: {formatPrice(cartTotal(items, discount))}</p>\n      <button type="submit">Pay</button>\n    </main>\n  );\n}\n');
  write(`${wt}/test/cart.test.ts`, 'import { cartTotal } from "../src/cart";\n\ntest("cart total sums line items", () => {\n  expect(cartTotal([item(2, 300), item(1, 150)])).toBe(750);\n});\n\ntest("cart total applies the discount once", () => {\n  expect(cartTotal([item(2, 300), item(1, 150)], percent(10))).toBe(675);\n});\n');
  tool("Bash", { command: "npm test", description: "Run the tests" }, "✓ cart total sums line items\n✓ cart total applies the discount once\n✓ checkout shows the total\n\nTests: 3 passed, 3 total");
  assistant([{ type: "text", text: "Done, in `add-checkout`:\n\n- **`src/pages/checkout.tsx`**: the checkout page, with the cart's lines, the total and a **Pay** button.\n- **`src/cart.ts`**: the discount is applied once, to the total, rather than to every line.\n- **`test/cart.test.ts`**: tests for the total, including the discount.\n\nAll 3 tests pass. I haven't committed yet; shall I?" }]);
  result(84000, 0.42, 3400, 48000);
  prompt("Yes, commit it and push the branch");
  tool("Bash", { command: 'git add -A && git commit -m "Add the checkout page, with tests for the cart total"', description: "Commit" }, "[add-checkout 44e8d69] Add the checkout page, with tests for the cart total");
  tool("Bash", { command: "git push -u origin add-checkout", description: "Push the branch" }, "branch 'add-checkout' set up to track 'origin/add-checkout'.");
  assistant([{ type: "text", text: "Committed and pushed `add-checkout`. Open a pull request from it when you're ready." }]);
  result(21000, 0.51, 600, 4000);
  // A turn with Kumiko's own tools, which the screenshot shows unfolded: delivering, then reading CI.
  prompt("Open a pull request, and tell me how CI does");
  tool("ToolSearch", { query: "select:mcp__kumiko__deliver,mcp__kumiko__github_api_get,mcp__kumiko__github_run_logs", max_results: 3 }, "Loaded 3 tools.");
  tool("mcp__kumiko__deliver", { branch: "add-checkout", title: "Add the checkout page", body: "The checkout page, and the discount applied once, to the total." }, "Opened PR #12 (https://github.com/you/webshop/pull/12).");
  tool("mcp__kumiko__github_api_get", { path: "actions/runs?branch=add-checkout&per_page=1" }, '{"total_count":1,"workflow_runs":[{"id":4211,"name":"Test","status":"completed","conclusion":"failure"}]}');
  tool("mcp__kumiko__github_run_logs", { run_id: 4211 }, "Run 4211: Test · Add the checkout page\nStatus: completed · failure\nJobs:\n- lint (job 9031): failure; failed: step 3 \"Run eslint\"\n\n=== lint / Run eslint ===\nsrc/pages/checkout.tsx\n  14:18  error  'formatPrice' is not defined  no-undef");
  assistant([{ type: "text", text: "Opened [PR #12](https://github.com/you/webshop/pull/12). CI fails on lint: `checkout.tsx` uses `formatPrice` without importing it. The tests pass. Shall I add the import and push?" }]);
  result(32000, 0.18, 900, 6000);

  const info = {
    id, sandbox: "webshop", workdir: "/workspace", status: "ended", prompt: "Add a checkout page in a worktree, with tests for the cart total",
    model: "claude-opus-5-5", defaultModel: "claude-opus-5-5", startedAt: new Date(Date.now() - 600_000).toISOString(), updatedAt: new Date().toISOString(),
    claudeSessionId: claudeId, commands: ["compact", "model", "context", "review", "init"],
  };
  mkdirSync(join(kumikoHome, "sessions"), { recursive: true });
  writeFileSync(join(kumikoHome, "sessions", `${id}.json`), JSON.stringify({ info, events }));
}

/**
 * Opens a page in a headless Chrome driven over its DevTools protocol, for a screenshot that needs the page acted on
 * first (`act` gets `eval`, which runs an expression in the page), then saves it as `name`.png.
 */
async function drive(browser, url, width, height, file, act) {
  const chrome = spawn(browser, ["--headless", "--no-sandbox", "--hide-scrollbars", "--remote-debugging-port=0", `--window-size=${width},${height}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const wsBrowser = await new Promise((resolve, reject) => {
      let err = "";
      chrome.stderr.on("data", (d) => {
        err += d;
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m) resolve(m[1]);
      });
      chrome.on("exit", () => reject(new Error(`Chrome exited: ${err.trim().split("\n").at(-1)}`)));
    });
    const port = new URL(wsBrowser).port;
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    let next = 0;
    const waiting = new Map();
    const loaded = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id !== undefined) {
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
      } else if (msg.method === "Page.loadEventFired") loaded.splice(0).forEach((r) => r());
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++next;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const load = new Promise((r) => loaded.push(r));
    await send("Page.navigate", { url });
    await load;
    // The app loads its data after the page does.
    await sleep(2500);
    await act({
      eval: async (expression) => {
        const r = await send("Runtime.evaluate", { expression, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(`In the page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
        return r.result.value;
      },
    });
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(data, "base64"));
    ws.close();
  } finally {
    chrome.kill();
  }
}

/** A stand-in GitHub, a folder of bare repositories, and a fake gh signed in to it, for the Repos page. */
function makeGitHub() {
  const repos = [
    { full_name: "you/webshop", private: true, description: "The shop", pushed_at: "2026-11-01T10:00:00Z" },
    { full_name: "you/api-server", private: true, description: "Orders and payments API", pushed_at: "2026-10-20T10:00:00Z" },
    { full_name: "acme/design-tokens", private: false, description: "Colours and type", pushed_at: "2026-09-01T10:00:00Z" },
  ];
  for (const r of repos) {
    mkdirSync(join(root, "github", dirname(r.full_name)), { recursive: true });
    git(root, "clone", "-q", "--bare", join(root, "origin.git"), join(root, "github", `${r.full_name}.git`));
  }
  mkdirSync(join(root, "gh"), { recursive: true });
  writeFileSync(join(root, "gh", "user.json"), JSON.stringify({ login: "you", name: "You" }));
  writeFileSync(join(root, "gh", "repos.json"), JSON.stringify(repos.map((r) => ({ ...r, fork: false, archived: false }))));
  return repos.map((r) => r.full_name);
}

makeOrigin();
const mirrored = makeGitHub();
const lima = mkdtempSync(join(tmpdir(), "kumiko-demo-lima-"));
const fixtures = join(repo, "packages/sandbox/fixtures");
const server = spawn(process.execPath, [join(repo, "packages/server/dist/src/main.js"), "--port", String(port)], {
  env: { ...process.env, FAKE_LIMA_DIR: lima, FAKE_LIMA_DELAY: "50", KUMIKO_LIMACTL: join(fixtures, "fake-limactl.mjs"), KUMIKO_SSH: join(fixtures, "fake-ssh.sh"), KUMIKO_HOME: kumikoHome, KUMIKO_TOKEN: token, NPM_TOKEN: "demo",
    KUMIKO_GH: join(repo, "packages/server/fixtures/fake-gh.mjs"), FAKE_GH_DIR: join(root, "gh"), KUMIKO_GITHUB_URL: `file://${join(root, "github")}` },
  stdio: "inherit",
});
const browser = chrome();

try {
  await waitFor(() => fetch(`${api}/sandboxes`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.ok), "the server");
  for (const r of mirrored) await call("POST", "/mirrors", { repo: r, private: r.startsWith("you/") });
  await waitFor(async () => (await call("GET", "/mirrors")).mirrors.every((m) => m.state === "ready"), "the mirrors");

  // The fake VMs share one home and one /workspace: each sandbox's repos are cloned before the next one's git is set up,
  // and no two sandboxes have the same repo.
  const ready = async (name) => {
    const p = (await call("GET", "/sandboxes")).find((x) => x.name === name);
    return p?.status === "running" && p.meta?.setup === "ready" && p.repos.every((r) => r.state === "cloned");
  };
  const sandbox = async (name, repos, cpus, memoryGiB, env, provision) => {
    await call("POST", "/sandboxes", { name, repos, template: "template:debian-12", cpus, memoryGiB, diskGiB: 100, workspaceGiB: 50, mounts: [], env, provision });
    await waitFor(() => ready(name), `the sandbox ${name}`).catch(async (err) => {
      throw new Error(`${err.message} Its repos: ${JSON.stringify((await call("GET", "/sandboxes")).find((x) => x.name === name)?.repos)}`);
    });
  };
  await sandbox("api-server", ["you/api-server", "acme/design-tokens"], 4, 4, [], "");
  await sandbox("docs-site", [], 2, 4, [], "");
  await sandbox("webshop", ["you/webshop"], 4, 8, ["NPM_TOKEN"], "sudo apt-get update\nsudo apt-get install -y nodejs npm");
  await call("POST", "/sandboxes/docs-site/stop");

  // The fake curl installed a claude that only prints its version; sessions need the fake one.
  const bin = join(lima, "vm-home/.local/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(repo, "packages/agent/fixtures/fake-claude.mjs")}" "$@"\n`);
  chmodSync(join(bin, "claude"), 0o755);

  const seeded = "0a1b2c3d4e5f";
  seedSession(seeded);
  const other = (await call("POST", "/sessions", { sandbox: "webshop", prompt: "Why does the dark-mode branch have two commits?" })).id;
  const waiting = (await call("POST", "/sessions", { sandbox: "api-server", prompt: "Find why /orders is slow under load" })).id;
  await call("POST", `/sessions/${seeded}/resume`);
  await sleep(1500);
  await call("POST", `/sessions/${other}/seen`);
  const sessions = [seeded, other, waiting];
  const tabs = (active) => call("PUT", "/tabs", { sessions, newSessions: [], active, order: sessions.map((s) => `session:${s}`) });

  mkdirSync(out, { recursive: true });
  const shot = async (name, hash, height, active = "sandboxes") => {
    await tabs(active);
    execFileSync(browser, ["--headless", "--no-sandbox", "--hide-scrollbars", `--window-size=1280,${height}`, "--virtual-time-budget=10000", `--screenshot=${join(out, `${name}.png`)}`, `${api}/login?token=${token}${hash}`], { stdio: "ignore" });
    console.log(`${name}.png`);
  };
  const driven = (name, hash, height, act) => drive(browser, `${api}/login?token=${token}${hash}`, 1280, height, join(out, `${name}.png`), act);
  await shot("sandboxes", "#/", 440);
  await shot("new-sandbox", "#/new", 1400);
  await shot("repos", "#/repos", 470);
  await tabs(`session:${seeded}`);
  await driven("session", `#/session/${seeded}`, 800, async (page) => {
    // The last turn's work unfolded, to show its tool calls; then the chat scrolled to its end again.
    await page.eval(`document.querySelectorAll(".work-summary")[document.querySelectorAll(".work-summary").length - 1].click()`);
    await sleep(800);
    await page.eval(`(() => { const c = document.querySelector(".chat"); c.scrollTop = c.scrollHeight; })()`);
    await sleep(300);
  });
  console.log("session.png");
} finally {
  server.kill();
  rmSync(lima, { recursive: true, force: true });
}
