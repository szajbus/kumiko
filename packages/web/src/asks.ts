import type { AgentQuestion, AskAnswer, AskClosedReason } from "@kumiko/shared";

/** What the user has picked for one question so far: options by label, and their own answer, if they wrote one. */
export interface Picks {
  labels: string[];
  own: string;
  /** The own answer is picked: typing in it picks it; it can be unpicked like any option, keeping the text. */
  ownOn: boolean;
}

export const noPicks = (): Picks => ({ labels: [], own: "", ownOn: false });

/** Picks option `label`, or for a multi-select question toggles it. Picking an option of a single choice drops the own answer. */
export function pick(q: AgentQuestion, p: Picks, label: string): Picks {
  if (!q.multiSelect) return { ...p, labels: [label], ownOn: false };
  return { ...p, labels: p.labels.includes(label) ? p.labels.filter((l) => l !== label) : [...p.labels, label] };
}

/** Picks the own answer, or toggles it for a multi-select question. */
export function pickOwn(q: AgentQuestion, p: Picks, on = q.multiSelect ? !p.ownOn : true): Picks {
  return q.multiSelect ? { ...p, ownOn: on } : { ...p, labels: on ? [] : p.labels, ownOn: on };
}

/** The own answer's text as typed: typing picks it, and emptying it unpicks it. */
export function typeOwn(q: AgentQuestion, p: Picks, own: string): Picks {
  return { ...pickOwn(q, p, own.trim() !== ""), own };
}

/** The answers to send: per question, the labels picked in the order the options come, then the own answer. */
export function answersOf(questions: AgentQuestion[], picks: Picks[]): Record<string, string[]> {
  const answers: Record<string, string[]> = {};
  questions.forEach((q, i) => {
    const p = picks[i] ?? noPicks();
    const given = [...q.options.map((o) => o.label).filter((l) => p.labels.includes(l)), ...(p.ownOn && p.own.trim() ? [p.own.trim()] : [])];
    if (given.length) answers[q.question] = given;
  });
  return answers;
}

/** An answer as given, split into the options picked and what the user wrote in their own words. */
export function splitAnswer(q: AgentQuestion, answer: string[] = []): { labels: string[]; own: string[] } {
  const labels = new Set(q.options.map((o) => o.label));
  return { labels: answer.filter((a) => labels.has(a)), own: answer.filter((a) => !labels.has(a)) };
}

/** How an ask ended, for its card once it is over; undefined while it waits, or when its answers say it all. */
export function askOutcome(kind: "questions" | "plan", answer: AskAnswer | undefined, closed: AskClosedReason | undefined): string | undefined {
  switch (answer?.kind) {
    case "answers":
      return undefined;
    case "approve":
      return "Approved.";
    case "feedback":
      return "Sent back:";
    case "skip":
      return "Skipped.";
    case "message":
      return "You answered with a message instead.";
  }
  if (closed === "interrupted") return "Stopped before you answered.";
  if (closed === "exited") return kind === "plan" ? "Claude stopped before you approved it." : "Claude stopped before you answered.";
  return undefined;
}

/** Where a question stands among those asked together, as "1 of 2"; nothing when it's the only one. */
export function askPosition(n: number, total: number): string | undefined {
  return total > 1 ? `${n + 1} of ${total}` : undefined;
}

/** What a plan is called: its first heading, or failing that its first line. */
export function planTitle(plan: string): string {
  const lines = plan.split("\n").map((l) => l.trim()).filter(Boolean);
  const heading = lines.find((l) => /^#{1,6}\s/.test(l));
  return (heading ?? lines[0] ?? "").replace(/^#{1,6}\s+/, "");
}
