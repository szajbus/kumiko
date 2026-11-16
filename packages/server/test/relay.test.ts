import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { LimaProvider, MetadataStore } from "@kumiko/sandbox";
import { repoFromRemote } from "@kumiko/shared";
import { Mirrors, syncBranches } from "../src/mirrors.js";
import { pktLine, readRequest, readSessionLine, Relays, remoteForms, vmGitConfig } from "../src/relay.js";
import { decide, parseHookBody, parseUpdates, Pushes } from "../src/pushes.js";
import { fakeGitHub, type FakeGitHub } from "./github.js";
import { sh } from "./repo.js";

const sandboxFixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../../../sandbox/fixtures");

/** git as the agent runs it in the fake VM: the VM user's home and config, none of the test's. */
function vmGit(home: string, cwd: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return vmGitIn(home, cwd, {}, ...args);
}

function vmGitIn(home: string, cwd: string, extra: NodeJS.ProcessEnv, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  // Not the session these tests may run in: a Kumiko session's commands carry its KUMIKO_SESSION.
  const env: NodeJS.ProcessEnv = { ...process.env, KUMIKO_SESSION: undefined, HOME: home, GIT_TERMINAL_PROMPT: "0", ...extra };
  if (env.KUMIKO_SESSION === undefined) delete env.KUMIKO_SESSION;
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
    const config = vmGitConfig(["acme/widget"], { name: 'A "quoted" \\ name', email: "a@example.com" });
    assert.match(config, /\tname = "A \\"quoted\\" \\\\ name"/);
    assert.match(config, /gitProxy = "@DIR@\/git-proxy for kumiko"/);
    assert.match(config, /\[url "git:\/\/kumiko\/acme\/widget.git"\]/);
    for (const u of remoteForms("acme/widget")) assert.ok(config.includes(`insteadOf = "${u}"`), u);
    assert.doesNotMatch(vmGitConfig(["acme/widget"], {}), /\[user\]/);
    // Every repo of the sandbox goes to its own mirror.
    const two = vmGitConfig(["acme/widget", "acme/other"], {});
    assert.match(two, /\[url "git:\/\/kumiko\/acme\/other.git"\]\n\tinsteadOf = "git@github.com:acme\/other.git"/);
    assert.match(two, /\[url "git:\/\/kumiko\/acme\/widget.git"\]/);
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
    pushes = new Pushes({ socket: join(root, "home", "run", "hook.sock"), mirrors, connection: (id) => relays.connection(id) });
    await pushes.start();
    relays = new Relays({
      dir: join(root, "home", "run"),
      hookSocket: join(root, "home", "run", "hook.sock"),
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
    relays.sync(new Map([["web", ["acme/widget"]]]));
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

  it("serves only the sandbox's own repositories", async () => {
    await until("the relay to connect", () => relays.view("web")?.state === "connected");
    for (const url of ["git://kumiko/acme/other.git", "git://kumiko/acme/widget.git/../other.git", "git://kumiko//etc/passwd"]) {
      const r = await vmGit(vmHome, vmHome, "ls-remote", url);
      assert.notEqual(r.code, 0, url);
      assert.match(r.err, /can only reach acme\/widget/, url);
    }
  });

  it("serves a repo added to the sandbox through the relay it has, without setting the link up again", async () => {
    await until("the relay to connect", () => relays.view("web")?.state === "connected");
    const sock = join(vmHome, ".config", "kumiko", "git.sock");
    const before = (await stat(sock)).ino;
    relays.sync(new Map([["web", ["acme/widget", "acme/other"]]]));
    await until("the VM's config to name acme/other", async () => (await readFile(join(vmHome, ".config", "kumiko", "git.config"), "utf8")).includes("acme/other"));
    const ls = await vmGit(vmHome, vmHome, "ls-remote", "git@github.com:acme/other.git", "refs/heads/main");
    assert.equal(ls.code, 0, ls.err);
    assert.equal(relays.view("web")?.state, "connected");
    assert.equal((await stat(sock)).ino, before, "the forward and its socket in the VM are the ones from before");

    relays.sync(new Map([["web", ["acme/widget"]]]));
    await until("acme/other to be gone from the VM's config", async () => !(await readFile(join(vmHome, ".config", "kumiko", "git.config"), "utf8")).includes("acme/other"));
    assert.match((await vmGit(vmHome, vmHome, "ls-remote", "git://kumiko/acme/other.git")).err, /can only reach acme\/widget/);
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

  it("keeps a pushed branch in the mirror, off GitHub, where the VM sees it as origin's", async () => {
    const sha = await commit("fix-x", "a");
    const r = await push("-u", "origin", "fix-x");
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /remote: Kumiko: fix-x is in the mirror on the user's computer, not on GitHub\. To publish it, call the deliver tool\./);
    assert.equal(onGitHub("refs/heads/fix-x"), undefined, "nothing reached GitHub");
    assert.equal(inMirror("refs/heads/fix-x"), sha);
    assert.equal(mirrors.createdBy("acme/widget", "fix-x"), "web");
    // A fetch from GitHub leaves it be, and the VM sees it as before.
    await mirrors.fetch("acme/widget", { force: true });
    assert.equal(inMirror("refs/heads/fix-x"), sha);
    const ls = await vmGit(vmHome, join(vmHome, "widget"), "ls-remote", "origin");
    assert.match(ls.out, new RegExp(`^${sha}\trefs/heads/fix-x$`, "m"));
    assert.doesNotMatch(ls.out, /refs\/github\//, "the VM never sees GitHub's copies");
  });

  it("force-pushes and deletes in the mirror only, leaving GitHub's copy as it was", async () => {
    // A branch that is on GitHub, as the mirror sees after a fetch.
    sh(work, "fetch", "--quiet", "origin");
    sh(work, "push", "--quiet", "origin", "origin/main:refs/heads/shared");
    await mirrors.fetch("acme/widget", { force: true });
    const theirs = onGitHub("refs/heads/shared")!;
    assert.equal(inMirror("refs/heads/shared"), theirs, "a branch in step follows GitHub");
    const clone = join(vmHome, "widget");
    await vmGit(vmHome, clone, "fetch", "--quiet");
    await vmGit(vmHome, clone, "checkout", "--quiet", "-B", "shared", "origin/shared");
    const mine = await commit("shared", "s");
    await vmGit(vmHome, clone, "commit", "--quiet", "--amend", "-m", "s, amended");
    const amended = (await vmGit(vmHome, clone, "rev-parse", "HEAD")).out.trim();
    assert.notEqual(amended, mine);
    const forced = await push("--force", "origin", "shared");
    assert.equal(forced.code, 0, forced.err);
    assert.equal(inMirror("refs/heads/shared"), amended);
    assert.equal(onGitHub("refs/heads/shared"), theirs, "GitHub's copy is untouched");
    // GitHub's copy moving doesn't undo what Claude pushed.
    sh(work, "push", "--quiet", "--force", "origin", "origin/main:refs/heads/shared");
    await mirrors.fetch("acme/widget", { force: true });
    assert.equal(inMirror("refs/heads/shared"), amended);

    const deleted = await push("origin", "--delete", "shared");
    assert.equal(deleted.code, 0, deleted.err);
    assert.match(deleted.err, /Kumiko: deleted shared in the mirror on the user's computer\. GitHub's shared, if there is one, is untouched\./);
    assert.equal(inMirror("refs/heads/shared"), undefined);
    assert.equal(onGitHub("refs/heads/shared"), theirs);
    await mirrors.fetch("acme/widget", { force: true });
    assert.equal(inMirror("refs/heads/shared"), undefined, "a fetch doesn't bring it back");
  });

  it("follows GitHub for branches in step, and for main always", async () => {
    sh(work, "fetch", "--quiet", "origin");
    sh(work, "push", "--quiet", "origin", "origin/main:refs/heads/followed");
    await mirrors.fetch("acme/widget", { force: true });
    sh(work, "checkout", "--quiet", "-B", "main", "origin/main");
    await writeFile(join(work, "more"), "more\n");
    sh(work, "add", "more");
    sh(work, "commit", "--quiet", "-m", "more");
    sh(work, "push", "--quiet", "origin", "main", "main:refs/heads/followed");
    await mirrors.fetch("acme/widget", { force: true });
    assert.equal(inMirror("refs/heads/main"), onGitHub("refs/heads/main"));
    assert.equal(inMirror("refs/heads/followed"), onGitHub("refs/heads/followed"));
    sh(work, "push", "--quiet", "origin", "--delete", "followed");
    await mirrors.fetch("acme/widget", { force: true });
    assert.equal(inMirror("refs/heads/followed"), undefined, "gone from GitHub, gone from the mirror");
  });

  it("refuses the default branch and tags, and says what to do instead", async () => {
    const main = onGitHub("refs/heads/main");
    const clone = join(vmHome, "widget");
    await vmGit(vmHome, clone, "fetch", "--quiet");
    await vmGit(vmHome, clone, "checkout", "--quiet", "-B", "main", "origin/main");
    await commit("main", "m");
    const r = await push("origin", "main");
    assert.notEqual(r.code, 0);
    assert.match(r.err, /remote: Kumiko: main is the default branch\. It follows GitHub, and changes only when the user approves merging a branch into it/);
    assert.match(r.err, /remote: Kumiko: nothing was pushed\./);
    assert.equal(inMirror("refs/heads/main"), main);

    await vmGit(vmHome, clone, "tag", "v9");
    const t = await push("origin", "v9");
    assert.notEqual(t.code, 0);
    assert.match(t.err, /the mirror takes only branches, not tags/);
    await vmGit(vmHome, clone, "reset", "--quiet", "--hard", "origin/main");
  });

  it("refuses a push into a mirror that didn't come through a relay", async () => {
    const r = await vmGit(vmHome, join(vmHome, "widget"), "push", mirrors.path("acme/widget"), "HEAD:refs/heads/direct");
    assert.notEqual(r.code, 0);
    assert.match(r.err, /Kumiko: pushing to this mirror isn't allowed/);
  });

  it("stops when the VM no longer runs, and takes its socket away", async () => {
    const sockets = () => readdirSync(join(root, "home", "run")).filter((f) => /^git-web-[0-9a-f]{8}\.sock$/.test(f));
    assert.equal(sockets().length, 1);
    const socket = join(root, "home", "run", sockets()[0]);
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
    failing.sync(new Map([["down", ["acme/widget"]]]));
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
  const ctx = { defaultBranch: "main" };

  it("takes any branch into the mirror, forced or deleted, but not the default branch, tags or other refs", () => {
    const ok = decide([{ old: z, new: a, ref: "refs/heads/new" }, { old: a, new: b, ref: "refs/heads/someone-elses" }, { old: a, new: z, ref: "refs/heads/old" }], ctx);
    assert.ok(ok.allowed);
    assert.deepEqual(ok.branches.map((x) => [x.branch, x.created, x.deleted]), [["new", true, false], ["someone-elses", false, false], ["old", false, true]]);
    for (const [u, why] of [
      [{ old: a, new: b, ref: "refs/heads/main" }, /default branch/],
      [{ old: z, new: a, ref: "refs/tags/v1" }, /not tags/],
      [{ old: z, new: a, ref: "refs/notes/x" }, /not other refs/],
      [{ old: z, new: a, ref: "refs/github/heads/x" }, /not other refs/],
    ] as const) {
      const d = decide([u], ctx);
      assert.ok(!d.allowed, u.ref);
      assert.match(d.reasons[0], why);
    }
  });

  it("refuses names that differ from another only in case", () => {
    for (const ref of ["refs/heads/MAIN", "refs/heads/Mine"]) {
      const d = decide([{ old: z, new: a, ref }], { ...ctx, branches: ["main", "mine"] });
      assert.ok(!d.allowed && /only in case/.test(d.reasons[0]), ref);
    }
  });

  it("brings the mirror's branches up to date with GitHub's, keeping what an agent pushed", async () => {
    const calls: string[][] = [];
    const git = async (args: string[]) => (calls.push(args), "");
    const [x, y, w] = ["1".repeat(40), "2".repeat(40), "3".repeat(40)];
    await syncBranches(
      git,
      new Map([["inStep", x], ["pushed", x], ["goneOnGitHub", x], ["main", x], ["deletedHere", x]]),
      new Map([["inStep", y], ["pushed", y], ["newOnGitHub", y], ["main", y], ["deletedHere", y]]),
      new Map([["inStep", x], ["pushed", w], ["goneOnGitHub", x], ["main", w], ["localOnly", w]]),
      "main",
    );
    assert.deepEqual(calls.sort(), [
      ["update-ref", "-d", "refs/heads/goneOnGitHub", x],
      ["update-ref", "refs/heads/inStep", y, x],
      ["update-ref", "refs/heads/main", y, w],
      ["update-ref", "refs/heads/newOnGitHub", y, "0".repeat(40)],
    ].sort());
  });

  it("reads the quarantine from the hook's body, whatever the paths hold", () => {
    const body = `object-directory /Users/zoë/.kumiko/mirrors/a/b.git/./objects/tmp_objdir-incoming-x\nalternates /x/objects:/y\nquarantine /q\n\n${z} ${a} refs/heads/x\n`;
    assert.deepEqual(parseHookBody(body), {
      quarantine: { objectDirectory: "/Users/zoë/.kumiko/mirrors/a/b.git/./objects/tmp_objdir-incoming-x", alternates: "/x/objects:/y", quarantinePath: "/q" },
      updates: [{ old: z, new: a, ref: "refs/heads/x" }],
    });
    assert.deepEqual(parseHookBody(`object-directory \nalternates \nquarantine \n\n${z} ${a} refs/heads/x\n`).quarantine, {});
  });

  it("reads the hook's lines, and nothing else", () => {
    assert.deepEqual(parseUpdates(`${z} ${a} refs/heads/x\n\n`), [{ old: z, new: a, ref: "refs/heads/x" }]);
    assert.throws(() => parseUpdates(`${z} ${a} refs/heads/x; rm -rf /\n`.replace("refs/heads/x;", "refs/heads/x ;")));
    assert.throws(() => parseUpdates("nonsense"));
  });

});

describe("git relays, closed", () => {
  it("start nothing once closed, so a sync that was under way can't leave one running", async () => {
    let forwards = 0;
    const relays = new Relays({
      dir: await mkdtemp(join(tmpdir(), "kumiko-relay-closed-")),
      mirrors: { ensure: async () => "", fetch: async () => {}, path: () => "", root: "" } as unknown as Mirrors,
      provider: { exec: () => { throw new Error("no VM"); }, forward: () => { forwards++; throw new Error("no VM"); } },
    });
    await relays.close();
    relays.sync(new Map([["late", ["acme/widget"]]]));
    assert.equal(relays.view("late"), undefined);
    assert.equal(forwards, 0);
  });
});
