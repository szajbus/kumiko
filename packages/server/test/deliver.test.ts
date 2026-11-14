import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import type { ApprovalCard, SessionEvent, SessionInfo, SessionStreamMessage } from "@kumiko/shared";
import { LimaProvider, MetadataStore, shellQuote } from "@kumiko/sandbox";
import { startServer, type RunningServer } from "../src/index.js";
import { fakeGitHub, type FakeGitHub } from "./github.js";
import { makeClone, sh } from "./repo.js";

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
    root = await realpath(await mkdtemp(join(tmpdir(), "kumiko-deliver-e2e-")));
    const limaDir = join(root, "lima");
    const vmHome = join(limaDir, "vm-home");
    process.env.FAKE_LIMA_DIR = limaDir;
    process.env.FAKE_GH_DIR = join(root, "gh");
    process.env.KUMIKO_GH = fakeGh;
    await mkdir(join(root, "gh"), { recursive: true });
    await writeFile(join(root, "gh", "user.json"), JSON.stringify({ login: "acme" }));
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
    const clone = await makeClone(root, "widget");
    sh(clone, "remote", "set-url", "origin", "git@github.com:acme/widget.git");
    await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "web", clonePath: clone, cpus: 1, memoryGiB: 1, diskGiB: 10, mounts: [], env: [] }) });
    await waitFor(async () => ((await (await api("/api/projects")).json()) as { name: string; relay?: { state: string } }[]).find((p) => p.name === "web")?.relay?.state === "connected");
  });

  after(async () => {
    await server?.close({ endSessions: true });
    github?.close();
    process.env = saved;
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

    const prompt = `widget deliver ${JSON.stringify({ branch: "fix-x", title: "Fix x", body: "Fixes x.", note: "Tiny." })}`;
    assert.equal((await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: prompt }) })).status, 202);
    const card = await waitFor(() => got.findLast((e): e is Extract<SessionEvent, { kind: "card" }> => e.kind === "card")?.payload);
    assert.equal(card.state, "open");
    assert.equal(card.card.kind === "deliver" && card.card.head, head);
    assert.equal(((await (await api("/api/sessions")).json()) as SessionInfo[]).find((s) => s.id === id)?.asking, "approval", "the tab says it waits on the user");

    const bad = await api(`/api/sessions/${id}/cards/${card.id}`, { method: "POST", body: JSON.stringify({ action: "approve", decision: { kind: "deliver", route: "sideways", method: "merge" } }) });
    assert.equal(bad.status, 400);
    const ok = await api(`/api/sessions/${id}/cards/${card.id}`, { method: "POST", body: JSON.stringify({ action: "approve", decision: { kind: "deliver", route: "main", method: "merge" } }) });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal(((await ok.json()) as ApprovalCard).state, "approved");

    const result = await waitFor(() => results()[1]);
    assert.match(String(result.kind === "claude" && result.payload.result), /^Delivered fix-x to main as [0-9a-f]{7} \(merge commit\)\./);
    assert.equal(sh(bare, "rev-parse", "main^2").trim(), head);
    const done = got.findLast((e): e is Extract<SessionEvent, { kind: "card" }> => e.kind === "card")!.payload;
    assert.equal(done.state, "done");
    const again = await api(`/api/sessions/${id}/cards/${card.id}`, { method: "POST", body: JSON.stringify({ action: "decline" }) });
    assert.equal(again.status, 409);
    sock.close();
  });
});
