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
- `--mount-only` repeats, but it splits its values on commas and can't set a path in the VM. Bentomo passes mounts with `--set '.mounts = […]'` instead.
- The remote `bash -s` hands the rest of stdin to the command after `exec`. Forwarded values containing quotes, `$` and newlines arrive intact.

Beyond the spec:

- **Working directory** (`workdir` in the spec, default `/workspace`, `~/…` allowed). Provisioning runs in it, and `exec` takes it as `cwd` for sessions.
  - Every start creates it if it's missing, and hands it to the VM user if they can't write to it; Lima creates `/workspace` as root when mounting under it. It can change in place, even while the VM runs.
  - Interactive shells start there too. Without `--workdir`, `limactl shell` tries the host's current directory and home, which rarely exist in the VM, and falls back to `~`. Each start writes `~/.config/bentomo/shell.sh`, sourced at the end of `~/.bashrc`, which moves a shell that lands in `~` to the working directory. A shell sent anywhere else stays there.
- **Mounts land in the working directory by default.** This replaces the spec's same-path rule.
  - A host folder `/a/b/c/d` is offered at `/workspace/d` in the VM (or `<working directory>/d`), with a `-2` suffix if that path is taken. The user can override it.
  - `~/…` in the VM path means the VM user's home; it becomes Lima's `{{.Home}}`.
  - When the host has `~/.claude`, the form starts with it mounted writable at `~/.claude` in the VM (`GET /api/defaults`).
  - VM paths can't be `/` or `~` and can't overlap.
  - Mounts saved without a VM path keep the host path.

- **`SandboxProvider`** has more methods: `validate` and `validateEdit` (so the server can answer `400` before going async), `edit` and `templates`. There is no separate "re-run provisioning": a sandbox is provisioned once, and a changed or fixed script runs by recreating it.
- **Claude Code is always installed**, as the first provisioning step before the user's script.
  - It uses the official native installer (`curl -fsSL https://claude.ai/install.sh | bash`), which puts it in `~/.local/bin` and needs no Node. curl is installed with apt if missing.
  - It is linked to `/usr/local/bin/claude`, so every shell finds it: login, non-login and `limactl shell`. Every start also puts `~/.local/bin` on `PATH` for every shell, as Claude Code's own checks expect: `~/.config/bentomo/env.sh`, sourced from the top of `~/.bashrc` (so commands run over ssh get it too) and from `~/.profile`. `exec` sets it as well.
  - If the install fails, provisioning fails (`provision_failed`), as for the script.
  - Every later start checks for it and reinstalls only if it is missing. A failure there is a warning.
  - With `~/.claude` mounted (the default), it uses the host's login and settings.
- **Provisioning output:**
  - The script runs with `set -e`.
  - Each command is echoed before it runs via a `DEBUG` trap, not `set -x`, so `$GITHUB_TOKEN` shows in the log as written, never its value.
  - stderr is merged into stdout, so the log keeps its order.
  - The script reaches `bash -c` through a quoted heredoc, so commands that read stdin (`apt`, `curl | sh`) can't consume the rest of the script.
- **If the first start fails** during create, provisioning runs on the next successful start. A sandbox counts as set up only once provisioning has run.
- **Sandbox page** (`#/sandbox/<name>`) in place of the spec's log drawer. Clicking a row opens it, and so does creating a sandbox. It shows status and actions, resources, template, setup state, creation time, mounts, forwarded variables, the provisioning script, and the log at full width.
- **Editing after creation** (`PATCH /api/sandboxes/:name`, **Edit** on the sandbox page). Name and template are fixed. The form has two ways to save:
  - **Save and recreate** (the default, `?recreate=1`) deletes the VM and creates it again from the changed spec, provisioning included. It works whether the VM runs or not, and the disk can shrink.
  - **Save** keeps the VM. CPUs, memory, disk and mounts go through `limactl edit`; they need the VM stopped, apply on its next start, and the disk can only grow. Forwarded variables and the provisioning script live only in Bentomo's metadata, so they can change while the VM runs, but a new script only runs on a recreate.
- **Recreate** (in the design's row menu) deletes a sandbox and creates it again from its stored spec: `POST /api/sandboxes/:name/recreate`.
- **`GET /api/env?names=A,B`** backs the form's "set on host" dots. It answers `true`/`false`, never values.
- **Request guard:** the server listens on `127.0.0.1` only. It also refuses requests whose `Host` or `Origin` isn't local, so a web page open in your browser can't drive it (DNS rebinding, CSRF).
