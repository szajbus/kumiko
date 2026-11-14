import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolResult, ToolSpec } from "@kumiko/agent";
import {
  FOOTERS,
  MAX_BODY,
  MAX_TITLE,
  withFooter,
  type AgentAsk,
  type ApprovalCard,
  type CardDecision,
  type DeliverCard,
  type DeliverMethod,
  type DeliverRoute,
  type SessionEvent,
  type SessionInfo,
} from "@kumiko/shared";
import { replaceFile } from "./files.js";
import type { GitHub } from "./github.js";
import { BranchMoved, deleteBranch, deliverFacts, land, mergeMessage, NotDeliverable, signs, squashMessage } from "./landing.js";
import type { Mirrors } from "./mirrors.js";

/** A call or decision that can't be taken as it is; the message says why, for the agent or the user. */
export class ApprovalError extends Error {}

/** What approvals need of the sessions: their events, and putting cards and answers into them. */
export interface ApprovalSessions {
  get(id: string): SessionInfo | undefined;
  events(id: string): readonly SessionEvent[];
  putCard(id: string, card: ApprovalCard): void;
  answerAsk(id: string, askId: string, answer: { kind: "allow" } | { kind: "deny"; message: string }): void;
}

export interface ApprovalOptions {
  mirrors: Mirrors;
  github: GitHub;
  /** The GitHub repository of the project a session is in, if it has one. */
  repoOf(project: string): Promise<string | null>;
  /** The user's git identity on the host: commits authored as anyone else are flagged. */
  identity(): Promise<{ name?: string; email?: string }>;
  /** Where the route and method picked last in each project are kept. */
  choicesFile: string;
}

const DELIVER: ToolSpec = {
  name: "deliver",
  description:
    "Deliver a pushed branch to the GitHub repository's default branch, or open a pull request for it. Kumiko shows the user a card with the branch's commits and changes, the user chooses straight to the default branch or a PR first, and you wait for their answer. Kumiko lands it on the user's computer, signed by them, and tells you what happened. Push the branch first. If it doesn't merge cleanly, you're told to merge the default branch into it first, and no card is shown. A branch with a PR open is landed by delivering it again.",
  inputSchema: {
    type: "object",
    properties: {
      branch: { type: "string", description: "The branch to deliver, as pushed to origin." },
      title: { type: "string", description: "A title for the work: the PR's title if the user opens one, and the commit's subject if they squash it." },
      body: { type: "string", description: "What the work does and why, in Markdown: the PR's description if the user opens one." },
      note: { type: "string", description: "Optional: why you'd deliver it, or which route you'd pick and why, for the user to read on the card." },
    },
    required: ["branch", "title", "body"],
  },
  approval: true,
};

const str = (v: unknown, name: string, max: number, required = true): string | undefined => {
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || (required && !v.trim())) throw new ApprovalError(`${name} must be a non-empty string.`);
  if (v.length > max) throw new ApprovalError(`${name} is longer than ${max} characters.`);
  return v;
};

/** The latest card for each ask in a session's events. */
export function cardsOf(events: readonly SessionEvent[]): Map<string, ApprovalCard> {
  const cards = new Map<string, ApprovalCard>();
  for (const e of events) if (e.kind === "card") cards.set(e.payload.id, e.payload);
  return cards;
}

/**
 * Kumiko's tools that need the user's approval, and their cards. When Claude asks to call one, Kumiko works out the
 * card from the mirror and GitHub and shows it, or tells Claude what to fix first. The user's decision is kept in the
 * card; the call itself runs only if the card says the user approved this very call, whatever Claude's settings say.
 */
export class Approvals {
  constructor(
    private readonly sessions: ApprovalSessions,
    private readonly opts: ApprovalOptions,
  ) {}

  list(): ToolSpec[] {
    return [DELIVER];
  }

