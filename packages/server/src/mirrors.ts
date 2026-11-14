import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseRepo, type MirrorView } from "@kumiko/shared";
import { replaceFile } from "./files.js";
import { GitError, runGit } from "./git.js";

/** Not a repository's name, or one that isn't picked. */
export class MirrorNotFound extends Error {}

/** A fetch didn't work; the message is git's. */
export class MirrorFetchFailed extends Error {}

/** `repos.json` couldn't be read when Kumiko started, so nothing is written over it until it is fixed. */
export class MirrorRecordError extends Error {}

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
  /**
   * The branches that first reached GitHub through a project's relay, by name, with the project and when it last
   * pushed: that project's agent may update, force-push and delete them. Dropped when the branch leaves GitHub.
   */
  created?: Record<string, { project: string; at: string }>;
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
  /**
   * The only git credential helper the mirrors use, in place of the user's own (the macOS keychain, say): gh's, so
   * fetches sign in with gh's token. Without it, git asks the user's helpers.
   */
  credentialHelper?: string;
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
 * The only hook in a mirror. A push that comes through a project's relay is in a git daemon Kumiko started, which
 * says in its environment how to reach Kumiko and which connection it is: the hook hands Kumiko the ref updates and
 * the quarantine they wait in, prints what Kumiko says, and exits with the code Kumiko gives, its last line. Kumiko
 * pushes them on to GitHub before answering. Any other push, or one Kumiko can't be asked about, is refused.
 */
const PRE_RECEIVE = `#!/bin/sh
# Written by Kumiko, and rewritten whenever it starts.
if [ -z "$KUMIKO_HOOK_SOCKET" ] || [ -z "$KUMIKO_CONNECTION" ]; then
  echo "${HOOK_MESSAGE}" >&2
  exit 1
fi
curl -sS -N --max-time 7200 --unix-socket "$KUMIKO_HOOK_SOCKET" \\
  -H "X-Kumiko-Connection: $KUMIKO_CONNECTION" \\
  -H "X-Git-Object-Directory: $GIT_OBJECT_DIRECTORY" \\
  -H "X-Git-Alternate-Object-Directories: $GIT_ALTERNATE_OBJECT_DIRECTORIES" \\
  -H "X-Git-Quarantine-Path: $GIT_QUARANTINE_PATH" \\
  --data-binary @- http://kumiko/pre-receive | {
  code=1
  while IFS= read -r line; do
    case "$line" in
      "kumiko-exit "*) code=\${line#kumiko-exit } ;;
      *) printf '%s\\n' "$line" >&2 ;;
    esac
  done
  [ "$code" = 0 ] || [ "$code" = 1 ] || code=1
  exit "$code"
}
`;

/**
 * The whole of a mirror's config, rewritten on every start. Only GitHub's branches and tags, pruned, so the mirror
 * holds nothing that isn't on GitHub and can always be deleted and made again. gc is Kumiko's to run, never git's on
 * its own; pushes are checked object by object; and the hooks are the mirror's own, whatever the user's
 * core.hooksPath says. With a credential helper, the empty one before it drops the user's helpers, so only it is asked.
 */
