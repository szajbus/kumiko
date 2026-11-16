/**
 * Approval cards: what Kumiko shows when the agent calls one of its tools that only runs once the user approves it,
 * such as delivering a branch. Everything on a card but Claude's note and the text it wrote is Kumiko's own, worked out
 * on the host from the mirror and GitHub.
 */

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
}

export interface DeliverCard {
  kind: "deliver";
  repo: string;
  branch: string;
  /** The default branch, where it lands. */
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
  /**
   * The branch's commits Kumiko signs when it opens a PR for it: its unsigned ones, when it is Claude's branch. A branch
   * someone else made is left as they pushed it.
   */
  toSign: number;
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

/**
 * A push to one of the agent's own branches that changes what CI runs: GitHub runs a branch's own workflows on push,
 * with the repository's secrets, so it waits in the mirror's hook for the user.
 */
export interface PushCard {
  kind: "push";
  repo: string;
  branch: string;
  /** Where the branch was on GitHub; undefined for a new branch. */
  old?: string;
  new: string;
  fastForward: boolean;
  /** Commits the push adds. */
  commits: number;
  /** The changes under .github/, compared with the default branch. */
  files: CardFile[];
  base: string;
}

export type ApprovalCardBody = DeliverCard | IssueCard | CommentCard | PushCard;

/**
 * What the user decided on a card, with what they changed: for Deliver the route and method, for the text that goes
 * public the text as they left it.
 */
export type CardDecision =
  | { kind: "deliver"; route: DeliverRoute; method: DeliverMethod; title?: string; body?: string }
  | { kind: "issue"; title: string; body: string; labels: string[] }
  | { kind: "comment"; body: string }
  | { kind: "push" };

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
    case "push":
      return { kind: "push" };
    default:
      return undefined;
  }
}
