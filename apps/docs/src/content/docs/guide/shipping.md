---
title: Review, push and merge
description: Approve what the agent sends to GitHub, review its branch, and let it read issues, pull requests and CI.
sidebar:
  order: 8
---

The agent pushes to the mirror on your Mac, never to GitHub. Its work reaches GitHub only when you approve a card in
the chat. A card opens or updates a pull request, merges into the default branch, creates an issue, or posts a
comment. This page covers what you do with those cards. For the mechanism behind them, see
[How code reaches GitHub](/architecture/github/).

## What the agent can push

In the sandbox, `git push` works as usual and goes to the mirror.

- **The agent pushes freely.** It can push, force-push and delete any branch in the mirror except the default
  branch, without asking. That includes branches someone else made.
- **GitHub's branches stay apart.** A branch the agent hasn't changed follows GitHub's. A branch it pushed to stays
  as it left it until a card sends it on. The default branch always follows GitHub.
- **Some pushes are refused**, with a message saying why: the default branch, tags, other refs, and a branch name
  that differs from another branch only in case. Your Mac's file system treats those two names as one.

## Deliver a branch

When work is ready, the agent pushes its branch, says in the chat what it did and which way it would land it, and
calls its `deliver` tool. It then waits while Kumiko shows a card under that message. The card is headed
`main ← branch`, with the repository in the corner. `main` is the base, the branch the work lands on. The agent can
name another base, such as the branch below a stacked pull request. A branch with an open pull request lands on that
pull request's base.

The card shows what's in the branch, worked out by Kumiko from the mirror: its commits, and its files with their
changes. Flags mark what needs a look:

- changes under `.github/`, which decide what CI runs and with which secrets,
- commits whose author isn't you, by your global `user.email`,
- commits without Claude's `Co-Authored-By` trailer.

The card also says whether the branch is only on your Mac, or how many of its commits aren't on GitHub. If sending
it would drop or change commits already on GitHub, the card lists them first. Kumiko matches commits by the change
they make, not by sha. A rebase, a squash or Kumiko's own signing lists nothing.

### Pick how it lands

The main button does what its label says. Its ▾ menu offers the other ways:

| Choice | Does |
| --- | --- |
| **Merge and push** | Makes one merge commit on top of the base, with the branch's commits as they are. |
| **Squash and push** | Makes one commit with all the branch's changes. Its subject is the agent's title, its message lists the branch's commits, and Claude's co-author trailer follows. |
| **Push and open pull request** | Sends the branch to GitHub, signed, and opens a pull request as you, with the agent's title and description. You can edit both on the card. |
| **Update pull request** | The first choice for a branch whose pull request is open but lacks commits the mirror has. Sends the new commits to the pull request. |

A squash doesn't carry over other co-authors the commits name. GitHub would show them as co-authors of a commit you
signed.

To land a pull request later, the agent delivers its branch again. The card then offers the two merges. A merge
commit says "Merge pull request #… from …", so GitHub shows the pull request as merged. A squash closes the pull
request with a comment saying where it landed. Merging a branch whose pull request lacks some commits updates the
pull request first.

After a merge, Kumiko deletes the branch on GitHub if the agent created it.

The button starts at the choice you made last time in that sandbox.

### Decline or ask for changes

**Decline…** opens a box to tell the agent why. With notes from a review, the button becomes **Request changes**.
The agent gets each note with its file and line, after anything you write in the box. <kbd>Cmd</kbd>+<kbd>Enter</kbd>
in the box sends it.

The card shows only when there's something to decide. If the branch isn't pushed, or doesn't merge cleanly, Kumiko
tells the agent what to fix instead.

### When the branch moves

A card is for the exact commit it shows. If the branch moves before you decide, the card goes out of date, and
**Review again** shows the new state. Once you decide, the card shrinks to a one-line receipt that says whether the
commit was signed.

## Review the changes

**Review** on the card opens the review pane beside the chat. It shows the branch's changes file by file, as they
would land, read from the mirror at the card's commit.

