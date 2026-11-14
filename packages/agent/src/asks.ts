import { answerFits, type AgentAsk, type AgentQuestion, type AskAnswer, type AskClosedReason } from "@kumiko/shared";
import type { AgentMessage } from "./driver.js";

/**
 * An ask a driver hands to the next one when it lets go, as `pendingCalls` does for tool calls: the agent goes on
 * waiting for it, and the next driver didn't see it asked. `data` is the driver's own; `answer` is the user's, if they
 * gave one that the agent hasn't been seen to take yet, to be sent again.
 */
export interface PendingAsk {
  ask: AgentAsk;
  data: Record<string, unknown>;
  answer?: AskAnswer;
}

/** The tools whose approval is the user answering: Claude asks for these even with permissions bypassed. */
const ASKING_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

interface Open {
  ask: AgentAsk;
  /** The tool's input as Claude asked with it; an answer replaces it whole, so it goes back with the answer in it. */
  input: Record<string, unknown>;
  answer?: AskAnswer;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Claude's AskUserQuestion input as questions; anything that isn't one is left out. */
function questionsOf(input: Record<string, unknown>): AgentQuestion[] {
  const list = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];
  return list.flatMap((q) => {
    const question = str(q?.question);
    if (!question) return [];
    const options = (Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : []).flatMap((o) => {
      const label = str(o?.label);
      return label ? [{ label, ...(str(o.description) ? { description: str(o.description) } : {}) }] : [];
    });
    return [{ question, ...(str(q.header) ? { header: str(q.header) } : {}), ...(q.multiSelect === true ? { multiSelect: true } : {}), options }];
  });
}

/**
 * Claude's permission requests (`can_use_tool`, with `--permission-prompt-tool stdio`), which with permissions bypassed
 * come only for the tools that ask the user something: AskUserQuestion and, in plan mode, ExitPlanMode. Those become
 * asks; any other is allowed at once, so bypassing stays what it was. An ask stays open until Claude's tool result for
 * it shows it has the answer, or Claude cancels it (the turn was stopped). `write` sends a line to Claude.
 */
export class AskBridge {
  private open = new Map<string, Open>();
  /** The host's tools that need the user's approval, by the agent's name for each, to the host's. */
  private approvals = new Map<string, string>();

  constructor(
    private readonly write: (line: string) => void,
    private readonly emit: (ev: { kind: "ask"; ask: AgentAsk } | { kind: "ask_closed"; id: string; reason: AskClosedReason }) => void,
  ) {}

  /**
   * The host's tools that need approval, by the host's name for each and the agent's: Claude asks before calling them,
   * because Kumiko started it with an "ask" rule for each, and these asks become approvals.
   */
  setApprovalTools(tools: { name: string; agentName: string }[]) {
    this.approvals = new Map(tools.map((t) => [t.agentName, t.name]));
  }

  /** Handles one of Claude's lines if it is a permission request or cancels one; false for any other. */
  handle(msg: AgentMessage): boolean {
    if (msg.type === "control_cancel_request") {
      const id = str(msg.request_id);
      const open = id ? this.open.get(id) : undefined;
      if (!id || !open) return false;
      this.open.delete(id);
      if (!open.answer) this.emit({ kind: "ask_closed", id, reason: "interrupted" });
      return true;
    }
    const request = msg.request as Record<string, unknown> | undefined;
    if (msg.type !== "control_request" || request?.subtype !== "can_use_tool") return false;
    const id = String(msg.request_id);
    const tool = str(request.tool_name) ?? "";
    const input = (request.input && typeof request.input === "object" ? request.input : {}) as Record<string, unknown>;
    const approval = this.approvals.get(tool);
    if (!ASKING_TOOLS.has(tool) && !approval) {
      this.reply(id, { behavior: "allow" });
      return true;
    }
    // Read again from the run's output after a server went away without saving how far it had got: the same ask.
    const known = this.open.get(id);
    if (known) {
      if (known.answer) this.send(id, known);
      return true;
    }
    const toolUseId = str(request.tool_use_id);
    const ask: AgentAsk = approval
      ? { kind: "approval", id, ...(toolUseId ? { toolUseId } : {}), tool: approval, input }
      : tool === "ExitPlanMode"
        ? { kind: "plan", id, ...(toolUseId ? { toolUseId } : {}), plan: str(input.plan) ?? "" }
        : { kind: "questions", id, ...(toolUseId ? { toolUseId } : {}), questions: questionsOf(input) };
    this.open.set(id, { ask, input });
    this.emit({ kind: "ask", ask });
    return true;
  }

