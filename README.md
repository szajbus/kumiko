# Kumiko

A Mac app for running coding agents on your GitHub repositories. Each agent works in a sandbox of its own, a VM it
owns, so it never stops to ask permission and can't reach the rest of your Mac. Its pushes stop at a mirror on your
Mac, and reach GitHub only when you approve them. Run many sessions across your sandboxes, and see which ones need you.

Today the sandboxes are [Lima](https://lima-vm.io) VMs and the agent is Claude Code. Kumiko runs on macOS, on Apple
silicon and Intel.

## Install

Download the `.dmg` for your Mac from the latest release on the Releases page, and follow
[Install and first session](apps/docs/src/content/docs/guide/quick-start.mdx). You need Lima 2.3 or later and the
GitHub CLI:

```sh
brew install lima gh
gh auth login
```

## Docs

The docs site covers the design, the architecture, the features, the user guide and how to work on Kumiko. Its pages
are Markdown in [`apps/docs/src/content/docs`](apps/docs/src/content/docs):

- [Overview](apps/docs/src/content/docs/overview/introduction.md): what Kumiko is, its concepts, principles and decisions
- [Architecture](apps/docs/src/content/docs/architecture/overview.md): processes, agent runs, the path to GitHub, security, state
- [User guide](apps/docs/src/content/docs/guide/quick-start.mdx): sandboxes, sessions, artifacts, shipping
- [Development](apps/docs/src/content/docs/development/setup.md): running from source, tests, conventions, releases

To read them as a site:

```sh
npm install
npm run docs:dev         # http://localhost:4321
```

## Run from source

You need a Mac, Node 24 or later, git and Lima.

```sh
npm install
npm run desktop          # builds everything and launches the app
npm run dev:desktop      # the app, with the UI hot-reloading and the server restarting on changes
npm test                 # builds, then runs every test against fake limactl, ssh and claude
```

[Development](apps/docs/src/content/docs/development/setup.md) covers the rest: working on the UI in a browser,
running against the fakes, the real-tool checks and releasing.

## Changes

[`CHANGELOG.md`](CHANGELOG.md) lists what changed for users in each release.