  /** Claude asked to call a tool that needs approval: show its card, or say why not. Never throws. */
  asked(info: SessionInfo, ask: Extract<AgentAsk, { kind: "approval" }>): void {
    void (async () => {
      let card: ApprovalCard;
      try {
        card = { id: ask.id, ...(ask.toolUseId ? { toolUseId: ask.toolUseId } : {}), at: new Date().toISOString(), state: "open", card: await this.cardFor(info, ask.tool, ask.input) };
        const note = typeof ask.input.note === "string" && ask.input.note.trim() ? ask.input.note.trim().slice(0, 2000) : undefined;
        if (note) card.note = note;
      } catch (err) {
        const message = err instanceof NotDeliverable || err instanceof ApprovalError ? err.message : `Kumiko couldn't check this: ${err instanceof Error ? err.message : String(err)}`;
        try {
          this.sessions.answerAsk(info.id, ask.id, { kind: "deny", message });
        } catch {
          // Claude stopped waiting meanwhile.
        }
        return;
      }
      if (!this.isOpen(info.id, ask.id)) return;
      this.sessions.putCard(info.id, card);
    })();
  }

  private isOpen(session: string, askId: string): boolean {
    const events = this.sessions.events(session);
    return events.some((e) => e.kind === "ask" && e.payload.id === askId) && !events.some((e) => (e.kind === "ask_answer" || e.kind === "ask_closed") && e.payload.id === askId);
  }

  private async repo(info: SessionInfo): Promise<string> {
    const repo = await this.opts.repoOf(info.sandbox);
    if (!repo) throw new ApprovalError("This project's clone has no origin on GitHub, so there's nothing to deliver to.");
    return repo;
  }

  private async cardFor(info: SessionInfo, tool: string, input: Record<string, unknown>): Promise<ApprovalCard["card"]> {
    switch (tool) {
      case "deliver":
        return this.deliverCard(info, input);
      default:
        throw new ApprovalError(`Kumiko has no card for ${tool}.`);
    }
  }

  private async deliverCard(info: SessionInfo, input: Record<string, unknown>): Promise<DeliverCard> {
    const branch = str(input.branch, "branch", 200)!.trim();
    const title = str(input.title, "title", MAX_TITLE)!.trim();
    const body = str(input.body, "body", MAX_BODY)!;
    const repo = await this.repo(info);
    await this.opts.mirrors.fetch(repo, { force: true });
    const dir = this.opts.mirrors.path(repo);
    const identity = await this.opts.identity().catch(() => ({}) as { email?: string });
    const facts = await deliverFacts(dir, branch, identity.email);
    const pr = await this.opts.github.prForBranch(repo, branch);
    const last = (await this.choices())[info.sandbox];
    const route: DeliverRoute = pr ? "main" : (last?.route ?? "main");
    return { kind: "deliver", repo, ...facts, ...(pr ? { pr } : {}), title, body, route, method: last?.method ?? "merge", signs: await signs(dir) };
  }

  private card(session: string, askId: string): ApprovalCard {
    const card = cardsOf(this.sessions.events(session)).get(askId);
    if (!card) throw new ApprovalError("There's no card for that.");
    return card;
  }

