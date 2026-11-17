import type { WorkflowRun } from "./github.js";

/** Why a path or a call can't be read as it is; the message is for the agent. */
export class ReadRefused extends Error {}

/** At most this much of a response goes to the agent. */
export const MAX_API_TEXT = 60_000;

/** At most this much of a run's logs goes to the agent. */
export const MAX_LOG_TEXT = 100_000;

/**
 * Endpoints whose answer is an archive, not text: GitHub redirects them to a download. A run's logs have their own tool,
 * which unpacks them and keeps what matters.
 */
const ARCHIVES = new Set(["zipball", "tarball"]);
const ARCHIVE_ENDS = new Set(["logs", "zip"]);

/**
 * The REST path a github_api_get call asks for, as gh api takes it: always under `repos/<repo>`, the sandbox's repo.
 * The agent gives it relative to the repo ("actions/runs?branch=x"), or whole ("/repos/owner/name/actions/runs"), and
 * nothing in it may lead out of the repo: no "." or ".." segments, even encoded, and none of gh's {placeholders}.
 */
export function apiPath(repo: string, input: unknown): string {
  if (typeof input !== "string") throw new ReadRefused("path must be a string, such as actions/runs?branch=main.");
  if (input.length > 2000) throw new ReadRefused("path is longer than 2000 characters.");
  if (/[\s\x00-\x1f\x7f{}#\\]/.test(input)) throw new ReadRefused("path can't have spaces, control characters, braces, # or backslashes.");
  const q = input.indexOf("?");
  let path = (q < 0 ? input : input.slice(0, q)).replace(/^\/+/, "");
  const query = q < 0 ? "" : input.slice(q);
  const prefix = `repos/${repo}`;
  if (path.toLowerCase() === prefix.toLowerCase() || path.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) path = path.slice(prefix.length).replace(/^\//, "");
  else if (/^repos(\/|$)/i.test(path)) throw new ReadRefused(`Only ${repo} can be read: give the path relative to it, such as actions/runs, or as /repos/${repo}/….`);
  const segments = path ? path.split("/") : [];
  for (const s of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(s);
    } catch {
      throw new ReadRefused(`path has a broken %-escape: ${s}`);
    }
    if (!s || decoded === "." || decoded === ".." || /[/\\]/.test(decoded)) throw new ReadRefused("path can't have empty, . or .. segments, or encoded slashes.");
  }
  const last = segments.at(-1)?.toLowerCase();
  if (segments.some((s) => ARCHIVES.has(s.toLowerCase())) || (last && ARCHIVE_ENDS.has(last))) {
    throw new ReadRefused("That answers with an archive, not text. For a workflow run's or job's logs, use github_run_logs.");
  }
  return segments.length ? `${prefix}/${segments.join("/")}${query}` : `${prefix}${query}`;
}

/**
 * GitHub's JSON, trimmed of what costs the agent much and tells it little: API URLs other than html_url, node ids, and
 * every nested repository and account, which come down to their names.
 */
export function compact(value: unknown, top = true): unknown {
  if (Array.isArray(value)) return value.map((v) => compact(v, false));
  if (!value || typeof value !== "object") return value;
  const o = value as Record<string, unknown>;
  if (!top && typeof o.full_name === "string" && o.owner && typeof o.owner === "object") return o.full_name;
  if (!top && typeof o.login === "string" && typeof o.avatar_url === "string") return o.login;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === "node_id" || (k.endsWith("_url") && k !== "html_url") || (k === "url" && "html_url" in o)) continue;
    out[k] = compact(v, false);
  }
  return out;
}