function mirrorConfig(dir: string, url: string, credentialHelper?: string): string {
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
${credentialHelper ? `[credential]\n\thelper =\n\thelper = ${quote(credentialHelper)}\n` : ""}`;
}

/**
 * The environment git runs in: the user's own, so fetches use their usual credentials and SSH setup, without any of
 * git's variables that would point it at another repository, and never waiting on a prompt nobody can see.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES"]) {
    delete env[name];
  }
  return env;
}

const exists = (path: string) => lstat(path).then(() => true, () => false);

/** The bytes a mirror's objects take, loose, packed and garbage, as git counts them: no walk over every file. */
export function objectsSize(countObjects: string): number {
  let kib = 0;
  for (const m of countObjects.matchAll(/^(size|size-pack|size-garbage): (\d+)$/gm)) kib += Number(m[2]);
  return kib * 1024;
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
    // Nothing here may keep Kumiko from starting: what goes wrong is shown on the page instead.
    if (!this.readError) await this.sweep().catch((err) => console.error(`Couldn't tidy ${this.root}: ${err instanceof Error ? err.message : String(err)}`));
    for (const e of this.entries.values()) {
      const dir = this.path(e.record.repo);
      if (!e.record.fetchedAt || !(await exists(join(dir, "HEAD")))) {
        void this.fetchEntry(e);
        continue;
      }
      try {
        await this.writeOwn(dir, e.record.url);
      } catch (err) {
        e.record.error = { message: `Kumiko couldn't rewrite the mirror's config and hooks: ${err instanceof Error ? err.message : String(err)}`, at: new Date().toISOString() };
      }
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

  /** Picks a repository and starts making its mirror if there is none, without waiting for it: for the page. */
  async pick(repo: string, opts: { private?: boolean } = {}): Promise<MirrorView> {
    const e = await this.addEntry(repo, opts);
    void this.ensureEntry(e).catch(() => {});
    return this.view(e);
  }

  private async addEntry(repo: string, opts: { private?: boolean }): Promise<Entry> {
    const r = parseRepo(repo);
    if (!r) throw new MirrorNotFound(`Not a GitHub repository: ${repo}. Give it as owner/name.`);
    const existing = this.entries.get(r.key);
    if (existing) return existing;
    if (this.readError) throw new MirrorRecordError(this.readError);
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
   * has been fetched at least once. A mirror already there isn't fetched again, and is used even if its last fetch
   * failed: call \`fetch\` for fresh refs.
   */
  async ensure(repo: string, opts: { private?: boolean } = {}): Promise<string> {
    return this.ensureEntry(await this.addEntry(repo, opts));
  }

  private async ensureEntry(e: Entry): Promise<string> {
    const dir = this.path(e.record.repo);
    if (e.record.fetchedAt && (await exists(join(dir, "HEAD")))) return dir;
    await this.fetchEntry(e);
    if (e.removed) throw new MirrorNotFound(`${e.record.repo} was removed.`);
    if (e.record.error || !e.record.fetchedAt) throw new MirrorFetchFailed(e.record.error?.message ?? `${e.record.repo} couldn't be fetched.`);
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

  /** The URL a repository's mirror fetches from, and pushes go on to: GitHub's. */
  url(repo: string): string {
    const e = this.entryOf(repo);
    if (!e) throw new MirrorNotFound(`${repo} isn't one of Kumiko's repositories.`);
    return e.record.url;
  }

  /** The project whose agent created `branch` on GitHub through the relay, if one did. */
  createdBy(repo: string, branch: string): string | undefined {
    return this.entryOf(repo)?.record.created?.[branch]?.project;
  }

  /** The branches `project`'s agent created that are still on GitHub, newest push first. */
  branchesOf(repo: string, project: string): { name: string; at: string }[] {
    const created = this.entryOf(repo)?.record.created ?? {};
    return Object.entries(created)
      .filter(([, c]) => c.project === project)
      .map(([name, c]) => ({ name, at: c.at }))
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  /** Records pushes GitHub accepted: each branch as `project`'s, or, when deleted, as nobody's. */
  async noteBranches(repo: string, project: string, changes: { branch: string; deleted: boolean }[]): Promise<void> {
    const e = this.entryOf(repo);
    if (!e || !changes.length) return;
    const created = { ...e.record.created };
    const at = new Date().toISOString();
    for (const c of changes) {
      if (c.deleted) delete created[c.branch];
      else created[c.branch] = { project, at };
    }
    e.record.created = created;
    if (!Object.keys(created).length) delete e.record.created;
    await this.save().catch(() => {});
    this.changed();
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
    // Never fetched yet, after a first clone that failed too: what arrives now is the whole repository in one pack.
    const first = !e.record.fetchedAt || !(await exists(join(dir, "HEAD")));
    try {
      if (!(await exists(join(dir, "HEAD")))) {
        await mkdir(dir, { recursive: true });
        // No template: its sample hooks and excludes are of no use in a mirror.
        await runGit(this.root, ["init", "--bare", "--quiet", "--template=", dir], { env, signal });
      }
      await this.writeOwn(dir, e.record.url);
      await git(["fetch", "--quiet", "--prune", "--no-write-fetch-head", "origin"], timeoutMs);
      // From here on the fetch has worked, and is kept even if what follows is stopped or fails.
      update.fetchedAt = new Date().toISOString();
      update.error = undefined;
      const gcDue = !first && (!e.record.gcAt || Date.now() - Date.parse(e.record.gcAt) > (this.opts.gcEveryMs ?? 7 * 24 * 60 * 60_000));
      // Asking GitHub where HEAD points costs another connection, so only when it matters: a new mirror, a HEAD
      // whose branch is gone, and with the weekly gc, for a default branch renamed on GitHub.
      if (first || gcDue || !(await git(["rev-parse", "--verify", "--quiet", "HEAD"]).then(() => true, () => false))) await this.followHead(git);
      const refs = await git(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"]);
      const names = refs.split("\n").filter(Boolean);
      update.branches = names.filter((n) => n.startsWith("refs/heads/")).length;
      update.tags = names.length - update.branches;
      // A branch gone from GitHub is nobody's: if the agent pushes one by that name again, it is a new one.
      if (e.record.created) {
        const kept = Object.entries(e.record.created).filter(([b]) => names.includes(`refs/heads/${b}`));
        update.created = kept.length ? Object.fromEntries(kept) : undefined;
      }
      if (first) update.gcAt = update.fetchedAt;
      else if (gcDue) {
        await git(["gc", "--quiet"], timeoutMs);
        update.gcAt = new Date().toISOString();
      }
    } catch (err) {
      // Stopped because the repository was removed or Kumiko is quitting: not a failure to show.
      if (!signal.aborted) update.error = { message: gitMessage(err), at: new Date().toISOString() };
    }
    if (e.removed || (signal.aborted && !update.fetchedAt)) return;
    update.size = await runGit(dir, ["count-objects", "-v"], { env }).then(objectsSize, () => e.record.size);
    Object.assign(e.record, update);
    if (!e.record.error) delete e.record.error;
    if (!e.record.created) delete e.record.created;
    await this.save().catch(() => {});
  }

  /**
   * Points the mirror's HEAD where GitHub's points, so a clone from it checks out the default branch. If GitHub can't
   * be asked, a HEAD whose branch is missing goes to main, master or the first branch there is.
   */
  private async followHead(git: (args: string[]) => Promise<string>): Promise<void> {
    const out = await git(["ls-remote", "--symref", "origin", "HEAD"]).catch(() => "");
    let ref = /^ref: (refs\/heads\/\S+)\tHEAD$/m.exec(out)?.[1];
    if (!ref) {
      if (await git(["rev-parse", "--verify", "--quiet", "HEAD"]).then(() => true, () => false)) return;
      const branches = (await git(["for-each-ref", "--format=%(refname)", "refs/heads"])).split("\n").filter(Boolean);
      ref = ["refs/heads/main", "refs/heads/master"].find((b) => branches.includes(b)) ?? branches[0];
    }
    if (ref) await git(["symbolic-ref", "HEAD", ref]);
  }

  /** Writes the mirror's config and hooks as Kumiko has them, replacing whatever is there. */
  private async writeOwn(dir: string, url: string): Promise<void> {
    await replace(join(dir, "config"), mirrorConfig(dir, url, this.opts.credentialHelper));
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
    if (this.readError) return Promise.reject(new MirrorRecordError(this.readError));
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
const replace = (file: string, text: string) => replaceFile(dirname(file), basename(file), text);
