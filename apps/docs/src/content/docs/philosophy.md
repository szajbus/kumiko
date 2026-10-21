---
title: Philosophy
description: The ideas Kumiko is built on.
---

The ideas that shape Kumiko. They explain why it behaves as it does, and new features are checked against them.

## The sandbox is the boundary

An agent is most useful when it can just get on with things: install what it needs, run the tests, try a fix, run them
again. Permission prompts get in the way of that, and approving them without reading makes them pointless.

So each project gets a sandbox, and the sandbox belongs to the agent. It's the agent's home and the project's
development environment: the agent can install, run and change anything there without asking. Your machine stays out
of reach, apart from what you choose to share. The question "may it do this?" becomes "what did I give it?", and you
answer that once, when you set up the project.

Because nothing you care about lives only in the sandbox, it's disposable. If it breaks, or you want a fresh one,
throw it away and build a new one.
