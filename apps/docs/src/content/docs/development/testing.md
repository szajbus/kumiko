---
title: Testing
description: The test runner, the fakes that stand in for Lima, SSH, Claude Code and the GitHub CLI, and the checks against the real tools.
sidebar:
  order: 4
---

```sh
npm test
```

`npm test` builds everything, then runs every test with Node's own test runner, `node --test`. Nothing else is
installed for testing.

| Tests | Run from |
| --- | --- |
| `packages/sandbox/test`, `packages/agent/test`, `packages/server/test` | Compiled, in each package's `dist/test` |
| `packages/web/test` | The TypeScript itself, as Node strips its types |

CI runs `npm test` on every push and pull request, on Ubuntu, in the Test workflow (`.github/workflows/test.yml`). The
git relay's tests need `socat`, as the real relay does, so install it to run them on your machine.

## One file

```sh
node --test packages/web/test/chat.test.ts
npm run build && node --test packages/server/dist/test/server.test.js
```

Compiled packages run from `dist`, so build first.

## The fakes

Tests run real processes that stand in for the tools Kumiko runs, instead of mocks. The code under test spawns them
and reads their output as it does with the real tools.

| Fake | Stands in for | State |
| --- | --- | --- |
| `packages/sandbox/fixtures/fake-limactl.mjs` | `limactl` | `FAKE_LIMA_DIR`. Every call is appended to `calls.log` there. |
| `packages/sandbox/fixtures/fake-ssh.sh` | `ssh` into a VM | Runs the command on your machine, with a home in `$FAKE_LIMA_DIR/vm-home` and `/workspace` in `$FAKE_LIMA_DIR/workspace`. A no-op `sudo` and a fake `curl` are in `fixtures/fake-bin`. |
| `packages/agent/fixtures/fake-claude.mjs` | `claude -p` in stream-json mode | None. The prompt's text picks what it does: `slow` streams for ten seconds, `crash` exits, `widget N J` calls a Kumiko tool, and more. |
| `packages/server/fixtures/fake-gh.mjs` | `gh` | `FAKE_GH_DIR`: the signed-in user, the repositories, issues, PRs and REST answers. |

Variables such as `FAKE_LIMA_DELAY`, `FAKE_LIMA_FAIL_CREATE`, `FAKE_LIMA_VERSION` and `FAKE_CURL_FAIL` make a fake
slow, fail or report another version. The comment at the top of each fake lists the variables it reads.

The fakes know only the calls Kumiko makes. The fake `gh` fails on any other call, so a new call shows up in the tests.

## Checks against the real tools

A fake copies what the real tool did when someone wrote it. When a change depends on how the real tool behaves, run
the check against the real one. When a new version of the tool passes, update the version in
[Supported platforms](/reference/supported/).

| Script | Needs | Checks |
| --- | --- | --- |
| `npm run roundtrip` | Lima | The Lima provider: create, provision, exec, stop, start, delete. |
| `npm run workspace-disk-check` | Lima 2.3 or later | The workspace disk: mounted at `/workspace`, grown while stopped, kept through a recreate with a file, a commit, a stash and an uncommitted change, and deleted with the sandbox. |
| `npm run drive -- --sandbox <name>` | A sandbox with Claude Code logged in, or `--local` inside a VM | The Claude Code driver: prompts, forwarded variables, interrupts, and another driver picking the agent up mid-turn. |
| `npm run tools-check -- --sandbox <name>` | A sandbox with Claude Code logged in, or `--local` | The tools Kumiko hosts for Claude: one always loaded, one deferred, a call left pending across a detach, and whether Claude's checkpoints cover the agent home. |

## The docs

`packages/server/test/docs.test.ts` checks that [Agent instructions](/reference/agent-instructions/) quotes, word for
word, what Kumiko writes for the agent. A change to those instructions fails the test until the page has the new text.
