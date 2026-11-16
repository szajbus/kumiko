---
title: What Kumiko is
description: Mission control for your coding agents.
---

Kumiko is mission control for your coding agents. Start agents on any of your repositories, let them work unattended,
and see at a glance what each one is doing and which ones need you.

![The Sandboxes tab: every sandbox, its repos, its sessions, and which ones are waiting on you.](../../assets/screenshots/sandboxes.png)

## What you get

- **Agents that don't stop to ask.** Each sandbox is a VM the agent owns, so it works without permission prompts while
  your machine stays out of reach.
- **Many tasks at once.** Run several sessions in a sandbox, each in its own tab and its own worktree, so they don't
  step on each other.
- **An overview of the work.** See which sessions are working and which are waiting on you.
- **Agents that don't need Kumiko running.** Quit the app or restart it, and the agents keep working. When it's back,
  you see everything they did meanwhile.
- **Nothing to lose.** The work lives on the sandbox's own disk, which outlives the VM, and the agent's branches are
  pushed to GitHub as it goes. A sandbox's VM can be thrown away and rebuilt at any time.

## The pieces

- **A repo** is one of your GitHub repositories. Kumiko keeps a mirror of it on your Mac.
- **A sandbox** is an isolated environment where the agent works, with the repos you picked cloned onto a disk of its
  own. It's the main thing you create; sessions hang off it.
- **A session** is one conversation with the agent, in one tab.
- **A worktree** is a separate checkout the agent makes for a task, so parallel tasks stay apart.

See [Supported sandboxes and agents](/reference/supported/).

## Where to go next

| You want to… | Read |
| --- | --- |
| Try it | [Quick start](/getting-started/quick-start/) |
| Understand why it works this way | [Philosophy](/philosophy/) |
| Do something specific in the app | [User guide](/guide/sandboxes/) |
