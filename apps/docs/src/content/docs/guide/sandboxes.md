---
title: Sandboxes
description: Creating, editing, restarting, rebuilding and deleting sandboxes, and the repos and workspace disk they have.
sidebar:
  order: 1
---

This page covers everything you can do with a sandbox: create it, pick its repos, tune it, change it later, and remove
it.

A sandbox is a VM of its own for the agent, with an agent home, a workspace disk, and the repos you picked from your
[mirrors](/guide/repos/) cloned onto that disk. The **Sandboxes** tab lists them, with each one's repos, status and
resources, how many sessions are open, and how many are waiting on you. Click a row to open the sandbox's page.

![The Sandboxes tab: three sandboxes, two running, one with a session waiting on you.](../../../assets/screenshots/sandboxes.png)

## Creating a sandbox

**New sandbox** takes a name of your choosing and the repos the sandbox works on. The name is lowercase letters, digits
and dashes; the VM is `kumiko-<name>`.

### Repos

Tick the repos from your mirrors. **Mirror another repository from GitHub…** adds a mirror first, from the same picker
as the [Repos](/guide/repos/) page, and ticks it.

Each repo is cloned into `/workspace/<folder>`, with its worktrees beside it in `/workspace/<folder>__worktrees`. The
form shows the folder each one gets:

- A repo's folder is its name, such as `/workspace/api`.
- Repos picked together that share a name each get their owner in front: `acme-api` and `szajbus-api`.
- A repo added later whose name is taken gets the owner in front itself. A folder, once given, never changes.

The clones are made inside the sandbox, from the mirrors, once it runs: `git clone git@github.com:<owner>/<name>.git`,
which git in the sandbox fetches from the mirror. `origin` keeps GitHub's URL. A sandbox can have no repos at all.

## The workspace disk

Every sandbox has a disk of its own, mounted at `/workspace`. The repos, their worktrees, and anything else there
(dependencies, build output, stashes, uncommitted work) stay on it when the sandbox is rebuilt. Only the system is
rebuilt, and the setup scripts bring back what's needed. Every session starts in `/workspace`.

The disk is a Lima disk, `kumiko-<name>-workspace`, which needs Lima 2.3 or later. It is made with the sandbox, can
grow while the sandbox is stopped, and is deleted with the sandbox. Nothing on your Mac opens it.

## Sandbox settings

The rest of the form, under **Sandbox**, is the sandbox's settings. What they mean depends on the sandbox
provider; with Lima, the only one today, they describe a VM.

### Template and resources

Choose the sandbox's template, its CPUs, memory, workspace disk and system disk. The workspace disk holds
`/workspace`; the system disk holds everything else, and is rebuilt with the VM. The form starts with sensible
defaults.

### Mounts

Three are always there and can't be changed:

| Host | In the sandbox | |
| --- | --- | --- |
| The workspace disk | `/workspace`: the repos and their worktrees | persistent |
| The sandbox's agent home (shown as **Claude home**) | `~/.claude`, where Claude Code looks | writable |
| The sandbox's **Kumiko folder**: the agent's setup scripts and the sessions' artifacts | the same path as on your Mac, and `~/.kumiko/shared` | writable |

The Kumiko folder is at the same path in the sandbox as on your Mac, `~/.kumiko/sandbox/<name>/` in your home, so a
path the agent gives you there, such as an artifact's, is one you can open as it is. `~/.kumiko/shared` in the sandbox
links to it. If an extra mount is in the way of that path (one of a folder holding it, at the same path), the Kumiko
folder is mounted at `~/.kumiko/shared` instead. Sandboxes made before Kumiko did this move theirs when they next start.

**Extra mounts** are folders from your Mac, nothing more: Kumiko doesn't treat them as repos. They appear at the same
path in the sandbox unless you set another. A sandbox path of `~/…` means the sandbox user's home. Sandbox paths can't
be `/` or `~`, can't overlap, and can't be in `/workspace`.

### Forwarded variables

List the **names** of host variables the sandbox should see, such as `NPM_TOKEN`. Kumiko stores only the names. Each
time it runs a command in the sandbox (provisioning, a session, an account check) it reads the values from its own
environment and hands them to the command on stdin (over SSH, with Lima), so they never appear in a process list or
on disk.

### This Mac's localhost

Off by default: the sandbox can't reach services listening on your Mac's `127.0.0.1`, such as databases, dev servers
and other apps' local APIs. Turn on **Let Claude reach services on this Mac's localhost** when the agent should use one
of them. Blocking it takes Lima 2.3 or later; with an older Lima, the sandbox page says the sandbox can reach them. A
change applies the next time the sandbox starts. See the [security model](/architecture/security/).

