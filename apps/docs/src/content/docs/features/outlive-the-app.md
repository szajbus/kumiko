---
title: Agents that outlive the app
description: Quit Kumiko, let your Mac sleep or restart the server, and the agents keep working. Kumiko catches up when it is back.
sidebar:
  order: 3
---

The agent runs in its sandbox, detached from Kumiko. Quit the app, let your Mac sleep, or restart Kumiko's server
while you work on it, and the agent finishes its turn. A command it started finishes, and a file it was writing gets
written.

When Kumiko is back, each session opens again where the agent got to. A turn still going carries on in its tab, with
what the agent wrote while Kumiko was away. A turn that finished shows in full, and its session waits on you. An agent
that exited shows its session as ended, with the error if it failed.

The work also outlives the VM. The repos live on the sandbox's workspace disk, which a rebuild keeps, and the agent's
login and settings live on your Mac. You can rebuild a broken sandbox and carry on.

## How to

- See what ends a session, and how to resume one: [Work in sessions](/guide/sessions/).
- [Rebuild or delete a sandbox](/guide/sandboxes/).
- Read how it works: [How an agent runs](/architecture/agent-runs/).
