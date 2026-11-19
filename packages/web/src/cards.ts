import type { ApprovalCard, AskAnswer, AskClosedReason, CardDecision, DeliverCard } from "@kumiko/shared";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The ways to deliver a branch, as the card's button offers them: "update" sends a PR's branch what it lacks. */
export type DeliverChoice = "merge" | "squash" | "pr" | "update";

/** Whether an open PR lacks what the mirror has: then updating it comes first. */
const behind = (c: DeliverCard) => c.pr !== undefined && c.github !== c.head;

/** What the card starts at: updating a PR that's behind, or else what the user picked last time, if the branch allows. */
export function initialChoice(c: DeliverCard): DeliverChoice {
  if (behind(c)) return "update";
  if (c.route === "pr" && !c.pr) return "pr";
  return c.method === "squash" ? "squash" : "merge";
}

/**
 * The choices for a branch, each with what it does in GitHub's words. A branch with a PR open can't have another, and
 * merging or squashing it says what happens to the PR.
 */
export function deliverChoices(c: DeliverCard): { choice: DeliverChoice; label: string; description: string }[] {
  const n = c.commits.length;
  const pr = c.pr ? `#${c.pr.number}` : undefined;
  const merge = n === 1 ? `The commit from this branch will be added to ${c.base} via a merge commit` : `All ${n} commits from this branch will be added to ${c.base} via a merge commit`;
  const squash = n === 1 ? `The commit from this branch will be added to ${c.base} as one new commit` : `The ${n} commits from this branch will be combined into one commit in ${c.base}`;
  const choices: { choice: DeliverChoice; label: string; description: string }[] = [];
  if (behind(c)) {
    const update = c.lost.length ? `${pr}'s branch will be replaced with this one, as shown above` : c.ahead === 1 ? `The new commit will be added to ${pr}` : `The ${c.ahead} new commits will be added to ${pr}`;
    choices.push({ choice: "update", label: "Update pull request", description: `${update}.` });
  }
  choices.push(
    { choice: "merge", label: "Merge and push", description: `${merge}${pr ? `, and ${pr} will show as merged` : ""}.` },
    { choice: "squash", label: "Squash and push", description: `${squash}${pr ? `, and ${pr} will be closed` : ""}.` },
  );
  if (!c.pr) choices.push({ choice: "pr", label: "Push and open pull request", description: "A pull request will be opened from this branch." });
  return choices;
}

/**
 * The decision a choice sends, with the PR's text when it opens one. A squash takes a title the user edited (before
 * switching from the PR) as its subject; otherwise Claude's.
 */
export function deliverDecision(choice: DeliverChoice, pr: { title: string; body: string; original?: string }): CardDecision | undefined {
  if (choice === "merge") return { kind: "deliver", route: "main", method: "merge" };
  if (choice === "update") return { kind: "deliver", route: "pr", method: "merge" };
  if (choice === "squash") {
    const title = pr.title.trim();
    return { kind: "deliver", route: "main", method: "squash", ...(title && title !== pr.original?.trim() ? { title } : {}) };
  }
  return pr.title.trim() ? { kind: "deliver", route: "pr", method: "merge", title: pr.title.trim(), body: pr.body } : undefined;
}

/**
 * The one thing the card says about signing: that it won't happen, when Kumiko lands a commit and the user's git
 * config gives it no key. Signing otherwise goes unmentioned; the receipt says which it was.
 */
export function unsignedWarning(c: DeliverCard, choice: DeliverChoice): string | undefined {
  // Publishing signs the commits that aren't on GitHub yet; merging or squashing signs the commit it writes.
  const signsSomething = choice === "merge" || choice === "squash" || c.toSign > 0;
  return signsSomething && !c.signs ? "Won't be signed: there's no signing key in your git config." : undefined;
}

/** Where the branch stands against GitHub, for the facts row: undefined when GitHub has all of it. */
export function whereLabel(c: DeliverCard): string | undefined {
  if (!c.github) return "only on your Mac";
  if (c.github === c.head || !c.ahead) return undefined;
  return `${c.ahead} not on GitHub`;
}

