/**
 * Approval cards: what Kumiko shows when the agent calls one of its tools that only runs once the user approves it,
 * such as delivering a branch. Everything on a card but Claude's note and the text it wrote is Kumiko's own, worked out
 * on the host from the mirror and GitHub.
 */

/** The longest reason a decline sends Claude, a review's notes included; the card refuses a longer one. */
export const MAX_REASON = 20_000;

/** Where delivered work goes: straight onto the default branch, or into a pull request first. */
export type DeliverRoute = "main" | "pr";
/** How it lands on the default branch: one merge commit, or one commit with all of its changes. */
export type DeliverMethod = "merge" | "squash";

/** A rule that fired, naming what it fired on. */
export interface CardFlag {
  rule: "ci" | "author" | "trailer";
  /** What fired it: a file, or a commit. */
  subject: string;
  /** Why the rule exists. */
  why: string;
}

export interface CardCommit {
  sha: string;
  subject: string;
  author: string;
  email: string;
  /** Has a Co-Authored-By trailer naming Claude. */
  claude: boolean;
  /** GitHub's copy of the branch has it already: on a branch with a PR open, the PR shows it. */
  onGithub?: boolean;
}

export interface CardFile {
  path: string;
  /** Lines added and deleted; undefined for a binary file. */
  added?: number;
  deleted?: number;
  flagged?: boolean;
}

/** An open pull request from the branch, which landing it straight on the default branch merges or closes. */
export interface CardPr {
  number: number;
  title: string;
  url: string;
  /** The branch it is open on. */
  base?: string;
}

export interface DeliverCard {
  kind: "deliver";
  repo: string;
  branch: string;
  /** Where it lands: the default branch, the branch Claude named, or the open PR's base. */
  base: string;
  /** The branch's commit the card is for: approving delivers exactly this. */
  head: string;
  commits: CardCommit[];
  files: CardFile[];
  added: number;
  deleted: number;
  flags: CardFlag[];
  pr?: CardPr;
  /** What Claude wrote: the PR's title and body, and the squash commit's subject. */
  title: string;
  body: string;
  /** The squash commit's message under its subject: one line per commit, from the commits' own subjects. */
  squashBody: string;
  /** The trailers a squash commit carries over from the branch's commits. */
  trailers: string[];
  /** The choices the card starts at: what the user picked last time in this sandbox. */
  route: DeliverRoute;
  method: DeliverMethod;
  /** Whether Kumiko signs what it writes to the default branch: the user's git config has a signing key. */
  signs: boolean;
  /** The unsigned commits that aren't on GitHub yet: Kumiko signs them on the way out. */
  toSign: number;
  /** Where the branch is on GitHub, if it is there at all: the mirror's may be ahead of it, or rewritten. */
  github?: string;
  /** The branch's commits that GitHub's copy of it doesn't have, or all of them when it isn't on GitHub. */
  ahead: number;
  /** Commits on GitHub's copy that publishing this branch would drop or change. */
  lost: { sha: string; subject: string; how: "dropped" | "changed" }[];
}

export interface IssueCard {
  kind: "issue";
  repo: string;
  title: string;
  body: string;
  labels: string[];
  /** The repository's labels, the only ones the card offers. */
  repoLabels: { name: string; color?: string; description?: string }[];
}

export interface CommentCard {
  kind: "comment";
  repo: string;
  /** What it comments on, as GitHub has it. */
  target: { type: "issue" | "pr"; number: number; title: string; state: string; author: string; url: string };
  body: string;
}

/** Why an issue is closed, as GitHub records it. */
export type CloseReason = "completed" | "not_planned";

/** Closing or reopening an issue or a PR, with a comment if there's one. */
export interface StateCard {
  kind: "state";
  repo: string;
  /** What it closes or reopens, as GitHub has it. */
  target: CommentCard["target"];
  action: "close" | "reopen";
  /** Why, for closing an issue only. */
  reason?: CloseReason;
  /** A comment posted with it; empty for none. */
  body: string;
}

/**
 * Changing an issue's or a PR's title, description or both. A field Claude left out stays as it is and isn't on the
 * card; `was` is what GitHub has now, and approving changes nothing if GitHub's copy changed since.
 */
export interface EditCard {
  kind: "edit";
  repo: string;
  target: CommentCard["target"];
  /** The new title and description; undefined for one that stays. */
  title?: string;
  body?: string;
  was: { title: string; body: string };
}

