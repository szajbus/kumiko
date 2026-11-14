import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import type { AgentAsk, ApprovalCard, AskAnswer, DeliverCard, SessionEvent, SessionInfo } from "@kumiko/shared";
import { Approvals, cardsOf, type ApprovalSessions } from "../src/approvals.js";
import { GitHub } from "../src/github.js";
import { land, squashMessage } from "../src/landing.js";
import { Mirrors } from "../src/mirrors.js";
import { fakeGitHub, type FakeGitHub } from "./github.js";

const fakeGh = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/fake-gh.mjs");

/** git as someone working on "GitHub" directly: the test's own identity, or another's. */
function git(cwd: string, args: string[], who = { name: "Test", email: "test@example.com" }): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email },
  });
}

/** The sessions as approvals see them: one session's events, with the answers Claude got. */
class FakeSessions implements ApprovalSessions {
  ev: SessionEvent[] = [];
  answers: { id: string; answer: AskAnswer }[] = [];
  closed = new Set<string>();
  readonly info = { id: "s1", sandbox: "web" } as SessionInfo;
  get(id: string) {
    return id === "s1" ? this.info : undefined;
  }
  events() {
    return this.ev;
  }
  putCard(_id: string, card: ApprovalCard) {
    this.ev.push({ seq: this.ev.length, kind: "card", payload: card });
  }
  answerAsk(_id: string, askId: string, answer: AskAnswer) {
    if (this.closed.has(askId) || this.answers.some((a) => a.id === askId)) throw new Error("not waiting");
    this.answers.push({ id: askId, answer });
    this.ev.push({ seq: this.ev.length, kind: "ask_answer", payload: { id: askId, answer } });
  }
  card(id: string) {
    return cardsOf(this.ev).get(id);
  }
  answer(id: string) {
    return this.answers.find((a) => a.id === id)?.answer;
  }
}

