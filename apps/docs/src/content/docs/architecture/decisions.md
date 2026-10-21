---
title: Decisions and trade-offs
description: The choices Kumiko's design rests on, and what they cost.
sidebar:
  order: 4
---

Change a decision, and update this page in the same commit.

## A sandbox per project, permissions bypassed

The agent gets a whole environment per project and works there without asking.

**Costs:** a sandbox uses memory and CPU while it runs, and is slow to create. The boundary is only as tight as the
project's mounts and forwarded variables.

## Same-path mounts

The clone and `<clone>__worktrees` are mounted at their host paths, because a worktree's `.git` file holds absolute
paths.

**Costs:** moving a clone means moving its worktrees, repairing them and recreating the sandbox.

## An agent home per project

Each project's agent configuration is a folder on the host, mounted into the sandbox. Your own is never mounted.

**Costs:** you log in once per project, and settings aren't shared between projects, except through the template new
homes are copied from.

## A local web server inside the desktop app

The window is a web page served by a server in the Electron main process, so the UI also runs in a plain browser during
development.

**Costs:** every request must be checked for a local origin, and a server restart stops every agent.

## Shelling out to the real tools

Kumiko runs the provider's and agent's CLIs, and `git`, and parses their output instead of keeping its own model. Tests
replace them with fake executables.

**Costs:** output formats change between versions, so supported versions are pinned and checked by scripts against the
real tools.

## JSON files, not a database

One JSON file per project, sandbox and saved session.

**Costs:** no transactions. One operation per sandbox at a time, and saves per session are serialized.

## Live sessions in memory, only the chat on disk

A live session's full event stream is kept in memory for tabs to replay. Only the chat is saved.

**Costs:** a server restart ends every agent, and a resumed session shows less than the live one did.

## Worktrees read from git, never fetched

Worktree status comes from `git` on the host each time. Kumiko never fetches.

**Costs:** "merged" is as fresh as your last fetch, and squash merges don't show as merged.

## A convention for worktrees, not a rule

The agent is told to work in a worktree when a task changes code. Kumiko doesn't enforce it or track which session made
which worktree.

**Costs:** the agent can still edit the clone directly.
