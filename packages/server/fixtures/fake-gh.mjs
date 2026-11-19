#!/usr/bin/env node
// A stand-in for the GitHub CLI, gh, for tests and UI development without a GitHub account.
// State lives in $FAKE_GH_DIR: user.json (the signed-in user, as GitHub's API returns it; signed out without it),
// repos.json (an array of repos as GET /user/repos returns them), github.json (issues, PRs, labels, runs and REST
// answers: see below) and token (the token gh hands git; "fake-token"
// without it).
// Every invocation is appended to $FAKE_GH_DIR/calls.log. Only the calls Kumiko makes are known; anything else fails,
// so a change to them shows up here.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_GH_DIR;
if (!dir) {
  console.error("FAKE_GH_DIR is not set");
  process.exit(2);
}
mkdirSync(dir, { recursive: true });
const args = process.argv.slice(2);
appendFileSync(join(dir, "calls.log"), JSON.stringify(args) + "\n");

const read = (name) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : undefined);
const user = read("user.json");
const is = (...want) => want.length === args.length && want.every((w, i) => w === args[i]);
const signedOut = () => {
  console.error("You are not logged into any GitHub hosts. To log in, run: gh auth login");
  process.exit(1);
};

if (is("auth", "status", "--hostname", "github.com")) {
  if (!user) signedOut();
  // Newer gh prints this on stdout.
  console.log(`github.com\n  ✓ Logged in to github.com account ${user.login} (keyring)`);
} else if (is("api", "user", "--jq", "{id, login, name, avatar_url} | @json")) {
  if (!user) {
    console.error("gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.");
    process.exit(4);
  }
  // A string result of --jq is printed raw.
  console.log(JSON.stringify({ id: user.id ?? null, login: user.login, name: user.name ?? null, avatar_url: user.avatar_url ?? null }));
} else if (is("api", "--paginate", "/user/repos?per_page=100&sort=pushed", "--jq", ".[] | {full_name, private, fork, archived, description, pushed_at} | @json")) {
  if (!user) signedOut();
  for (const r of read("repos.json") ?? []) {
    const { full_name, private: priv, fork, archived, description, pushed_at } = r;
    console.log(JSON.stringify({ full_name, private: priv, fork, archived, description: description ?? null, pushed_at: pushed_at ?? null }));
  }
} else if (is("auth", "git-credential", "get")) {
  // As git's credential helper: what git asks for comes on stdin, and the answer goes back as key=value lines.
  const ask = Object.fromEntries(readFileSync(0, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  if (!user || ask.host !== "github.com") process.exit(1);
  const token = existsSync(join(dir, "token")) ? readFileSync(join(dir, "token"), "utf8").trim() : "fake-token";
  console.log(`protocol=https\nhost=github.com\nusername=${user.login}\npassword=${token}`);
} else if (is("auth", "git-credential", "store") || is("auth", "git-credential", "erase")) {
  // gh keeps its own token: nothing to store or forget.
} else if (args[0] === "api" && args[1] === "--method" && args[2] === "GET" && args.length === 4) {
  // REST GETs, kept in github.json's api: { "<path as asked>": <body> }; a string body is sent as it is.
  if (!user) signedOut();
  const body = (read("github.json")?.api ?? {})[args[3]];
  if (body === undefined) {
    console.log(JSON.stringify({ message: "Not Found", documentation_url: "https://docs.github.com/rest", status: "404" }));
    console.error("gh: Not Found (HTTP 404)");
    process.exit(1);
  }
  process.stdout.write(typeof body === "string" ? body : JSON.stringify(body));
} else if (args[0] === "pr" || args[0] === "issue" || args[0] === "label" || args[0] === "run") {
  github();
} else {
  console.error(`fake gh: unknown command: ${args.join(" ")}`);
  process.exit(1);
}

/** Value of option `name` in args, if given. */
function opt(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Issues, pull requests and labels, kept in github.json: { next, items: [{ number, type, title, body, state, author,
 * labels, comments, head, base, url }], labels: [{ name, color, description }] }. Only what Kumiko asks for.
 */
function github() {
  if (!user) signedOut();
  const file = join(dir, "github.json");
  const db = read("github.json") ?? { next: 1, items: [], labels: [] };
  const save = () => writeFileSync(file, JSON.stringify(db, null, 2));
  const repo = opt("--repo");
  if (!repo) {
    console.error("fake gh: --repo is required");
    process.exit(1);
  }
  const url = (type, n) => `https://github.com/${repo}/${type === "pr" ? "pull" : "issues"}/${n}`;
  const find = (n) => db.items.find((i) => i.number === Number(n));
  const [noun, verb] = args;
  if (noun === "pr" && verb === "list" && opt("--head")) {
    const prs = db.items.filter((i) => i.type === "pr" && i.head === opt("--head") && i.state === "OPEN");
    console.log(JSON.stringify(prs.map((p) => ({ number: p.number, title: p.title, url: url("pr", p.number), baseRefName: p.base, headRepositoryOwner: { login: repo.split("/")[0] } }))));
  } else if (noun === "pr" && verb === "create") {
    const body = readFileSync(0, "utf8");
    if (db.items.some((i) => i.type === "pr" && i.head === opt("--head") && i.state === "OPEN")) {
      console.error(`a pull request for branch "${opt("--head")}" into branch "${opt("--base")}" already exists`);
      process.exit(1);
    }
    const n = db.next++;
    db.items.push({ number: n, type: "pr", title: opt("--title"), body, state: "OPEN", author: user.login, labels: [], comments: [], head: opt("--head"), base: opt("--base") });
    save();
    console.log(url("pr", n));
  } else if ((noun === "issue" || noun === "pr") && (verb === "close" || verb === "reopen")) {
    // The flags come as --flag value or --flag=value, as gh takes them.
    const flag = (name) => opt(name) ?? args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
    const item = find(args[2]);
    if (!item) process.exit(1);
    item.state = verb === "close" ? "CLOSED" : "OPEN";
    const reason = flag("--reason");
    if (reason) item.stateReason = reason;
    if (flag("--comment")) item.comments.push({ author: user.login, body: flag("--comment") });
    save();
  } else if ((noun === "issue" || noun === "pr") && verb === "edit") {
    const item = find(args[2]);
    if (!item) process.exit(1);
    const title = opt("--title") ?? args.find((a) => a.startsWith("--title="))?.slice("--title=".length);
    if (title !== undefined) item.title = title;
    if (args.includes("--body-file")) item.body = readFileSync(0, "utf8");
    save();
    console.log(url(item.type, item.number));
  } else if ((noun === "issue" || noun === "pr") && verb === "view") {
    const item = find(args[2]);
    if (!item || (noun === "pr") !== (item.type === "pr")) {
      console.error(`GraphQL: Could not resolve to ${noun === "pr" ? "a PullRequest" : "an issue or pull request"} with the number of ${args[2]}.`);
      process.exit(1);
    }
    console.log(JSON.stringify(shape(item)));
  } else if ((noun === "issue" || noun === "pr") && verb === "list") {
    const state = (opt("--state") ?? "open").toUpperCase();
    const q = opt("--search");
    const items = db.items.filter((i) => (noun === "pr") === (i.type === "pr") && (state === "ALL" || i.state === state) && (!q || `${i.title} ${i.body}`.includes(q)));
    console.log(JSON.stringify(items.slice(0, Number(opt("--limit") ?? 30)).map(shape)));
  } else if (noun === "issue" && verb === "create") {
    const labels = args.flatMap((a, i) => (a === "--label" ? [args[i + 1]] : []));
    const unknown = labels.find((l) => !db.labels.some((x) => x.name === l));
    if (unknown) {
      console.error(`could not add label: '${unknown}' not found`);
      process.exit(1);
    }
    const n = db.next++;
    db.items.push({ number: n, type: "issue", title: opt("--title"), body: readFileSync(0, "utf8"), state: "OPEN", author: user.login, labels, comments: [] });
    save();
    console.log(url("issue", n));
  } else if ((noun === "issue" || noun === "pr") && verb === "comment") {
    const item = find(args[2]);
    if (!item) process.exit(1);
    item.comments.push({ author: user.login, body: readFileSync(0, "utf8") });
    save();
    console.log(`${url(item.type, item.number)}#issuecomment-${1000 + item.comments.length}`);
  } else if (noun === "run" && verb === "view") {
    // Runs, kept in github.json's runs: { "<id>": { run: <as --json gives it>, log, logFailed, logError } }.
    const run = (db.runs ?? {})[args[2]];
    if (!run) {
      console.error(`HTTP 404: Not Found (https://api.github.com/repos/${repo}/actions/runs/${args[2]})`);
      process.exit(1);
    }
    if (opt("--json")) {
      console.log(JSON.stringify(run.run));
    } else if (run.logError) {
      console.error(run.logError);
      process.exit(1);
    } else {
      const job = opt("--job");
      const jobName = job && run.run.jobs.find((j) => String(j.databaseId) === job)?.name;
      const log = args.includes("--log-failed") ? run.logFailed : run.log;
      process.stdout.write(jobName ? log.split("\n").filter((l) => !l || l.startsWith(`${jobName}\t`)).join("\n") : log);
    }
  } else if (noun === "label" && verb === "list") {
    console.log(JSON.stringify(db.labels));
  } else {
    console.error(`fake gh: unknown command: ${args.join(" ")}`);
    process.exit(1);
  }

  /** An item as gh's --json shows it. */
  function shape(i) {
    return {
      number: i.number,
      title: i.title,
      state: i.state,
      author: { login: i.author },
      body: i.body,
      labels: i.labels.map((name) => ({ name })),
      comments: i.comments.map((c) => ({ author: { login: c.author }, body: c.body, createdAt: "2026-11-14T12:00:00Z" })),
      url: url(i.type, i.number),
      updatedAt: "2026-11-14T12:00:00Z",
      ...(i.type === "pr" ? { headRefName: i.head, baseRefName: i.base, files: [], reviews: [] } : {}),
    };
  }
}
