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
import { pktLine, readRequest, readSessionLine, Relays, remoteForms, vmGitConfig } from "../src/relay.js";
import { decide, githubLines, parseUpdates, Pushes, type PushAnswer } from "../src/pushes.js";
import type { PushCard } from "@kumiko/shared";
import { fakeGitHub, type FakeGitHub } from "./github.js";
import { sh } from "./repo.js";

const sandboxFixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../../../sandbox/fixtures");

/** git as the agent runs it in the fake VM: the VM user's home and config, none of the test's. */
function vmGit(home: string, cwd: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return vmGitIn(home, cwd, {}, ...args);
}

function vmGitIn(home: string, cwd: string, extra: NodeJS.ProcessEnv, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_TERMINAL_PROMPT: "0", ...extra };
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

  it("reads the proxy's session line, if there is one, before git's request", () => {
    const req = pktLine("git-upload-pack /acme/widget.git\0host=kumiko\0");
    const id = "0b1c2d3e-0000-4000-8000-000000000001";
    assert.deepEqual(readSessionLine(Buffer.concat([Buffer.from(`kumiko-session ${id}\n`), req])), { session: id, after: req });
    assert.deepEqual(readSessionLine(Buffer.concat([Buffer.from("kumiko-session \n"), req])), { after: req }, "none named");
    assert.deepEqual(readSessionLine(req), { after: req }, "an older proxy's");
    assert.equal(readSessionLine(Buffer.from("kumiko-sess")), undefined, "not all there yet");
    assert.throws(() => readSessionLine(Buffer.from("kumiko-session $(rm -rf /)\n")));
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
  let pushes: Pushes;
  let work: string;
  /** What the push hook asked the user, and how the test answers: by default, it's never answered. */
  const asks: { pusher: { project: string; session?: string }; card: PushCard; answer(a: PushAnswer): void; done: { ok: boolean; text: string }[] }[] = [];
  const closed: string[] = [];
  let bare: string;
  let changes = 0;
  const provider = () => new LimaProvider({ limactl: join(sandboxFixtures, "fake-limactl.mjs"), ssh: join(sandboxFixtures, "fake-ssh.sh"), metadata: new MetadataStore(join(root, "sandboxes")) });

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "kumiko-relay-test-")));
    limaDir = join(root, "lima");
    vmHome = join(limaDir, "vm-home");
    await mkdir(limaDir, { recursive: true });
    process.env.FAKE_LIMA_DIR = limaDir;
    github = await fakeGitHub(root);
    ({ work, bare } = await github.repo("acme/widget"));
    await github.repo("acme/other");
    mirrors = new Mirrors({ home: join(root, "home"), remoteUrl: (repo) => `${github.url}/${repo.toLowerCase()}.git`, freshMs: 0 });
    await mirrors.start();
    pushes = new Pushes({
      socket: join(root, "home", "run", "hook.sock"),
      mirrors,
      connection: (id) => relays.connection(id),
      askCi: (pusher, _connection, card) => {
        let answer!: (a: PushAnswer) => void;
        const promise = new Promise<PushAnswer>((r) => (answer = r));
        const entry = { pusher, card, answer, done: [] as { ok: boolean; text: string }[] };
        asks.push(entry);
        return { answer: promise, done: (ok, text) => entry.done.push({ ok, text }) };
      },
    });
    await pushes.start();
    relays = new Relays({
      dir: join(root, "home", "run"),
      hookSocket: join(root, "home", "run", "hook.sock"),
      onConnectionClosed: (id) => closed.push(id),
      mirrors,
      provider: provider(),
      identity: async () => ({ name: "Test", email: "test@example.com" }),
      onChange: () => changes++,
    });
  });

  after(async () => {
    await relays?.close();
    await pushes?.close();
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

  /** Commits a change in the VM's clone, on `branch` (made from what's checked out if it doesn't exist). */
  const commit = async (branch: string, file: string) => {
    const clone = join(vmHome, "widget");
    await vmGit(vmHome, clone, "checkout", "--quiet", "-B", branch);
    await writeFile(join(clone, file), `${file}\n`);
    await vmGit(vmHome, clone, "add", file);
    const r = await vmGit(vmHome, clone, "commit", "--quiet", "-m", file);
    assert.equal(r.code, 0, r.err);
    return (await vmGit(vmHome, clone, "rev-parse", "HEAD")).out.trim();
  };
  const push = (...args: string[]) => vmGit(vmHome, join(vmHome, "widget"), "push", ...args);
  const onGitHub = (ref: string) => {
    try {
      return sh(bare, "rev-parse", "--verify", "--quiet", ref).trim();
    } catch {
      return undefined;
    }
  };
  const inMirror = (ref: string) => {
    try {
      return sh(mirrors.path("acme/widget"), "rev-parse", "--verify", "--quiet", ref).trim();
    } catch {
      return undefined;
    }
  };

  it("pushes a new branch on to GitHub, and records it as the project's", async () => {
    const sha = await commit("fix-x", "a");
    const r = await push("-u", "origin", "fix-x");
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /remote: Kumiko: pushed fix-x to GitHub \(acme\/widget\)\./);
    assert.equal(onGitHub("refs/heads/fix-x"), sha);
    assert.equal(inMirror("refs/heads/fix-x"), sha, "the mirror matches GitHub");
    assert.equal(mirrors.createdBy("acme/widget", "fix-x"), "web");
    assert.deepEqual(mirrors.branchesOf("acme/widget", "web").map((b) => b.name), ["fix-x"]);
  });

  it("force-pushes and deletes the project's own branches", async () => {
    const clone = join(vmHome, "widget");
    await vmGit(vmHome, clone, "commit", "--quiet", "--amend", "-m", "a, amended");
    const amended = (await vmGit(vmHome, clone, "rev-parse", "HEAD")).out.trim();
    const forced = await push("--force", "origin", "fix-x");
    assert.equal(forced.code, 0, forced.err);
    assert.equal(onGitHub("refs/heads/fix-x"), amended);

    const deleted = await push("origin", "--delete", "fix-x");
    assert.equal(deleted.code, 0, deleted.err);
    assert.match(deleted.err, /Kumiko: deleted fix-x on GitHub/);
    assert.equal(onGitHub("refs/heads/fix-x"), undefined);
    assert.equal(inMirror("refs/heads/fix-x"), undefined);
    assert.equal(mirrors.createdBy("acme/widget", "fix-x"), undefined);
  });

  it("refuses the default branch and tags, and says what to do instead", async () => {
    const main = onGitHub("refs/heads/main");
    await commit("main", "m");
    const r = await push("origin", "main");
    assert.notEqual(r.code, 0);
    assert.match(r.err, /remote: Kumiko: main is the default branch\. It changes only when the user approves delivering a branch to it/);
    assert.match(r.err, /remote: Kumiko: nothing was pushed\./);
    assert.equal(onGitHub("refs/heads/main"), main);
    assert.equal(inMirror("refs/heads/main"), main);

    await vmGit(vmHome, join(vmHome, "widget"), "tag", "v9");
    const t = await push("origin", "v9");
    assert.notEqual(t.code, 0);
    assert.match(t.err, /Kumiko doesn't push tags to GitHub/);
    assert.equal(onGitHub("refs/tags/v9"), undefined);
    await vmGit(vmHome, join(vmHome, "widget"), "reset", "--quiet", "--hard", "origin/main");
  });

  it("refuses branches someone else created", async () => {
    sh(work, "push", "--quiet", "origin", "main:refs/heads/yours");
    const clone = join(vmHome, "widget");
    await vmGit(vmHome, clone, "fetch", "--quiet");
    await vmGit(vmHome, clone, "checkout", "--quiet", "-B", "yours", "origin/yours");
    await commit("yours", "y");
    const r = await push("origin", "yours");
    assert.notEqual(r.code, 0);
    assert.match(r.err, /yours wasn't created from this sandbox, so Kumiko won't change it/);
    assert.equal(onGitHub("refs/heads/yours"), sh(work, "rev-parse", "HEAD").trim());
    const d = await push("origin", "--delete", "yours");
    assert.notEqual(d.code, 0);
    assert.ok(onGitHub("refs/heads/yours"));
  });

  it("refuses a whole push when any of it is refused", async () => {
    await commit("both", "b");
    const r = await push("origin", "both", "yours");
    assert.notEqual(r.code, 0);
    assert.equal(onGitHub("refs/heads/both"), undefined, "the allowed branch didn't go either");
    assert.equal(mirrors.createdBy("acme/widget", "both"), undefined);
  });

  it("passes on GitHub refusing a push whose lease is stale, and leaves the mirror as it was", async () => {
    const first = await commit("lease", "l1");
    assert.equal((await push("origin", "lease")).code, 0);
    // Someone moves the branch on GitHub; the mirror hasn't fetched since.
    sh(work, "fetch", "--quiet", "origin");
    sh(work, "push", "--quiet", "--force", "origin", "main:refs/heads/lease");
    const theirs = onGitHub("refs/heads/lease");
    await commit("lease", "l2");
    const r = await push("origin", "lease");
    assert.notEqual(r.code, 0);
    assert.match(r.err, /stale info|rejected/);
    assert.match(r.err, /Kumiko: GitHub refused the push, so nothing was pushed/);
    assert.equal(onGitHub("refs/heads/lease"), theirs);
    assert.equal(inMirror("refs/heads/lease"), first, "the mirror didn't move");
  });

  it("waits for the user on a push that changes CI, asking in the session it came from, once per change", async () => {
    const clone = join(vmHome, "widget");
    await vmGit(vmHome, clone, "fetch", "--quiet");
    await vmGit(vmHome, clone, "checkout", "--quiet", "-B", "ci", "origin/main");
    await mkdir(join(clone, ".github", "workflows"), { recursive: true });
    await writeFile(join(clone, ".github", "workflows", "ci.yml"), "on: push\n");
    await vmGit(vmHome, clone, "add", ".github");
    await vmGit(vmHome, clone, "commit", "--quiet", "-m", "CI");
    const session = "0b1c2d3e-0000-4000-8000-000000000001";
    const pushing = vmGitIn(vmHome, clone, { KUMIKO_SESSION: session }, "push", "-u", "origin", "ci");
    await until("the push to ask", () => asks.length === 1);
    const [a] = asks;
    assert.deepEqual(a.pusher, { project: "web", repo: "acme/widget", session });
    assert.equal(a.card.branch, "ci");
    assert.equal(a.card.old, undefined, "a new branch");
    assert.deepEqual(a.card.files.map((f) => [f.path, f.added]), [[".github/workflows/ci.yml", 1]]);
    assert.equal(onGitHub("refs/heads/ci"), undefined, "nothing on GitHub while it waits");
    a.answer({ allowed: true });
    const r = await pushing;
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /remote: Kumiko: ci changes \.github\/workflows\/ci\.yml, which decides what CI runs/);
    assert.match(r.err, /remote: Kumiko: waiting for the user to allow it in Kumiko…/);
    assert.ok(onGitHub("refs/heads/ci"));
    assert.deepEqual(a.done, [{ ok: true, text: "Pushed to GitHub, with its CI change" }]);
    assert.ok(mirrors.ciAllowed("acme/widget", "ci"));

    // More work with the same .github/ goes through by itself.
    await writeFile(join(clone, "more"), "more\n");
    await vmGit(vmHome, clone, "add", "more");
    await vmGit(vmHome, clone, "commit", "--quiet", "-m", "more");
    assert.equal((await push("origin", "ci")).code, 0);
    assert.equal(asks.length, 1);

    // Another change to it asks again; refused, nothing goes.
    await writeFile(join(clone, ".github", "workflows", "ci.yml"), "on: [push, pull_request]\n");
    await vmGit(vmHome, clone, "commit", "--quiet", "-am", "CI again");
    const before = onGitHub("refs/heads/ci");
    const again = push("origin", "ci");
    await until("the second ask", () => asks.length === 2);
    assert.equal(asks[1].pusher.session, undefined, "no session named");
    asks[1].answer({ allowed: false, message: "The user declined pushing ci." });
    const refused = await again;
    assert.notEqual(refused.code, 0);
    assert.match(refused.err, /remote: Kumiko: The user declined pushing ci\./);
    assert.equal(onGitHub("refs/heads/ci"), before);
  });

  it("lets the user know a push stopped waiting when git in the VM goes", async () => {
    const clone = join(vmHome, "widget");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: vmHome, GIT_TERMINAL_PROMPT: "0" };
    delete env.GIT_CONFIG_GLOBAL;
    const git = spawn("git", ["-C", clone, "push", "origin", "ci"], { env, stdio: "ignore" });
    await until("the third ask", () => asks.length === 3);
    const before = closed.length;
    git.kill("SIGKILL");
    await until("the relay to hear the push went", () => closed.length > before);
    asks[2].answer({ allowed: false, message: "gone" });
  });

  it("refuses a push into a mirror that didn't come through a relay", async () => {
    const r = await vmGit(vmHome, join(vmHome, "widget"), "push", mirrors.path("acme/widget"), "HEAD:refs/heads/direct");
    assert.notEqual(r.code, 0);
    assert.match(r.err, /Kumiko: pushing to this mirror isn't allowed/);
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

describe("the push policy", () => {
  const z = "0".repeat(40);
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const created: Record<string, string> = { mine: "web", theirs: "api" };
  const ctx = { defaultBranch: "main", createdBy: (br: string) => created[br] };
  const pusher = { project: "web", repo: "acme/widget" };

  it("allows new branches and the project's own, and nothing else", () => {
    const ok = decide([{ old: z, new: a, ref: "refs/heads/new" }, { old: a, new: b, ref: "refs/heads/mine" }, { old: a, new: z, ref: "refs/heads/mine" }], pusher, ctx);
    assert.ok(ok.allowed);
    assert.deepEqual(ok.branches.map((x) => [x.branch, x.created, x.deleted]), [["new", true, false], ["mine", false, false], ["mine", false, true]]);
    for (const [u, why] of [
      [{ old: a, new: b, ref: "refs/heads/main" }, /default branch/],
      [{ old: z, new: a, ref: "refs/heads/main" }, /default branch/],
      [{ old: z, new: a, ref: "refs/tags/v1" }, /doesn't push tags/],
      [{ old: z, new: a, ref: "refs/notes/x" }, /refs other than branches/],
      [{ old: a, new: b, ref: "refs/heads/theirs" }, /another project's sandbox/],
      [{ old: a, new: z, ref: "refs/heads/someone" }, /wasn't created from this sandbox/],
    ] as const) {
      const d = decide([u], pusher, ctx);
      assert.ok(!d.allowed, u.ref);
      assert.match(d.reasons[0], why);
    }
  });

  it("reads the hook's lines, and nothing else", () => {
    assert.deepEqual(parseUpdates(`${z} ${a} refs/heads/x\n\n`), [{ old: z, new: a, ref: "refs/heads/x" }]);
    assert.throws(() => parseUpdates(`${z} ${a} refs/heads/x; rm -rf /\n`.replace("refs/heads/x;", "refs/heads/x ;")));
    assert.throws(() => parseUpdates("nonsense"));
  });

  it("shows GitHub's lines without git's own", () => {
    assert.deepEqual(githubLines("remote: \nremote: Create a pull request for 'x' on GitHub by visiting:\nremote:      https://github.com/acme/widget/pull/new/x\nTo https://github.com/acme/widget.git\n*\trefs/heads/x:refs/heads/x\t[new branch]\nDone\n"), [
      "Create a pull request for 'x' on GitHub by visiting:",
      "     https://github.com/acme/widget/pull/new/x",
    ]);
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
