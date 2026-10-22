---
title: Projects and sandboxes
description: Creating, editing, restarting, recreating and deleting projects and their sandboxes.
sidebar:
  order: 1
---

This page covers everything you can do with a project: create it, tune its sandbox, change it later, and remove it.

A project is a local git clone with one sandbox and one agent home. The **Projects** tab lists them, with each
sandbox's status and resources, how many sessions are open, and how many are waiting on you. Click a row to open the
project's page.

![The Projects tab: three projects, two running, one with a session waiting on you.](../../../assets/screenshots/projects.png)

## Creating a project

**New project** takes a host folder (the clone) and a name, which defaults to the folder's name. Kumiko checks the clone
with git on the host:

- It must be the top folder of a non-bare repository's main working tree: not a subfolder, not a linked worktree.
- It must not already be a project, and the name must be free.

Kumiko creates `<clone>__worktrees` if it's missing and seeds the agent home.

## Sandbox settings

The rest of the form, under **Sandbox**, is the sandbox's settings. What they mean depends on the sandbox
provider; with Lima, the only one today, they describe a VM.

### Template and resources

Choose the sandbox's template, its CPUs, memory and disk. The form starts with sensible defaults.

### Mounts

Four mounts are always there, listed under **Default mounts**, and can't be changed:

| Host | In the sandbox | |
| --- | --- | --- |
| The clone | The same absolute path | writable |
| `<clone>__worktrees` | The same absolute path | writable |
| The project's agent home (shown as **Claude home**) | `~/.claude`, where Claude Code looks | writable |
| The project's **Kumiko folder**: the agent's setup scripts and the sessions' artifacts | `~/.kumiko` | writable |

**Extra mounts** are up to you. They default to the same path in the sandbox too. A sandbox path of `~/…` means the
sandbox user's home. Sandbox paths can't be `/` or `~` and can't overlap.

### Forwarded variables

List the **names** of host variables the sandbox should see, such as `GITHUB_TOKEN`. Kumiko stores only the names. Each
time it runs a command in the sandbox (provisioning, a session, a usage check) it reads the values from its own
environment and hands them to the command on stdin (over SSH, with Lima), so they never appear in a process list or
on disk.

### This Mac's localhost

Off by default: the sandbox can't reach services listening on your Mac's `127.0.0.1`, such as databases, dev servers
and other apps' local APIs. Turn on **Let Claude reach services on this Mac's localhost** when the agent should use one
of them. Blocking it takes Lima 2.3 or later; with an older Lima, the project page says the sandbox can reach them. A
change applies the next time the sandbox starts. See the [security model](/architecture/security/).

### Provisioning script

A shell script run once, in the clone, when the sandbox is first set up. It runs with `set -e`, and each command is
echoed in the log before it runs, written as in the script, so `$GITHUB_TOKEN` shows as `$GITHUB_TOKEN`, never its
value.

Before your script, Kumiko installs the agent: Claude Code, with its native installer, linked to
`/usr/local/bin/claude`. If either fails, the sandbox shows **Provision failed**; fix the script and recreate it.

### The agent's setup scripts

The agent installs what its work needs as it goes, and that is lost when the sandbox is recreated. So the agent is told
to write it down: as shell scripts in its own folder, `provision.d/` in the project's Kumiko folder
(`~/.kumiko/provision.d/` in the sandbox), one per concern, such as `20-postgres.sh`. They survive a recreate,
because the Kumiko folder is on your Mac. It is kept apart from the agent home, which is Claude Code's to change.

When the sandbox is created, they run after your provisioning script: each `*.sh` file in name order, in the clone,
with the same forwarded variables, and each stops at its first failing command. One that fails doesn't stop the others
or the sandbox: it shows **Running · agent setup failed**, and the project page says which. Files that aren't plain
`*.sh` files, or are over 1 MB, are left out. If your own script fails, none of them run.

The agent manages them; there is nothing you need to do. To see them, open **Agent's setup scripts** on the project
page, which also says how each went when the sandbox was created. If they go wrong, **Delete scripts** there deletes the
folder and everything in it: the sandbox keeps what they set up until you recreate it, and then starts from your
provisioning script only.

## Editing a project

**Edit** changes the sandbox's settings. The clone, name and template are fixed, and so are the default mounts. Two ways
to save:

- **Save and recreate sandbox** (the default) deletes the sandbox and creates it again from the changed settings,
  provisioning included. It works whether the sandbox is running or not, and the disk can shrink.
- **Save** keeps the sandbox. CPUs, memory, disk and mounts apply on its next start, and the disk can only grow. If
  the sandbox is running when they change, the button becomes **Save and restart sandbox**: it stops the sandbox,
  saves and starts it again, ending its live sessions. Forwarded variables and the script can change while it runs,
  but a new script only runs on a recreate.

## Restarting, recreating and deleting

- **Restart sandbox** stops a running sandbox and starts it again, ending its live sessions (it asks first if there
  are any). The disk is kept, so nothing is provisioned again.
- **Recreate sandbox** deletes the sandbox and creates it again from its stored settings, with the
  [agent's setup scripts](#the-agents-setup-scripts). The agent home and the saved sessions stay, and so does the
  login.
- **Delete** removes the project, its sandbox, its agent home and its saved sessions, after asking. The clone and its
  worktrees are never touched.

## Getting a shell

To look around in a sandbox yourself, with Lima:

```sh
limactl shell km-<project>
```

The shell starts in the clone, with the agent (Claude Code) on `PATH` and pointed at the project's agent home.
