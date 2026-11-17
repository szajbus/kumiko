---
title: State on disk
description: Every file Kumiko writes, on your Mac and in the sandbox, and what lives only in memory.
sidebar:
  order: 5
---

Kumiko keeps everything of its own under `~/.kumiko`. Set `KUMIKO_HOME` to move it. The sandboxes' VMs and workspace
disks belong to the sandbox provider. With Lima, they are the VM `kumiko-<name>` and the disk
`kumiko-<name>-workspace`, in `~/.lima`.

## On your Mac

### Sandboxes

| Where | What |
| --- | --- |
| `workspaces/<name>.json` | The sandbox: its repos, each with its folder in `/workspace`, and the folders of repos taken out while it was stopped. Those are deleted from `/workspace` when it next starts. |
| `sandboxes/<name>.json` | The VM's settings, with the names of forwarded variables but never their values, and its setup state: the agent's setup scripts it was created with, and how each went. |
| `claude/<name>/` | The sandbox's agent home: login, settings, history. Mounted into the sandbox. |
| `claude-template/` | What new agent homes are copied from. |
| `sandbox/<name>/` | The sandbox's Kumiko folder. It is at the same path in the sandbox, and at `~/.kumiko/shared` there. It holds what Kumiko and the agent keep for Kumiko, apart from the agent home. |
| `sandbox/<name>/artifacts/<session id>/` | The session's [artifacts](/guide/artifacts/), which the agent writes. |
| `sandbox/<name>/provision.d/` | The agent's [setup scripts](/guide/sandboxes/#the-agents-setup-scripts), run when the sandbox is created. |
| `sandbox/<name>/setup.md`, `user-provision.sh` | The guide to the agent's setup scripts, and a copy of your provisioning script for the agent to read. Kumiko writes them again whenever the sandbox or a session starts. |

The agent home's `CLAUDE.md` is yours. It imports `kumiko.md`, which Kumiko rewrites with
[its instructions to the agent](/reference/agent-instructions/).

### Sessions

| Where | What |
| --- | --- |
| `sessions/<id>.json` | A saved session: its chat, the window's panes and which version of each artifact they showed, and its run. The run part says where the agent runs, how much of the run's output the chat covers, the calls to Kumiko's tools the agent is waiting on, and the questions it is waiting for you to answer. See [How an agent runs](/architecture/agent-runs/#what-is-saved). |
| `sessions/attachments/` | Files sent with prompts. Deleted when no saved session names them. |
| `sessions/artifacts/` | Every version of an artifact a window showed, named by its SHA-256, for the window to show and a rewind to put back. Deleted at start when no saved session names them. |
| `tabs.json` | The window's open tabs. |

### Repositories

| Where | What |
| --- | --- |
| `repos.json` | The [repositories you picked](/guide/repos/), how each mirror's last fetch went, and which branches each sandbox's agent created on GitHub. |
| `mirrors/<owner>/<name>.git` | Each repository's bare mirror. Kumiko's alone: it rewrites their config and hooks on every start, and deletes folders here that aren't a picked repository's. See [How code reaches GitHub](/architecture/github/#the-mirrors). |
| `choices.json` | The route and method you picked last on a deliver card, per sandbox. |

### The server

| Where | What |
| --- | --- |
| `run/git-<sandbox>-<id>.sock` | The socket a running sandbox's VM reaches its mirrors through, forwarded into the VM over SSH. Made when the relay starts, removed when it stops. |
| `run/hook.sock` | Where the mirrors' pre-receive hooks ask Kumiko about a push. Only your user can open it. |
| `home-id` | This home's id, which tags the runs its server starts. |
| `server.lock` | The running server's pid and port. One server per home: a second refuses to start. |
| `tmp/` | Kumiko's scratch folder, for files it reads out of folders the agent can change. |

## In the sandbox

| Where | What |
| --- | --- |
| `/workspace/<folder>` | Each repo's clone, on the workspace disk. |
| `/workspace/<folder>__worktrees/` | The repo's worktrees. |
| `~/.kumiko/local/runs/<session id>-<n>/` | Each agent process's run: its input FIFO, output and errors, pid and exit code. On the VM's own disk. See [How an agent runs](/architecture/agent-runs/#a-run). |
| `~/.config/kumiko/git.config` | The git config that sends the sandbox's repositories through the relay, included from `~/.gitconfig`. |

The workspace disk outlives the VM. A rebuild keeps it, **Rebuild from scratch** makes it anew, and deleting the
sandbox deletes it.

A run outlives Kumiko's server and is deleted when the agent exits. Runs that no saved session points at are removed
when the server starts and when the sandbox starts.

## In memory only

- Operations, their logs, and logins in progress. A server restart loses them.
- A live session's full event stream. Only the chat is saved, so a resumed session shows less than the live one did.
- How each repo's clone is, as the sandbox page shows it. Kumiko checks it again when the sandbox starts.

Live sessions are saved with their run, so the next server opens them again. Tabs come back from `tabs.json`.

A file that can't be read affects only its own sandbox, and the UI says which file and why.
