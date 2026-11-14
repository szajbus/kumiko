import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { LimaProvider, MetadataStore } from "@kumiko/sandbox";
import { repoFromRemote } from "@kumiko/shared";
import { Mirrors } from "../src/mirrors.js";
import { pktLine, readRequest, Relays, remoteForms, vmGitConfig } from "../src/relay.js";
import { fakeGitHub, type FakeGitHub } from "./github.js";
import { sh } from "./repo.js";

const sandboxFixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../../../sandbox/fixtures");

/** git as the agent runs it in the fake VM: the VM user's home and config, none of the test's. */
function vmGit(home: string, cwd: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_TERMINAL_PROMPT: "0" };
  delete env.GIT_CONFIG_GLOBAL;
  delete env.GIT_CONFIG_NOSYSTEM;
  env.GIT_CONFIG_NOSYSTEM = "1";
  return new Promise((done) => {
    execFile("git", ["-C", cwd, ...args], { env }, (err, out, errOut) => done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(out), err: String(errOut) }));
  });
}

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("git relay pieces", () => {
  it("reads a git:// request and what follows it, and only that", () => {
    const line = pktLine("git-upload-pack /acme/widget.git\0host=kumiko\0\0version=2\0");
    const read = readRequest(Buffer.concat([line, Buffer.from("0000")]))!;
    assert.equal(read.request.service, "git-upload-pack");
    assert.equal(read.request.path, "/acme/widget.git");
    assert.equal(read.request.rest.toString(), "\0host=kumiko\0\0version=2\0");
    assert.equal(read.after.toString(), "0000");
    assert.equal(readRequest(line.subarray(0, 10)), undefined, "not all there yet");
    assert.throws(() => readRequest(pktLine("git-upload-archive /acme/widget.git\0")));
    assert.throws(() => readRequest(Buffer.from("GET / HTTP/1.1\r\n")));
    assert.throws(() => readRequest(Buffer.from("zzzz")));
  });

  it("knows GitHub's remote URLs, and nothing else", () => {
    for (const url of ["git@github.com:acme/widget.git", "git@github.com:acme/widget", "https://github.com/acme/widget.git", "https://github.com/acme/widget", "https://token@github.com/acme/widget.git", "ssh://git@github.com/acme/widget.git"]) {
      assert.equal(repoFromRemote(url)?.repo, "acme/widget", url);
    }
    for (const url of ["git@gitlab.com:acme/widget.git", "https://github.com/acme", "https://github.com/acme/widget/tree/main", "/srv/widget.git", "https://github.com.evil.example/acme/widget.git", "git@github.com:acme/../widget.git"]) {
      assert.equal(repoFromRemote(url), undefined, url);
    }
  });

  it("writes the VM's config with the user's identity quoted, and every URL form to the mirror", () => {
    const config = vmGitConfig("acme/widget", { name: 'A "quoted" \\ name', email: "a@example.com" });
    assert.match(config, /\tname = "A \\"quoted\\" \\\\ name"/);
    assert.match(config, /gitProxy = "@DIR@\/git-proxy for kumiko"/);
    assert.match(config, /\[url "git:\/\/kumiko\/acme\/widget.git"\]/);
    for (const u of remoteForms("acme/widget")) assert.ok(config.includes(`insteadOf = "${u}"`), u);
    assert.doesNotMatch(vmGitConfig("acme/widget", {}), /\[user\]/);
  });
});

