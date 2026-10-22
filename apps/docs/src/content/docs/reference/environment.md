---
title: Environment variables
description: Variables that change where Kumiko keeps things and what it runs.
sidebar:
  order: 2
---

## Kumiko

| Variable | Default | Does |
| --- | --- | --- |
| `KUMIKO_HOME` | `~/.kumiko` | Where Kumiko keeps projects, sandbox records, agent homes and sessions. Only one server runs per home; give a second Kumiko (a development one, say) a home of its own. |
| `KUMIKO_PORT` | a free port (app), `4317` (server alone) | The server's port. |

## Sandbox provider: Lima

Lima is the only sandbox provider today; see [Supported sandboxes and agents](/reference/supported/).

| Variable | Default | Does |
| --- | --- | --- |
| `LIMA_HOME` | `~/.lima` | Lima's own folder; Kumiko reads each instance's `ssh.config` from it. |
| `KUMIKO_LIMACTL` | `limactl` | The `limactl` to run. The tests point it at `packages/sandbox/fixtures/fake-limactl.mjs`. |
| `KUMIKO_SSH` | `ssh` | The `ssh` to run commands in a sandbox with. The tests point it at `packages/sandbox/fixtures/fake-ssh.sh`. |

The fake `limactl`, for tests and for working on the UI without real sandboxes:

| Variable | Does |
| --- | --- |
| `FAKE_LIMA_DIR` | Where the fake `limactl` keeps its state. |
| `FAKE_LIMA_DELAY` | How long each fake `limactl` step takes, in ms, to see progress in the UI. |
| `FAKE_LIMA_FAIL_CREATE` | Makes the fake `limactl create` fail. |

## Development

| Variable | Does |
| --- | --- |
| `KUMIKO_DEV_URL` | Set by `dev:desktop`: the window loads the UI from Vite and the app starts no server of its own. Ignored when packaged. |
| `KUMIKO_TOKEN` | The secret every API request must carry. Set by `dev:desktop`, so the server keeps it through restarts; the server alone makes a new one each start. |
| `KUMIKO_SERVER` | Where Vite proxies `/api` (default `http://127.0.0.1:4317`). |
| `KUMIKO_WEB_PORT` | Where `dev:desktop` starts looking for a free Vite port (default `5173`). |

## In the sandbox

What Kumiko sets for the agent. Today these are for Claude Code, the only agent.

| Variable | Set by | Is |
| --- | --- | --- |
| `CLAUDE_CONFIG_DIR` | Kumiko, in every command and shell | `~/.claude`, the mounted agent home (Claude Code-specific). |
| `PATH` | Kumiko | Includes `~/.local/bin`, where Claude Code installs. |
| Your forwarded variables | Kumiko, per command | Read from the host's environment at the time. |
