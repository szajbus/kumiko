---
title: Goals and non-goals
description: What Kumiko aims for, and what it leaves out.
sidebar:
  order: 1
---

## Goals

1. **Unattended, safely.** The agent runs with permissions bypassed, in a sandbox per project.
2. **Many sessions at once.** Across projects, and in parallel on one project.
3. **An overview.** Which sessions need you, and where each worktree stands.
4. **Disposable sandboxes.** Everything that matters lives on the host.
5. **Local.** One user, one machine, no service.

## Non-goals

- **Remote or shared use.** The server only accepts local requests.
- **Enforcing a workflow.** The agent is told the worktree convention, not forced to follow it.
- **Managing git remotes.** Kumiko never fetches, pushes or merges.
