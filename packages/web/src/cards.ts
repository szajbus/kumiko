import type { ApprovalCard, AskAnswer, AskClosedReason, DeliverCard, DeliverMethod, DeliverRoute } from "@kumiko/shared";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The card's heading: the verb and what it acts on. */
export function cardTitle(card: ApprovalCard["card"], route?: DeliverRoute): string {
  switch (card.kind) {
    case "deliver":
      return (route ?? card.route) === "pr" ? "Open a PR" : "Deliver";
    case "issue":
      return "Create an issue";
    case "comment":
      return `Comment on ${card.target.type === "pr" ? "PR" : "issue"} #${card.target.number}`;
    case "push":
      return `Push ${card.branch}, which changes CI`;
  }
}

/** What approving does, for each route and method: so nobody has to remember what Squash does to a PR. */
export function effectLine(c: DeliverCard, route: DeliverRoute, method: DeliverMethod): string {
  // Unsigned, the footer says why; the line only says what lands.
  const signed = c.signs ? " signed by you" : "";
  const commits = plural(c.commits.length, "commit");
  if (route === "pr") return `Opens a pull request as you, with the title and body below. Nothing lands on ${c.base} yet: when you want it landed, Claude delivers the branch again.`;
  if (c.pr) {
    return method === "merge"
      ? `Adds one merge commit${signed}, “Merge pull request #${c.pr.number} from ${c.repo.split("/")[0]}/${c.branch}”. GitHub will show #${c.pr.number} as merged.`
      : `Adds one commit${signed} with all ${plural(c.files.length, "file")}' changes. #${c.pr.number} is closed with a comment saying where it landed.`;
  }
  return method === "merge"
    ? `Adds one merge commit${signed} on top of ${c.base}, “Merge branch '${c.branch}'”. The ${commits} come along as they are.`
    : `Adds one commit${signed} with all ${plural(c.files.length, "file")}' changes and the message below. The ${commits} stay only on the branch.`;
}

/** The primary button: the consequence, not "Approve". */
export function approveLabel(card: ApprovalCard["card"], route?: DeliverRoute, method?: DeliverMethod): string {
  switch (card.kind) {
    case "deliver": {
      if ((route ?? card.route) === "pr") return "Open pull request";
      const sign = card.signs ? "sign and " : "";
      if (card.pr) return `${method === "squash" ? "Squash, " : ""}${sign}land #${card.pr.number}`.replace(/^./, (x) => x.toUpperCase());
      return `${method === "squash" ? "Squash, " : ""}${sign}push to ${card.base}`.replace(/^./, (x) => x.toUpperCase());
    }
    case "issue":
      return "Create issue";
    case "comment":
      return "Post as you";
    case "push":
      return "Allow this push";
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
export const commitsLabel = (c: DeliverCard) => plural(c.commits.length, "commit");
export const filesLabel = (c: DeliverCard) => plural(c.files.length, "file");

/** How much of a file's change is additions, as a share of the bar. */
export function barShares(added = 0, deleted = 0): { add: number; del: number } {
  const total = added + deleted;
  return total ? { add: (added / total) * 100, del: (deleted / total) * 100 } : { add: 0, del: 0 };
}

/** Whether a key press approves a card: ⌘↩ or Ctrl+Enter, never plain Enter, which types in the card's text boxes. */
export const isApproveKey = (e: { key: string; metaKey: boolean; ctrlKey: boolean }) => e.key === "Enter" && (e.metaKey || e.ctrlKey);
