---
title: Logging the agent in
description: Log a project's agent in from Kumiko, by pasting a code into the login dialog.
sidebar:
  order: 5
---

The agent needs a login before it can work. You log in once per project, from Kumiko, and every session of the project
uses it. It's kept even if you rebuild the sandbox.

## The login dialog

The first time you send a message in a project, the reply is a card saying **Claude isn't logged in**, and the
**Log in to Claude** dialog opens. If it doesn't (you weren't looking at the tab, say), choose **Log in** on the card,
or type `/login`.

1. Choose **Open the sign-in page**. It opens in your browser.
2. Sign in, and copy the code the page shows.
3. Back in Kumiko, paste it under **Paste the code**, and choose **Log in**.

The card turns green and says which account you're logged in as. Choose **Retry** to send your message again; the agent
gets to work.

## If it doesn't work

- **A wrong code** shows the agent's own message in the dialog. Choose **Try again** for a fresh sign-in link.
- **The dialog waits 10 minutes** for a code. After that, or if you choose **Cancel**, start again with **Log in** on the
  card.
- **Another session is logging in** to the same project: the dialog joins that login instead of starting a second one.
