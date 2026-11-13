---
title: Repository mirrors
description: The GitHub repositories Kumiko keeps a mirror of on your Mac, and how to add, fetch and remove them.
sidebar:
  order: 8
---

Kumiko keeps a bare mirror of each GitHub repository you pick, on your Mac. Your sandboxes will get their code from
these mirrors, so they never need GitHub credentials of their own. The mirrors are Kumiko's: it makes them, fetches
into them, tidies them and deletes them. Don't run git in them yourself.

Open them from the home button: **Repos**, beside **Projects**.

![The Repos page: three repositories, each fetched just now.](../../../assets/screenshots/repos.png)

## GitHub access

Kumiko uses the GitHub CLI already on your Mac, `gh`, and its login. There is no separate sign-in. The account it's
signed in as shows at the top of the page, with its avatar.

- **gh isn't installed:** install it (`brew install gh`), sign it in, then **Check again**.
- **gh isn't signed in:** run `gh auth login` in Terminal, then **Check again**.

Only the list of repositories to pick from needs `gh`. Fetching uses plain `git` with your usual credentials on the
Mac, over SSH or HTTPS as `gh config get git_protocol` says, so mirrors you already have keep working without it.

## Adding a repository

**Add repository** lists every repository `gh` can see, yours and your organizations', most recently pushed first.
Type to filter by name or description; ↑ ↓ and Enter add the highlighted one. The dialog stays open, so you can add
several. Each one is cloned in the background and shows **Cloning…** until it's done.

## The list

Each repository shows when it was last fetched, with how many branches and tags it has, and how much space its
mirror takes. A fetch that failed shows git's message under the row; what was fetched before stays as it was.

- **Fetch now** (↻) fetches it from GitHub. Fetches asked for within a few seconds of each other share one.
- **Remove** deletes the mirror. Nothing changes on GitHub, and you can add the repository again any time.

## What a mirror holds

A mirror is at `~/.kumiko/mirrors/<owner>/<name>.git`, in lowercase, and holds only GitHub's branches and tags. Branches
deleted on GitHub are deleted from it on the next fetch, so it can always be deleted and made again. Kumiko:

- rewrites each mirror's config and hooks whenever it starts, and clones again a mirror that has gone missing;
- runs `git gc` in a mirror after a fetch, once a week;
- refuses every push to a mirror, for now, and would check the objects of one (`receive.fsckObjects`).
