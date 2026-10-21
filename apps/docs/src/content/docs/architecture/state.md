---
title: State on disk
description: Every file Kumiko writes, and what lives only in memory.
sidebar:
  order: 10
---

Everything Kumiko keeps is under `~/.kumiko` (`KUMIKO_HOME` to move it). The sandboxes themselves belong to the
sandbox provider.

| Where | What |
| --- | --- |
| `projects/<id>.json` | The project: clone and worktrees paths. |
| `sandboxes/<id>.json` | The sandbox's settings (variable names, never values) and setup state. |
| `claude/<id>/` | The project's agent home: login, settings, history. |
| `claude-template/` | What new agent homes are copied from. |
| `sessions/<id>.json` | Saved chats, for resuming, and where the session's agent runs: its run, and how much of the run's output the chat covers. |
| `sessions/attachments/` | Files sent with prompts. |
| `tabs.json` | The window's open tabs. |
| `home-id` | This home's id, which tags the runs its server starts. |
| `server.lock` | The running server's pid and port. One server per home: a second refuses to start. |

The agent home's `CLAUDE.md` is yours. It imports `kumiko.md`, which Kumiko rewrites with the worktree convention.

In each sandbox, every agent process has a run in `~/.kumiko/runs/<session id>-<n>/`, on the sandbox's own disk: a FIFO
for its input, its output and errors as files, its pid and, once it exits, its exit code. The run outlives Kumiko's
server and is deleted when the agent exits. Runs no saved session points at are removed when the server starts and
when the sandbox starts.

Operations, logs and logins are in memory only, and a server restart loses them. Live sessions are saved, with their
run, so the next server opens them again; tabs come back from disk.

A file that can't be read only affects its own project, and the UI says which file and why.
