---
title: Log in and use your subscription
description: Log a sandbox's agent in to Claude from Kumiko, and why your own Claude plan works with it.
sidebar:
  order: 2
---

The agent needs a Claude login before it can work. You log in once per sandbox, from Kumiko. Every session in the
sandbox uses that login, and a rebuild of the sandbox keeps it.

## Log in

The first time you send a message in a sandbox, the reply is a card saying **Claude isn't logged in**, and the
**Log in to Claude** dialog opens. If you missed the dialog, choose **Log in** on the card, or type `/login`.

1. Choose **Open the sign-in page**. The page opens in your browser.
2. Sign in, and copy the code the page shows.
3. In Kumiko, paste the code under **Paste the code**, and choose **Log in**.

The card turns green and names the account you logged in as. Choose **Retry** to send your message again.

If another session of the same sandbox is already logging in, the dialog joins that login. It doesn't start a second
one. For a wrong code or a dialog that timed out, see [Troubleshooting](/guide/troubleshooting/#logging-in).

## See your usage

In a session's tab, the two bars in the title bar's corner show how much of your plan's usage limits the sandbox's account has used. Click
them to open **Session details**. It names the Claude account and plan, says when each limit resets, and shows the
session's context, memory and cost. Kumiko reads the usage again after each turn, and about once a minute while the session is live.

## Use your Claude subscription

You can use your own Claude subscription with Kumiko. Kumiko doesn't stand in for Claude Code or talk to Claude
itself. Every session is Claude Code, running in your sandbox. It uses your plan the same way `claude` in a terminal
does.

That keeps Kumiko within Anthropic's rules for tools built around Claude Code:

- **Claude Code as published.** Kumiko installs it with Anthropic's own installer and doesn't change it.
- **Your own login.** You sign in on Anthropic's own sign-in page, and the login stays in the sandbox. Kumiko passes
  the code from the page on to Claude Code. It keeps neither the code nor your login.
- **Your own usage.** Your plan pays for what your sessions use, under your agreement with Anthropic. Kumiko doesn't
  resell Claude usage, pay for it, or route it through anyone else.

Your plan's usage limits apply as they do anywhere. Many sessions at once use them up faster.

Anthropic doesn't make or endorse Kumiko. The rules Kumiko follows are on Claude Code's
[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page.
