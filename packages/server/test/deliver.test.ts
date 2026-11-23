import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import { REVIEW, type ApprovalCard, type ReviewDiff, type SandboxView, type SessionEvent, type SessionInfo, type SessionStreamMessage, type WindowState } from "@kumiko/shared";
import { LimaProvider, MetadataStore, shellQuote } from "@kumiko/sandbox";
import { startServer, type RunningServer } from "../src/index.js";
import { fakeGitHub, type FakeGitHub } from "./github.js";
import { sh } from "./repo.js";
import { shortTmp } from "./tmp.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../../../sandbox/fixtures");
const fakeClaude = resolve(here, "../../../agent/fixtures/fake-claude.mjs");
const fakeGh = resolve(here, "../../fixtures/fake-gh.mjs");

describe("delivering from a session", () => {
  let server: RunningServer;
  let root: string;
  let github: FakeGitHub;
  let bare: string;
  let work: string;
  const saved = { ...process.env };

  const api = (path: string, init: RequestInit = {}) => fetch(server.url + path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${server.token}`, ...init.headers } });
  const waitFor = async <T>(fn: () => T | undefined | Promise<T | undefined>, ms = 20_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  before(async () => {
    root = await shortTmp("kumiko-deliver-e2e-");
    const limaDir = join(root, "lima");
    const vmHome = join(limaDir, "vm-home");
    process.env.FAKE_LIMA_DIR = limaDir;
    process.env.FAKE_GH_DIR = join(root, "gh");
    // GPG with no keys: whatever the developer's own has, the commits here are unsigned.
    process.env.GNUPGHOME = join(root, "gnupg");
    await mkdir(join(root, "gnupg"), { recursive: true, mode: 0o700 });
    process.env.KUMIKO_GH = fakeGh;
    await mkdir(join(root, "gh"), { recursive: true });
    await writeFile(join(root, "gh", "user.json"), JSON.stringify({ id: 42, login: "acme" }));
    const bin = join(vmHome, ".local", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeClaude)} "$@"\n`);
    await chmod(join(bin, "claude"), 0o755);
    github = await fakeGitHub(root);
    ({ bare, work } = await github.repo("acme/widget"));
    process.env.KUMIKO_GITHUB_URL = github.url;
    const env = () => ({});
    const provider = new LimaProvider({ limactl: join(fixtures, "fake-limactl.mjs"), ssh: join(fixtures, "fake-ssh.sh"), metadata: new MetadataStore(join(root, "sandboxes")), env });
    server = await startServer({ provider, port: 0, refreshMs: 200, env, home: root, dataDir: join(root, "data"), sessionsDir: join(root, "sessions") });
    await api("/api/mirrors", { method: "POST", body: JSON.stringify({ repo: "acme/widget" }) });
    await api("/api/sandboxes", { method: "POST", body: JSON.stringify({ name: "web", repos: ["acme/widget"], cpus: 1, memoryGiB: 1, diskGiB: 10, workspaceGiB: 1, mounts: [], env: [] }) });
    // Cloned in the VM means git there reaches the mirror.
    await waitFor(async () => ((await (await api("/api/sandboxes")).json()) as SandboxView[]).find((p) => p.name === "web")?.repos[0]?.state === "cloned");
  });

  after(async () => {
    await server?.close({ endSessions: true });
    github?.close();
    process.env = saved;
    await rm(root, { recursive: true, force: true });
  });

  it("shows the card Claude waits on, and lands the branch once the user approves it over the API", async () => {
    // The agent's branch, on GitHub.
    execFileSync("git", ["-C", work, "checkout", "--quiet", "-b", "fix-x"]);
    await writeFile(join(work, "x"), "x\n");
    sh(work, "add", "x");
    sh(work, "commit", "--quiet", "-m", "Fix x\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
    sh(work, "push", "--quiet", "origin", "fix-x");
    const head = sh(work, "rev-parse", "HEAD").trim();

    const res = await api("/api/sessions", { method: "POST", body: JSON.stringify({ sandbox: "web", prompt: "hi" }) });
    const { id } = (await res.json()) as { id: string };
    await waitFor(async () => ((await (await api("/api/sessions")).json()) as SessionInfo[]).find((s) => s.id === id)?.status === "idle");
    const got: SessionEvent[] = [];
    const sock = new WebSocket(`${server.url.replace("http", "ws")}/api/sessions/${id}/events?after=0`, { headers: { authorization: `Bearer ${server.token}` } });
    sock.on("message", (m) => {
      const msg = JSON.parse(String(m)) as SessionStreamMessage;
      if (msg.kind !== "caught_up") got.push(msg);
    });
    const results = () => got.filter((e) => e.kind === "claude" && e.payload.type === "result");
    await waitFor(() => results().length >= 1);

    const prompt = `widget deliver ${JSON.stringify({ branch: "fix-x", title: "Fix x", body: "Fixes x." })}`;
    assert.equal((await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: prompt }) })).status, 202);
    const card = await waitFor(() => got.findLast((e): e is Extract<SessionEvent, { kind: "card" }> => e.kind === "card")?.payload);
    assert.equal(card.state, "open");
    assert.equal(card.card.kind === "deliver" && card.card.head, head);
    assert.equal(((await (await api("/api/sessions")).json()) as SessionInfo[]).find((s) => s.id === id)?.asking, "approval", "the tab says it waits on the user");

    const bad = await api(`/api/sessions/${id}/cards/${card.id}`, { method: "POST", body: JSON.stringify({ action: "approve", decision: { kind: "deliver", route: "sideways", method: "merge" } }) });
    assert.equal(bad.status, 400);
    // As on a machine whose git has no name or email, CI's say: the merge commit is by the user's GitHub account.
    // Only while it lands: the fake VM runs in this process's environment, with its own git config.
    const gitConfig = join(root, "no-identity.gitconfig");
    await writeFile(gitConfig, "[user]\n\tuseConfigOnly = true\n");
    const identityEnv = ["GIT_CONFIG_GLOBAL", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"] as const;
    const before = Object.fromEntries(identityEnv.map((k) => [k, process.env[k]]));
    for (const k of identityEnv) delete process.env[k];
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
    let result: SessionEvent;
    try {
      const ok = await api(`/api/sessions/${id}/cards/${card.id}`, { method: "POST", body: JSON.stringify({ action: "approve", decision: { kind: "deliver", route: "main", method: "merge" } }) });
      assert.equal(ok.status, 200, await ok.clone().text());
      assert.equal(((await ok.json()) as ApprovalCard).state, "approved");
      result = await waitFor(() => results()[1]);
    } finally {
      for (const k of identityEnv) if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
    const text = String(result.kind === "claude" && result.payload.result);
    assert.match(text, /^Delivered fix-x to main as [0-9a-f]{7} \(merge commit, unsigned\)\./);
    assert.match(text, /no name or email, so the commit is by their GitHub account, acme <42\+acme@users\.noreply\.github\.com>\./);
    assert.equal(sh(bare, "rev-parse", "main^2").trim(), head);
    assert.equal(sh(bare, "log", "-1", "--format=%an <%ae> / %cn <%ce>", "main").trim(), "acme <42+acme@users.noreply.github.com> / acme <42+acme@users.noreply.github.com>");
    const done = got.findLast((e): e is Extract<SessionEvent, { kind: "card" }> => e.kind === "card")!.payload;
    assert.equal(done.state, "done");
    const again = await api(`/api/sessions/${id}/cards/${card.id}`, { method: "POST", body: JSON.stringify({ action: "decline" }) });
    assert.equal(again.status, 409);
    sock.close();
  });

  it("serves the card's changes to the review pane, and sends the user's notes back to Claude when they decline", async () => {
    execFileSync("git", ["-C", work, "checkout", "--quiet", "main"]);
    sh(work, "pull", "--quiet", "origin", "main");
    execFileSync("git", ["-C", work, "checkout", "--quiet", "-b", "review-x"]);
    await writeFile(join(work, "README"), "hi\nthere\n");
    sh(work, "commit", "--quiet", "-am", "Say more\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
    const one = sh(work, "rev-parse", "HEAD").trim();
    await writeFile(join(work, "y"), "y\n");
    sh(work, "add", "y");
    sh(work, "commit", "--quiet", "-m", "Add y\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
    sh(work, "push", "--quiet", "origin", "review-x");

    const res = await api("/api/sessions", { method: "POST", body: JSON.stringify({ sandbox: "web", prompt: "hi" }) });
    const { id } = (await res.json()) as { id: string };
    await waitFor(async () => ((await (await api("/api/sessions")).json()) as SessionInfo[]).find((s) => s.id === id)?.status === "idle");
    const got: SessionEvent[] = [];
    const sock = new WebSocket(`${server.url.replace("http", "ws")}/api/sessions/${id}/events?after=0`, { headers: { authorization: `Bearer ${server.token}` } });
    sock.on("message", (m) => {
      const msg = JSON.parse(String(m)) as SessionStreamMessage;
      if (msg.kind !== "caught_up") got.push(msg);
    });
    await waitFor(() => got.some((e) => e.kind === "claude" && e.payload.type === "result"));
    const prompt = `widget deliver ${JSON.stringify({ branch: "review-x", title: "Review x", body: "." })}`;
    assert.equal((await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: prompt }) })).status, 202);
    const card = await waitFor(() => got.findLast((e): e is Extract<SessionEvent, { kind: "card" }> => e.kind === "card")?.payload);

    const diff = (await (await api(`/api/sessions/${id}/cards/${card.id}/diff`)).json()) as ReviewDiff;
    assert.deepEqual(diff.files.map((f) => [f.path, f.status, f.added, f.deleted]), [["README", "modified", 1, 0], ["y", "added", 1, 0]]);
    const readme = diff.files[0];
    assert.deepEqual(readme.hunks[0].lines, [" hi", "+there"]);
    const blob = (await (await api(`/api/sessions/${id}/cards/${card.id}/blob/${readme.newBlob}`)).json()) as { text: string };
    assert.equal(blob.text, "hi\nthere\n");
    const commit = (await (await api(`/api/sessions/${id}/cards/${card.id}/diff?commit=${one}`)).json()) as ReviewDiff;
    assert.deepEqual(commit.files.map((f) => f.path), ["README"], "one commit shows only what it changed");
    assert.equal(commit.message, "Say more\n\nCo-Authored-By: Claude <noreply@anthropic.com>", "with its whole message");
    assert.equal(diff.message, undefined);
    assert.equal((await api(`/api/sessions/${id}/cards/${card.id}/diff?commit=${"0".repeat(40)}`)).status, 400, "only the card's commits");
    assert.equal((await api(`/api/sessions/${id}/cards/${card.id}/blob/HEAD`)).status, 400);
    assert.equal((await api(`/api/sessions/${id}/cards/nope/diff`)).status, 404);

    // The card's Review button: the pane opens beside the chat, and closes on a second press.
    const opened = (await (await api(`/api/sessions/${id}/window/review`, { method: "POST", body: JSON.stringify({ ask: card.id }) })).json()) as WindowState;
    assert.ok(Object.values(opened.panes).includes(REVIEW));
    assert.deepEqual(opened.widgets[REVIEW], { kind: "review", state: { ask: card.id } });
    const closed = (await (await api(`/api/sessions/${id}/window/review`, { method: "POST", body: JSON.stringify({ ask: card.id }) })).json()) as WindowState;
    assert.ok(!Object.values(closed.panes).includes(REVIEW));
    assert.equal((await api(`/api/sessions/${id}/window/review`, { method: "POST", body: JSON.stringify({ ask: "nope" }) })).status, 404);

    // Notes make a long reason; it reaches Claude whole.
    const reason = `README:2\n> there\n${"Say it differently. ".repeat(300)}`;
    assert.ok(reason.length > 4000);
    const declined = await api(`/api/sessions/${id}/cards/${card.id}`, { method: "POST", body: JSON.stringify({ action: "decline", reason }) });
    assert.equal(((await declined.json()) as ApprovalCard).reason, reason.trim());
    sock.close();
  });

  it("keeps the VM's pushes in the mirror, and sends a branch to GitHub only when the user approves its PR", async () => {
    const vmHome = join(root, "lima", "vm-home");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: vmHome, GIT_TERMINAL_PROMPT: "0" };
    delete env.GIT_CONFIG_GLOBAL;
    delete env.KUMIKO_SESSION;
    // Not sync: the relay that serves it runs in this process.
    const vm = (...args: string[]) =>
      new Promise<{ code: number; err: string }>((resolve) => execFile("git", args, { env }, (err, _out, errOut) => resolve({ code: err ? 1 : 0, err: String(errOut) })));
    const clone = join(vmHome, "widget");
    await vm("clone", "--quiet", "git@github.com:acme/widget.git", clone);
    await mkdir(join(clone, ".github"), { recursive: true });
    await writeFile(join(clone, ".github", "ci.yml"), "on: push\n");
    await vm("-C", clone, "checkout", "--quiet", "-b", "ci");
    await vm("-C", clone, "add", ".github");
    await vm("-C", clone, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "CI\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
    const pushed = await vm("-C", clone, "push", "-u", "origin", "ci");
    assert.equal(pushed.code, 0, pushed.err);
    assert.match(pushed.err, /ci is in the mirror on the user's computer, not on GitHub/);
    assert.throws(() => sh(bare, "rev-parse", "--verify", "--quiet", "refs/heads/ci"), "not on GitHub, CI change or not");

    const res = await api("/api/sessions", { method: "POST", body: JSON.stringify({ sandbox: "web", prompt: "hi" }) });
    const { id } = (await res.json()) as { id: string };
    await waitFor(async () => ((await (await api("/api/sessions")).json()) as SessionInfo[]).find((s) => s.id === id)?.status === "idle");
    const got: SessionEvent[] = [];
    const sock = new WebSocket(`${server.url.replace("http", "ws")}/api/sessions/${id}/events?after=0`, { headers: { authorization: `Bearer ${server.token}` } });
    sock.on("message", (m) => {
      const msg = JSON.parse(String(m)) as SessionStreamMessage;
      if (msg.kind !== "caught_up") got.push(msg);
    });
    const results = () => got.filter((e) => e.kind === "claude" && e.payload.type === "result");
    await waitFor(() => results().length >= 1);
    assert.equal((await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: `widget deliver ${JSON.stringify({ branch: "ci", title: "CI", body: "Runs CI." })}` }) })).status, 202);
    const card = await waitFor(() => got.findLast((e): e is Extract<SessionEvent, { kind: "card" }> => e.kind === "card")?.payload);
    assert.ok(card.card.kind === "deliver" && card.card.github === undefined && card.card.flags.some((f) => f.rule === "ci"));
    const ok = await api(`/api/sessions/${id}/cards/${card.id}`, { method: "POST", body: JSON.stringify({ action: "approve", decision: { kind: "deliver", route: "pr", method: "merge", title: "CI", body: "Runs CI." } }) });
    assert.equal(ok.status, 200, await ok.clone().text());
    const result = await waitFor(() => results()[1]);
    assert.match(String(result.kind === "claude" && result.payload.result), /^Opened PR #\d+/);
    assert.ok(sh(bare, "rev-parse", "--verify", "refs/heads/ci"), "on GitHub once approved");
    sock.close();
  });
});
