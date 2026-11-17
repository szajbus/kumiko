---
title: State on disk
description: Every file Kumiko writes, and what lives only in memory.
sidebar:
  order: 10
---

Everything Kumiko keeps is under `~/.kumiko` (`KUMIKO_HOME` to move it). The sandboxes' VMs and workspace disks
belong to the sandbox provider: with Lima, the VM `kumiko-<name>` and the disk `kumiko-<name>-workspace`, in
`~/.lima`.

| Where | What |
| --- | --- |
| `workspaces/<name>.json` | The sandbox: its repos, each with its folder in `/workspace`, and the folders of repos taken out while it was stopped, deleted from `/workspace` when it next starts. |
| `sandboxes/<name>.json` | The sandbox's VM settings (variable names, never values) and setup state, with the agent's setup scripts it was created with and how each went. |
| `claude/<name>/` | The sandbox's agent home: login, settings, history. |
| `sandbox/<name>/` | The sandbox's Kumiko folder, at the same path in the sandbox, and at `~/.kumiko/shared` there: what Kumiko and the agent keep for Kumiko, apart from the agent home. |
| `sandbox/<name>/artifacts/<session id>/` | The session's [artifacts](/guide/artifacts/), which the agent writes. |
| `sandbox/<name>/provision.d/` | The agent's [setup scripts](/guide/sandboxes/#the-agents-setup-scripts), run when the sandbox is created. |
| `sandbox/<name>/setup.md`, `user-provision.sh` | The guide to the agent's setup scripts, and a copy of the provisioning script for it to read. Kumiko writes them again whenever the sandbox or a session starts. |
| `claude-template/` | What new agent homes are copied from. |
| `sessions/<id>.json` | Saved chats, for resuming, with the window's panes and which version of each artifact they showed, and where the session's agent runs: its run, how much of the run's output the chat covers, any calls to Kumiko's tools the agent is waiting on, and what it asked you that it is still waiting for. |
| `sessions/attachments/` | Files sent with prompts. |
| `sessions/artifacts/` | Every version of an artifact a window showed, named by its SHA-256, for the window to show and a rewind to put back. Those no saved session names any more are deleted when Kumiko starts. |
| `repos.json` | The [repositories you picked](/guide/repos/), with how each mirror's last fetch went. |
| `run/git-<sandbox>-<id>.sock` | The socket each running sandbox's VM reaches its mirrors through, forwarded into the VM over SSH. Made when the relay starts, removed when it stops. |
| `run/hook.sock` | Where the mirrors' pre-receive hooks ask Kumiko about a push. Only you can reach it. |
| `mirrors/<owner>/<name>.git` | Each repository's bare mirror. Kumiko's alone: it rewrites their config and hooks on every start, and deletes folders here that aren't a picked repository's. |
| `tabs.json` | The window's open tabs. |
| `home-id` | This home's id, which tags the runs its server starts. |
| `server.lock` | The running server's pid and port. One server per home: a second refuses to start. |

The agent home's `CLAUDE.md` is yours. It imports `kumiko.md`, which Kumiko rewrites with
[its instructions to the agent](/reference/agent-instructions/).

In each sandbox, every agent process has a run in `~/.kumiko/local/runs/<session id>-<n>/`, on the sandbox's own disk: a FIFO
for its input, its output and errors as files, its pid and, once it exits, its exit code. The run outlives Kumiko's
server and is deleted when the agent exits. Runs no saved session points at are removed when the server starts and
when the sandbox starts.

The repos are cloned on the sandbox's workspace disk, at `/workspace/<folder>`, with their worktrees in
`/workspace/<folder>__worktrees`. The disk outlives the VM: a rebuild keeps it, and deleting the sandbox deletes it.
How each repo's clone is, as the sandbox page shows it, is kept in memory and checked again when the sandbox starts.

Operations, logs and logins are in memory only, and a server restart loses them. Live sessions are saved, with their
run, so the next server opens them again; tabs come back from disk.

A file that can't be read only affects its own sandbox, and the UI says which file and why.
