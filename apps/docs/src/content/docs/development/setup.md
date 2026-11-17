---
title: Set up and run from source
description: Install the dependencies, run the app, and work on the UI and server with fast reloads or without real sandboxes.
sidebar:
  order: 1
---

## Requirements

- A Mac. Linux builds and runs, but gets little use. See [Supported platforms](/reference/supported/).
- [Node](https://nodejs.org) 24 or later, and npm.
- git.
- [Lima](https://lima-vm.io) 2.3 or later, for real sandboxes. The fakes below need no Lima.
- The [GitHub CLI](https://cli.github.com), signed in with `gh auth login`, to add repositories.

## Run the app

```sh
brew install lima gh
npm install
npm run desktop
```

`npm run desktop` builds every package and the UI, then starts Electron. It uses `~/.kumiko`, as the packaged app does.

## The development loop

```sh
npm run dev:desktop
```

`dev:desktop` (`apps/desktop/dev.mjs`) runs three things together:

- `tsc --watch` on the server, and the server under `node --watch`. A change to server code restarts the server.
- Vite, which hot-reloads the UI.
- Electron, with its window loading the UI from Vite (`KUMIKO_DEV_URL`).

The agents keep working while the server restarts. The restarted server attaches to their runs again and picks the
sessions up where they got to. See [How an agent runs](/architecture/agent-runs/).

A change to the Electron main process or preload needs the app restarted. Quitting the app stops everything.

`dev:desktop` starts looking for free ports at `4317` for the server and `5173` for Vite. Set `KUMIKO_PORT` and
`KUMIKO_WEB_PORT` to start elsewhere.

## One server per Kumiko home

Only one Kumiko app runs at a time. Only one server runs per Kumiko home: the server writes `server.lock` there, and a
second server on the same home refuses to start. So `dev:desktop` won't start while the packaged app uses
`~/.kumiko`. Give the development copy a home of its own:

```sh
KUMIKO_HOME=~/.kumiko-dev npm run dev:desktop
```

A sandbox belongs to the home that created it. Runs are tagged with their home's id, so servers on different homes
that share a VM leave each other's agents alone.

## The UI in a browser

To work on the UI in a browser, run the server and Vite on their own:

```sh
npm run dev:server   # the API on http://127.0.0.1:4317
npm run dev:web      # Vite on http://localhost:5173, proxying /api to the server
```

Every API request needs the server's token. The server prints an address that signs a browser in:

```text
Open http://127.0.0.1:4317/api/login?token=… to sign a browser in; through the dev UI, the same path on its port.
```

Through Vite, open the same path on Vite's port: `http://localhost:5173/api/login?token=…`. The server makes a new
token each time it starts, unless `KUMIKO_TOKEN` sets one. Vite proxies to `KUMIKO_SERVER`, by default
`http://127.0.0.1:4317`.

## Without real sandboxes

The fakes the tests use stand in for `limactl`, `ssh`, `claude` and `gh`. Point the server at them to work on the UI
without Lima, without a Claude account and without GitHub:

```sh
FAKE_LIMA_DIR=/tmp/fake-lima FAKE_LIMA_DELAY=1500 \
KUMIKO_LIMACTL=$PWD/packages/sandbox/fixtures/fake-limactl.mjs \
KUMIKO_SSH=$PWD/packages/sandbox/fixtures/fake-ssh.sh \
KUMIKO_GH=$PWD/packages/server/fixtures/fake-gh.mjs FAKE_GH_DIR=/tmp/fake-gh \
KUMIKO_HOME=/tmp/fake-kumiko \
npm run dev:server
```

`FAKE_LIMA_DELAY` slows each fake `limactl` step, in milliseconds, so progress shows in the UI. The fake `ssh` runs
commands on your machine, in a home of its own at `$FAKE_LIMA_DIR/vm-home`. The fake `gh` keeps its state in
`FAKE_GH_DIR`.

Provisioning installs a `claude` that only prints its version. For sessions that answer, replace
`$FAKE_LIMA_DIR/vm-home/.local/bin/claude` with a script that runs `packages/agent/fixtures/fake-claude.mjs`, as
`apps/docs/scripts/screenshots.mjs` does. Set `KUMIKO_GITHUB_URL` to a folder of bare repositories (`file:///…`) to give
the mirrors something to fetch. [Environment variables](/reference/environment/) lists every variable.

## Other scripts

| Script | Does |
| --- | --- |
| `npm run build` | Builds the packages with `tsc -b` and the UI with Vite. |
| `npm run typecheck` | Type-checks everything without building the UI. |
| `npm run server` | Runs the built server on its own. |
| `npm run dist:app` | Packages the app for Apple silicon, unpacked, in `apps/desktop/release`. |
| `npm run docs:dev` | The docs site on `http://localhost:4321`. See [Writing docs](/development/writing-docs/). |

Tests have a page of their own: [Testing](/development/testing/).
