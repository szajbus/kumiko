/**
 * Words for tool calls the window doesn't hang on (see widgets.ts for those): Kumiko's GitHub tools and deliver, loading
 * deferred tools, and any other MCP server's tools, which Claude Code names mcp__<server>__<tool>.
 */

/** A tool call's line in the chat: what was done, and to what; `mono` when that is a path or a name, not words. */
export interface ToolLine {
  label: string;
  title?: string;
  mono?: boolean;
}

const KUMIKO = "mcp__kumiko__";

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The chat's line for one of Kumiko's own tools that isn't about the window, or for loading tools; undefined for others. */
export function toolLine(name: string, input: Record<string, unknown>): ToolLine | undefined {
  const n = num(input.number);
  const repo = str(input.repo);
  // In a sandbox with several repos, the call says which.
  const inRepo = (t: string | undefined) => [t, repo && `in ${repo}`].filter(Boolean).join(" ") || undefined;
  switch (name.startsWith(KUMIKO) ? name.slice(KUMIKO.length) : name === "ToolSearch" ? "ToolSearch" : "") {
    case "deliver":
      return { label: "Asked to deliver", title: str(input.branch), mono: true };
    case "github_issue_view":
      return { label: "Read issue", title: inRepo(n ? `#${n}` : undefined) };
    case "github_pr_view":
      return { label: "Read pull request", title: inRepo(n ? `#${n}` : undefined) };
    case "github_issue_list":
    case "github_pr_list": {
      const what = name.endsWith("pr_list") ? "pull requests" : "issues";
      const state = str(input.state) ?? "open";
      const search = str(input.search);
      return { label: `Listed ${state === "all" ? "" : `${state} `}${what}`, title: inRepo(search && `matching “${search}”`) };
    }
    case "github_label_list":
      return { label: "Listed labels", title: inRepo(undefined) };
    case "github_issue_create":
      return { label: "Asked to create an issue", title: str(input.title) };
    case "github_issue_comment":
      return { label: "Asked to comment on issue", title: inRepo(n ? `#${n}` : undefined) };
    case "github_pr_comment":
      return { label: "Asked to comment on pull request", title: inRepo(n ? `#${n}` : undefined) };
    case "github_api_get":
      return { label: "Read from GitHub", title: str(input.path) ?? "the repository", mono: true };
    case "github_run_logs": {
      const run = num(input.run_id);
      const job = num(input.job_id);
      return { label: input.failed_only === false ? "Read the logs of run" : "Read the failed steps of run", title: [run, job && `job ${job}`].filter(Boolean).join(", ") || undefined, mono: true };
    }
    case "ToolSearch": {
      // "select:a,b" loads those tools by name; anything else is a search.
      const query = str(input.query) ?? "";
      if (query.startsWith("select:")) {
        const names = query.slice("select:".length).split(",").map((t) => toolName(t.trim())).filter(Boolean);
        return { label: names.length === 1 ? "Loaded a tool" : "Loaded tools", title: names.join(", "), mono: true };
      }
      return { label: "Looked for tools", title: query || undefined };
    }
    default:
      return undefined;
  }
}

/**
 * A tool's name as the chat shows it: Kumiko's own without their prefix, another MCP server's as "Server · tool", with
 * claude.ai's connectors by their own names, and Claude Code's as they are.
 */
export function toolName(name: string): string {
  if (name.startsWith(KUMIKO)) return name.slice(KUMIKO.length);
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return name;
  const server = m[1].replace(/^claude_ai_/, "").replace(/_/g, " ");
  return `${server} · ${m[2]}`;
}
