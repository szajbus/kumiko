import type { AgentMessage } from "./driver.js";

/**
 * Tools the caller hosts for the agent, outside the sandbox: Claude reaches them as an MCP server of the SDK kind,
 * whose JSON-RPC goes over stream-json's control protocol, so nothing in the VM talks to the host.
 */
export const TOOLS_SERVER = "kumiko";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the tool's input. */
  inputSchema: Record<string, unknown>;
  /** In the agent's context from the start; otherwise deferred, and loaded by the agent's tool search when it wants it. */
  alwaysLoad?: boolean;
  /**
   * Runs only once the user approves it: the agent asks before each call, as for its own questions, and waits however
   * long it takes, while the call itself keeps the usual time limit. The host still checks the approval when called.
   */
  approval?: boolean;
}

/** The agent's name for one of the host's tools. */
export const agentToolName = (name: string) => `mcp__${TOOLS_SERVER}__${name}`;

/**
 * The `--settings` that make the agent ask before calling the host's tools that need approval: an "ask" rule holds
 * even with permissions bypassed, and the asking comes as a permission request (see `AskBridge`).
 */
export function approvalSettings(tools: ToolSpec[]): string | undefined {
  const ask = tools.filter((t) => t.approval).map((t) => agentToolName(t.name));
  return ask.length ? JSON.stringify({ permissions: { ask } }) : undefined;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
  /** Pictures that go back with the text, in base64. */
  images?: { data: string; mimeType: string }[];
}

export interface ToolCallContext {
  /** The agent's id of the tool call, as in its `tool_use` block. */
  toolUseId?: string;
  /** Aborted when the agent cancels the call (the user stopped the turn). */
  signal: AbortSignal;
}

export interface ToolHost {
  list(): ToolSpec[];
  call(name: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult>;
}

/** A call the agent made that hasn't been answered: what a driver that detaches leaves for the next one to answer. */
export interface PendingCall {
  /** The control request's id, which the answer names. */
  requestId: string;
  /** The JSON-RPC `tools/call` message. */
  message: Record<string, unknown>;
}


/**
 * How long the agent waits for a call, in ms. The host's tools answer at once, or within half a minute at most (a picture
 * after a reload); a server restarting hands calls over in seconds. Longer is a hang, so the agent is told it timed out
 * and can carry on. Tools that wait for the user on purpose would need a server of their own, with a longer limit.
 */
export const TOOL_TIMEOUT_MS = 60 * 1000;

/** The `--mcp-config` that has Claude reach the host's tools. */
export const mcpConfig = () => JSON.stringify({ mcpServers: { [TOOLS_SERVER]: { type: "sdk", name: TOOLS_SERVER, timeout: TOOL_TIMEOUT_MS } } });

type JsonRpc = { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> };

/** Answers the agent's MCP messages for the host's tools; `write` sends a line to the agent. */
export class ToolBridge {
  /** Calls under way, by control request id. */
  private calls = new Map<string, { message: JsonRpc; abort: AbortController }>();
  /** Answers nothing more; see `close` and `release`. */
  private closed = false;
  /** Calls being answered, to wait for when the driver lets go. */
  private inflight = new Set<Promise<void>>();
  /** The driver is letting go; calls answered meanwhile are `drained`, in case their answers don't arrive. */
  private draining = false;
  private drained: [string, { message: JsonRpc }][] = [];
  private answersUnsure = false;

  constructor(
    private readonly host: ToolHost,
    private readonly write: (line: string) => void,
  ) {}