### Provisioning script

A shell script run once, in `/workspace`, when the sandbox is first set up. It runs with `set -e`, and each command is
echoed in the log before it runs, written as in the script, so `$NPM_TOKEN` shows as `$NPM_TOKEN`, never its value.

Before your script, Kumiko installs the agent: Claude Code, with its native installer, linked to
`/usr/local/bin/claude`. If either fails, the sandbox shows **Provision failed**; fix the script and rebuild it.

The agent gets a copy of the script, `user-provision.sh` in the sandbox's Kumiko folder, so its own setup scripts don't
repeat what yours does. Keep secrets out of the script: use forwarded variables.

### The agent's setup scripts

The agent installs what its work needs as it goes, and writes it down as setup scripts so a rebuilt sandbox gets it
again. They run when the sandbox is created, after your provisioning script; if one fails, the sandbox shows
**Running · agent setup failed**.

The agent manages them; there is nothing you need to do. To see them, open **Agent's setup scripts** on the sandbox
page. To start from scratch, **Delete scripts** there deletes them all: the sandbox keeps what they set up until you
rebuild it, and then starts from your provisioning script only.

## The sandbox page

The page shows the sandbox's sessions, its repos, its settings, its mounts and variables, the agent's setup scripts,
and the log of the last operation.

Each repo shows its GitHub name, its folder, and how its clone is: **Cloned**, **Cloning…**, or **Clone failed** with
git's message. Before the sandbox has run, or while git in it can't reach the mirrors yet, a repo shows **Not cloned
yet**, with why when git can't reach them, or **Checked when the sandbox starts** while it is stopped. Kumiko looks again each time the sandbox starts. A
folder in the way that isn't a git clone is left alone, and the repo shows why it couldn't be cloned.

**Add repo** opens the form to pick more. A new repo is cloned at once if the sandbox runs, or when it next starts.

### Removing a repo

Untick it in **Edit** and save. Its mirror stops being served to the sandbox, and Kumiko deletes its folder and its
worktrees folder from `/workspace`: at once if the sandbox runs, or when it next starts. Before that, the dialog lists
what in that repo isn't pushed: branches with commits that aren't on GitHub, worktrees with uncommitted changes, and
stashes. Branches on GitHub stay, and adding the repo again clones it again.

## Editing a sandbox

**Edit** changes the sandbox's settings, and adds and removes repos. The name and template are fixed, and so are the default
mounts. Two ways to save:

- **Save and rebuild sandbox** (the default) deletes the VM and creates it again from the changed settings,
  provisioning included. It works whether the sandbox is running or not, and the system disk can shrink. The workspace
  disk stays as it is.
- **Save** keeps the VM. CPUs, memory, disks and mounts apply on its next start, and the disks can only grow. If the
  sandbox is running when they change, the button becomes **Save and restart sandbox**: it stops the sandbox, saves and
  starts it again, ending its live sessions. Forwarded variables and the script can change while it runs, but a new
  script only runs on a rebuild. Repos alone are saved at once.

## Restarting, rebuilding and deleting

- **Restart sandbox** stops a running sandbox and starts it again, ending its live sessions (it asks first if there
  are any). Both disks are kept, so nothing is provisioned again.
- **Rebuild sandbox** deletes the VM and creates it again from its stored settings, with the
  [agent's setup scripts](#the-agents-setup-scripts). The workspace disk is attached to the new VM as it is: clones,
  worktrees, stashes, uncommitted work and dependencies are all still there. The agent home, the saved sessions and
  the login stay too.
- **Rebuild from scratch** is Rebuild with the workspace disk wiped too. Kumiko then clones each repo again from its
  mirror, so only what's pushed comes back. The agent home and the login stay.
- **Delete sandbox** removes the sandbox: its VM, its workspace disk and everything on it, its agent home and its saved
  sessions. Branches the agent pushed stay on GitHub.

Rebuild from scratch and Delete first list what the sandbox has that isn't pushed, repo by repo: branches with commits
that aren't on GitHub, worktrees with uncommitted changes, and stashes. Anything else on the disk goes too, such as
ignored files like `node_modules` and `.env`. If something would be lost, you tick that you understand before going
on. A stopped sandbox can't be looked into: **Start it and check** starts it and lists what it finds, or you can go on
without checking.

## Getting a shell

To look around in a sandbox yourself, with Lima:

```sh
limactl shell kumiko-<name>
```

The shell starts in `/workspace`, with the agent (Claude Code) on `PATH` and pointed at the sandbox's agent home.
