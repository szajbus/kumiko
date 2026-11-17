---
title: Philosophy
description: The ideas Kumiko is built on.
---

The ideas that shape Kumiko. They explain why it behaves as it does, and new features are checked against them.

## The sandbox is the boundary

An agent is most useful when it can just get on with things: install what it needs, run the tests, try a fix, run them
again. Permission prompts get in the way of that, and approving them without reading makes them pointless.

So the agent works in a sandbox, and the sandbox belongs to the agent. It's the agent's home and its development
environment: the agent can install, run and change anything there without asking. Your machine stays out of reach,
apart from what you choose to share. The question "may it do this?" becomes "what did I give it?", and you answer that
once, when you set up the sandbox.

The work sits on a disk of the sandbox's own, which outlives the VM, and what the agent pushes reaches GitHub. So the
VM is disposable: if it breaks, or you want a fresh one, rebuild it and carry on.

## Kumiko is mission control, not the engine

Mission control watches every flight, sends instructions and calls for help when something needs a person. The
spacecraft don't need it to keep flying. Kumiko works the same way. It starts agents, gives them their work, shows you
what each one is doing and tells you which ones need you. But the work is the agent's, and it happens in the sandbox,
not in Kumiko.

So an agent doesn't depend on Kumiko being there. Quit the app, let your Mac sleep, restart Kumiko while you work on it:
the agent carries on with its turn. A command it started finishes, and a file it was writing gets written. When Kumiko
comes back, it catches up on what happened and shows it as if it had been watching all along.

What ends an agent's work is a decision about that work: closing its session, or stopping, rebuilding or deleting the
sandbox it lives in. Never just Kumiko going away.
