import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { GitHub, gitHubUrl } from "../src/github.js";
import { MirrorFetchFailed, MirrorNotFound, MirrorRecordError, Mirrors, objectsSize, type MirrorOptions } from "../src/mirrors.js";
import { LimaProvider, MetadataStore } from "@kumiko/sandbox";
import { startServer } from "../src/index.js";
import { sh } from "./repo.js";

const fakeGh = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/fake-gh.mjs");
const sandboxFixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../../../sandbox/fixtures");

// The mirrors' git reads the user's config, as it must for their credentials; here there is none to read.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

interface World {
  root: string;
  home: string;
  /** Stands in for github.com: `<base>/<owner>/<name>.git`. */
  base: string;
  /** A clone of acme/widget, to change "GitHub" from. */
  work: string;
}

/** A "GitHub" with acme/widget on it: main, feature and develop, which HEAD points at, and a tag. */
async function world(): Promise<World> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kumiko-mirrors-test-")));
  const base = join(root, "github");
  const upstream = join(base, "acme", "widget.git");
  await mkdir(upstream, { recursive: true });
  sh(upstream, "init", "--bare", "--quiet", "--initial-branch=main");
  const work = join(root, "work");
  sh(root, "clone", "--quiet", upstream, work);
  await writeFile(join(work, "README"), "hi\n");
  sh(work, "add", "README");
  sh(work, "commit", "--quiet", "-m", "first");
  sh(work, "tag", "v1");
  sh(work, "branch", "feature");
  sh(work, "branch", "develop");
  sh(work, "push", "--quiet", "origin", "main", "feature", "develop", "v1");
  sh(upstream, "symbolic-ref", "HEAD", "refs/heads/develop");
  return { root, home: join(root, "home"), base, work };
}

function mirrorsOf(w: World, opts: Partial<MirrorOptions> = {}): Mirrors {
  return new Mirrors({ home: w.home, remoteUrl: (repo) => `file://${w.base}/${repo.toLowerCase()}.git`, ...opts });
}

const refs = (dir: string) => sh(dir, "for-each-ref", "--format=%(refname) %(objectname)").trim().split("\n").sort();