  /**
   * The user decided on a card. Approving checks the branch is still where the card has it, and if it moved, the card
   * goes stale instead; "refresh" works the card out again; declining tells Claude, with the user's reason.
   */
  async decide(session: string, askId: string, action: { action: "approve"; decision: CardDecision } | { action: "decline"; reason?: string } | { action: "refresh" }): Promise<ApprovalCard> {
    const info = this.sessions.get(session);
    if (!info) throw new ApprovalError("This session is gone.");
    const card = this.card(session, askId);
    if (!this.isOpen(session, askId)) throw new ApprovalError("Claude isn't waiting for this any more.");
    if (card.state !== "open" && card.state !== "stale") throw new ApprovalError("This has been decided already.");
    if (action.action === "decline") {
      const reason = action.reason?.trim().slice(0, 4000);
      const next: ApprovalCard = { ...card, state: "declined", ...(reason ? { reason } : {}) };
      this.sessions.putCard(session, next);
      this.sessions.answerAsk(session, askId, { kind: "deny", message: `The user declined ${what(card)}${reason ? `: “${reason}”` : "."}` });
      return next;
    }
    const ask = this.askOf(session, askId);
    if (action.action === "refresh") {
      let body: ApprovalCard["card"];
      try {
        body = await this.cardFor(info, ask.tool, ask.input);
      } catch (err) {
        if (!(err instanceof NotDeliverable || err instanceof ApprovalError)) throw err;
        const next: ApprovalCard = { ...card, state: "failed", receipt: { ok: false, text: err.message } };
        this.sessions.putCard(session, next);
        this.sessions.answerAsk(session, askId, { kind: "deny", message: err.message });
        return next;
      }
      const next: ApprovalCard = { ...card, card: body, state: "open" };
      delete next.moved;
      this.sessions.putCard(session, next);
      return next;
    }
    if (card.state === "stale") throw new ApprovalError("The branch moved since this card was shown: review the new state first.");
    const decision = action.decision;
    if (decision.kind !== card.card.kind) throw new ApprovalError("That decision isn't for this card.");
    if (card.card.kind === "deliver" && decision.kind === "deliver") {
      if (card.card.pr && decision.route === "pr") throw new ApprovalError(`${card.card.branch} has PR #${card.card.pr.number} open already.`);
      // Bound to the commit the card shows: if the branch moved, nothing is approved.
      await this.opts.mirrors.fetch(card.card.repo, { force: true }).catch(() => {});
      const now = await this.opts.mirrors.branchHead(card.card.repo, card.card.branch);
      if (now !== card.card.head) {
        const commits = now ? await this.opts.mirrors.countBetween(card.card.repo, card.card.head, now) : 0;
        const next: ApprovalCard = { ...card, state: "stale", moved: { to: now ?? "", commits } };
        this.sessions.putCard(session, next);
        return next;
      }
      await this.saveChoice(info.sandbox, decision.route, decision.method);
    }
    const next: ApprovalCard = { ...card, state: "approved", decision };
    this.sessions.putCard(session, next);
    this.sessions.answerAsk(session, askId, { kind: "allow" });
    return next;
  }

  private askOf(session: string, askId: string): Extract<AgentAsk, { kind: "approval" }> {
    for (const e of this.sessions.events(session)) if (e.kind === "ask" && e.payload.id === askId && e.payload.kind === "approval") return e.payload;
    throw new ApprovalError("There's no such ask.");
  }

  /**
   * Claude calls a tool the user approved: done only if a card for this very call says so, with the input it was
   * approved with, and only once.
   */
  async call(info: SessionInfo, name: string, args: Record<string, unknown>, toolUseId: string | undefined): Promise<ToolResult> {
    const events = this.sessions.events(info.id);
    const card = toolUseId ? [...cardsOf(events).values()].find((c) => c.toolUseId === toolUseId) : undefined;
    const ask = card && events.find((e) => e.kind === "ask" && e.payload.id === card.id);
    const asked = ask?.kind === "ask" && ask.payload.kind === "approval" ? ask.payload : undefined;
    if (!card || !asked || asked.tool !== name || JSON.stringify(asked.input) !== JSON.stringify(args)) {
      return { text: `Not approved: the user hasn't seen this call to ${name}. Call it again, and wait for the user to decide on the card Kumiko shows.`, isError: true };
    }
    if (card.state === "done" || card.state === "failed") return { text: `Done already: ${card.receipt?.text ?? card.state}.`, isError: card.state === "failed" };
    if (card.state === "working") return { text: "This is being done already.", isError: true };
    if (card.state !== "approved" || !card.decision) return { text: `Not approved: the user hasn't approved this ${card.state === "declined" ? "(they declined it)" : "yet"}.`, isError: true };
    this.sessions.putCard(info.id, { ...card, state: "working" });
    try {
      const { result, receipt } = await this.run(info, card);
      this.sessions.putCard(info.id, { ...card, state: "done", receipt });
      return result;
    } catch (err) {
      const message = err instanceof BranchMoved ? `${(card.card as DeliverCard).branch} moved after the user approved it, so nothing was delivered. Call deliver again.` : err instanceof Error ? err.message : String(err);
      this.sessions.putCard(info.id, { ...card, state: "failed", receipt: { ok: false, text: `Couldn't ${what(card)}`, meta: message } });
      return { text: `Nothing was done: ${message}`, isError: true };
    }
  }