describe("git relay", () => {
  let root: string;
  let limaDir: string;
  let vmHome: string;
  let github: FakeGitHub;
  let mirrors: Mirrors;
  let relays: Relays;
  let work: string;
  let changes = 0;
  const provider = () => new LimaProvider({ limactl: join(sandboxFixtures, "fake-limactl.mjs"), ssh: join(sandboxFixtures, "fake-ssh.sh"), metadata: new MetadataStore(join(root, "sandboxes")) });

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "kumiko-relay-test-")));
    limaDir = join(root, "lima");
    vmHome = join(limaDir, "vm-home");
    await mkdir(limaDir, { recursive: true });
    process.env.FAKE_LIMA_DIR = limaDir;
    github = await fakeGitHub(root);
    ({ work } = await github.repo("acme/widget"));
    await github.repo("acme/other");
    mirrors = new Mirrors({ home: join(root, "home"), remoteUrl: (repo) => `${github.url}/${repo.toLowerCase()}.git`, freshMs: 0 });
    await mirrors.start();
    relays = new Relays({
      dir: join(root, "home", "run"),
      mirrors,
      provider: provider(),
      identity: async () => ({ name: "Test", email: "test@example.com" }),
      onChange: () => changes++,
    });
  });

  after(async () => {
    await relays?.close();
    await mirrors?.close();
    github?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("clones and pulls in the VM from the mirror, which fetches from GitHub first, with no credentials in the VM", async () => {
    relays.sync(new Map([["web", "acme/widget"]]));
    assert.equal(relays.view("web")?.state, "connecting");
    await until("the relay to connect", () => relays.view("web")?.state === "connected");
    assert.ok(changes > 0, "the page hears of it");
    assert.ok(mirrors.get("acme/widget"), "the repository is picked through ensure");

    const config = await readFile(join(vmHome, ".config", "kumiko", "git.config"), "utf8");
    assert.ok(config.includes(`gitProxy = "${vmHome}/.config/kumiko/git-proxy for kumiko"`), config);
    assert.match(await readFile(join(vmHome, ".gitconfig"), "utf8"), /path = .*\.config\/kumiko\/git.config/);

    const clone = join(vmHome, "widget");
    const cloned = await vmGit(vmHome, vmHome, "clone", "--quiet", "git@github.com:acme/widget.git", clone);
    assert.equal(cloned.code, 0, cloned.err);
    assert.equal(await readFile(join(clone, "README"), "utf8"), "hi\n");
    assert.equal((await vmGit(vmHome, clone, "config", "--get", "remote.origin.url")).out.trim(), "git@github.com:acme/widget.git", "origin still names GitHub in the clone's config");

    // Someone pushes to GitHub; the VM's next pull sees it, because the mirror fetches before serving.
    await writeFile(join(work, "NEWS"), "news\n");
    sh(work, "add", "NEWS");
    sh(work, "commit", "--quiet", "-m", "news");
    sh(work, "push", "--quiet", "origin", "main");
    const pulled = await vmGit(vmHome, clone, "pull", "--quiet", "--ff-only");
    assert.equal(pulled.code, 0, pulled.err);
    assert.equal(await readFile(join(clone, "NEWS"), "utf8"), "news\n");

    // The HTTPS form goes the same way, whatever its case.
    const ls = await vmGit(vmHome, vmHome, "ls-remote", "https://github.com/acme/widget", "refs/heads/main");
    assert.equal(ls.code, 0, ls.err);
    assert.equal(ls.out.split("\t")[0], sh(work, "rev-parse", "HEAD").trim());
  });

  it("serves only the project's own repository", async () => {
    await until("the relay to connect", () => relays.view("web")?.state === "connected");
    for (const url of ["git://kumiko/acme/other.git", "git://kumiko/acme/widget.git/../other.git", "git://kumiko//etc/passwd"]) {
      const r = await vmGit(vmHome, vmHome, "ls-remote", url);
      assert.notEqual(r.code, 0, url);
      assert.match(r.err, /can only reach acme\/widget/, url);
    }
  });

  it("refuses pushes, as the mirror's hook does for now", async () => {
    const clone = join(vmHome, "widget");
    await writeFile(join(clone, "x"), "x\n");
    await vmGit(vmHome, clone, "add", "x");
    await vmGit(vmHome, clone, "commit", "--quiet", "-m", "x");
    const r = await vmGit(vmHome, clone, "push", "origin", "HEAD:refs/heads/x");
    assert.notEqual(r.code, 0);
    assert.match(r.err, /remote: Kumiko: pushing to this mirror isn't allowed/);
  });

  it("stops when the VM no longer runs, and takes its socket away", async () => {
    const socket = join(root, "home", "run", "git-web.sock");
    assert.ok(existsSync(socket));
    relays.sync(new Map());
    assert.equal(relays.view("web"), undefined);
    await until("the socket to go", () => !existsSync(socket));
    const r = await vmGit(vmHome, vmHome, "ls-remote", "git@github.com:acme/widget.git");
    assert.notEqual(r.code, 0);
  });

  it("says why it is down, and tries again", async () => {
    let forwards = 0;
    const real = provider();
    const failing = new Relays({
      dir: join(root, "home", "run"),
      mirrors,
      retryMs: 20,
      provider: {
        exec: real.exec.bind(real),
        forward: () => {
          forwards++;
          return spawn("sh", ["-c", "echo 'Error: remote port forwarding failed for listen path' >&2; exit 255"], { stdio: ["ignore", "ignore", "pipe"] });
        },
      },
    });
    failing.sync(new Map([["down", "acme/widget"]]));
    await until("the relay to give up", () => failing.view("down")?.state === "down");
    assert.match(failing.view("down")!.error!, /remote port forwarding failed/);
    await until("another try", () => forwards >= 2);
    await failing.close();
  });
});

describe("git relays, closed", () => {
  it("start nothing once closed, so a sync that was under way can't leave one running", async () => {
    let forwards = 0;
    const relays = new Relays({
      dir: join(tmpdir(), "kumiko-relay-closed"),
      mirrors: { ensure: async () => "", fetch: async () => {}, path: () => "", root: "" } as unknown as Mirrors,
      provider: { exec: () => { throw new Error("no VM"); }, forward: () => { forwards++; throw new Error("no VM"); } },
    });
    await relays.close();
    relays.sync(new Map([["late", "acme/widget"]]));
    assert.equal(relays.view("late"), undefined);
    assert.equal(forwards, 0);
  });
});
