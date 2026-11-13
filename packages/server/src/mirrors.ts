import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseRepo, type MirrorView } from "@kumiko/shared";
import { GitError, runGit } from "./git.js";

/** Not a repository's name, or one that isn't picked. */
export class MirrorNotFound extends Error {}

/** A fetch didn't work; the message is git's. */
export class MirrorFetchFailed extends Error {}

/** What is kept of each picked repository in `repos.json`, beside Kumiko's other data. */
interface RepoRecord {
  repo: string;
  /** Where its mirror fetches from, fixed when it was picked. */
  url: string;
  addedAt: string;
  private?: boolean;
  fetchedAt?: string;
  error?: { message: string; at: string };
  gcAt?: string;
  size?: number;
  branches?: number;
  tags?: number;
}

interface Entry {
  key: string;
  record: RepoRecord;
  /** The fetch (and gc after it) under way, which later requests join. */
  running?: Promise<void>;
  startedAt?: string;
  /** The fetch under way makes the mirror: there was none. */
  cloning?: boolean;
  abort?: AbortController;
  /** When the last fetch ended, by the clock, for "close together". */
  endedAt?: number;
  /** Removed while a fetch ran: its end mustn't write anything back. */
  removed?: boolean;
}

export interface MirrorOptions {
  /** Kumiko's home: the record is `repos.json` in it, the mirrors under `mirrors/`. */
  home: string;
  /** Where a newly picked repository is fetched from. */
  remoteUrl(repo: string): string | Promise<string>;
  /** Called after anything a mirror's view shows changes. */
  onChange?(): void;
  /** Fetches asked for within this long of the last one's end share it; 5 s by default. */
  freshMs?: number;
  /** How long between `git gc` runs in a mirror; a week by default. */
  gcEveryMs?: number;
  /** How long a fetch or a gc may run, in ms; an hour by default, for a first clone of a big repository. */
  fetchTimeoutMs?: number;
}

const HOOK_MESSAGE = "Kumiko: pushing to this mirror isn't allowed.";

/**
 * The only hook in a mirror. Pushes are closed for now: later the hook will ask Kumiko whether each ref update is
 * allowed, so the mirror starts closed and is opened deliberately.
 */
const PRE_RECEIVE = `#!/bin/sh
# Written by Kumiko, and rewritten whenever it starts.
echo "${HOOK_MESSAGE}" >&2
exit 1
`;

/**
 * The whole of a mirror's config, rewritten on every start. Only GitHub's branches and tags, pruned, so the mirror
 * holds nothing that isn't on GitHub and can always be deleted and made again. gc is Kumiko's to run, never git's on
 * its own; pushes are checked object by object; and the hooks are the mirror's own, whatever the user's
 * core.hooksPath says.
 */
function mirrorConfig(dir: string, url: string): string {
  const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `# Written by Kumiko, and rewritten whenever it starts.
[core]
\trepositoryformatversion = 0
\tbare = true
\tlogAllRefUpdates = false
\thooksPath = ${quote(join(dir, "hooks"))}
[remote "origin"]
\turl = ${quote(url)}
\tfetch = +refs/heads/*:refs/heads/*
\tfetch = +refs/tags/*:refs/tags/*
\tprune = true
[gc]
\tauto = 0
[receive]
\tfsckObjects = true
`;
}

/**
 * The environment git runs in: the user's own, so fetches use their usual credentials and SSH setup, without any of
 * git's variables that would point it at another repository, and never waiting on a prompt nobody can see.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES"]) {
    delete env[name];
  }
  return env;
}

const exists = (path: string) => lstat(path).then(() => true, () => false);

/** The bytes a folder takes, files and all; links are counted as themselves, not followed. */
async function dirSize(path: string): Promise<number> {
  let total = 0;
  for (const d of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const p = join(path, d.name);
    if (d.isDirectory()) total += await dirSize(p);
    else total += await lstat(p).then((s) => s.size, () => 0);
  }
  return total;
}

