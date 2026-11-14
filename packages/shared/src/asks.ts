/**
 * The agent stopping in the middle of a turn to ask the user something: questions to answer, or a plan to approve.
 * The turn goes on once the user answers; until then the agent waits, for as long as it takes.
 */

/** One question, with the options to pick from; the user may always answer in their own words instead. */
export interface AgentQuestion {
  question: string;
  /** A short label for it, such as "Storage". */
  header?: string;
  /** Any number of options may be picked, rather than one. */
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/** What the agent asks. `id` is how the answer names it; `toolUseId` is the agent's tool call that asks, if any. */
export type AgentAsk =
  | { kind: "questions"; id: string; toolUseId?: string; questions: AgentQuestion[] }
  /** A plan, in Markdown, that the agent waits on before changing anything. */
  | { kind: "plan"; id: string; toolUseId?: string; plan: string }
  /**
   * One of the host's tools that only runs once the user approves it, such as delivering a branch: the agent waits on
   * the card Kumiko shows for it. `tool` is the host's name for the tool, `input` what the agent called it with.
   */
  | { kind: "approval"; id: string; toolUseId?: string; tool: string; input: Record<string, unknown> };

/**
 * The user's answer to an ask.
 * - `answers`: to questions, by question text; each is the labels picked, or the user's own text. A question left out
 *   wasn't answered.
 * - `approve`, `feedback`: to a plan; feedback sends it back to be planned further.
 * - `skip`: questions the user chose not to answer.
 * - `allow`, `deny`: to an approval, decided on its card; `deny` carries what the agent is told. Only Kumiko itself
 *   gives these, never the API: approving means Kumiko has checked what the card shows.
 * - `message`: any kind, answered by a message the user sent instead, which the agent reads next.
 */
export type AskAnswer =
  | { kind: "answers"; answers: Record<string, string[]> }
  | { kind: "approve" }
  | { kind: "feedback"; text: string }
  | { kind: "skip" }
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "message" };

/** Why the agent stopped waiting without an answer: the turn was stopped, or the agent itself went. */
export type AskClosedReason = "interrupted" | "exited";

/** Whether `answer` is one an ask of `kind` takes. */
export function answerFits(kind: AgentAsk["kind"], answer: AskAnswer): boolean {
  if (answer.kind === "message") return true;
  if (kind === "approval") return answer.kind === "allow" || answer.kind === "deny";
  return kind === "questions" ? answer.kind === "answers" || answer.kind === "skip" : answer.kind === "approve" || answer.kind === "feedback";
}

/** The longest answer, or plan feedback, the user can give in their own words. */
export const MAX_ASK_TEXT = 20_000;

/** `value` as an answer, if it is a well-formed one; for answers that come over the API. */
export function parseAskAnswer(value: unknown): AskAnswer | undefined {
  const v = value as Record<string, unknown> | null;
  switch (v?.kind) {
    case "approve":
    case "skip":
    case "message":
      return { kind: v.kind };
    case "feedback":
      return typeof v.text === "string" && v.text.trim() && v.text.length <= MAX_ASK_TEXT ? { kind: "feedback", text: v.text.trim() } : undefined;
    case "answers": {
      const given = v.answers as Record<string, unknown> | null;
      if (!given || typeof given !== "object" || Array.isArray(given)) return undefined;
      const answers: Record<string, string[]> = {};
      for (const [question, a] of Object.entries(given)) {
        if (!Array.isArray(a) || !a.every((x) => typeof x === "string" && x.length <= MAX_ASK_TEXT)) return undefined;
        const kept = (a as string[]).map((x) => x.trim()).filter(Boolean);
        if (kept.length) answers[question] = kept;
      }
      return { kind: "answers", answers };
    }
    default:
      return undefined;
  }
}