/** The heading of the box listing what publishing would lose from GitHub. */
export function lostHeading(c: DeliverCard): string | undefined {
  const dropped = c.lost.filter((l) => l.how === "dropped").length;
  const changed = c.lost.length - dropped;
  if (!c.lost.length) return undefined;
  const where = c.pr ? `#${c.pr.number}` : "GitHub";
  const parts = [dropped && `drops ${plural(dropped, "commit")}`, changed && `changes ${plural(changed, "commit")}`].filter(Boolean).join(", and ");
  return `${parts.charAt(0).toUpperCase()}${parts.slice(1)} that ${c.lost.length === 1 ? "is" : "are"} on ${where}:`;
}

/** The card's verb: what approving does. */
export function cardVerb(card: ApprovalCard["card"], choice?: DeliverChoice): string {
  switch (card.kind) {
    case "deliver":
      return choice === "pr" ? "Open a PR" : choice === "update" ? "Update" : choice === "squash" ? "Squash" : "Merge";
    case "issue":
      return "Create an issue";
    case "comment":
      return `Comment on #${card.target.number}`;
    case "state":
      return `${card.action === "close" ? "Close" : "Reopen"} #${card.target.number}`;
    case "edit":
      return `Edit #${card.target.number}`;
  }
}

/** The primary button: the action, not "Approve". */
export function approveLabel(card: ApprovalCard["card"], choice?: DeliverChoice): string {
  switch (card.kind) {
    case "deliver":
      return deliverChoices(card).find((c) => c.choice === choice)?.label ?? "Merge and push";
    case "issue":
      return "Create issue";
    case "comment":
      return "Post comment";
    case "state":
      return `${card.action === "close" ? "Close" : "Reopen"} ${card.target.type === "pr" ? "pull request" : "issue"}`;
    case "edit":
      return `Update ${card.target.type === "pr" ? "pull request" : "issue"}`;
  }
}

/** What the card was for, as words after "Declined:" or "Not done:". */
export function cardAction(card: ApprovalCard): string {
  const c = card.card;
  switch (c.kind) {
    case "deliver": {
      // Declined, it has no decision: then what the card offered first.
      const d = card.decision?.kind === "deliver" ? card.decision : undefined;
      const choice: DeliverChoice = d ? (d.route === "pr" ? (c.pr ? "update" : "pr") : d.method) : initialChoice(c);
      if (choice === "pr") return `open a PR for ${c.branch}`;
      if (choice === "update") return `update #${c.pr?.number} with ${c.branch}`;
      return `${choice} ${c.branch} into ${c.base}`;
    }
    case "issue":
      return "create the issue";
    case "comment":
      return `comment on #${c.target.number}`;
    case "state":
      return `${c.action} #${c.target.number}`;
    case "edit":
      return `edit #${c.target.number}`;
  }
}

/**
 * What the card says once it is over, if anything beyond its receipt: Claude stopped waiting, or the user answered by
 * sending a message instead. Undefined while it is open.
 */
export function cardClosed(card: ApprovalCard | undefined, answer: AskAnswer | undefined, closed: AskClosedReason | undefined): string | undefined {
  if (answer?.kind === "message") return "You sent a message instead; nothing was done.";
  if (closed && card?.state !== "done" && card?.state !== "failed" && card?.state !== "working") return "Claude stopped waiting; nothing was done.";
  return undefined;
}

/** The facts strip's counts: "3 commits", "4 files". */
export const commitsLabel = (c: { commits: unknown[] }) => plural(c.commits.length, "commit");
export const filesLabel = (c: { files: unknown[] }) => plural(c.files.length, "file");

/** How much of a file's change is additions, as a share of the bar. */
export function barShares(added = 0, deleted = 0): { add: number; del: number } {
  const total = added + deleted;
  return total ? { add: (added / total) * 100, del: (deleted / total) * 100 } : { add: 0, del: 0 };
}
