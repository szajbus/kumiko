---
title: Adding a sandbox provider or agent
description: The two interfaces another sandbox provider or coding agent implements, and what the rest of Kumiko still assumes.
sidebar:
  order: 5
---

Kumiko has two seams: a sandbox provider, which gives each sandbox an isolated environment, and an agent driver, which
runs the agent inside it. Each seam is a TypeScript interface, so a new provider or agent starts as one new class.
Today there is one of each: `LimaProvider` and `ClaudeDriver`. [Supported platforms](/reference/supported/) lists
their versions.

Read [Decisions and trade-offs](/overview/decisions/) before you start. Several decisions there depend on how Lima and
Claude Code behave.

## A sandbox provider

Implement `SandboxProvider` in `packages/sandbox/src/provider.ts`:

| Method | Does |
| --- | --- |
| `list` | Lists Kumiko's sandboxes only, with their state. |
| `validate`, `create` | Checks a new sandbox's spec, then creates, starts and provisions its VM: the agent, the user's provisioning script, then the agent's setup scripts. |
| `start`, `stop` | Starts and stops the VM. |
| `validateEdit`, `edit` | Checks an edit, then applies it to resources, mounts and the stored spec. |
| `delete` | Deletes the VM and its record, and its workspace disk unless `keepWorkspace` is set. A rebuild sets it. |
| `exec` | Runs a command in the VM with stdio piped. Everything else in Kumiko runs commands through it. |
| `forward` | Forwards a Unix socket in the VM to one on the host, for as long as the process runs. The git relay uses it. |
| `templates` | Lists the templates the create form offers, and the one to preselect. |

The rest of Kumiko also assumes these things of a sandbox:

- A disk of the sandbox's own is mounted at `/workspace`, and it outlives the VM.
- The agent home is mounted where the agent looks for it, and the sandbox's Kumiko folder is mounted at its host path.
- Forwarded variables reach commands run with `exec`, without being written to disk.
- A process started through `exec` with `setsid`, or with `perl` where there is no `setsid`, outlives the connection.
  Agents run detached, in runs (`packages/agent/src/runs.ts`), and need `bash`, `mkfifo` and `tail -F`.
- `git` and `socat` are there or can be installed with `apt-get`. The git relay's setup script
  (`packages/server/src/relay.ts`) installs them.

The provider is chosen in code, in `packages/server/src/server.ts`, and not per sandbox. Its `id` type allows only
`"lima"`.

## An agent

Implement `AgentDriver` in `packages/agent/src/driver.ts`. The session layer talks only to this interface.

| Methods | Do |
| --- | --- |
| `start`, `attach`, `position`, `detach` | Start the agent in a run of its own, attach to a run started earlier from a byte offset, report how far the output has been read, and let go while the agent keeps running. |
| `send`, `withdraw` | Send a prompt, which starts a turn or queues behind one, and take back a queued prompt the agent hasn't read. |
| `interrupt`, `stop` | End the current turn and keep the process, or end the process. |
| `rewindFiles` | Put the files the agent changed back as they were before a prompt. |
| `taskOutput`, `stopTask`, `backgroundTasks` | Read and stop background shells, monitors and subagents, and move foreground tasks to the background. |
| `answer`, `pendingAsks`, `setPlanMode` | Answer the agent's questions and plans, list the ones still open, and switch plan mode. |
| `pendingCalls` | List calls to Kumiko's tools the agent is waiting on, for the next driver to answer after a detach. |
| `onEvent` | Report the agent's events. |

Runs work for any agent that reads lines on stdin and writes lines on stdout. So `start`, `attach`, `position` and
`detach` can follow `ClaudeDriver`.

The tools Kumiko gives the agent, such as artifacts and `deliver`, come as a `ToolHost` in `start` and `attach`
(`packages/agent/src/tools.ts`). Claude Code reaches them as an MCP server over its control protocol. Another agent
needs some way to call them.

The rest is still specific to Claude Code, and would need generalizing:

- Session events carry Claude Code's stream-json as it is, with `kind: "claude"`. Both the server (`sessions.ts`) and
  the UI (`chat.ts`) read its message shapes.
- Login (`logins.ts`) and the account check (`usage.ts`) run `claude` commands directly.
- The Lima provider's provisioning installs Claude Code.
- The agent home is mounted at `~/.claude`, and `CLAUDE_CONFIG_DIR` points to it.
- The questions and plans the agent asks you about are Claude's `AskUserQuestion` and `ExitPlanMode` tools, and their
  answers are worded for Claude (`packages/agent/src/asks.ts`).

The driver is chosen in code, in `packages/server/src/server.ts`, like the provider.
