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
| `sessions/<id>.json` | Saved chats, for resuming. |
| `sessions/attachments/` | Files sent with prompts. |
| `tabs.json` | The window's open tabs. |

The agent home's `CLAUDE.md` is yours. It imports `kumiko.md`, which Kumiko rewrites with the worktree convention.

Operations, logs, live sessions and logins are in memory only, and a server restart loses them. Tabs and their
sessions come back from disk.

A file that can't be read only affects its own project, and the UI says which file and why.
