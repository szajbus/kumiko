---
title: Decisions and trade-offs
description: The choices Kumiko's design rests on, why, and what they cost.
---

Each entry says what Kumiko does, why, what it costs, and, where it matters, the obvious alternative it doesn't take. When you change a decision, update
this page in the same commit.

## A sandbox per set of repos, with permissions bypassed

The agent gets a whole VM and works there without asking. A sandbox has a name you choose and the repos you pick, so
one agent can work across several repos.

**Why.** Permission prompts stop unattended work, and a VM limits what bypassed permissions can reach.

**Costs.** A sandbox uses memory and CPU while it runs, and takes minutes to create. The boundary is only as tight as
the sandbox's mounts and forwarded variables.

**Instead of.** One sandbox per clone, and running the agent on your Mac with prompts.

## Questions and plans as cards

With permissions bypassed, Claude still asks before two tools whose approval is your answer: AskUserQuestion and, in
plan mode, ExitPlanMode. Kumiko takes these asks over stream-json's control protocol
(`--permission-prompt-tool stdio`) and shows them as cards. It allows any other tool that asks at once. Kumiko turns
plan mode on with a control request. An ask waits for its answer with no time limit, and is saved with the session's
run, so the next server can answer it.

**Why.** Those two tools are how the agent asks you something, and they need an answer, not an approval.

**Costs.** Two of Claude's tools are handled outside the agent-neutral driver interface, and their answers are worded
for Claude. An answer is known to have arrived only once Claude's tool result for it does, so Kumiko may send one
twice. Claude ignores the second.

**Instead of.** Starting with `--permission-mode plan`, which leaves the agent in the default mode after a plan is
approved, asking about every edit.

## Repos on the sandbox's own disk

The repos are cloned inside the sandbox from the mirrors, onto a workspace disk mounted at `/workspace`, which
outlives the VM. Nothing on your Mac opens that disk. Every session starts in `/workspace`, and the agent reads a
repo's own `CLAUDE.md` only once it works in that repo.

**Why.** The agent can write a clone's git config, hooks and `.gitattributes`, which can make git run commands. If
the clones were on your Mac, git there would run what the agent wrote. Code reaches your Mac only as git objects
pushed to a mirror.

**Costs.** Your Mac can't read the clones, so what the UI shows of them comes from commands run in the sandbox. Losing
the disk loses what wasn't pushed. The disk needs Lima 2.3 or later, and grows only while the sandbox is stopped.

**Instead of.** Cloning on your Mac and mounting the clones into the VM.

## Mirrors on your Mac, no credentials in the sandbox

Kumiko keeps a bare mirror of each repo on your Mac and fetches it from GitHub. Git in the sandbox reaches the mirrors
through a socket Kumiko forwards in, which serves only that sandbox's repos. A pre-receive hook asks Kumiko about every
push. Pushes to the default branch and tags are refused.

**Why.** A sandbox with a GitHub token could push anywhere the token can, and your `gh` login can bypass branch
protections. With the mirrors, the sandbox's list of repos decides what it reaches, and the agent can't change that
list.

**Costs.** Kumiko runs a relay per running sandbox and a hook socket. Each mirror takes disk space on your Mac. The
agent sees GitHub only through Kumiko's tools.

**Instead of.** Forwarding a GitHub token into the sandbox.

## Delivery to GitHub on a card, signed on your Mac

The agent calls the `deliver` tool for a branch it pushed. You choose on a card to merge it into the default branch or
the base the agent names, open a pull request, or update the pull request it has open. Kumiko then does it on your Mac, with your `gh` login,
and signs the agent's commits with your key. Issues and comments the agent writes go through cards too, and so does closing or reopening an issue or a PR.

**Why.** You see the commits and changes before anything reaches GitHub, and what lands there is signed by you.

**Costs.** Signing changes the commits' shas, so the agent has to run `git pull --rebase` afterwards. A branch that
doesn't merge cleanly has to be fixed by the agent before a card appears.

**Instead of.** Letting the agent push to GitHub and open pull requests itself.

## An agent home per sandbox

Each sandbox's agent configuration is a folder on your Mac, mounted into the sandbox. Your own is never mounted.

**Why.** Your own configuration holds your login and settings for every project. A sandbox should hold only its own.

**Costs.** You log in once per sandbox. Settings aren't shared between sandboxes, except through the template that new
agent homes are copied from.

**Instead of.** Mounting `~/.claude`.

## A local web server inside the desktop app

The window is a web page served by a server in the Electron main process.

**Why.** The UI also runs in a plain browser during development, with hot reloading.

**Costs.** Every request must carry the server's secret and come from a local origin. See
[Security model](/architecture/security/#the-local-server).

## Shelling out to the real tools

Kumiko runs `limactl`, `claude` and `git` and parses their output, instead of keeping its own model of them. Tests
replace them with fake executables.

**Why.** The real tools stay the source of truth, and Kumiko works with what you'd run yourself.

**Costs.** Output formats change between versions. Kumiko pins the supported versions and checks them with scripts
against the real tools. See [Testing](/development/testing/).

## JSON files, not a database

Kumiko keeps one JSON file per sandbox, VM and saved session, under `~/.kumiko`.

**Why.** You can read them, and they need no service.

**Costs.** There are no transactions. Kumiko runs one operation per sandbox at a time, and serializes saves per
session.

## Agents that outlive the server

Each agent runs detached in a run in its sandbox, with a FIFO for its input and a file for its output. The server
attaches to it over SSH and follows the output from a byte offset. A restart, a quit or a dropped connection doesn't
stop the agent. The next server attaches again where the saved chat ends. See
[How an agent runs](/architecture/agent-runs/).

**Why.** An agent's work should end only when you decide, not when Kumiko goes away.

**Costs.** The output file grows with every streamed token until the agent exits. The run is a few shell scripts sent
with each command, which need `bash`, `tail -F` and `setsid` or `perl` in the sandbox. Only one server may use a
Kumiko home at a time. A request in flight when the server goes, such as a prompt or a stop, is lost.

**Instead of.** Running the agent as a child process of the server.

## Live sessions in memory, only the chat on disk

Kumiko keeps a live session's full event stream in memory for tabs to replay. It saves only the chat, with the deltas
of a message still in progress.

**Why.** The event stream is large, and the chat is what a resumed session needs.

**Costs.** A resumed session shows less than the live one did.

## A convention for worktrees, not a rule

Kumiko tells the agent to work in a worktree when a task changes code. It doesn't enforce it, or track which session
made which worktree.

**Why.** The agent knows when a task needs a worktree better than a rule does, and a question or a look around doesn't.

**Costs.** The agent can still edit the clone directly, and two sessions can collide there.