  /** Handles one of the agent's lines if it is an MCP message for the host's tools; false for any other. */
  handle(msg: AgentMessage): boolean {
    if (this.closed) return false;
    const request = msg.request as { subtype?: unknown; server_name?: unknown; message?: unknown } | undefined;
    if (msg.type !== "control_request" || request?.subtype !== "mcp_message" || request.server_name !== TOOLS_SERVER) return false;
    const requestId = String(msg.request_id);
    const m = (request.message ?? {}) as JsonRpc;
    if (m.id === undefined) {
      // A notification. The only one that matters says a call was cancelled; each is acknowledged, as the SDK does.
      if (m.method === "notifications/cancelled") this.cancel(m.params?.requestId);
      this.reply(requestId, { jsonrpc: "2.0", result: {}, id: 0 });
      return true;
    }
    switch (m.method) {
      case "initialize":
        this.result(requestId, m, { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: TOOLS_SERVER, version: "1" } });
        break;
      case "tools/list":
        this.result(requestId, m, {
          tools: this.host.list().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, _meta: { "anthropic/alwaysLoad": t.alwaysLoad === true } })),
        });
        break;
      case "tools/call":
        this.track(this.call(requestId, m));
        break;
      default:
        this.reply(requestId, { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
    }
    return true;
  }

  /** Calls the agent made that haven't been answered yet. */
  pending(): PendingCall[] {
    const unsure = this.answersUnsure ? this.drained : [];
    return [...this.calls, ...unsure].map(([requestId, c]) => ({ requestId, message: c.message as Record<string, unknown> }));
  }

  /**
   * The driver is letting go: resolves once the calls under way have been answered, or after `ms`, whichever is first.
   * Calls still under way then are left pending, for the next driver.
   */
  drain(ms: number): Promise<void> {
    this.draining = true;
    const all = Promise.allSettled([...this.inflight]).then(() => {});
    return Promise.race([all, new Promise<void>((r) => setTimeout(r, ms).unref?.())]);
  }

  /**
   * The answers written while draining may not have reached the agent (its input was cut off rather than closed): they
   * go to the next driver with the pending calls, to be answered again. The agent ignores a second answer.
   */
  answersMayBeLost() {
    this.answersUnsure = true;
  }

  /** Answers calls an earlier driver left unanswered. */
  rerun(pending: PendingCall[]) {
    for (const p of pending) if (!this.calls.has(p.requestId)) this.track(this.call(p.requestId, p.message as JsonRpc));
  }

  /** Nothing more will be answered: the agent is gone. */
  close() {
    this.release();
    this.calls.clear();
  }

  /** The driver let go of the agent: nothing more is answered, and the calls under way stay `pending` for the next one. */
  release() {
    this.closed = true;
    for (const c of this.calls.values()) c.abort.abort();
  }

  private async call(requestId: string, m: JsonRpc) {
    const abort = new AbortController();
    this.calls.set(requestId, { message: m, abort });
    const name = String(m.params?.name ?? "");
    const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
    const meta = m.params?._meta as Record<string, unknown> | undefined;
    const toolUseId = typeof meta?.["claudecode/toolUseId"] === "string" ? meta["claudecode/toolUseId"] : undefined;
    let res: ToolResult;
    try {
      res = this.host.list().some((t) => t.name === name)
        ? await this.host.call(name, args, { toolUseId, signal: abort.signal })
        : { text: `There is no tool ${name}.`, isError: true };
    } catch (err) {
      res = { text: err instanceof Error ? err.message : String(err), isError: true };
    }
    // Cancelled: the agent isn't waiting for this answer any more. Released: the next driver answers it.
    if (this.closed || this.calls.get(requestId)?.abort !== abort) return;
    this.calls.delete(requestId);
    if (this.draining) this.drained.push([requestId, { message: m }]);
    const images = (res.images ?? []).map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
    this.result(requestId, m, { content: [{ type: "text", text: res.text }, ...images], ...(res.isError ? { isError: true } : {}) });
  }


  private track(call: Promise<void>) {
    this.inflight.add(call);
    void call.finally(() => this.inflight.delete(call));
  }

  private cancel(id: unknown) {
    for (const [requestId, c] of this.calls) {
      if (c.message.id !== id) continue;
      c.abort.abort();
      this.calls.delete(requestId);
    }
  }

  private result(requestId: string, m: JsonRpc, result: unknown) {
    this.reply(requestId, { jsonrpc: "2.0", id: m.id, result });
  }

  private reply(requestId: string, mcp_response: unknown) {
    this.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { mcp_response } } }) + "\n");
  }
}