/** A response's body as the agent reads it: compacted JSON, or the text as it is; cut when it's too long. */
export function apiText(body: string, raw: boolean): string {
  if (body.includes("\0")) throw new ReadRefused("GitHub answered with binary data, which isn't shown.");
  let text = body.trim();
  if (!raw) {
    try {
      text = JSON.stringify(compact(JSON.parse(text)));
    } catch {
      // Not JSON: as it is.
    }
  }
  if (text.length <= MAX_API_TEXT) return text || "(empty)";
  return `${text.slice(0, MAX_API_TEXT)}\n[Kumiko cut the rest: ${text.length - MAX_API_TEXT} more characters. Ask for fewer, with per_page= and page=, or for a narrower path.]`;
}

/** A run as a few lines: what it is, how it went, and its jobs, with the steps that failed. */
export function runSummary(run: WorkflowRun): string {
  const lines = [
    `Run ${run.databaseId}${run.attempt && run.attempt > 1 ? `, attempt ${run.attempt}` : ""}: ${run.workflowName ?? run.name ?? "?"}${run.displayTitle ? ` · ${run.displayTitle}` : ""}`,
    `Status: ${run.status}${run.conclusion ? ` · ${run.conclusion}` : ""}${run.event ? ` · on ${run.event}` : ""}${run.headBranch ? ` · branch ${run.headBranch}` : ""}${run.headSha ? ` · ${run.headSha.slice(0, 7)}` : ""}${run.createdAt ? ` · ${run.createdAt}` : ""}`,
    run.url,
  ];
  if (run.jobs?.length) {
    lines.push("Jobs:");
    for (const j of run.jobs) {
      const failed = (j.steps ?? []).filter((s) => s.conclusion === "failure").map((s) => `step ${s.number} "${s.name}"`);
      lines.push(`- ${j.name} (job ${j.databaseId}): ${j.conclusion || j.status}${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
    }
  }
  return lines.join("\n");
}

/** ANSI colours, and the timestamp GitHub starts each line with. */
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** What gh calls a step it can't match lines to, as with GitHub's newer log archives. */
const UNKNOWN_STEP = "UNKNOWN STEP";
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z ?/;

/**
 * gh's log lines ("job\tstep\tline") as the agent reads them: a heading for each job's step, its lines without
 * timestamps or colours, and only the last `tail` of each, where a step says why it failed. Cut from the start when the
 * whole is still too long.
 */
export function logText(log: string, tail: number): string {
  const steps: { job: string; step: string; lines: string[] }[] = [];
  for (const raw of log.split("\n")) {
    if (!raw) continue;
    const [job, step, ...rest] = raw.split("\t");
    const line = rest.length ? rest.join("\t") : (step ?? job);
    const at = steps.at(-1);
    const key = rest.length ? { job, step } : { job: at?.job ?? "?", step: at?.step ?? "?" };
    const group = at && at.job === key.job && at.step === key.step ? at : (steps.push({ ...key, lines: [] }), steps.at(-1)!);
    group.lines.push(line.replace(ANSI, "").replace(STAMP, "").replace(/\r$/, ""));
  }
  const parts = steps.map((s) => {
    // When gh can't tell the steps apart, a job's log is one "step", ending in the cleanup after the one that failed:
    // its tail ends at the last error instead, where the failure is.
    const lastError = s.step === UNKNOWN_STEP ? s.lines.findLastIndex((l) => l.startsWith("##[error]")) : -1;
    const lines = lastError >= 0 ? s.lines.slice(0, lastError + 1) : s.lines;
    const after = s.lines.length - lines.length;
    const kept = lines.slice(-tail);
    const cut = lines.length - kept.length;
    const note = [cut ? `last ${kept.length} of ${s.lines.length} lines` : "", after ? `up to its last error, without the ${after} lines after it` : ""].filter(Boolean).join(", ");
    return `=== ${s.job} / ${s.step}${note ? ` (${note})` : ""} ===\n${kept.join("\n")}`;
  });
  const text = parts.join("\n\n");
  if (text.length <= MAX_LOG_TEXT) return text;
  return `[Kumiko cut the first ${text.length - MAX_LOG_TEXT} characters: ask for one job with job_id, or a smaller tail.]\n${text.slice(-MAX_LOG_TEXT)}`;
}
