---
title: Add repositories
description: Mirror your GitHub repositories on your Mac so sandboxes can clone them, and fetch or remove the mirrors.
sidebar:
  order: 3
---

Kumiko keeps a bare mirror of each GitHub repository you add, on your Mac. Sandboxes clone their repos from these
mirrors and push back to them, so a sandbox never needs GitHub credentials. Kumiko owns the mirrors: it makes them,
fetches into them, tidies them and deletes them. Don't run git in them yourself.

To open the list, choose **Repos** beside **Sandboxes** on the home page.

![The Repos page: three repositories, each fetched just now.](../../../assets/screenshots/repos.png)

## Connect GitHub

Kumiko uses the GitHub CLI on your Mac, `gh`, and its login. There is no separate sign-in. The top of the **Repos**
page shows the account `gh` is signed in as, with its avatar.

If the page says **The GitHub CLI, gh, isn't installed** or **Not signed in**, fix that in Terminal and choose
**Check again**:

```sh
brew install gh
gh auth login
```

Mirrors fetch over HTTPS. Git signs in with `gh`'s token through `gh auth git-credential`. It never uses your own
credential helpers or SSH keys, so it doesn't ask the macOS keychain. Kumiko never sees the token. If `gh` signs out,
fetches of private repositories fail until you sign it in again.

## Add a repository

1. Choose **Add repository**. The dialog lists the repositories `gh` can see, one owner at a time, starting with
   your own.
2. To see an organization's repositories, pick it from the menu beside the search.
3. Type to filter by name or description. Use <kbd>↑</kbd> and <kbd>↓</kbd> to move, and <kbd>Enter</kbd> to add
   the highlighted one, or click it.

The dialog stays open, so you can add several. Kumiko clones each one in the background, and the list shows
**Cloning…** until it's done.

You can also add a repository while you create a sandbox, with **Mirror another repository from GitHub…** in the
form's repo list.

## Fetch and remove

Each row shows when the mirror was last fetched, how many branches and tags it has, and how much space it takes. If
the last fetch failed, the row says **Fetch failed** with git's message, and the mirror keeps what it had.

- **Fetch now** fetches the repository from GitHub. Requests made within a few seconds of each other share one fetch.
- **Remove** deletes the mirror on your Mac. Nothing changes on GitHub, and you can add the repository again at any
  time. Kumiko then clones it afresh.

Kumiko doesn't fetch on a timer. A mirror also brings itself up to date from GitHub each time a sandbox fetches
through it.

Removing a mirror that a sandbox uses cuts that sandbox off from the repository on GitHub. It also deletes any branch
the agent pushed that no card has sent to GitHub yet.

## What a mirror holds

A mirror is at `~/.kumiko/mirrors/<owner>/<name>.git`, in lowercase. It holds GitHub's branches and tags, and the
branches the agent pushed from its sandboxes. A branch deleted on GitHub is deleted from the mirror at the next fetch.

Kumiko:

- writes each mirror's config and hooks again whenever it starts, and clones a missing mirror again,
- runs `git gc` in a mirror after a fetch, once a week,
- checks the objects of every push with `receive.fsckObjects`,
- refuses any push that doesn't come through a sandbox's relay.

To see how sandboxes reach the mirrors and what reaches GitHub, see
[How code reaches GitHub](/architecture/github/). To send the agent's work on, see
[Review, push and merge](/guide/shipping/).