describe("repository mirrors", () => {
  it("makes a bare mirror of GitHub's branches and tags, under Kumiko's home, with HEAD where GitHub's is", async () => {
    const w = await world();
    const mirrors = mirrorsOf(w);
    await mirrors.start();
    const path = await mirrors.ensure("Acme/Widget");
    assert.equal(path, join(w.home, "mirrors", "acme", "widget.git"));
    assert.equal(mirrors.path("acme/widget"), path, "the same mirror whatever the case");
    assert.equal(sh(path, "rev-parse", "--is-bare-repository").trim(), "true");
    assert.deepEqual(refs(path), refs(join(w.base, "acme", "widget.git")));
    assert.equal(sh(path, "symbolic-ref", "HEAD").trim(), "refs/heads/develop");

    const [m] = mirrors.list();
    assert.equal(m.repo, "Acme/Widget", "as it was first spelled");
    assert.equal(m.state, "ready");
    assert.equal(m.branches, 3);
    assert.equal(m.tags, 1);
    assert.ok(m.size && m.size > 0);
    assert.ok(m.fetchedAt);

    const record = JSON.parse(await readFile(join(w.home, "repos.json"), "utf8"));
    assert.deepEqual(record.repos.map((r: { repo: string }) => r.repo), ["Acme/Widget"]);
    await mirrors.close();
  });

  it("refuses every push, and checks the objects of one", async () => {
    const w = await world();
    const mirrors = mirrorsOf(w);
    await mirrors.start();
    const path = await mirrors.ensure("acme/widget");
    assert.equal(sh(path, "config", "receive.fsckObjects").trim(), "true");
    assert.deepEqual(await readdir(join(path, "hooks")), ["pre-receive"]);

    await writeFile(join(w.work, "README"), "changed\n");
    sh(w.work, "commit", "--quiet", "-am", "second");
    assert.throws(() => sh(w.work, "push", "--quiet", path, "HEAD:refs/heads/main"), /pushing to this mirror isn't allowed/);
    assert.throws(() => sh(w.work, "push", "--quiet", path, "HEAD:refs/heads/new"), /pushing to this mirror isn't allowed/);
    assert.deepEqual(refs(path), refs(join(w.base, "acme", "widget.git")), "nothing changed");
    await mirrors.close();
  });

  it("fetches new branches and tags and prunes deleted ones", async () => {
    const w = await world();
    const mirrors = mirrorsOf(w, { freshMs: 0 });
    await mirrors.start();
    const path = await mirrors.ensure("acme/widget");
    const upstream = join(w.base, "acme", "widget.git");
    sh(w.work, "push", "--quiet", "origin", "--delete", "feature");
    sh(w.work, "push", "--quiet", "origin", "main:refs/heads/next");
    sh(w.work, "tag", "v2");
    sh(w.work, "push", "--quiet", "origin", "v2");
    // Not branches or tags: never mirrored.
    sh(w.work, "push", "--quiet", "origin", "main:refs/pull/1/head");
    await mirrors.fetch("acme/widget");
    assert.deepEqual(refs(path), refs(upstream).filter((r) => !r.startsWith("refs/pull/")));
    assert.ok(!refs(path).some((r) => r.startsWith("refs/heads/feature ")));
    await mirrors.close();
  });

  it("lets fetches asked for close together share one", async () => {
    const w = await world();
    let changes = 0;
    const mirrors = mirrorsOf(w, { onChange: () => changes++ });
    await mirrors.start();
    await mirrors.ensure("acme/widget");
    changes = 0;
    await Promise.all([mirrors.fetch("acme/widget"), mirrors.fetch("acme/widget"), mirrors.fetch("acme/widget")]);
    // One that ended moments ago stands in for these, so none started.
    assert.equal(changes, 0);

    const later = mirrorsOf({ ...w, home: join(w.root, "home2") }, { freshMs: 0, onChange: () => changes++ });
    await later.start();
    await later.ensure("acme/widget");
    changes = 0;
    await Promise.all([later.fetch("acme/widget"), later.fetch("acme/widget"), later.fetch("acme/widget")]);
    // One fetch: it started and it ended.
    assert.equal(changes, 2);
    await mirrors.close();
    await later.close();
  });

  it("keeps what it had when a fetch fails, and says why", async () => {
    const w = await world();
    const mirrors = mirrorsOf(w, { freshMs: 0 });
    await mirrors.start();
    const path = await mirrors.ensure("acme/widget");
    const before = refs(path);
    const fetchedAt = mirrors.get("acme/widget")!.fetchedAt;
    await rm(join(w.base, "acme"), { recursive: true });
    await assert.rejects(mirrors.fetch("acme/widget"), MirrorFetchFailed);
    const m = mirrors.get("acme/widget")!;
    assert.equal(m.state, "failed");
    assert.match(m.error!.message, /does not appear to be a git repository|not found/);
    assert.equal(m.fetchedAt, fetchedAt);
    assert.deepEqual(refs(path), before);

    const missing = mirrorsOf(w);
    await assert.rejects(missing.ensure("acme/nothing-here"), MirrorFetchFailed);
    await mirrors.close();
  });

  it("rewrites config and hooks on start, clones mirrors that went missing, and deletes ones nobody picked", async () => {
    const w = await world();
    const first = mirrorsOf(w);
    await first.start();
    const path = await first.ensure("acme/widget");
    await first.close();

    // What someone else might have done there meanwhile.
    sh(path, "config", "remote.origin.url", "https://example.com/evil.git");
    sh(path, "config", "receive.fsckObjects", "false");
    sh(path, "config", "core.fsmonitor", "touch /tmp/kumiko-should-not-run");
    await writeFile(join(path, "hooks", "post-update"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(path, "hooks", "pre-receive"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const stray = join(w.home, "mirrors", "someone", "else.git");
    await mkdir(stray, { recursive: true });

    const second = mirrorsOf(w);
    await second.start();
    assert.equal(sh(path, "config", "remote.origin.url").trim(), `file://${w.base}/acme/widget.git`);
    assert.equal(sh(path, "config", "receive.fsckObjects").trim(), "true");
    assert.throws(() => sh(path, "config", "core.fsmonitor"));
    assert.deepEqual(await readdir(join(path, "hooks")), ["pre-receive"]);
    assert.match(await readFile(join(path, "hooks", "pre-receive"), "utf8"), /isn't allowed/);
    assert.equal(existsSync(join(w.home, "mirrors", "someone")), false);
    await second.close();

    await rm(path, { recursive: true });
    const third = mirrorsOf(w);
    await third.start();
    assert.equal(third.get("acme/widget")!.state, "cloning");
    assert.equal(await third.ensure("acme/widget"), path);
    assert.deepEqual(refs(path), refs(join(w.base, "acme", "widget.git")));
    await third.close();
  });

  it("runs gc when it is due", async () => {
    const w = await world();
    const mirrors = mirrorsOf(w, { freshMs: 0, gcEveryMs: 0 });
    await mirrors.start();
    const path = await mirrors.ensure("acme/widget");
    const gcAt = async () => JSON.parse(await readFile(join(w.home, "repos.json"), "utf8")).repos[0].gcAt as string;
    const first = await gcAt();
    for (let i = 0; i < 3; i++) {
      await writeFile(join(w.work, `f${i}`), `${i}\n`);
      sh(w.work, "add", ".");
      sh(w.work, "commit", "--quiet", "-m", `c${i}`);
      sh(w.work, "push", "--quiet", "origin", "main");
      await new Promise((r) => setTimeout(r, 5));
      await mirrors.fetch("acme/widget");
    }
    assert.notEqual(await gcAt(), first);
    assert.equal(sh(path, "count-objects").trim().split(" ")[0], "0", "no loose objects left");
    await mirrors.close();
  });

  it("deletes a mirror when its repository is removed, even while it is being cloned", async () => {
    const w = await world();
    const mirrors = mirrorsOf(w);
    await mirrors.start();
    const path = await mirrors.ensure("acme/widget");
    await mirrors.remove("acme/widget");
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(dirname(path)), false, "no empty owner folder left");
    assert.deepEqual(mirrors.list(), []);
    assert.deepEqual(JSON.parse(await readFile(join(w.home, "repos.json"), "utf8")).repos, []);
    await assert.rejects(mirrors.remove("acme/widget"), MirrorNotFound);

    await mirrors.add("acme/widget");
    const cloning = mirrors.ensure("acme/widget").catch(() => {});
    await mirrors.remove("acme/widget");
    await cloning;
    assert.equal(existsSync(path), false);
    assert.deepEqual(mirrors.list(), []);

    // Picked again, it is made afresh.
    assert.equal(await mirrors.ensure("acme/widget"), path);
    assert.deepEqual(refs(path), refs(join(w.base, "acme", "widget.git")));
    await mirrors.close();
  });

  it("refuses names that aren't GitHub repositories", async () => {
    const w = await world();
    const mirrors = mirrorsOf(w);
    await mirrors.start();
    for (const bad of ["acme", "acme/..", "../x/y", "acme/widget.git", "a/b/c", "-acme/x", "acme/wid get"]) {
      await assert.rejects(mirrors.add(bad), MirrorNotFound, bad);
    }
    assert.equal(existsSync(join(w.home, "repos.json")), false);
  });

  it("leaves the mirrors alone when the record can't be read", async () => {
    const w = await world();
    const first = mirrorsOf(w);
    await first.start();
    const path = await first.ensure("acme/widget");
    await first.close();
    await writeFile(join(w.home, "repos.json"), "{ not json");
    const second = mirrorsOf(w);
    await second.start();
    assert.match(second.readError!, /repos\.json, can't be read/);
    assert.ok(existsSync(path));
    // Nor is the file written over, so it can still be fixed.
    await assert.rejects(second.add("acme/other"), MirrorRecordError);
    await assert.rejects(second.ensure("acme/other"), MirrorRecordError);
    assert.equal(await readFile(join(w.home, "repos.json"), "utf8"), "{ not json");
  });

  it("starts even when a mirror can't be rewritten, and says so on its row", async () => {
    const w = await world();
    const first = mirrorsOf(w);
    await first.start();
    const path = await first.ensure("acme/widget");
    await first.close();
    await chmod(path, 0o555);
    try {
      const second = mirrorsOf(w);
      await second.start();
      const m = second.get("acme/widget")!;
      assert.equal(m.state, "failed");
      assert.match(m.error!.message, /couldn't rewrite the mirror's config and hooks/);
    } finally {
      await chmod(path, 0o755);
    }
  });

  it("hands out a mirror it has even when its last fetch failed", async () => {
    const w = await world();
    const mirrors = mirrorsOf(w, { freshMs: 0 });
    await mirrors.start();
    const path = await mirrors.ensure("acme/widget");
    await rm(join(w.base, "acme"), { recursive: true });
    await assert.rejects(mirrors.fetch("acme/widget"), MirrorFetchFailed);
    assert.equal(await mirrors.ensure("acme/widget"), path);
    await mirrors.close();
  });

  it("doesn't run gc right after a first clone that worked only on a retry", async () => {
    const w = await world();
    await rm(join(w.base, "acme"), { recursive: true });
    const mirrors = mirrorsOf(w, { gcEveryMs: 0 });
    await mirrors.start();
    await assert.rejects(mirrors.ensure("acme/widget"), MirrorFetchFailed);
    await mkdir(join(w.base, "acme"), { recursive: true });
    sh(w.root, "clone", "--quiet", "--bare", w.work, join(w.base, "acme", "widget.git"));
    const path = await mirrors.ensure("acme/widget");
    const record = JSON.parse(await readFile(join(w.home, "repos.json"), "utf8")).repos[0];
    assert.equal(record.gcAt, record.fetchedAt, "counted as a first clone");
    assert.notEqual(sh(path, "count-objects").trim().split(" ")[0], "0", "gc didn't pack the loose objects");
    await mirrors.close();
  });
});

describe("the GitHub CLI", () => {
  let dir: string;
  let gh: GitHub;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "kumiko-gh-test-"));
    process.env.FAKE_GH_DIR = dir;
    gh = new GitHub({ gh: fakeGh });
  });

  it("says when gh isn't installed", async () => {
    assert.deepEqual(await new GitHub({ gh: join(dir, "no-such-gh") }).account(), { status: "missing" });
  });

  it("says when gh isn't signed in, with what it printed", async () => {
    const a = await gh.account();
    assert.equal(a.status, "signed-out");
    assert.match((a as { detail: string }).detail, /not logged into any GitHub hosts/);
  });

  it("names the account, with an avatar only from GitHub's image host", async () => {
    await writeFile(join(dir, "user.json"), JSON.stringify({ login: "octo", name: "Octo Cat", avatar_url: "https://avatars.githubusercontent.com/u/1?v=4" }));
    assert.deepEqual(await gh.account(), { status: "signed-in", login: "octo", name: "Octo Cat", avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4" });
    await writeFile(join(dir, "user.json"), JSON.stringify({ login: "octo", avatar_url: "https://evil.example/a.png" }));
    assert.deepEqual(await gh.account(), { status: "signed-in", login: "octo" });
  });

  it("lists the repos, most recently pushed first, skipping names it can't mirror", async () => {
    await writeFile(join(dir, "user.json"), JSON.stringify({ login: "octo" }));
    await writeFile(
      join(dir, "repos.json"),
      JSON.stringify([
        { full_name: "octo/old", private: false, fork: false, archived: true, description: "line one\nline two", pushed_at: "2020-01-01T00:00:00Z" },
        { full_name: "acme/new", private: true, fork: true, archived: false, description: null, pushed_at: "2026-01-01T00:00:00Z" },
        { full_name: "../escape", private: false, fork: false, archived: false },
      ]),
    );
    assert.deepEqual(await gh.repos(), [
      { repo: "acme/new", private: true, fork: true, archived: false, pushedAt: "2026-01-01T00:00:00Z" },
      { repo: "octo/old", private: false, fork: false, archived: true, description: "line one\nline two", pushedAt: "2020-01-01T00:00:00Z" },
    ]);
  });

  it("has mirrors fetch over HTTPS with gh's token, never asking the user's own credential helpers", async () => {
    assert.equal(gitHubUrl("acme/widget"), "https://github.com/acme/widget.git");
    const w = await world();
    const mirrors = mirrorsOf(w, { credentialHelper: gh.credentialHelper() });
    await mirrors.start();
    const path = await mirrors.ensure("acme/widget");
    // The user's own helper, as osxkeychain would be: it mustn't be asked.
    const global = join(w.root, "gitconfig");
    await writeFile(global, `[credential]\n\thelper = "!f() { echo password=from-keychain; }; f"\n`);
    const fill = (host: string) =>
      execFileSync("git", ["credential", "fill"], { cwd: path, input: `protocol=https\nhost=${host}\n\n`, env: { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_TERMINAL_PROMPT: "0" }, stdio: "pipe" }).toString();
    assert.match(fill("github.com"), /^password=fake-token$/m);
    assert.throws(() => fill("example.com"), "only gh is asked, and it knows only GitHub");
    await mirrors.close();
  });
});

describe("the Repos page's API", () => {
  it("adds, fetches and removes mirrors, and lists the account's repos", async () => {
    const w = await world();
    const ghDir = join(w.root, "gh");
    await mkdir(ghDir);
    process.env.FAKE_GH_DIR = ghDir;
    await writeFile(join(ghDir, "user.json"), JSON.stringify({ login: "octo", avatar_url: "https://avatars.githubusercontent.com/u/1" }));
    await writeFile(join(ghDir, "repos.json"), JSON.stringify([{ full_name: "acme/widget", private: true, fork: false, archived: false }]));
    process.env.FAKE_LIMA_DIR = join(w.root, "lima");
    await mkdir(process.env.FAKE_LIMA_DIR);
    const provider = new LimaProvider({ limactl: join(sandboxFixtures, "fake-limactl.mjs"), metadata: new MetadataStore(join(w.root, "sandboxes")) });
    const server = await startServer({
      provider,
      port: 0,
      dataDir: w.home,
      sessionsDir: join(w.home, "sessions"),
      github: new GitHub({ gh: fakeGh }),
      repoUrl: (repo) => `file://${w.base}/${repo.toLowerCase()}.git`,
    });
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${server.url}${path}`, { method, headers: { authorization: `Bearer ${server.token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: r.status, body: (await r.json()) as any };
    };
    try {
      assert.deepEqual((await call("GET", "/api/github/account")).body, { status: "signed-in", login: "octo", avatarUrl: "https://avatars.githubusercontent.com/u/1" });
      assert.deepEqual((await call("GET", "/api/github/repos")).body.repos.map((r: { repo: string }) => r.repo), ["acme/widget"]);
      assert.deepEqual(await call("GET", "/api/mirrors"), { status: 200, body: { mirrors: [] } });

      assert.equal((await call("POST", "/api/mirrors", { repo: "../etc" })).status, 400);
      const added = await call("POST", "/api/mirrors", { repo: "acme/widget", private: true });
      assert.equal(added.status, 201);
      assert.equal(added.body.private, true);
      // The clone runs in the background; the page follows it.
      let m;
      for (let i = 0; i < 100 && (m = (await call("GET", "/api/mirrors")).body.mirrors[0]).state !== "ready"; i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(m.state, "ready");
      assert.equal(m.path, join(w.home, "mirrors", "acme", "widget.git"));

      assert.equal((await call("POST", "/api/mirrors/acme/widget/fetch")).status, 202);
      assert.equal((await call("POST", "/api/mirrors/acme/nope/fetch")).status, 404);
      assert.equal((await call("DELETE", "/api/mirrors/acme/widget")).status, 200);
      assert.deepEqual((await call("GET", "/api/mirrors")).body, { mirrors: [] });
      assert.equal(existsSync(m.path), false);
      assert.equal((await call("DELETE", "/api/mirrors/acme/widget")).status, 404);
    } finally {
      await server.close();
    }
  });
});

/**
 * A "GitHub" reached through git's ext:: transport, so each connection runs a script first: the n-th connection
 * (counting from 1) can be held up for a while, or refused. The script counts connections in `count`.
 */
async function slowGitHub(w: World, opts: { slow?: number; fail?: number }): Promise<{ url: string; count(): Promise<number> }> {
  const script = join(w.root, "connect.sh");
  const count = join(w.root, "count");
  await writeFile(
    script,
    `#!/bin/sh
n=$(( $(cat '${count}' 2>/dev/null || echo 0) + 1 ))
echo $n > '${count}'
[ "$n" = "${opts.fail ?? 0}" ] && exit 1
[ "$n" = "${opts.slow ?? 0}" ] && sleep 3
exec "$1" "$2"
`,
    { mode: 0o755 },
  );
  return { url: `ext::${script} %S ${join(w.base, "acme", "widget.git")}`, count: async () => Number(await readFile(count, "utf8").catch(() => "0")) };
}

describe("repository mirrors, connection by connection", () => {
  before(() => {
    // ext:: is off by default; only these tests' git may use it.
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "protocol.ext.allow";
    process.env.GIT_CONFIG_VALUE_0 = "always";
  });
  after(() => {
    delete process.env.GIT_CONFIG_COUNT;
    delete process.env.GIT_CONFIG_KEY_0;
    delete process.env.GIT_CONFIG_VALUE_0;
  });

  it("keeps a fetch that worked when Kumiko quits during what comes after it", async () => {
    const w = await world();
    // The first clone's second connection asks where HEAD points: held up, then Kumiko quits.
    const gh = await slowGitHub(w, { slow: 2 });
    const mirrors = mirrorsOf(w, { remoteUrl: () => gh.url });
    await mirrors.start();
    const cloning = mirrors.ensure("acme/widget").catch(() => {});
    while ((await gh.count()) < 2) await new Promise((r) => setTimeout(r, 20));
    await mirrors.close();
    await cloning;
    const record = JSON.parse(await readFile(join(w.home, "repos.json"), "utf8")).repos[0];
    assert.ok(record.fetchedAt, "the fetch is recorded");
    assert.equal(record.error, undefined);
  });

  it("asks GitHub where HEAD points only when it needs to, and copes when it can't", async () => {
    const w = await world();
    // The first clone's second connection, where HEAD points, is refused.
    const gh = await slowGitHub(w, { fail: 2 });
    const mirrors = mirrorsOf(w, { remoteUrl: () => gh.url, freshMs: 0 });
    await mirrors.start();
    const path = await mirrors.ensure("acme/widget");
    assert.equal(sh(path, "symbolic-ref", "HEAD").trim(), "refs/heads/main", "a branch that is there");
    const before = await gh.count();
    await mirrors.fetch("acme/widget");
    assert.equal((await gh.count()) - before, 1, "one connection: the fetch");
    await mirrors.close();
  });
});

describe("a mirror's size", () => {
  it("is what git counts of its objects", () => {
    assert.equal(objectsSize("count: 3\nsize: 12\nin-pack: 9\npacks: 1\nsize-pack: 100\nprune-packable: 0\ngarbage: 0\nsize-garbage: 4\n"), 116 * 1024);
  });
});
