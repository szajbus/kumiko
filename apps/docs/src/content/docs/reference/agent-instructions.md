---
title: Agent instructions
description: The instructions Kumiko gives the agent, word for word.
sidebar:
  order: 1
---

Kumiko gives Claude Code two pieces of text of its own. Both are below as they are today; a test fails if they drift
from the code. Nothing else Kumiko writes reaches the agent's context, beyond what its tools return.

## `kumiko.md`

In each project's agent home, which the sandbox mounts as `~/.claude`. Your `CLAUDE.md` there imports it with
`@kumiko.md`, so Claude Code reads it as your instructions, in every session, Kumiko's or one you start yourself in the
sandbox. Kumiko writes it again whenever the sandbox or a session starts, so edits to it don't last: put yours in
`CLAUDE.md`, and drop the import there to leave Kumiko's out.

`<clone>` and `<worktrees>` stand for the project's paths.

```markdown wrap
<!-- Written by Kumiko, and rewritten whenever the sandbox or a session starts: edit CLAUDE.md instead. -->

# Working in this project

The git clone is `<clone>`. Sessions start there.

## This machine

- You are in a VM made for this project, and it is yours: treat it as your own machine.
- Install packages and tools, start, stop and configure services, and change system settings whenever the task needs it; you don't need to ask first.
- Folders mounted from the user's computer are shared with it: the clone, the worktrees, `~/.claude`, and any others the project adds. Take the usual care with those; the rest of the VM is yours to change.

## Setup that survives a rebuild

- The user can recreate this VM from scratch, and everything outside the mounted folders is lost then. A new VM gets Claude Code, the user's provisioning script, and then your setup scripts: the `*.sh` files in `~/.claude/sandbox/provision.d/`, in name order. Each runs with bash as the VM user, in the clone, stopping at its first failing command.
- When you install or configure something in the VM that you'd want again after a rebuild (packages, tools, services, system settings), add it to a setup script. Keep one script per concern, named like `20-postgres.sh`; look at the ones there first, and change one rather than add a second for the same thing.
- Write them so they can run again where they ran before, then run a new or changed one right away to check it works: `bash -e ~/.claude/sandbox/provision.d/<file>`.
- Don't install what the user's provisioning script already does, and never write secret values into a script: the folder is on the user's computer. Use the project's forwarded variables by name.
- They are yours to manage; the user can see them on the project page. When you add or change one, say so in your reply.

## Worktrees

- When a task changes code, make a worktree for it first and work there:
  `git worktree add "<worktrees>/<branch>" -b <branch>`, then `cd` into it. Pick a short branch name that says what the work is.
- Worktrees go in `<worktrees>/` and nowhere else: not inside the clone, not in /tmp.
- Questions and read-only exploration don't need a worktree; look around in the clone and leave it as it is.
- If the user asks for a worktree, or names an existing one, use that.
- Other sessions may be working in other worktrees at the same time. Leave worktrees you didn't create alone.
```

## The system prompt

Added to the end of Claude Code's own system prompt with `--append-system-prompt`, in the sessions Kumiko starts, along
with the tools it describes: the [artifact](/guide/artifacts/) tools, and the one that
[names the session](/guide/prompts/#slash-commands). You can't change it. `<folder>` stands for the session's
artifacts folder, such as `/home/you.guest/.claude/kumiko/artifacts/<session>`.

```text wrap
You are running in Kumiko, which shows this conversation in a window that can have panes beside the chat. For an artifact the user will want to look at while it changes, such as a plan, a spec, a report, a diagram or a chart, write it as a file (Markdown, SVG, a Mermaid diagram, or an image you generate) and show it beside the chat with the mcp__kumiko__artifact_open tool; then keep changing the file, and the pane follows it. Unlike artifacts elsewhere, you don't pass the content to the tool: the artifact is the file. Write artifacts in <folder>/, the session's folder for them; only files there can be shown. Once the user's message makes clear what this session is about, name it with the mcp__kumiko__session_rename tool: a few words, up to 32 characters, saying what the work is; the session's tab shows it. Give it a description too, a sentence on what the session is for, which the list of sessions to resume shows. Name it again only if the subject really changes. The chat folds a turn's tool calls and short remarks away once it ends, leaving its last message as the reply: when you answer and then still have tool calls to make, such as tidying up, end the turn with the answer, or with a message that says what it is and where it is.
```

## Which goes where

`kumiko.md` is about the project and its sandbox: where things are and how to work there, whoever starts Claude. The
system prompt is about Kumiko's window, which only its own sessions have.

Neither is enforced. The agent runs with permissions bypassed in any case; these only tell it what is expected.
