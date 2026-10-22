---
title: Supported sandboxes and agents
description: Which sandbox providers and coding agents Kumiko works with today, the versions they were checked against, and what adding another takes.
sidebar:
  order: 0
---

Kumiko is a desktop app built around two seams: a **sandbox provider**, which gives each project an isolated
environment, and an **agent**, which works inside it. Today there is one of each. Which host platforms it runs on
follows mostly from the sandbox provider.

## Host platforms

| Platform | Status | Notes |
| --- | --- | --- |
| macOS | Supported | What Kumiko is built and used on. `dist:mac` packages it for Apple silicon and Intel. |
| Linux | Possible, untested | Lima runs on Linux, and `dist:linux` makes an unpacked build, but it gets little use. |
| Windows | Not supported | The desktop app has a Windows build config, but Lima only has experimental support there (through WSL2). |

## Sandbox providers

| Provider | Status | Isolation | Checked against | Hosts |
| --- | --- | --- | --- | --- |
| [Lima](https://lima-vm.io) | Supported, the default | A virtual machine per project | Lima 2.2.1 | macOS, Linux |

**Lima notes:**

- Sandboxes are Lima instances named `km-<project>`, kept in `~/.lima` (or `LIMA_HOME`). Kumiko never touches other
  instances.
- Any Lima template can be chosen; Debian 12 is preselected. Installing the agent uses `curl`, and installs it with
  `apt-get` if it's missing, so a template without `curl` must be Debian- or Ubuntu-based.
- Kumiko drives it with `limactl` and with `ssh` using the instance's generated config.
- Lima 2.3 or later, with `vz` VMs, can keep a sandbox off your Mac's loopback (`networkOpts.hostLoopback`), which
  Kumiko asks for unless a project allows it. With an older Lima, or another VM type, the sandbox can reach it, and
  the project page says so. Kumiko notices an upgraded Lima within a few minutes; a running sandbox needs a restart.
- Agents outlive the SSH connection that started them because systemd-logind leaves a user's processes running when
  their session ends (`KillUserProcesses=no`, Debian's default). A template that turns it on stops the agent whenever
  Kumiko's server goes away.

## Agents

| Agent | Status | Checked against | How Kumiko runs it |
| --- | --- | --- | --- |
| [Claude Code](https://claude.com/claude-code) | Supported, the only agent | Claude Code 2.1.304 | `claude -p` in stream-json mode, permissions bypassed |

**Claude Code notes:**

- Kumiko installs it in every sandbox with its native installer; you don't need it on the host.
- Each project has its own agent home, Claude Code's `~/.claude`, kept on the host in `~/.kumiko/claude/<project>/`.
  Kumiko keeps its own files apart from it, in `~/.kumiko` in the sandbox (`~/.kumiko/sandbox/<project>/` on the host).
- Every session feature is available with it:

| Feature | Uses |
| --- | --- |
| Streaming replies, tool calls, cost and tokens | stream-json output with partial messages |
| Working on while Kumiko is away | stream-json input read from a FIFO, which only ends when Kumiko closes it |
| Stop | an interrupt control request |
| Resume, fork | `--resume`, `--fork-session`, `--resume-session-at` |
| Rewind, and putting files back | `--replay-user-messages` and file checkpoints (`rewind_files`) |
| Slash commands | `slash_commands` from `system/init` |
| Model picker | `--model` and `/model` |
| Login | `claude auth status`, `claude auth login` |
| Usage in the title bar | the subscription usage endpoint, with the agent home's credentials |
| Artifacts, and the other tools Kumiko gives the agent | an SDK MCP server over the control protocol (`--mcp-config`), some tools deferred until `ToolSearch` loads them; `npm run tools-check` checks it against a real Claude |

## Adding another

Both seams are TypeScript interfaces, so a new provider or agent is mostly one new class. What else it needs today:

### A sandbox provider

Implement `SandboxProvider` (`packages/sandbox/src/provider.ts`): `list`, `create`, `start`, `stop`, `delete`, `edit`,
`validate`, `validateEdit`, `templates`, and `exec`, which runs a command inside with stdio piped. Everything else in
Kumiko runs commands through `exec`.

It also has to honour what the rest of Kumiko assumes:

- the clone and its worktrees folder are mounted at the **same absolute paths** inside,
- the agent home is mounted where the agent looks for it,
- forwarded variables reach commands run with `exec`, without being written to disk,
- a process started through `exec` with `setsid` (or `perl`'s) outlives the connection, and `bash`, `mkfifo` and
  `tail -F` are there: agents run detached in runs in the sandbox (`packages/agent/src/runs.ts`).

Today the provider is chosen in code (`LimaProvider`), not per project, and its `id` type only allows `"lima"`.

### An agent

Implement `AgentDriver` (`packages/agent/src/driver.ts`): `start`, `attach`, `position`, `send`, `interrupt`,
`rewindFiles`, `stop`, `detach`, `pendingCalls` and `onEvent`. That covers running sessions. The tools Kumiko gives the
agent come as a `ToolHost` in `start` and `attach` (`tools.ts`); Claude Code reaches them as an MCP server over its
control protocol, and another agent needs some way to call them. Runs (`runs.ts`) work for any agent that
reads lines on stdin and writes them on stdout, so `attach`, `position` and `detach` can follow `ClaudeDriver`. The rest is still specific to Claude Code and would need generalizing:

- session events carry Claude Code's stream-json as-is (`kind: "claude"`), and both the server (`sessions.ts`) and the
  UI (`chat.ts`) read its message shapes,
- login (`logins.ts`) and the usage check (`usage.ts`) run `claude` commands directly,
- installing the agent is part of the Lima provider's provisioning,
- the agent home is mounted at `~/.claude` and pointed to by `CLAUDE_CONFIG_DIR`.

If you're planning either, read [Decisions and trade-offs](/architecture/decisions/) first.
