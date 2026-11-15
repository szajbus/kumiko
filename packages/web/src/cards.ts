import type { ApprovalCard, AskAnswer, AskClosedReason, CardDecision, DeliverCard } from "@kumiko/shared";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The three ways to deliver a branch, as the card's button offers them. */
export type DeliverChoice = "merge" | "squash" | "pr";

/** What the card starts at: what the user picked last time, if the branch allows it. */
export function initialChoice(c: DeliverCard): DeliverChoice {
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
  const choices: { choice: DeliverChoice; label: string; description: string }[] = [
    { choice: "merge", label: "Merge and push", description: `${merge}${pr ? `, and ${pr} will show as merged` : ""}.` },
    { choice: "squash", label: "Squash and push", description: `${squash}${pr ? `, and ${pr} will be closed` : ""}.` },
  ];
  if (!c.pr) choices.push({ choice: "pr", label: "Push and open pull request", description: "A pull request will be opened from this branch." });
  return choices;
}

/** The decision a choice sends, with the PR's text when it opens one. */
export function deliverDecision(choice: DeliverChoice, pr: { title: string; body: string; footer: boolean }): CardDecision | undefined {
  if (choice !== "pr") return { kind: "deliver", route: "main", method: choice };
  return pr.title.trim() ? { kind: "deliver", route: "pr", method: "merge", title: pr.title.trim(), body: pr.body, ...(pr.footer ? {} : { footer: false }) } : undefined;
}

/**
 * The one thing the card says about signing: that it won't happen, when Kumiko lands a commit and the user's git
 * config gives it no key. Signing otherwise goes unmentioned; the receipt says which it was.
 */
export function unsignedWarning(c: DeliverCard, choice: DeliverChoice): string | undefined {
  return choice !== "pr" && !c.signs ? "Won't be signed: there's no signing key in your git config." : undefined;
}

/** The card's verb: what approving does. */
export function cardVerb(card: ApprovalCard["card"], choice?: DeliverChoice): string {
  switch (card.kind) {
    case "deliver":
      return choice === "pr" ? "Open a PR" : "Merge";
    case "issue":
      return "Create an issue";
    case "comment":
      return `Comment on #${card.target.number}`;
    case "push":
      return "Push";
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
    case "push":
      return "Allow push";
  }
}

/** What the card was for, as words after "Declined:" or "Not done:". */
export function cardAction(card: ApprovalCard): string {
  const c = card.card;
  switch (c.kind) {
    case "deliver": {
      const d = card.decision?.kind === "deliver" ? card.decision : undefined;
      if (d?.route === "pr") return `open a PR for ${c.branch}`;
      return `${d?.method === "squash" ? "squash" : "merge"} ${c.branch} into ${c.base}`;
    }
    case "issue":
      return "create the issue";
    case "comment":
      return `comment on #${c.target.number}`;
    case "push":
      return `push ${c.branch}`;
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
