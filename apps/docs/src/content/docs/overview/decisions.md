---
title: Decisions and trade-offs
description: The choices Kumiko's design rests on, and what they cost.
sidebar:
  order: 4
---

Change a decision, and update this page in the same commit.

## Sandboxes, permissions bypassed

The agent gets a whole environment, a sandbox, and works there without asking. A sandbox is the main thing in Kumiko:
it has a name of your choosing and the repos you pick, rather than being tied to one clone.

**Costs:** a sandbox uses memory and CPU while it runs, and is slow to create. The boundary is only as tight as the
sandbox's mounts and forwarded variables.

## Questions and plans over the agent's permission prompts

With permissions bypassed, Claude still asks the host before the two tools whose approval is the user answering:
AskUserQuestion and, in plan mode, ExitPlanMode. Kumiko takes those asks over stream-json's control protocol
(`--permission-prompt-tool stdio`) and shows them as cards; any other tool that asks is allowed at once. Plan mode is
switched on with a control request rather than started with `--permission-mode plan`, which would leave the agent in
the default mode, asking about every edit, once a plan is approved. An ask waits for its answer with no time limit, and
outlives the server like a tool call: what is still open is saved with the session's run, and answered by the next
server.

**Costs:** two of Claude's tools are handled outside the agent-neutral driver interface's messages, and their answers
are worded for Claude. An answer is only known to have arrived once Claude's tool result for it does, so one may be sent
twice; Claude ignores the second.

## Repos on the sandbox's own disk

The repos are cloned inside the sandbox, from the mirrors, onto a disk of its own mounted at `/workspace`, which
outlives the VM. Nothing on the host opens that disk, so code reaches the host only through git, and git on the host
never runs in a config the agent wrote. Every session starts in `/workspace`, and a repo's own `CLAUDE.md` is read only
once a session works in it.

**Costs:** the host can't read the clones: what the UI knows of them comes from an exec in the sandbox. Losing the disk
loses what wasn't pushed. The disk needs Lima 2.3 or later, and grows only while the sandbox is stopped.

## An agent home per sandbox

Each sandbox's agent configuration is a folder on the host, mounted into the sandbox. Your own is never mounted.

**Costs:** you log in once per sandbox, and settings aren't shared between sandboxes, except through the template new
homes are copied from.

## A local web server inside the desktop app

The window is a web page served by a server in the Electron main process, so the UI also runs in a plain browser during
development.

**Costs:** every request must be checked for a local origin.

## Shelling out to the real tools

Kumiko runs the provider's and agent's CLIs, and `git`, and parses their output instead of keeping its own model. Tests
replace them with fake executables.

**Costs:** output formats change between versions, so supported versions are pinned and checked by scripts against the
real tools.

## JSON files, not a database

One JSON file per sandbox, VM and saved session.

**Costs:** no transactions. One operation per sandbox at a time, and saves per session are serialized.

## Agents that outlive the server

Each agent runs detached in a run in its sandbox, with a FIFO for its input and a file for its output, and the server
attaches to it over SSH, following the output from a byte offset. A server restart, a quit or a dropped connection
doesn't stop the agent; the next server attaches again where the saved chat ends.

**Costs:** the output file grows with every streamed token until the agent exits (no rotation). The run is a few
shell scripts sent with each command, which assume `bash`, `tail -F` and `setsid` (or `perl`) in the sandbox. Only
one server may use a Kumiko home at a time, and runs are tagged with their home so servers on different homes can
share sandboxes. A request in flight when the server goes (a prompt, a stop) is lost with it.

## Live sessions in memory, only the chat on disk

A live session's full event stream is kept in memory for tabs to replay. Only the chat is saved, with the deltas of a
message still in progress.

**Costs:** a resumed session shows less than the live one did.

## A convention for worktrees, not a rule

The agent is told to work in a worktree when a task changes code. Kumiko doesn't enforce it or track which session made
which worktree.

**Costs:** the agent can still edit the clone directly.
