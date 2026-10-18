# Bentomo

A desktop app that creates, starts, stops and deletes Lima VMs ("sandboxes"), the same shape as workmux's Lima sandboxes.

Bentomo only touches Lima instances named `bm-…`. Every other instance, workmux's `wm-…` VMs included, is never listed, started, stopped or deleted.

## Requirements

- Node 24+
- [Lima](https://lima-vm.io) (`brew install lima`), with `limactl` on your `PATH`

## Run it

```sh
npm install
npm run desktop          # build everything and launch the Electron app
```

Package a macOS app (on a Mac):

```sh
npm run build && npm run dist:mac -w @bentomo/desktop   # → apps/desktop/release/
```

When the app is launched from the Dock, it reads your login shell's environment once at startup. That puts Homebrew's `limactl` on `PATH` and makes the variables you export in your shell profile available for forwarding. If you rotate a token in your profile, restart the app.

### Develop the UI in a browser

```sh
npm run dev:server       # API on http://127.0.0.1:4317
npm run dev:web          # Vite on http://localhost:5173, proxying /api
```

Without Electron, the folder picker becomes a text field for the host path.

To work without real VMs, point the server at the fake `limactl` used by the tests:

```sh
FAKE_LIMA_DIR=/tmp/fake-lima FAKE_LIMA_DELAY=1500 \
BENTOMO_LIMACTL=$PWD/packages/sandbox/fixtures/fake-limactl.mjs \
BENTOMO_SSH=$PWD/packages/sandbox/fixtures/fake-ssh.sh \
BENTOMO_HOME=/tmp/fake-bentomo \
npm run dev:server
```

## Scripts

| Script | Does |
| --- | --- |
| `npm run build` | Type-checks and builds every package, including the web UI. |
| `npm test` | Builds, then runs the adapter and server tests against the fake `limactl`. |
| `npm run roundtrip` | Build step 1's check against **real Lima**: creates `bm-roundtrip` (Debian 12, writable mount), provisions it with a forwarded variable, then checks exec stdin, stop, start (no re-provisioning) and delete. |
| `npm run server` | Runs the server alone and serves the built UI. |
| `npm run desktop` | Builds and launches the Electron app. |

## Layout

```
apps/desktop/          Electron main + preload (bundled with the server by esbuild)
packages/server/       HTTP + WS (Hono, ws), operations, list refresh
packages/sandbox/      SandboxProvider interface, Lima adapter, metadata files
packages/web/          React + Vite UI
packages/shared/       API and event types
```

State: Lima owns the VMs (`~/.lima/bm-*`). Bentomo keeps one JSON file per sandbox in `~/.bentomo/sandboxes/<name>.json`, holding the spec with variable names only, never values. Operation logs live in server memory. `BENTOMO_HOME` and `LIMA_HOME` override the locations.

## Notes on the implementation

Checked against Lima 2.2.1 (the spec's open questions):

- `limactl list --format json` prints one JSON object per line, with `name`, `status`, `cpus`, `memory` and `disk` (bytes) and `sshConfigFile`.
- `--mount-only` repeats. Lima splits its values on commas, so a mount path containing a comma is rejected.
- The remote `bash -s` hands the rest of stdin to the command after `exec`. Forwarded values containing quotes, `$` and newlines arrive intact.

Beyond the spec:

- **`SandboxProvider`** has three more methods: `provision` (re-run), `validate` (so the server can answer `400` before going async) and `templates`.
- **Provisioning output:**
  - The script runs with `set -e`.
  - Each command is echoed before it runs via a `DEBUG` trap, not `set -x`, so `$GITHUB_TOKEN` shows in the log as written, never its value.
  - stderr is merged into stdout, so the log keeps its order.
  - The script reaches `bash -c` through a quoted heredoc, so commands that read stdin (`apt`, `curl | sh`) can't consume the rest of the script.
- **If the first start fails** during create, provisioning runs on the next successful start. A sandbox counts as set up only once provisioning has run.
- **Recreate** (in the design's row menu) deletes a sandbox and creates it again from its stored spec: `POST /api/sandboxes/:name/recreate`.
- **`GET /api/env?names=A,B`** backs the form's "set on host" dots. It answers `true`/`false`, never values.
- **Request guard:** the server listens on `127.0.0.1` only. It also refuses requests whose `Host` or `Origin` isn't local, so a web page open in your browser can't drive it (DNS rebinding, CSRF).
