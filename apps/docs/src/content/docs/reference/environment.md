---
title: Environment variables
description: The variables that change where Kumiko keeps its files and which tools it runs, and the ones it sets in a sandbox.
sidebar:
  order: 2
---

Kumiko reads these from its own environment. An app opened from the Dock gets the variables your login shell
exports, read once when Kumiko starts. A variable already set in Kumiko's environment wins, except `PATH`, which
comes from the login shell.

## Kumiko

| Variable | Default | Does |
| --- | --- | --- |
| `KUMIKO_HOME` | `~/.kumiko` | Where Kumiko keeps its files. See [State on disk](/architecture/state/). Only one server runs per home, so give a second Kumiko, such as a development build, a home of its own. |
| `KUMIKO_PORT` | A free port for the app, `4317` for the server alone | The server's port. |

## GitHub

| Variable | Default | Does |
| --- | --- | --- |
| `KUMIKO_GH` | `gh` | The GitHub CLI that lists your repositories, gives mirrors their token, and runs the agent's GitHub tools. |
| `KUMIKO_GITHUB_URL` | Unset | When set, new mirrors fetch from `<KUMIKO_GITHUB_URL>/<owner>/<name>.git` instead of GitHub. Point it at a folder of bare repositories, `file:///…`, or at a `git daemon` serving one, `git://…`. Tests use it with the fake `gh`. |

## Lima

Lima is the only sandbox provider today. See [Supported platforms and versions](/reference/supported/).

| Variable | Default | Does |
| --- | --- | --- |
| `LIMA_HOME` | `~/.lima` | Lima's own folder. Kumiko reads each VM's `ssh.config` from it. |
| `KUMIKO_LIMACTL` | `limactl` | The `limactl` Kumiko runs. |
| `KUMIKO_SSH` | `ssh` | The `ssh` Kumiko runs commands in a sandbox with. |

## Development

| Variable | Does |
| --- | --- |
| `KUMIKO_DEV_URL` | Set by `npm run dev:desktop`. The window loads the UI from Vite, and the app starts no server of its own. The packaged app ignores it. |
| `KUMIKO_TOKEN` | The secret every API request must carry. `dev:desktop` sets it so the server keeps it through restarts. A server started without it makes a new one each time. |
| `KUMIKO_SERVER` | Where Vite sends `/api` requests. The default is `http://127.0.0.1:4317`. |
| `KUMIKO_WEB_PORT` | The first port `dev:desktop` tries for Vite. The default is `5173`. |

### Fakes for tests

The tests and the UI work without real sandboxes run against fake tools. Point `KUMIKO_LIMACTL` at
`packages/sandbox/fixtures/fake-limactl.mjs`, `KUMIKO_SSH` at `packages/sandbox/fixtures/fake-ssh.sh`, and
`KUMIKO_GH` at `packages/server/fixtures/fake-gh.mjs`. See [Testing](/development/testing/).

| Variable | Does |
| --- | --- |
| `FAKE_LIMA_DIR` | Where the fake `limactl` keeps its state. |
| `FAKE_LIMA_DELAY` | How long each fake `limactl` step takes, in milliseconds, to see progress in the UI. |
| `FAKE_LIMA_FAIL_CREATE` | Makes the fake `limactl create` fail. |
| `FAKE_LIMA_VERSION` | The Lima version the fake reports. The default is `2.3.0`. |
| `FAKE_LIMA_VMTYPE` | The VM type the fake creates. The default is `vz`. |
| `FAKE_GH_DIR` | Where the fake `gh` keeps its state. |
| `FAKE_CLAUDE_CONTEXT` | The fake `claude`'s starting context size, in tokens. The default is 20000, growing by 500 a turn. |
| `FAKE_CLAUDE_AGENT_MS` | How long each step of a fake subagent takes. The default is 200. |
| `FAKE_CLAUDE_SHELL_MS` | How long each step of a fake background command takes. The default is 100. |
| `FAKE_CLAUDE_COMPACT_MS` | How long a fake compaction takes. The default is 100. |
| `DISABLE_AUTO_COMPACT` | Turns off auto-compaction in the fake `claude`, as it does in Claude Code. |

## In the sandbox

Kumiko sets these for every command it runs in a sandbox, and in every shell there. Today they are for Claude Code,
the only agent.

| Variable | Is |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | `~/.claude`, the mounted agent home, so Claude Code keeps all its configuration there. |
| `PATH` | Includes `~/.local/bin`, where Claude Code installs. |
| Your forwarded variables | Read from Kumiko's environment on your Mac at the time of each command. Kumiko sets them per command, not in interactive shells. |

Kumiko writes the shell part to `~/.config/kumiko/env.sh` in the sandbox on every start, and sources it from
`~/.bashrc` and `~/.profile`.
