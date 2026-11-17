---
title: Principles
description: The ideas Kumiko is built on, its goals, and what it leaves out.
---

These ideas explain why Kumiko behaves as it does. New features are checked against them.

## The sandbox is the boundary

An agent is most useful when it can install what it needs, run the tests, try a fix and run them again. Permission
prompts interrupt that. Approving them without reading makes them pointless.

So the agent works in a sandbox, and the sandbox belongs to the agent. The agent can install, run and change anything
there without asking. Your Mac stays out of reach, apart from what you share with the sandbox. The question "may it do
this?" becomes "what did I give it?", and you answer it once, when you set up the sandbox.

The work sits on the sandbox's workspace disk, which outlives the VM, and the agent's settings sit on your Mac. So the
VM is disposable. If it breaks, or you want a clean one, rebuild it and carry on.

## Kumiko watches, the agent works

Kumiko starts agents, gives them their work, shows you what each one does and tells you which ones need you. The work
happens in the sandbox, not in Kumiko.

So an agent doesn't depend on Kumiko running. Quit the app, let your Mac sleep or restart Kumiko, and the agent
carries on with its turn. A command it started finishes, and a file it was writing gets written. When Kumiko comes
back, it reads what happened and shows it as if it had been watching.

An agent stops only when you decide about its work. Closing its session or deleting its sandbox ends it. Stopping,
restarting or rebuilding the sandbox stops the agent's process and puts the session to sleep, and the conversation
continues once the sandbox runs again.

## Nothing leaves without you

The agent can do anything inside its sandbox, and nothing outside it on its own. Its pushes stop at a mirror on your
Mac. A branch reaches GitHub, and the default branch changes, only when you approve it on a card. Kumiko then does it
on your Mac, with your GitHub login and your signing key. The same holds for issues and comments the agent writes.

## Goals

1. **Unattended and safe.** The agent runs with permissions bypassed, in a sandbox of its own.
2. **Many sessions at once.** Across sandboxes, and in parallel in one sandbox.
3. **One overview.** You see which sessions are working and which need you.
4. **Disposable VMs.** The repos live on the workspace disk and the agent's settings on your Mac, so a VM can be
   rebuilt at any time.
5. **Local.** One user, one Mac, no service in between.

## Non-goals

- **Remote or shared use.** The server accepts only local requests from its own window.
- **Enforcing a workflow.** The agent is told to work in worktrees. Kumiko doesn't force it.
- **Acting on GitHub by itself.** Kumiko fetches the mirrors from GitHub, but it sends a branch, opens a pull request
  or changes the default branch only when you approve a card.