- The left side lists the files by folder, each with its status and line counts. Flagged files are amber.
- The right side shows each file's diff, unified or split, with **Wrap** and **Hide whitespace**. Click the hidden
  lines between changes to show them. A very long file opens on request. A binary file only says it's binary.
- **Viewed** folds a file and counts it. The card shows how many files you've viewed.
- To leave a note for the agent, click a line number. <kbd>Cmd</kbd>+<kbd>Enter</kbd> saves the note and
  <kbd>Esc</kbd> drops it. A note left at an earlier commit of the branch says so.
- <kbd>j</kbd> and <kbd>k</kbd> go to the next and previous file. <kbd>v</kbd> marks the file viewed.

When the agent delivers the branch again, files that didn't change stay viewed. A file that changed is marked
"changed since viewed". If the review pane showed the earlier card, it moves to the new one. A line under the
toolbar says it was refreshed, with a button that shows only what changed since the earlier card's commit.
**Since you last looked**, in the menu at the top left, shows only what changed in the branch's own files, leaving
out what a merge or rebase brought in from the default branch. The same menu shows one commit at a time, with its
message above its diff. A branch of one commit shows that commit's message above all its changes.

When the branch has a pull request open, the card and the pane mark the commits the pull request doesn't have yet
as new. If the pull request has some of the branch's commits already, the pane opens on **New since PR #N**: what
the new commits change, compared with the pull request's head on GitHub. It leaves out what a merge or rebase
brought in, as **Since you last looked** does. A line under the pane's toolbar says how many commits are new, with a
button to switch to all changes and back.

Viewed marks and notes work in every view but one commit's. A note on a removed line in **New since PR #N** stays
in that view, and the agent is told which commit the line is from.

Kumiko keeps what you viewed and your notes in the app, per branch and session. Nothing goes to GitHub. You don't
need to review to approve: the card's button works whatever the pane says.

## Signing

Kumiko signs the commits it sends to GitHub with your key, changing nothing else in them. Commits already on GitHub
stay as they are, whoever made them. Signing changes the commits' shas, so Kumiko tells the agent to run
`git pull --rebase` on the branch.

Kumiko uses the key named in your global git config as `user.signingkey`. With GPG and no key named there, it uses a
GPG key for your `user.email` that can sign, as `git commit -S` would. When there's no key to sign with, the card
warns that the commit won't be signed. Kumiko doesn't sign then, even with `commit.gpgsign` on.

A merge or squash commit Kumiko writes is by the `user.name` and `user.email` in your global git config. If it has no
name and email, Kumiko asks GitHub who you are. If that fails too, the agent is told
to have you set `user.name` and `user.email` with `git config --global`.

## Issues, pull requests and CI

The agent has no `gh` login in the sandbox. It works with issues and pull requests through Kumiko's tools, which run
`gh` on your Mac.

- **Reading happens without asking.** The agent can view and list issues, pull requests and labels. With
  `github_api_get` it can read anything of the repository through GitHub's REST API, such as workflow runs, check
  runs and releases. With `github_run_logs` it gets a workflow run's jobs and the logs of its failed steps.
- **Writing asks you first.** Creating an issue or commenting on an issue or pull request shows a card with the text
  as GitHub will show it. You can edit it, and it posts as you leave it, from your account. An issue's labels can only
  be the repository's own labels.
- **Closing and reopening ask you too.** The agent can close or reopen an issue or a pull request, with a comment. The
  card shows the comment, which you can edit or empty. For an issue it closes, the card also shows the reason, completed
  or not planned, which you can change. Closing a pull request leaves its branch. A merged pull request can't be closed
  or reopened.
- **Editing asks you too.** The agent can change the title or the description of an issue or a pull request, such as
  a PR whose work changed since it was opened. The card shows the new text, which you can edit, and what GitHub has
  now. If someone changes it on GitHub before the agent makes the change, Kumiko leaves it alone and tells the agent.

Kumiko marks what the tools return as written by others: information, not instructions. On a public repository,
anyone can write an issue.

The agent can't relabel issues or pull requests, and can't re-run or cancel workflow runs.

In a sandbox with several repos, the agent names the repository in each call. In a sandbox with one, that one is
used.
