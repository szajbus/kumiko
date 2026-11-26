---
title: Pushes you approve
description: The agent pushes freely to a mirror on your Mac. Nothing reaches GitHub until you approve it on a card, and Kumiko signs it with your key.
sidebar:
  order: 5
---

The sandbox has no GitHub credentials. When the agent runs `git push`, the branch goes to Kumiko's mirror of the
repository on your Mac, and no further. In the mirror the agent pushes, force-pushes and deletes its branches without
asking. It can't push to the default branch or push tags.

When work is ready, the agent says why and what it would pick, and calls `deliver`. Kumiko shows you a card with the
branch's commits and files, and flags what needs a look, such as changes under `.github/` or commits by someone else.
**Review** opens the changes file by file. There you can ask the agent about a line, a file or the whole change, and
it answers in the same thread, next to the code. Then you choose:

- **Merge and push**, or **Squash and push**, onto the default branch.
- **Push and open pull request**, with the agent's title and description.
- **Update pull request**, for a branch whose PR is open.
- **Decline…** or **Request changes**, which sends the agent your reasons and the changes it said it would make.

Kumiko does it on your Mac with your `gh` login, and signs the agent's commits with your key on the way. To land a
pull request, the agent delivers its branch again. Issues and comments go through cards the same way.

## How to

- [Review, push and merge](/guide/shipping/).
- [Add repositories](/guide/repos/), which sets up their mirrors.
- Read how it works: [How code reaches GitHub](/architecture/github/).
