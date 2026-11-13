#!/usr/bin/env node
// Takes the docs' screenshots of the real UI, against the fake limactl, ssh and claude the tests use, so they can be
// taken again whenever the UI changes. Needs the app built (npm run build) and a headless Chrome.
//   node apps/docs/scripts/screenshots.mjs
// DEMO_ROOT is where the demo's clones and Kumiko home go, and shows in the screenshots; it defaults to /Users/you,
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
const code = join(root, "code");
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

/** A clone with a remote and three worktrees: one merged, one with uncommitted changes, one with unpushed commits. */
function makeRepos() {
  for (const name of ["code", ".kumiko", "origin.git", "github", "gh"]) rmSync(join(root, name), { recursive: true, force: true });
  mkdirSync(code, { recursive: true });
  git(root, "init", "-q", "--bare", "origin.git");
  git(code, "clone", "-q", join(root, "origin.git"), "webshop");
  const shop = join(code, "webshop");
  writeFileSync(join(shop, "README.md"), "# webshop\n");
  git(shop, "add", ".");
  git(shop, "commit", "-qm", "Start the shop");
  git(shop, "branch", "-M", "main");
  git(shop, "push", "-q", "origin", "main");
  git(shop, "remote", "set-head", "origin", "main");
  const wt = (branch) => join(code, "webshop__worktrees", branch);
  git(shop, "worktree", "add", "-q", wt("fix-cart-total"), "-b", "fix-cart-total");
  writeFileSync(join(wt("fix-cart-total"), "cart.ts"), "// fixed\n");
  git(wt("fix-cart-total"), "add", ".");
  git(wt("fix-cart-total"), "commit", "-qm", "Fix the cart total");
  git(wt("fix-cart-total"), "push", "-q", "-u", "origin", "fix-cart-total");
  git(shop, "merge", "-q", "--ff-only", "fix-cart-total");
  git(shop, "push", "-q", "origin", "main");
  git(shop, "worktree", "add", "-q", wt("add-checkout"), "-b", "add-checkout");
  writeFileSync(join(wt("add-checkout"), "checkout.tsx"), "// checkout\n");
  git(wt("add-checkout"), "add", ".");
  git(wt("add-checkout"), "commit", "-qm", "Add the checkout page");
  writeFileSync(join(wt("add-checkout"), "checkout.tsx"), "// checkout, more\n");
  git(shop, "worktree", "add", "-q", wt("dark-mode"), "-b", "dark-mode");
  git(wt("dark-mode"), "commit", "-q", "--allow-empty", "-m", "Dark mode");
  git(wt("dark-mode"), "commit", "-q", "--allow-empty", "-m", "Tweak dark mode");
  for (const name of ["api-server", "docs-site"]) {
    git(code, "init", "-q", name);
    git(join(code, name), "commit", "-q", "--allow-empty", "-m", "Start");
  }
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
  const shop = join(code, "webshop");
  const wt = join(code, "webshop__worktrees", "add-checkout");
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
  tool("Bash", { command: `git worktree add "${wt}" -b add-checkout`, description: "Create a worktree for the checkout page" }, "Preparing worktree (new branch 'add-checkout')");
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

  const info = {
    id, sandbox: "webshop", workdir: shop, status: "ended", prompt: "Add a checkout page in a worktree, with tests for the cart total",
    model: "claude-opus-5-5", defaultModel: "claude-opus-5-5", startedAt: new Date(Date.now() - 600_000).toISOString(), updatedAt: new Date().toISOString(),
    claudeSessionId: claudeId, commands: ["compact", "model", "context", "review", "init"],
  };
  mkdirSync(join(kumikoHome, "sessions"), { recursive: true });
  writeFileSync(join(kumikoHome, "sessions", `${id}.json`), JSON.stringify({ info, events }));
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

makeRepos();
const mirrored = makeGitHub();
const lima = mkdtempSync(join(tmpdir(), "kumiko-demo-lima-"));
const fixtures = join(repo, "packages/sandbox/fixtures");
const server = spawn(process.execPath, [join(repo, "packages/server/dist/src/main.js"), "--port", String(port)], {
  env: { ...process.env, FAKE_LIMA_DIR: lima, FAKE_LIMA_DELAY: "50", KUMIKO_LIMACTL: join(fixtures, "fake-limactl.mjs"), KUMIKO_SSH: join(fixtures, "fake-ssh.sh"), KUMIKO_HOME: kumikoHome, KUMIKO_TOKEN: token, GITHUB_TOKEN: "demo",
    KUMIKO_GH: join(repo, "packages/server/fixtures/fake-gh.mjs"), FAKE_GH_DIR: join(root, "gh"), KUMIKO_GITHUB_URL: `file://${join(root, "github")}` },
  stdio: "inherit",
});
const browser = chrome();

try {
  await waitFor(() => fetch(`${api}/projects`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.ok), "the server");
  const project = (name, cpus, memoryGiB, env, provision) =>
    call("POST", "/projects", { clonePath: join(code, name), name, template: "template:debian-12", cpus, memoryGiB, diskGiB: 100, mounts: [], env, provision });
  await project("webshop", 4, 8, ["GITHUB_TOKEN"], "sudo apt-get update\nsudo apt-get install -y nodejs npm");
  await project("api-server", 4, 4, ["GITHUB_TOKEN"], "");
  await project("docs-site", 2, 4, [], "");
  const ready = async () => (await call("GET", "/projects")).every((p) => p.status === "running" && p.meta?.setup === "ready");
  await waitFor(ready, "the sandboxes");
  await call("POST", "/projects/docs-site/stop");

  // The fake curl installed a claude that only prints its version; sessions need the fake one.
  const bin = join(lima, "vm-home/.local/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(repo, "packages/agent/fixtures/fake-claude.mjs")}" "$@"\n`);
  chmodSync(join(bin, "claude"), 0o755);

  for (const r of mirrored) await call("POST", "/mirrors", { repo: r, private: r.startsWith("you/") });
  await waitFor(async () => (await call("GET", "/mirrors")).mirrors.every((m) => m.state === "ready"), "the mirrors");

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
  const shot = async (name, hash, height, active = "projects") => {
    await tabs(active);
    execFileSync(browser, ["--headless", "--no-sandbox", "--hide-scrollbars", `--window-size=1280,${height}`, "--virtual-time-budget=10000", `--screenshot=${join(out, `${name}.png`)}`, `${api}/login?token=${token}${hash}`], { stdio: "ignore" });
    console.log(`${name}.png`);
  };
  await shot("projects", "#/", 440);
  await shot("new-project", "#/new", 1400);
  await shot("repos", "#/repos", 470);
  await shot("session", `#/session/${seeded}`, 800, `session:${seeded}`);
} finally {
  server.kill();
  rmSync(lima, { recursive: true, force: true });
}
