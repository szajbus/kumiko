#!/usr/bin/env node
// A stand-in for the GitHub CLI, gh, for tests and UI development without a GitHub account.
// State lives in $FAKE_GH_DIR: user.json (the signed-in user, as GitHub's API returns it; signed out without it),
// repos.json (an array of repos as GET /user/repos returns them) and protocol (git_protocol, "https" without it).
// Every invocation is appended to $FAKE_GH_DIR/calls.log. Only the calls Kumiko makes are known; anything else fails,
// so a change to them shows up here.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
} else if (is("api", "user", "--jq", "{login, name, avatar_url} | @json")) {
  if (!user) {
    console.error("gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.");
    process.exit(4);
  }
  // A string result of --jq is printed raw.
  console.log(JSON.stringify({ login: user.login, name: user.name ?? null, avatar_url: user.avatar_url ?? null }));
} else if (is("api", "--paginate", "/user/repos?per_page=100&sort=pushed", "--jq", ".[] | {full_name, private, fork, archived, description, pushed_at} | @json")) {
  if (!user) signedOut();
  for (const r of read("repos.json") ?? []) {
    const { full_name, private: priv, fork, archived, description, pushed_at } = r;
    console.log(JSON.stringify({ full_name, private: priv, fork, archived, description: description ?? null, pushed_at: pushed_at ?? null }));
  }
} else if (is("config", "get", "git_protocol", "--host", "github.com")) {
  console.log(existsSync(join(dir, "protocol")) ? readFileSync(join(dir, "protocol"), "utf8").trim() : "https");
} else {
  console.error(`fake gh: unknown command: ${args.join(" ")}`);
  process.exit(1);
}
