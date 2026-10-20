import type { AgentMessage } from "@bentomo/agent";

/** How much of one tool result's text a session keeps. Claude's own transcript in the sandbox keeps all of it. */
export const MAX_TOOL_RESULT_CHARS = 64 * 1024;

/** `text` cut to `max` characters, with a note saying how much was left out. */
export function truncate(text: string, max = MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return `${text.slice(0, max)}\n… ${Math.ceil(dropped / 1024)} KB more not kept by Bentomo`;
}

/**
 * Shrinks what a session keeps of one of Claude's messages: the text of each tool result is cut to
 * MAX_TOOL_RESULT_CHARS, and `tool_use_result` is dropped. That is the same output again in structured form
 * (a Read's file, a Bash command's stdout), and nothing shows it. Images and documents lose their data: the files of
 * a prompt Claude echoes back, or an image a Read returned. Anything else comes back as it was.
 */
export function trimMessage(m: AgentMessage): AgentMessage {
  if (m.type !== "user") return m;
  const message = m.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!("tool_use_result" in m) && !Array.isArray(content)) return m;
  const { tool_use_result: _dropped, ...rest } = m;
  if (!Array.isArray(content)) return rest as AgentMessage;
  return { ...rest, message: { ...message, content: content.map(trimBlock) } } as AgentMessage;
}

function trimBlock(block: unknown): unknown {
  const b = block as { type?: unknown; content?: unknown };
  if (b?.type === "image" || b?.type === "document") return withoutData(b);
  if (!b || b.type !== "tool_result") return block;
  if (typeof b.content === "string") return { ...b, content: truncate(b.content) };
  if (!Array.isArray(b.content)) return block;
  return {
    ...b,
    content: b.content.map((c: { type?: unknown; text?: unknown }) =>
      c?.type === "text" && typeof c.text === "string" ? { ...c, text: truncate(c.text) } : c?.type === "image" || c?.type === "document" ? withoutData(c) : c,
    ),
  };
}

/** An image or document block with its `source` cut to what kind it was. The chat only shows that there was one. */
function withoutData(block: object): unknown {
  const { source, ...rest } = block as { source?: { data?: unknown } };
  if (!source || typeof source !== "object" || !("data" in source)) return block;
  const { data: _dropped, ...kind } = source;
  return { ...rest, source: kind };
}
