---
title: Supported platforms and versions
description: The host platforms, sandbox providers and coding agents Kumiko works with today, and the versions they were checked against.
sidebar:
  order: 4
---

Kumiko has one sandbox provider, Lima, and one agent, Claude Code. The host platforms it runs on follow mostly from
the sandbox provider. To add another provider or agent, see
[Adding a sandbox provider or agent](/development/extending/).

## Host platforms

| Platform | Status | Notes |
| --- | --- | --- |
| macOS | Supported | Kumiko is built and used on it. Releases have a `.dmg` and a `.zip` for Apple silicon and Intel. |
| Linux | Possible, untested | Lima runs on Linux, and `dist:linux` makes an unpacked build, but it gets little use. |
| Windows | Not supported | The desktop app has a Windows icon, but Lima supports Windows only experimentally, through WSL2. |

## Sandbox providers

| Provider | Status | Isolation | Checked against | Hosts |
| --- | --- | --- | --- | --- |
| [Lima](https://lima-vm.io) | Supported, the default | A virtual machine per sandbox | Lima 2.3.0 | macOS, Linux |

### Lima

- Each sandbox is a Lima instance named `kumiko-<name>`, in `~/.lima` or `LIMA_HOME`, with a Lima disk
  `kumiko-<name>-workspace` mounted at `/workspace`. Kumiko leaves other instances and disks alone.
- Kumiko needs Lima 2.3 or later, which mounts a disk where Kumiko asks (`additionalDisks[].mountPoint`). With an older
  Lima, creating a sandbox says to upgrade.
- Lima formats the workspace disk on the first boot only, so a rebuilt VM gets the disk as it was. The disk grows only
  while the VM is stopped, as Lima won't resize a disk in use.
- You can pick any Lima template. The form preselects Debian 12. Kumiko installs Claude Code with `curl`. A template
  without `curl` gets it from `apt-get`, so it must be based on Debian or Ubuntu. The git relay installs `git` and
  `socat` the same way.
- Kumiko runs `limactl`, and `ssh` with the instance's generated config.
- Lima 2.3 or later, with a `vz` VM, can keep a sandbox off your Mac's loopback (`networkOpts.hostLoopback`). Kumiko
  asks for that unless the sandbox allows it. With another VM type, the sandbox can reach your loopback, and the
  sandbox page says so. Kumiko notices an upgraded Lima within a few minutes. A running sandbox needs a restart to
  use it.
- Agents outlive the SSH connection that started them because systemd-logind leaves a user's processes running when
  their session ends (`KillUserProcesses=no`, Debian's default). In a template that turns it on, the agent stops
  whenever Kumiko's server goes away.

## Agents

| Agent | Status | Checked against | How Kumiko runs it |
| --- | --- | --- | --- |
| [Claude Code](https://claude.com/claude-code) | Supported, the only agent | Claude Code 2.1.309 | `claude -p` in stream-json mode, permissions bypassed |

### Claude Code

- Kumiko installs Claude Code in every sandbox with its native installer. You don't need it on your Mac.
- Each sandbox has its own agent home, Claude Code's `~/.claude`, kept on your Mac in `~/.kumiko/claude/<name>/`.
  Kumiko keeps its own files apart from it, in the sandbox's Kumiko folder. See [State on disk](/architecture/state/).

Every session feature works with Claude Code:

| Feature | Uses |
| --- | --- |
| Streaming replies, tool calls, cost and tokens | stream-json output with partial messages |
| Diffs of file edits | `tool_use_result` beside an Edit's or a Write's result: its `structuredPatch`, and for a Write, `type` (`create` or `update`). A NotebookEdit's `old_source`. Subagents' results don't carry it, so Kumiko diffs theirs from the input |
| Subagents' work | Their messages, by `parent_tool_use_id`, whole, as Claude Code doesn't stream them. The `task_*` and `background_tasks_changed` system messages |
| Background shells, monitors and subagents | The `get_task_output`, `stop_task` and `background_tasks` control requests |
| Working on while Kumiko is away | stream-json input read from a FIFO, which ends only when Kumiko closes it |
| Taking back a queued message | The `cancel_async_message` control request |
| Stop | The `interrupt` control request |
| Questions and plans | `--permission-prompt-tool stdio`: Claude asks before `AskUserQuestion` and `ExitPlanMode` even with permissions bypassed. Plan mode is switched with `set_permission_mode` |
| Resume, fork | `--resume`, `--fork-session`, `--resume-session-at` |
| Rewind, and putting files back | `--replay-user-messages` and file checkpoints (`rewind_files`), with `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1` |
| Suggestions | `--prompt-suggestions` |
| Slash commands | `slash_commands` from `system/init` |
| Compactions, and how full the context is | The `system/status` (`compacting`, `compact_result`) and `system/compact_boundary` messages, the summary that follows them, and the `get_context_usage` control request, asked at the start and after each turn and compaction |
| Model picker | `--model` and `/model` |
| Login | `claude auth status`, `claude auth login` |
| Usage in the title bar | `rate_limit_event` messages, which come with each turn, and `claude auth status` for the account |
| Artifacts, `deliver` and Kumiko's other tools | An SDK MCP server over the control protocol (`--mcp-config`), with some tools deferred until `ToolSearch` loads them. `npm run tools-check` checks it against a real Claude Code |

[Testing](/development/testing/#checks-against-the-real-tools) has the scripts that check each version.