export type ApprovalCardBody = DeliverCard | IssueCard | CommentCard | StateCard | EditCard;

/**
 * What the user decided on a card, with what they changed: for Deliver the route and method, for the text that goes
 * public the text as they left it.
 */
export type CardDecision =
  | { kind: "deliver"; route: DeliverRoute; method: DeliverMethod; title?: string; body?: string }
  | { kind: "issue"; title: string; body: string; labels: string[] }
  | { kind: "comment"; body: string }
  | { kind: "state"; body: string; reason?: CloseReason }
  | { kind: "edit"; title?: string; body?: string };

/** What happened, as the card's one-line receipt shows it. */
export interface CardReceipt {
  ok: boolean;
  text: string;
  /** Details after it: "merge commit · signed". */
  meta?: string;
  url?: string;
  /** What the link says, such as "View on GitHub". */
  link?: string;
}

/**
 * A card as the chat shows it, by the ask it answers. `open` waits for the user; `stale` found the branch moved when
 * they approved; `approved` is waiting for Claude to make the call; `working` is being done; then `done`, `failed`
 * or `declined`. Each change is a new event with the whole card.
 */
export interface ApprovalCard {
  id: string;
  toolUseId?: string;
  /** When Claude asked. */
  at: string;
  card: ApprovalCardBody;
  state: "open" | "stale" | "approved" | "working" | "done" | "failed" | "declined";
  /** Where the branch moved to, for a stale card. */
  moved?: { to: string; commits: number };
  decision?: CardDecision;
  /**
   * The user commented on the card's changes, so Claude stopped waiting on it to answer: the card stays open for the
   * user to decide without a call of Claude's, and what they decide reaches Claude as a message.
   */
  discussing?: boolean;
  /** The reason the user gave Claude for declining. */
  reason?: string;
  receipt?: CardReceipt;
}

/** The longest title and body Kumiko takes for an issue, a PR or a comment; GitHub's own limit is 65536 characters. */
export const MAX_TITLE = 256;
export const MAX_BODY = 60_000;

/** `value` as a decision on a card of `kind`, if it is a well-formed one; for decisions that come over the API. */
export function parseCardDecision(value: unknown): CardDecision | undefined {
  const v = value as Record<string, unknown> | null;
  const text = (x: unknown, max: number) => (typeof x === "string" && x.length <= max ? x : undefined);
  // Titles are one line, as on GitHub; a squash commit's subject too.
  const line = (x: unknown) => (typeof x === "string" && !/[\r\n]/.test(x) ? text(x, MAX_TITLE)?.trim() : undefined);
  switch (v?.kind) {
    case "deliver": {
      if (v.route !== "main" && v.route !== "pr") return undefined;
      if (v.method !== "merge" && v.method !== "squash") return undefined;
      const title = v.title === undefined ? undefined : line(v.title);
      const body = v.body === undefined ? undefined : text(v.body, MAX_BODY);
      if ((v.title !== undefined && !title) || (v.body !== undefined && body === undefined)) return undefined;
      return { kind: "deliver", route: v.route, method: v.method, ...(title ? { title } : {}), ...(body !== undefined ? { body } : {}) };
    }
    case "issue": {
      const title = line(v.title);
      const body = text(v.body, MAX_BODY);
      const labels = Array.isArray(v.labels) && v.labels.every((l) => typeof l === "string" && l.length <= 100) ? (v.labels as string[]) : undefined;
      return title && body !== undefined && labels ? { kind: "issue", title, body, labels } : undefined;
    }
    case "comment": {
      const body = text(v.body, MAX_BODY);
      return body?.trim() ? { kind: "comment", body } : undefined;
    }
    case "state": {
      const body = text(v.body, MAX_BODY);
      if (v.reason !== undefined && v.reason !== "completed" && v.reason !== "not_planned") return undefined;
      return body !== undefined ? { kind: "state", body, ...(v.reason ? { reason: v.reason } : {}) } : undefined;
    }
    case "edit": {
      const title = v.title === undefined ? undefined : line(v.title);
      const body = v.body === undefined ? undefined : text(v.body, MAX_BODY);
      if ((v.title !== undefined && !title) || (v.body !== undefined && body === undefined) || (title === undefined && body === undefined)) return undefined;
      return { kind: "edit", ...(title ? { title } : {}), ...(body !== undefined ? { body } : {}) };
    }
    default:
      return undefined;
  }
}
