---
title: Overview
description: Kumiko's processes and how they talk to each other.
sidebar:
  order: 2
---

Kumiko is a local web app in an Electron shell. A Node server does the work: it manages sandboxes, runs git on the host,
drives the agents and serves the React UI. The window is a browser pointed at it.

```mermaid
flowchart TB
  subgraph app["Electron app (host)"]
    win["Window: React UI<br/>packages/web"]
    server["Kumiko server, in the main process<br/>packages/server · 127.0.0.1"]
    win -- "HTTP + WebSocket" --> server
  end
  subgraph hostside["Host"]
    provider["sandbox provider<br/>(limactl)"]
    git["git"]
    data[("~/.kumiko")]
    clone[("clone + clone__worktrees")]
  end
  subgraph sb["Sandbox, one per project"]
    agent["agent<br/>(claude -p)"]
  end
  server --> provider
  server --> git
  server --> data
  git --> clone
  provider -- "create · start · stop · delete" --> sb
  server -- "attach (ssh)" --> agent
  clone -. "mounted at the same paths" .-> sb
  data -. "agent home mounted" .-> sb
```

## Processes

- **Electron main** (`apps/desktop`) starts the server in-process on a free local port and opens a window on it. It
  also owns the folder picker, the single-instance lock, quit confirmation and opening links in the browser.
- **The server** (`packages/server`) is Hono on Node's HTTP server, plus `ws`. Live state (sandbox list, operations,
  sessions) is in memory; durable state is JSON files under `~/.kumiko`.
- **The UI** (`packages/web`) is a React single-page app with hash routes.
- **The sandbox provider** creates and runs one sandbox per project, and runs commands inside it.
- **The agent** runs in the sandbox, one process per session, alive between turns. It runs detached, in a run of its
  own (a FIFO for its input, a file for its output), so it outlives the server; the server attaches to it over SSH
  and attaches again after a restart. See [Decisions](/architecture/decisions/#agents-that-outlive-the-server).

## Packages

An npm workspaces monorepo in TypeScript. Packages build with `tsc -b`, the UI with Vite, and the desktop app bundles
the server with esbuild.

```mermaid
flowchart BT
  shared["@kumiko/shared"]
  sandbox["@kumiko/sandbox"] --> shared
  agent["@kumiko/agent"] --> sandbox
  agent --> shared
  server["@kumiko/server"] --> agent
  server --> sandbox
  server --> shared
  web["@kumiko/web"] --> shared
  desktop["@kumiko/desktop"] --> server
```

| Package | Does |
| --- | --- |
| `packages/shared` | Types and helpers the server and UI share: API shapes, events, name patterns, limits. No runtime dependencies. |
| `packages/sandbox` | The `SandboxProvider` interface, `LimaProvider`, and the sandbox records in `~/.kumiko/sandboxes/`. |
| `packages/agent` | The `AgentDriver` interface, `ClaudeDriver`, and a fake `claude` for tests. |
| `packages/server` | HTTP and WebSocket server: projects, operations, sessions, git, login, usage. |
| `packages/web` | The React UI. Logic worth testing lives in plain modules (`chat.ts`, `pastes.ts`, …) with tests in `test/`. |
| `apps/desktop` | Electron main process and preload, the icon, and the dev loop (`dev.mjs`). |

## Channels

| Channel | Carries |
| --- | --- |
| `/api/…` (HTTP) | Reads and actions. Long actions answer `202` and report progress as events. |
| `/api/events` (WebSocket) | App-wide: projects, operations and their logs, session status. |
| `/api/sessions/:id/events` (WebSocket) | One session's events, replayed and then live. |