async function until<T>(what: string, check: () => T | undefined, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("delivering", () => {
  let root: string;
  let github: FakeGitHub;
  let bare: string;
  let work: string;
  let mirrors: Mirrors;
  let sessions: FakeSessions;
  let approvals: Approvals;
  let n = 0;
  const savedEnv = { ...process.env };

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "kumiko-deliver-test-")));
    // The user's global git config, as Kumiko reads it on the host: their identity and an SSH signing key.
    const key = join(root, "signing");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    await writeFile(join(root, "gitconfig"), `[user]\n\tname = Test\n\temail = test@example.com\n\tsigningkey = ${key}.pub\n[gpg]\n\tformat = ssh\n`);
    process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.FAKE_GH_DIR = join(root, "gh");
    await mkdir(join(root, "gh"));
    await writeFile(join(root, "gh", "user.json"), JSON.stringify({ login: "acme" }));
    github = await fakeGitHub(root);
    ({ bare, work } = await github.repo("acme/widget"));
    mirrors = new Mirrors({ home: join(root, "home"), remoteUrl: (repo) => `${github.url}/${repo.toLowerCase()}.git`, freshMs: 0 });
    await mirrors.start();
    await mirrors.ensure("acme/widget");
  });

  after(async () => {
    await mirrors.close();
    github.close();
    process.env = savedEnv;
    await rm(root, { recursive: true, force: true });
  });

  const fresh = () => {
    sessions = new FakeSessions();
    approvals = new Approvals(sessions, {
      mirrors,
      github: new GitHub({ gh: fakeGh }),
      repoOf: async () => "acme/widget",
      identity: async () => ({ name: "Test", email: "test@example.com" }),
      choicesFile: join(root, "home", "choices.json"),
    });
  };

  /** Pushes `branch` to GitHub as Claude would have: commits with the Claude trailer, from main, recorded as the project's. */
  const branch = async (name: string, files: Record<string, string>, opts: { from?: string; trailer?: boolean; who?: { name: string; email: string } } = {}) => {
    git(work, ["fetch", "--quiet", "origin"]);
    git(work, ["checkout", "--quiet", "-B", name, opts.from ?? "origin/main"]);
    for (const [file, text] of Object.entries(files)) {
      await mkdir(dirname(join(work, file)), { recursive: true });
      await writeFile(join(work, file), text);
      git(work, ["add", file]);
      git(work, ["commit", "--quiet", "-m", `Change ${file}${opts.trailer === false ? "" : "\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"}`], opts.who);
    }
    git(work, ["push", "--quiet", "--force", "origin", name]);
    await mirrors.fetch("acme/widget");
    await mirrors.noteBranches("acme/widget", "web", [{ branch: name, deleted: false }]);
    return git(work, ["rev-parse", "HEAD"]).trim();
  };

  /** Claude asks to deliver: resolves with its card, or the answer it got instead. */
  const ask = async (input: Record<string, unknown>) => {
    const id = `ask-${++n}`;
    const a: Extract<AgentAsk, { kind: "approval" }> = { kind: "approval", id, toolUseId: `tool-${n}`, tool: "deliver", input };
    sessions.ev.push({ seq: sessions.ev.length, kind: "ask", payload: a });
    approvals.asked(sessions.info, a);
    await until("a card or an answer", () => sessions.card(id) ?? sessions.answer(id));
    return { id, toolUseId: a.toolUseId!, input, card: sessions.card(id), answer: sessions.answer(id) };
  };

  const onGitHub = (ref: string) => {
    try {
      return git(bare, ["rev-parse", "--verify", "--quiet", ref]).trim();
    } catch {
      return undefined;
    }
  };

  it("shows a card for exactly the pushed commit, with what Kumiko found", async () => {
    fresh();
    const head = await branch("fix-x", { "a.ts": "a\n", ".github/workflows/ci.yml": "on: push\n" });
    git(work, ["commit", "--quiet", "--allow-empty", "-m", "Someone else's"], { name: "Mallory", email: "m@example.com" });
    git(work, ["push", "--quiet", "origin", "fix-x"]);
    await mirrors.fetch("acme/widget");
    const last = git(work, ["rev-parse", "HEAD"]).trim();
    assert.notEqual(last, head);
    const { card, answer } = await ask({ branch: "fix-x", title: "Fix x", body: "It fixes x.", note: "Small, I'd go straight to main." });
    assert.equal(answer, undefined);
    const c = card!.card as DeliverCard;
    assert.equal(card!.note, "Small, I'd go straight to main.");
    assert.equal(c.head, last);
    assert.equal(c.base, "main");
    assert.deepEqual(c.commits.map((x) => [x.subject, x.claude]), [["Change a.ts", true], ["Change .github/workflows/ci.yml", true], ["Someone else's", false]]);
    assert.deepEqual(c.files.map((f) => [f.path, f.added, f.flagged ?? false]), [[".github/workflows/ci.yml", 1, true], ["a.ts", 1, false]]);
    assert.deepEqual(c.flags.map((f) => f.rule).sort(), ["author", "ci", "trailer"]);
    assert.equal(c.route, "main");
    assert.equal(c.method, "merge");
    assert.equal(c.signs, true);
    assert.deepEqual(c.trailers, ["Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"]);
  });

  it("says what to fix instead of showing a card", async () => {
    fresh();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ branch: "nope", title: "t", body: "b" }, /nope isn't on GitHub\. Push it first \(git push -u origin nope\)/],
      [{ branch: "main", title: "t", body: "b" }, /main is the branch work is delivered to/],
      [{ branch: "--upload-pack=x", title: "t", body: "b" }, /isn't a branch name/],
      [{ branch: "fix-x", title: "", body: "b" }, /title must be a non-empty string/],
    ];
    for (const [input, why] of cases) {
      const r = await ask(input);
      assert.equal(r.card, undefined, JSON.stringify(input));
      assert.equal(r.answer?.kind, "deny");
      assert.match((r.answer as { message: string }).message, why);
    }
    await branch("empty", {});
    const empty = await ask({ branch: "empty", title: "t", body: "b" });
    assert.match((empty.answer as { message: string }).message, /empty has no commits that aren't on main already/);

    git(work, ["checkout", "--quiet", "-B", "main", "origin/main"]);
    await writeFile(join(work, "clash"), "main's\n");
    git(work, ["add", "clash"]);
    git(work, ["commit", "--quiet", "-m", "main's clash"]);
    const before = git(work, ["rev-parse", "HEAD~1"]).trim();
    await branch("clash", { clash: "branch's\n" }, { from: before });
    git(work, ["push", "--quiet", "origin", "main"]);
    await mirrors.fetch("acme/widget");
    const r = await ask({ branch: "clash", title: "t", body: "b" });
    assert.equal(r.card, undefined);
    assert.match((r.answer as { message: string }).message, /clash doesn't merge cleanly into main \(conflicts in clash\)\. Merge origin\/main into it, resolve, push, and call deliver again\./);
  });

  it("runs nothing the user didn't approve, whatever Claude calls it with", async () => {
    fresh();
    await branch("guarded", { g: "g\n" });
    const r = await ask({ branch: "guarded", title: "Guarded", body: "b" });
    const main = onGitHub("refs/heads/main");
    const unknown = await approvals.call(sessions.info, "deliver", r.input, "tool-made-up");
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /Not approved: the user hasn't seen this call/);
    const early = await approvals.call(sessions.info, "deliver", r.input, r.toolUseId);
    assert.match(early.text, /Not approved: the user hasn't approved this yet/);
    await approvals.decide("s1", r.id, { action: "approve", decision: { kind: "deliver", route: "main", method: "merge" } });
    const changed = await approvals.call(sessions.info, "deliver", { ...r.input, branch: "fix-x" }, r.toolUseId);
    assert.match(changed.text, /Not approved/);
    assert.equal(onGitHub("refs/heads/main"), main, "nothing landed");
  });

  it("lands an approved branch as a merge commit signed on the host, deletes it, and only once", async () => {
    fresh();
    const head = await branch("ship", { s: "s\n" });
    const r = await ask({ branch: "ship", title: "Ship", body: "b" });
    const decided = await approvals.decide("s1", r.id, { action: "approve", decision: { kind: "deliver", route: "main", method: "merge" } });
    assert.equal(decided.state, "approved");
    assert.deepEqual(sessions.answer(r.id), { kind: "allow" });
    const res = await approvals.call(sessions.info, "deliver", r.input, r.toolUseId);
    assert.equal(res.isError, undefined, res.text);
    assert.match(res.text, /^Delivered ship to main as [0-9a-f]{7} \(merge commit, signed\)\. ship was deleted on GitHub\./);
    const main = onGitHub("refs/heads/main")!;
    assert.equal(git(bare, ["rev-parse", `${main}^2`]).trim(), head);
    const commit = git(bare, ["cat-file", "commit", main]);
    assert.match(commit, /^gpgsig -----BEGIN SSH SIGNATURE-----/m);
    assert.match(commit, /\n\nMerge branch 'ship'\n$/);
    assert.equal(onGitHub("refs/heads/ship"), undefined);
    assert.equal(mirrors.createdBy("acme/widget", "ship"), undefined);
    const card = sessions.card(r.id)!;
    assert.equal(card.state, "done");
    assert.match(card.receipt!.text, /^Delivered ship → main as [0-9a-f]{7}$/);
    assert.equal(card.receipt!.meta, "merge commit · signed");
    const again = await approvals.call(sessions.info, "deliver", r.input, r.toolUseId);
    assert.match(again.text, /^Done already/);
    assert.equal(onGitHub("refs/heads/main"), main);
  });

  it("squashes into one signed commit with the branch's co-authors, and remembers the choice", async () => {
    fresh();
    await branch("squashy", { q1: "1\n", q2: "2\n" });
    const r = await ask({ branch: "squashy", title: "Squash it", body: "b" });
    await approvals.decide("s1", r.id, { action: "approve", decision: { kind: "deliver", route: "main", method: "squash", title: "Squash it, edited", message: "* one\n* two" } });
    const res = await approvals.call(sessions.info, "deliver", r.input, r.toolUseId);
    assert.match(res.text, /\(squashed, signed\)/);
    const main = onGitHub("refs/heads/main")!;
    assert.equal(git(bare, ["rev-list", "--parents", "-n1", main]).trim().split(" ").length, 2, "one parent");
    assert.equal(git(bare, ["log", "-1", "--format=%B", main]), "Squash it, edited\n\n* one\n* two\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n\n");
    assert.deepEqual(JSON.parse(await readFile(join(root, "home", "choices.json"), "utf8")).web, { route: "main", method: "squash" });
    await branch("next", { nx: "x\n" });
    const next = await ask({ branch: "next", title: "Next", body: "b" });
    assert.equal((next.card!.card as DeliverCard).method, "squash", "starts at what was picked last time");
  });

  it("merges again when main moved on GitHub after the card was approved", async () => {
    fresh();
    await branch("racer", { r: "r\n" });
    const r = await ask({ branch: "racer", title: "Racer", body: "b" });
    await approvals.decide("s1", r.id, { action: "approve", decision: { kind: "deliver", route: "main", method: "merge" } });
    git(work, ["fetch", "--quiet", "origin"]);
    git(work, ["checkout", "--quiet", "-B", "main", "origin/main"]);
    await writeFile(join(work, "other"), "o\n");
    git(work, ["add", "other"]);
    git(work, ["commit", "--quiet", "-m", "Someone landed first"]);
    git(work, ["push", "--quiet", "origin", "main"]);
    const theirs = onGitHub("refs/heads/main")!;
    const res = await approvals.call(sessions.info, "deliver", r.input, r.toolUseId);
    assert.equal(res.isError, undefined, res.text);
    assert.equal(git(bare, ["rev-parse", `${onGitHub("refs/heads/main")}^1`]).trim(), theirs, "on top of theirs");
  });

  it("merges again, once, when GitHub refuses the lease because main moved between the fetch and the push", async () => {
    fresh();
    const head = await branch("lease", { le: "l\n" });
    let fetches = 0;
    let theirs = "";
    const landed = await land(mirrors.path("acme/widget"), mirrors.url("acme/widget"), {
      branch: "lease",
      head,
      method: "merge",
      message: "Merge branch 'lease'\n",
      sign: false,
      fetch: async () => {
        await mirrors.fetch("acme/widget");
        if (fetches++ > 0) return;
        git(work, ["fetch", "--quiet", "origin"]);
        git(work, ["checkout", "--quiet", "-B", "main", "origin/main"]);
        git(work, ["commit", "--quiet", "--allow-empty", "-m", "Landed meanwhile"]);
        git(work, ["push", "--quiet", "origin", "main"]);
        theirs = git(work, ["rev-parse", "HEAD"]).trim();
      },
    });
    assert.equal(fetches, 2, "tried twice");
    assert.equal(onGitHub("refs/heads/main"), landed.sha);
    assert.equal(git(bare, ["rev-parse", `${landed.sha}^1`]).trim(), theirs);
  });

  it("goes stale when the branch moves before the user decides, and shows the new state when asked", async () => {
    fresh();
    await branch("moving", { m1: "1\n" });
    const r = await ask({ branch: "moving", title: "Moving", body: "b" });
    const now = await branch("moving", { m2: "2\n" }, { from: "origin/moving" });
    const stale = await approvals.decide("s1", r.id, { action: "approve", decision: { kind: "deliver", route: "main", method: "merge" } });
    assert.equal(stale.state, "stale");
    assert.deepEqual(stale.moved, { to: now, commits: 1 });
    assert.equal(sessions.answer(r.id), undefined, "Claude still waits");
    await assert.rejects(approvals.decide("s1", r.id, { action: "approve", decision: { kind: "deliver", route: "main", method: "merge" } }), /review the new state first/);
    const refreshed = await approvals.decide("s1", r.id, { action: "refresh" });
    assert.equal(refreshed.state, "open");
    assert.equal((refreshed.card as DeliverCard).head, now);
  });

  it("tells Claude the user declined, with their reason", async () => {
    fresh();
    await branch("nah", { n: "n\n" });
    const r = await ask({ branch: "nah", title: "Nah", body: "b" });
    const declined = await approvals.decide("s1", r.id, { action: "decline", reason: "Split it up." });
    assert.equal(declined.state, "declined");
    assert.deepEqual(sessions.answer(r.id), { kind: "deny", message: "The user declined delivering nah: “Split it up.”" });
    await assert.rejects(approvals.decide("s1", r.id, { action: "decline" }), /isn't waiting/);
  });

  it("opens a PR with Kumiko's footer, then lands it with GitHub's wording", async () => {
    fresh();
    const head = await branch("pr-me", { p: "p\n" });
    const r = await ask({ branch: "pr-me", title: "PR me", body: "Does p." });
    await approvals.decide("s1", r.id, { action: "approve", decision: { kind: "deliver", route: "pr", method: "merge", title: "PR me, edited", body: "Does p, edited." } });
    const res = await approvals.call(sessions.info, "deliver", r.input, r.toolUseId);
    assert.match(res.text, /^Opened PR #(\d+) \(https:\/\/github\.com\/acme\/widget\/pull\/\d+\)\. Nothing is on main yet/);
    const db = JSON.parse(await readFile(join(root, "gh", "github.json"), "utf8"));
    const pr = db.items.find((i: { head: string }) => i.head === "pr-me");
    assert.equal(pr.title, "PR me, edited");
    assert.equal(pr.body, "Does p, edited.\n\n🤖 Opened by Claude in Kumiko");
    assert.equal(sessions.card(r.id)!.receipt!.text, `Opened PR #${pr.number}`);

    const again = await ask({ branch: "pr-me", title: "ignored", body: "ignored" });
    const c = again.card!.card as DeliverCard;
    assert.deepEqual(c.pr, { number: pr.number, title: "PR me, edited", url: `https://github.com/acme/widget/pull/${pr.number}` });
    await assert.rejects(approvals.decide("s1", again.id, { action: "approve", decision: { kind: "deliver", route: "pr", method: "merge" } }), /has PR #\d+ open already/);
    await approvals.decide("s1", again.id, { action: "approve", decision: { kind: "deliver", route: "main", method: "merge" } });
    const landed = await approvals.call(sessions.info, "deliver", again.input, again.toolUseId);
    assert.equal(landed.isError, undefined, landed.text);
    const main = onGitHub("refs/heads/main")!;
    assert.equal(git(bare, ["rev-parse", `${main}^2`]).trim(), head);
    assert.equal(git(bare, ["log", "-1", "--format=%B", main]), `Merge pull request #${pr.number} from acme/pr-me\n\nPR me, edited\n\n`);
  });

  it("puts the branch's co-authors under a squash message once", () => {
    const t = "Co-Authored-By: Claude <noreply@anthropic.com>";
    assert.equal(squashMessage("Subject", "* a", [t]), `Subject\n\n* a\n\n${t}\n`);
    assert.equal(squashMessage("Subject", `* a\n\n${t}`, [t]), `Subject\n\n* a\n\n${t}\n`);
    assert.equal(squashMessage("Subject", "", []), "Subject\n");
  });
});
