import type { AgentMessage } from "@kumiko/agent";

/** How much of one tool result's text a session keeps. Claude's own transcript in the sandbox keeps all of it. */
export const MAX_TOOL_RESULT_CHARS = 64 * 1024;

/** `text` cut to `max` characters, with a note saying how much was left out. */
export function truncate(text: string, max = MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return `${text.slice(0, max)}\n… ${Math.ceil(dropped / 1024)} KB more not kept by Kumiko`;
}

/**
 * Shrinks what a session keeps of one of Claude's messages: the text of each tool result is cut to
 * MAX_TOOL_RESULT_CHARS, and `tool_use_result` is dropped. That is the same output again in structured form
 * (a Read's file, a Bash command's stdout), and nothing shows it. Only a file edit's keeps what its diff is drawn from
 * (see `editResult`). Images and documents lose their data: the files of a prompt Claude echoes back, or an image a
 * Read returned. Anything else comes back as it was.
 */
export function trimMessage(m: AgentMessage): AgentMessage {
  if (m.type !== "user") return m;
  const message = m.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!("tool_use_result" in m) && !Array.isArray(content)) return m;
  const { tool_use_result: result, ...rest } = m;
  const edit = editResult(result);
  const kept = edit ? { ...rest, tool_use_result: edit } : rest;
  if (!Array.isArray(content)) return kept as AgentMessage;
  return { ...kept, message: { ...message, content: content.map(trimBlock) } } as AgentMessage;
}

/**
 * What the chat draws an edit's diff from, out of its `tool_use_result`: the patch of an Edit or a Write, with where
 * it is in the file, or the cell a NotebookEdit changed, as it was. Both also carry the whole file, which is left
 * out. A patch is cut to MAX_TOOL_RESULT_CHARS of lines, and says so with `truncated`.
 */
export function editResult(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  const pick = (...keys: string[]) => Object.fromEntries(keys.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));
  if (Array.isArray(r.structuredPatch)) {
    let room = MAX_TOOL_RESULT_CHARS;
    const hunks: unknown[] = [];
    for (const h of r.structuredPatch as { lines?: unknown }[]) {
      const lines = Array.isArray(h?.lines) ? h.lines.filter((l): l is string => typeof l === "string") : [];
      const fit = lines.findIndex((l) => (room -= l.length + 1) < 0);
      hunks.push({ ...h, lines: fit < 0 ? lines : lines.slice(0, fit) });
      if (fit >= 0) return { ...pick("type", "userModified", "replaceAll"), structuredPatch: hunks, truncated: true };
    }
    return { ...pick("type", "userModified", "replaceAll"), structuredPatch: hunks };
  }
  if (typeof r.old_source === "string" && typeof r.edit_mode === "string") {
    return { ...pick("cell_id", "cell_type", "edit_mode"), old_source: truncate(r.old_source) };
  }
  return undefined;
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
