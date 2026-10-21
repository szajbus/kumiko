# Kumiko

Mission control for your coding agents. Each project gets a sandbox the agent owns, so it works without permission prompts while your machine stays out of reach. Run many sessions across your projects, and see at a glance which ones need you.

Today the sandboxes are Lima VMs and the agent is Claude Code.

## Quick start

To use Kumiko, download it from Releases and follow the [quick start](apps/docs/src/content/docs/getting-started/quick-start.mdx). To run it from source you need a Mac, Node 24+, git and [Lima](https://lima-vm.io).

```sh
brew install lima
npm install
npm run desktop          # builds everything and launches the app
```

Choose **New project**, point it at a git clone, wait for the sandbox to say **Running**, then **New session** and say what you want done. The first session asks you to log the agent in.

## Docs

```sh
npm run docs:dev         # http://localhost:4321
```

The user guide, architecture, and supported sandboxes and agents. Pages are Markdown in [`apps/docs/src/content/docs`](apps/docs/src/content/docs); the site is [Starlight](https://starlight.astro.build). `npm run docs:build` builds it to `apps/docs/dist`.

## Development

```sh
npm test                 # builds, then runs every test against fake limactl, ssh and claude
npm run dev:desktop      # the app, with the UI hot-reloading and the server restarting on changes
```

`dev:desktop` restarts the server when its code changes. The agents keep working through it, and the restarted server opens their sessions again where they got to. Changes to the Electron main process or preload need the app restarted. Only one Kumiko app runs at a time, and only one server per Kumiko home: `dev:desktop` refuses to start while the regular app uses `~/.kumiko`, unless you give it its own `KUMIKO_HOME`.

To work on the UI in a browser, or without real sandboxes:

```sh
npm run dev:server       # API on http://127.0.0.1:4317
npm run dev:web          # Vite on http://localhost:5173, proxying /api

# the server against the fake limactl the tests use
FAKE_LIMA_DIR=/tmp/fake-lima FAKE_LIMA_DELAY=1500 \
KUMIKO_LIMACTL=$PWD/packages/sandbox/fixtures/fake-limactl.mjs \
KUMIKO_SSH=$PWD/packages/sandbox/fixtures/fake-ssh.sh \
KUMIKO_HOME=/tmp/fake-kumiko \
npm run dev:server
```

### Testing

Tests use Node's own runner, and real processes as fakes (`fake-limactl`, `fake-ssh`, `fake-claude`) instead of mocks. Run one file with `node --test`, e.g. `node --test packages/web/test/chat.test.ts`, or `npm run build && node --test packages/server/dist/test/server.test.js` for compiled packages.

The fakes only copy what the real tools do. When a change depends on how they really behave, run the check against the real one, and update the checked version in the docs when a new one passes:

| Script | Checks |
| --- | --- |
| `npm run roundtrip` | The Lima provider: create, provision, exec, stop, start, delete. |
| `npm run projects-check` | Same-path mounts and worktrees seen from both sides. |
| `npm run drive -- --sandbox <project>` | The Claude Code driver: prompts, forwarded variables, interrupts, and another driver picking the agent up mid-turn. |
| `npm run widgets-check -- --sandbox <project>` | The tools Kumiko hosts for Claude: one always loaded, one deferred, a call left pending across a detach, and whether Claude's checkpoints cover its Claude home. |

### Releasing

Every commit on `main` that passes the tests is built into the **unstable** pre-release on GitHub, replacing the last one: `Kumiko-unstable-arm64.dmg` and `Kumiko-unstable-x64.dmg`, with the commits since the last release as its notes. About Kumiko shows which build it is, e.g. `0.1.0-unstable.42`. Releases are that build, once it's been tried:

1. Download the unstable `.dmg`, install it and try it.
2. Write what changed for users under a new `## <version>` heading at the top of [`CHANGELOG.md`](CHANGELOG.md), from the unstable release's notes: leave out docs, tests and fixes to things that never shipped. Commit it to `main`.
3. `npm run release <version>` checks that `main` is the unstable build's commit, give or take the changelog, and asks you to confirm which build it's releasing. Then it dates the heading, sets the app's version, commits and tags `v<version>`, and pushes both.
4. The tag starts the Release workflow: it runs the tests, builds the `.dmg` and `.zip` for Apple silicon and Intel, and uploads them to a **draft** GitHub release with the changelog section as its notes. Check the draft and publish it. To start over, delete the draft and the tag (`git push --delete origin v<version>`, `git tag -d v<version>`).

The app isn't signed. When the `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` secrets are set, the Release workflow signs and notarizes it with no other changes; then take the Open Anyway step out of the quick start.

### Layout

```
apps/desktop/      Electron main + preload; bundles the server with esbuild
apps/docs/         The docs site
packages/shared/   Types and helpers the server and UI share
packages/sandbox/  SandboxProvider and the Lima provider
packages/agent/    AgentDriver and the Claude Code driver
packages/server/   HTTP + WebSocket server: projects, operations, sessions, git
packages/web/      React + Vite UI
```

### Guidelines

- **Types the server and UI share go in `packages/shared`.** The sandbox is only touched behind `SandboxProvider`, and the agent is run behind `AgentDriver` (login and usage still call `claude` directly; don't add more of that).
- **UI logic worth testing goes in a plain module** in `packages/web/src`, with a test in `packages/web/test`.
- **TypeScript is strict ESM** (`NodeNext`): relative imports end in `.js`, and type-only imports use `import type`.
- **Errors are typed classes**, mapped to an HTTP status in one place (`app.onError`). The API always answers JSON.
- **Check input before it reaches a shell or a file:** ids against their shape, values shell-quoted, secrets on stdin.
- **Kumiko only touches its own `km-…` sandboxes**, and never writes into a project's repository.
- **Comments say why**, in full sentences, especially behind a workaround. No comments that repeat the code.
- **Tests use the fakes, not mocks.** A bug fix comes with a test that fails without it.
- **UI copy is short and plain:** say what happened or what will happen, name the file and the reason when something can't be read, and ask before anything that loses work.
- **Commit subjects say what changes for the user**, in the imperative, without a prefix: "Rewind sessions in place, and fork from a message or with /fork". The body says what was wrong and what happens now.
- **Update the docs with the change.** When the UI changes visibly, retake the screenshots: `npm run build && node apps/docs/scripts/screenshots.mjs`. The script photographs a demo against the fakes; its paths live in `DEMO_ROOT` (default `/Users/you`, which must exist and be writable).
