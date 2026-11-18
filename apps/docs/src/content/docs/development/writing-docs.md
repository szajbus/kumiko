---
title: Writing docs
description: Where the pages live, what goes in each section, the skills the docs are written with, and how to retake the screenshots.
sidebar:
  order: 6
---

The docs are a [Starlight](https://starlight.astro.build) site in `apps/docs`. Pages are Markdown in
`apps/docs/src/content/docs`, one folder per section.

```sh
npm run docs:dev       # http://localhost:4321, reloading as you edit
npm run docs:build     # static HTML in apps/docs/dist
npm run docs:preview   # serves the build
```

Mermaid diagrams go in ` ```mermaid ` fences. A page loads Mermaid only when it has a diagram.

## Sections

The sidebar runs from why Kumiko is built as it is, to using it, to working on it. `apps/docs/astro.config.mjs` sets
the order of the sections. Each page's `sidebar.order` sets its place in its section.

| Folder | What goes there |
| --- | --- |
| `overview/` | What Kumiko is, its concepts, its principles, and the decisions it rests on with what each costs. |
| `architecture/` | How it works inside: processes, how an agent runs, how code reaches GitHub, security, state on disk. |
| `features/` | One short page per feature: what you get and why, with a screenshot, and links to the guide. No steps. |
| `guide/` | How to do things in the app, one task per page. |
| `reference/` | Lookups: shortcuts, variables, the agent's instructions, supported versions, the API. |
| `development/` | Working on Kumiko itself. |

Link to another page rather than repeat it. A feature page links to its guide page, and a guide page links to the
architecture page that explains why.

## Style

Two skills in `.claude/skills` set how the docs are written. Claude reads both before docs work, as `CLAUDE.md` says.

- `documentation` (from `anthropics/knowledge-work-plugins`): what each kind of page covers. Write for the reader,
  put the most useful information first, show commands and screenshots, and link instead of copying.
- `unslop` (from `cursor/plugins`): the editing rules. No dashes as punctuation, sentence case headings, plain words,
  one idea per sentence, active voice, and numbers instead of adverbs.

The docs speak to the user as "you", and name things as the app's UI names them, in bold: **New sandbox**,
**Rebuild from scratch**.

## Keep them current

Update the docs in the same commit as the change they describe. A changed decision changes
[Decisions and trade-offs](/overview/decisions/). A new or changed environment variable changes
[Environment variables](/reference/environment/).

[Agent instructions](/reference/agent-instructions/) quotes what Kumiko writes for the agent, word for word.
`packages/server/test/docs.test.ts` fails when the page and the code differ. Change the code, then paste its new
output into the page.

## Screenshots

When the UI changes visibly, retake the screenshots:

```sh
npm run build && node apps/docs/scripts/screenshots.mjs
```

The script starts a server against the fakes, builds a demo of three sandboxes with sessions, and photographs it with
a headless Chrome. The pictures go to `apps/docs/src/assets/screenshots`. For the session, the script drives Chrome over
its DevTools protocol, to unfold the last turn's tool calls before the picture is taken.

- `DEMO_ROOT` is where the demo's Kumiko home and GitHub stand-in go. Its path shows in the screenshots. It defaults
  to `/Users/you`, which has to exist and be writable:
  `sudo mkdir /Users/you && sudo chown $USER /Users/you`.
- `CHROME` names the browser. By default the script uses Playwright's headless shell, then Google Chrome.
- `KUMIKO_PORT` sets the demo server's port, by default `4319`.
