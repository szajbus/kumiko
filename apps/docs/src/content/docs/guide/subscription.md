---
title: Using your Claude subscription
description: Kumiko runs Claude Code as Anthropic publishes it, so your plan works with it as it does in a terminal.
sidebar:
  order: 6
---

You can use your own Claude subscription with Kumiko. Kumiko doesn't stand in for Claude Code or talk to Claude
itself: every session is Claude Code, running in your sandbox, so it uses your plan the same way running
`claude` in a terminal does.

That keeps Kumiko within Anthropic's rules for tools built around Claude Code:

- **Claude Code as published.** Kumiko installs it with Anthropic's own installer and doesn't change it.
- **Your own login.** You sign in on Anthropic's own sign-in page, and the login stays in the sandbox. Kumiko
  passes the code the page shows on to Claude Code, and keeps neither the code nor your login.
- **Your own usage.** What your sessions use is billed to your plan, under your agreement with Anthropic. Kumiko
  doesn't resell Claude usage or pay for it, and doesn't route it through anyone else.

Your plan's usage limits apply as they do anywhere, and many sessions at once use them up faster.

Kumiko isn't made or endorsed by Anthropic. The rules it follows are on Claude Code's
[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page.