  private async run(info: SessionInfo, card: ApprovalCard): Promise<{ result: ToolResult; receipt: ApprovalCard["receipt"] & object }> {
    const c = card.card;
    const d = card.decision!;
    if (c.kind !== "deliver" || d.kind !== "deliver") throw new Error(`Kumiko can't do ${c.kind} yet.`);
    if (d.route === "pr") {
      const title = d.title ?? c.title;
      const pr = await this.opts.github.prCreate(c.repo, { base: c.base, head: c.branch, title, body: withFooter(d.body ?? c.body, FOOTERS.pr) });
      return {
        result: { text: `Opened PR #${pr.number} (${pr.url}). Nothing is on ${c.base} yet; when the user wants it landed, call deliver on ${c.branch} again.` },
        receipt: { ok: true, text: `Opened PR #${pr.number}`, meta: "as you", url: pr.url, link: "Open PR" },
      };
    }
    const dir = this.opts.mirrors.path(c.repo);
    const url = this.opts.mirrors.url(c.repo);
    const message = d.method === "merge" ? mergeMessage(c.repo, c.branch, c.pr) : squashMessage(d.title ?? c.title, d.message ?? c.squashBody, c.trailers);
    const landed = await land(dir, url, { branch: c.branch, head: c.head, method: d.method, message, sign: c.signs, fetch: () => this.opts.mirrors.fetch(c.repo, { force: true }) });
    const short = landed.sha.slice(0, 7);
    const notes: string[] = [];
    if (c.pr && d.method === "squash") {
      await this.opts.github.prClose(c.repo, c.pr.number, `Landed as ${landed.sha} on ${landed.base}.`).then(
        () => notes.push(`PR #${c.pr!.number} was closed with a comment saying so.`),
        (err) => notes.push(`PR #${c.pr!.number} couldn't be closed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    // Only a branch Claude created from this project goes; one the user made stays.
    if (this.opts.mirrors.createdBy(c.repo, c.branch) === info.sandbox && (await deleteBranch(dir, url, c.branch, c.head).catch(() => false))) {
      await this.opts.mirrors.noteBranches(c.repo, info.sandbox, [{ branch: c.branch, deleted: true }]);
      notes.push(`${c.branch} was deleted on GitHub.`);
    }
    await this.opts.mirrors.fetch(c.repo, { force: true }).catch(() => {});
    const how = `${d.method === "merge" ? "merge commit" : "squashed"}${landed.signed ? ", signed" : ""}`;
    return {
      result: { text: `Delivered ${c.branch} to ${landed.base} as ${short} (${how}). ${notes.join(" ")}${notes.length ? " " : ""}Update with git fetch --prune, and git pull --ff-only on ${landed.base}.` },
      receipt: { ok: true, text: `Delivered ${c.branch} → ${landed.base} as ${short}`, meta: how.replace(", ", " · "), url: `https://github.com/${c.repo}/commit/${landed.sha}`, link: "View on GitHub" },
    };
  }

  private async choices(): Promise<Record<string, { route?: DeliverRoute; method?: DeliverMethod }>> {
    try {
      const v = JSON.parse(await readFile(this.opts.choicesFile, "utf8")) as unknown;
      return v && typeof v === "object" ? (v as Record<string, { route?: DeliverRoute; method?: DeliverMethod }>) : {};
    } catch {
      return {};
    }
  }

  private async saveChoice(project: string, route: DeliverRoute, method: DeliverMethod) {
    const all = await this.choices();
    all[project] = { route, method };
    await mkdir(dirname(this.opts.choicesFile), { recursive: true });
    await replaceFile(dirname(this.opts.choicesFile), "choices.json", JSON.stringify(all, null, 2) + "\n").catch(() => {});
  }
}

/** What the card asks, as words for Claude and the receipt. */
function what(card: ApprovalCard): string {
  switch (card.card.kind) {
    case "deliver":
      return `delivering ${card.card.branch}`;
    case "issue":
      return "creating the issue";
    case "comment":
      return `commenting on #${card.card.target.number}`;
  }
}