  /** One of Claude's messages that isn't for the bridge: a tool result for an ask shows Claude has its answer. */
  seen(msg: AgentMessage) {
    if (msg.type !== "user" || !this.open.size) return;
    const content = (msg.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as { type?: unknown; tool_use_id?: unknown }[]) {
      if (block?.type !== "tool_result") continue;
      for (const [id, open] of this.open) {
        if (open.ask.toolUseId === undefined || open.ask.toolUseId !== block.tool_use_id) continue;
        this.open.delete(id);
        if (!open.answer) this.emit({ kind: "ask_closed", id, reason: "interrupted" });
      }
    }
  }

  /** Answers ask `id`; kept until Claude has it, so the next driver can send it again. */
  answer(id: string, answer: AskAnswer) {
    const open = this.open.get(id);
    if (!open) throw new Error("Claude isn't waiting for that answer any more.");
    if (!answerFits(open.ask.kind, answer)) throw new Error(`That isn't an answer to ${open.ask.kind === "plan" ? "a plan" : open.ask.kind === "approval" ? "an approval" : "questions"}.`);
    open.answer = answer;
    this.send(id, open);
  }

  /** Asks Claude hasn't been seen to have the answer to. */
  pending(): PendingAsk[] {
    return [...this.open.values()].map(({ ask, input, answer }) => ({ ask, data: { input }, ...(answer ? { answer } : {}) }));
  }

  /** Takes over asks an earlier driver left open; answers given to them that Claude may not have yet are sent again. */
  adopt(pending: PendingAsk[]) {
    for (const p of pending) {
      if (this.open.has(p.ask.id)) continue;
      const input = (p.data.input && typeof p.data.input === "object" ? p.data.input : {}) as Record<string, unknown>;
      const open: Open = { ask: p.ask, input, ...(p.answer ? { answer: p.answer } : {}) };
      this.open.set(p.ask.id, open);
      // Claude ignores an answer to a request it has settled already, so sending one twice is safe.
      if (open.answer) this.send(p.ask.id, open);
    }
  }

  /** Claude has gone: nothing it asked can be answered now. */
  close() {
    for (const [id, open] of this.open) if (!open.answer) this.emit({ kind: "ask_closed", id, reason: "exited" });
    this.open.clear();
  }

  private send(id: string, { ask, input, answer }: Open) {
    this.reply(id, permission(ask, input, answer!));
  }

  private reply(requestId: string, response: unknown) {
    this.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } }) + "\n");
  }
}

/**
 * Claude's permission result for an answer. Answers go back in the tool's input, which it replaces whole and checks
 * against the tool's schema; a picked label reads to Claude as picked, anything else as the user's own words. Any other
 * answer refuses the tool, with what the user wants instead as the reason, which is all Claude reads of it.
 */
function permission(ask: AgentAsk, input: Record<string, unknown>, answer: AskAnswer): Record<string, unknown> {
  switch (answer.kind) {
    case "answers": {
      const given = Object.entries(answer.answers).filter(([, a]) => a.length).map(([q, a]) => [q, a.join(", ")]);
      return { behavior: "allow", updatedInput: { ...input, answers: Object.fromEntries(given) } };
    }
    case "approve":
      return { behavior: "allow" };
    case "allow":
      // The input as Claude asked with it: what the user approved, the card's choices and edits, Kumiko keeps itself.
      return { behavior: "allow", updatedInput: input };
    case "deny":
      return { behavior: "deny", message: answer.message };
    case "feedback":
      return { behavior: "deny", message: `The user wants changes to the plan before approving it:\n\n${answer.text}` };
    case "skip":
      return { behavior: "deny", message: "The user skipped these questions without answering them. Carry on with your best judgment, or ask in words if you can't." };
    case "message":
      return {
        behavior: "deny",
        message: ask.kind === "plan"
          ? "The user didn't approve the plan here: they sent a message instead, which follows. Read it before going on."
          : ask.kind === "approval"
            ? "The user didn't approve this: they sent a message instead, which follows. Read it before going on."
            : "The user didn't answer here: they sent a message instead, which follows. Read it before going on.",
      };
  }
}