/** git's complaint, without the progress lines a fetch can print before it. */
function gitMessage(err: unknown): string {
  if (err instanceof GitError) {
    const lines = (err.stderr || err.message).split("\n").filter((l) => l.trim() && !/^(remote: )?(Counting|Compressing|Enumerating|Receiving|Resolving|Total) /.test(l));
    return lines.slice(-6).join("\n").slice(0, 2000) || err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * The bare mirrors of the GitHub repositories the user picked, one per repository at `mirrors/<owner>/<name>.git`
 * in Kumiko's home, shared by every project that uses it. Kumiko owns them completely: it makes them, fetches into
 * them, runs gc in them, rewrites their config and hooks on every start, and deletes them. Nobody else runs git there.
 */
export class Mirrors {
  readonly root: string;
  private readonly file: string;
  private entries = new Map<string, Entry>();
  /** Removals under way, by key: a repository picked again meanwhile waits for its old mirror to be gone. */
  private removing = new Map<string, Promise<void>>();
  private saving: Promise<void> = Promise.resolve();
  private started = false;
  /** Why `repos.json` couldn't be read when Kumiko started; the mirrors are left alone then, not swept. */
  readError?: string;

  constructor(private readonly opts: MirrorOptions) {
    this.root = join(opts.home, "mirrors");
    this.file = join(opts.home, "repos.json");
  }

  /** Where a repository's mirror is, or would be, without touching anything. Lowercase, as GitHub ignores case. */
  path(repo: string): string {
    const r = parseRepo(repo);
    if (!r) throw new MirrorNotFound(`Not a GitHub repository: ${repo}. Give it as owner/name.`);
    const [owner, name] = r.key.split("/");
    return join(this.root, owner, `${name}.git`);
  }

  /**
   * Reads the picked repositories, rewrites each mirror's config and hooks, deletes folders under `mirrors/` that
   * aren't a picked repository's, and starts cloning the picked ones whose mirror is missing or was never finished.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    let records: RepoRecord[] = [];
    try {
      records = await this.read();
    } catch (err) {
      this.readError = `Kumiko's list of repositories, ${this.file}, can't be read (${err instanceof Error ? err.message : String(err)}). Fix the file, or delete it to start again with none.`;
    }
    for (const record of records) {
      const r = parseRepo(record.repo);
      if (!r || typeof record.url !== "string" || this.entries.has(r.key)) continue;
      this.entries.set(r.key, { key: r.key, record });
    }
    if (!this.readError) await this.sweep();
    for (const e of this.entries.values()) {
      const dir = this.path(e.record.repo);
      if (e.record.fetchedAt && (await exists(join(dir, "HEAD")))) await this.writeOwn(dir, e.record.url);
      else void this.fetchEntry(e).catch(() => {});
    }
  }

  /** Stops the fetches under way and waits for them to end, and for the record to be written. */
  async close(): Promise<void> {
    for (const e of this.entries.values()) e.abort?.abort();
    await Promise.all([...this.entries.values()].map((e) => e.running?.catch(() => {})));
    await this.saving;
  }

  list(): MirrorView[] {
    return [...this.entries.values()].sort((a, b) => a.key.localeCompare(b.key)).map((e) => this.view(e));
  }

  /** The repository's mirror as the page shows it, or undefined if it isn't picked. */
  get(repo: string): MirrorView | undefined {
    const e = this.entryOf(repo);
    return e && this.view(e);
  }

  /** Picks a repository, without fetching it; the record keeps how GitHub spells it, the first time. */
  async add(repo: string, opts: { private?: boolean } = {}): Promise<MirrorView> {
    return this.view(await this.addEntry(repo, opts));
  }

  private async addEntry(repo: string, opts: { private?: boolean }): Promise<Entry> {
    const r = parseRepo(repo);
    if (!r) throw new MirrorNotFound(`Not a GitHub repository: ${repo}. Give it as owner/name.`);
    const existing = this.entries.get(r.key);
    if (existing) return existing;
    await this.removing.get(r.key);
    const record: RepoRecord = { repo: r.repo, url: await this.opts.remoteUrl(r.repo), addedAt: new Date().toISOString() };
    if (opts.private !== undefined) record.private = opts.private;
    // Looked up again: another add may have got here while the URL was worked out.
    let e = this.entries.get(r.key);
    if (!e) {
      e = { key: r.key, record };
      this.entries.set(r.key, e);
      await this.save();
      this.changed();
    }
    return e;
  }

  /**
   * Picks the repository if it isn't, makes its mirror if there is none, and resolves with the mirror's path once it
   * has been fetched at least once. A mirror already there isn't fetched again: call \`fetch\` for that.
   */
  async ensure(repo: string, opts: { private?: boolean } = {}): Promise<string> {
    const e = await this.addEntry(repo, opts);
    const dir = this.path(repo);
    if (!e.record.fetchedAt || !(await exists(join(dir, "HEAD")))) await this.fetchEntry(e);
    if (e.removed) throw new MirrorNotFound(`${repo} was removed.`);
    if (!e.record.fetchedAt || e.record.error) throw new MirrorFetchFailed(e.record.error?.message ?? `${repo} couldn't be fetched.`);
    return dir;
  }

  /**
   * Fetches GitHub's branches and tags into the mirror, making it first if needed, and runs gc when it is due.
   * Joins a fetch under way, and one that ended less than `freshMs` ago and worked stands in for a new one.
   * Rejects with git's message if the fetch fails.
   */
  async fetch(repo: string): Promise<void> {
    const e = this.entryOf(repo);
    if (!e) throw new MirrorNotFound(`${repo} isn't one of Kumiko's repositories.`);
    const fresh = e.endedAt !== undefined && Date.now() - e.endedAt < (this.opts.freshMs ?? 5000) && !e.record.error;
    if (!e.running && fresh && (await exists(join(this.path(repo), "HEAD")))) return;
    await this.fetchEntry(e);
    if (e.record.error) throw new MirrorFetchFailed(e.record.error.message);
  }

  /** Unpicks a repository and deletes its mirror, stopping a fetch under way first. */
  async remove(repo: string): Promise<void> {
    const e = this.entryOf(repo);
    if (!e) throw new MirrorNotFound(`${repo} isn't one of Kumiko's repositories.`);
    const done = (async () => {
      this.entries.delete(e.key);
      e.removed = true;
      e.abort?.abort();
      await e.running?.catch(() => {});
      await this.save();
      const dir = this.path(e.record.repo);
      await rm(dir, { recursive: true, force: true });
      await rmdir(dirname(dir)).catch(() => {});
    })();
    this.removing.set(e.key, done);
    try {
      await done;
    } finally {
      if (this.removing.get(e.key) === done) this.removing.delete(e.key);
      this.changed();
    }
  }

  private entryOf(repo: string): Entry | undefined {
    const r = parseRepo(repo);
    return r && this.entries.get(r.key);
  }

  private view(e: Entry): MirrorView {
    const { record: r } = e;
    const state = e.running ? (e.cloning || !r.fetchedAt ? "cloning" : "fetching") : r.error ? "failed" : r.fetchedAt ? "ready" : "cloning";
    return {
      repo: r.repo,
      path: this.path(r.repo),
      addedAt: r.addedAt,
      state,
      ...(r.private !== undefined ? { private: r.private } : {}),
      ...(e.running && e.startedAt ? { startedAt: e.startedAt } : {}),
      ...(r.fetchedAt ? { fetchedAt: r.fetchedAt } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(r.size !== undefined ? { size: r.size } : {}),
      ...(r.branches !== undefined ? { branches: r.branches } : {}),
      ...(r.tags !== undefined ? { tags: r.tags } : {}),
    };
  }

  /** Starts a fetch, or joins the one under way. Never rejects: how it went is in the record. */
  private fetchEntry(e: Entry): Promise<void> {
    if (e.running) return e.running;
    if (e.removed) return Promise.resolve();
    e.cloning = !existsSync(join(this.path(e.record.repo), "HEAD"));
    const abort = new AbortController();
    e.abort = abort;
    e.startedAt = new Date().toISOString();
    const run = this.runFetch(e, abort.signal).finally(() => {
      e.running = undefined;
      e.abort = undefined;
      e.endedAt = Date.now();
      if (!e.removed) this.changed();
    });
    e.running = run;
    this.changed();
    return run;
  }

  private async runFetch(e: Entry, signal: AbortSignal): Promise<void> {
    const dir = this.path(e.record.repo);
    const env = gitEnv();
    const timeoutMs = this.opts.fetchTimeoutMs ?? 60 * 60_000;
    const git = (args: string[], ms = 60_000) => runGit(dir, args, { env, signal, timeoutMs: ms });
    const update: Partial<RepoRecord> = {};
    try {
      const made = !(await exists(join(dir, "HEAD")));
      if (made) {
        await mkdir(dir, { recursive: true });
        // No template: its sample hooks and excludes are of no use in a mirror.
        await runGit(this.root, ["init", "--bare", "--quiet", "--template=", dir], { env, signal });
      }
      await this.writeOwn(dir, e.record.url);
      await git(["fetch", "--quiet", "--prune", "--no-write-fetch-head", "origin"], timeoutMs);
      await this.followHead(dir, git);
      const refs = await git(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"]);
      const names = refs.split("\n").filter(Boolean);
      update.branches = names.filter((n) => n.startsWith("refs/heads/")).length;
      update.tags = names.length - update.branches;
      const now = new Date().toISOString();
      update.fetchedAt = now;
      update.error = undefined;
      // A first clone arrives as one pack, so its gc is as good as done.
      const gcAt = made ? undefined : e.record.gcAt;
      if (made) update.gcAt = now;
      else if (!gcAt || Date.now() - Date.parse(gcAt) > (this.opts.gcEveryMs ?? 7 * 24 * 60 * 60_000)) {
        await git(["gc", "--quiet"], timeoutMs);
        update.gcAt = new Date().toISOString();
      }
    } catch (err) {
      // Stopped because the repository was removed or Kumiko is quitting: not a failure to show.
      if (signal.aborted) return;
      update.error = { message: gitMessage(err), at: new Date().toISOString() };
    }
    if (e.removed) return;
    update.size = await dirSize(dir);
    Object.assign(e.record, update);
    if (!e.record.error) delete e.record.error;
    await this.save();
  }

  /** Points the mirror's HEAD where GitHub's points, so a clone from it checks out the default branch. */
  private async followHead(dir: string, git: (args: string[]) => Promise<string>): Promise<void> {
    const out = await git(["ls-remote", "--symref", "origin", "HEAD"]).catch(() => "");
    const ref = /^ref: (refs\/heads\/\S+)\tHEAD$/m.exec(out)?.[1];
    if (ref) await git(["symbolic-ref", "HEAD", ref]);
  }

  /** Writes the mirror's config and hooks as Kumiko has them, replacing whatever is there. */
  private async writeOwn(dir: string, url: string): Promise<void> {
    await replace(join(dir, "config"), mirrorConfig(dir, url));
    const hooks = join(dir, "hooks");
    await rm(hooks, { recursive: true, force: true });
    await mkdir(hooks);
    await writeFile(join(hooks, "pre-receive"), PRE_RECEIVE, { mode: 0o755 });
  }

  /** Deletes what is under `mirrors/` but isn't a picked repository's mirror: left by a removal cut short, say. */
  private async sweep(): Promise<void> {
    const keep = new Set([...this.entries.values()].map((e) => this.path(e.record.repo)));
    for (const owner of await readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      const ownerDir = join(this.root, owner.name);
      if (!owner.isDirectory()) {
        await rm(ownerDir, { force: true });
        continue;
      }
      for (const repo of await readdir(ownerDir).catch(() => [])) {
        const dir = join(ownerDir, repo);
        if (!keep.has(dir)) await rm(dir, { recursive: true, force: true });
      }
      await rmdir(ownerDir).catch(() => {});
    }
  }

  private async read(): Promise<RepoRecord[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const data = JSON.parse(text) as { repos?: unknown };
    return Array.isArray(data?.repos) ? (data.repos as RepoRecord[]).filter((r) => r && typeof r === "object") : [];
  }

  /** Writes the record, one write at a time, each with what is picked by then. */
  private save(): Promise<void> {
    const next = this.saving.then(async () => {
      const repos = [...this.entries.values()].sort((a, b) => a.key.localeCompare(b.key)).map((e) => e.record);
      await mkdir(dirname(this.file), { recursive: true });
      await replace(this.file, JSON.stringify({ repos }, null, 2) + "\n");
    });
    this.saving = next.catch(() => {});
    return next;
  }

  private changed(): void {
    this.opts.onChange?.();
  }
}

/** Writes a file whole, through a temporary one, so a crash never leaves half of it. */
async function replace(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}
