import { isBusy, isWaiting, type LogLine, type OpKind, type SandboxInfo, type SandboxStats, type VmView, type SessionInfo, type SessionStatus } from "@kumiko/shared";

export const COLORS = {
  running: "#4CC38A",
  stopped: "#9AA1AD",
  busy: "#8FA6F0",
  failed: "#F07A6A",
  warn: "#E3A24A",
  /** A saved session without a tab. */
  closed: "#5F6773",
} as const;

const OP_LABEL: Record<OpKind, string> = {
  creating: "Creating",
  starting: "Starting",
  stopping: "Stopping",
  deleting: "Deleting",
  recreating: "Rebuilding",
  restarting: "Restarting",
  editing: "Saving changes",
};

const OP_DONE: Record<OpKind, string> = {
  creating: "Created",
  starting: "Started",
  stopping: "Stopped",
  deleting: "Deleted",
  recreating: "Rebuilt",
  restarting: "Restarted",
  editing: "Saved",
};

const OP_FAILED: Record<OpKind, string> = {
  creating: "Create failed",
  starting: "Start failed",
  stopping: "Stop failed",
  deleting: "Delete failed",
  recreating: "Rebuild failed",
  restarting: "Restart failed",
  editing: "Save failed",
};

/** The agent's setup scripts that failed when the VM was created. */
export function failedAgentScripts(sb: SandboxInfo): string[] {
  return (sb.meta?.agentSetup?.scripts ?? []).filter((s) => s.exitCode !== undefined && s.exitCode !== 0).map((s) => s.file);
}

/** The status cell: what the sandbox is doing or how it is. */
export function statusOf(sb: VmView, log: LogLine[] = []): { text: string; color: string } {
  if (sb.busy && sb.operation) {
    // Once a create or start reaches installing Claude Code or the provisioning script, say so.
    const step = log.findLast((l) => l.kind === "note" && l.text.startsWith("— "))?.text;
    const label = step?.startsWith("— installing Claude")
      ? "Installing Claude Code"
      : step?.startsWith("— provisioning")
        ? "Provisioning"
        : step?.startsWith("— agent setup")
          ? "Running the agent's setup"
          : OP_LABEL[sb.operation.op];
    return { text: `${label}…`, color: COLORS.busy };
  }
  if (sb.meta?.setup === "provision_failed") return { text: "Provisioning failed", color: COLORS.failed };
  switch (sb.status) {
    case "running":
      return sb.meta?.setup === "creating"
        ? { text: "Running · not provisioned", color: COLORS.warn }
        : failedAgentScripts(sb).length
          ? { text: "Running · agent setup failed", color: COLORS.warn }
          : { text: "Running", color: COLORS.running };
    case "stopped":
      return sb.meta?.setup === "creating"
        ? { text: "Stopped · not provisioned", color: COLORS.warn }
        : { text: "Stopped", color: COLORS.stopped };
    case "broken":
      return { text: "Broken", color: COLORS.failed };
    case "absent":
      return { text: "No sandbox", color: COLORS.warn };
    default:
      return { text: "Unknown", color: COLORS.warn };
  }
}

/** The pill in the log drawer: the running operation, or how the last one ended. */
export function opPill(sb: VmView | undefined, op = sb?.operation): { text: string; color: string } | undefined {
  if (!op) return undefined;
  if (!op.endedAt) return { text: OP_LABEL[op.op], color: COLORS.busy };
  if (op.result === "error") {
    const code = sb?.meta?.setup === "provision_failed" ? sb.meta.provisionExitCode : undefined;
    return { text: code !== undefined ? `Provisioning failed · exit ${code}` : OP_FAILED[op.op], color: COLORS.failed };
  }
  return { text: OP_DONE[op.op], color: COLORS.stopped };
}

/** When the sandbox's VM was created: its own record's time, which a rebuild renews. */
export function sandboxCreatedAt(sb: VmView): string | undefined {
  return sb.meta?.createdAt;
}

/** The sandbox's size for the list: CPUs, memory and its workspace disk, as Lima has them, else as its record says. */
export function resources(sb: VmView): [string, string, string] | undefined {
  const s = sb.meta?.spec;
  const workspace = sb.workspaceGiB ?? s?.workspaceGiB;
  const ws = workspace === undefined ? "—" : `${workspace} GiB`;
  if (sb.cpus === undefined && sb.memoryGiB === undefined) return s && [`${s.cpus}`, `${s.memoryGiB} GiB`, ws];
  return [`${sb.cpus ?? "?"}`, `${sb.memoryGiB ?? "?"} GiB`, ws];
}

/** One of a running sandbox's readings, as a bar: how full it is, and in words. */
export interface Meter {
  label: "CPU" | "Memory" | "Disk" | "Workspace";
  /** Missing until there is a reading to show, as for CPU on the first one. */
  percent?: number;
  text: string;
  color: string;
}

/** Green while there is room, amber from 80%, red from 95%. */
export const meterColor = (percent: number): string => (percent >= 95 ? COLORS.failed : percent >= 80 ? COLORS.warn : COLORS.running);

const gib = (bytes: number) => {
  const n = bytes / 1024 ** 3;
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} GiB`;
};

/** A reading, with the workspace disk's use once the server measures it. */
type Reading = SandboxStats;

/**
 * The CPU, memory and disk bars of a sandbox's reading, and the workspace disk's when the reading has it. Disks are
 * full as `df` counts it: of the space not reserved.
 */
export function meters(s: Reading): Meter[] {
  const meter = (label: Meter["label"], percent: number | undefined, text: string): Meter => ({
    label,
    percent,
    text,
    color: percent === undefined ? COLORS.stopped : meterColor(percent),
  });
  const pct = (used: number, total: number) => (total > 0 ? (100 * used) / total : 0);
  const cpu = s.cpuPercent === undefined ? undefined : Math.round(s.cpuPercent);
  const mem = Math.round(pct(s.memUsedBytes, s.memTotalBytes));
  const disk = Math.round(pct(s.diskUsedBytes, s.diskUsedBytes + s.diskFreeBytes));
  return [
    meter("CPU", cpu, `${cpu === undefined ? "—" : `${cpu}% busy`} · load ${s.load.toFixed(1)}`),
    meter("Memory", mem, `${gib(s.memUsedBytes)} used · ${mem}%`),
    meter("Disk", disk, `${gib(s.diskUsedBytes)} used · ${disk}%`),
    ...(s.workspaceUsedBytes !== undefined && s.workspaceFreeBytes !== undefined
      ? [meter("Workspace", Math.round(pct(s.workspaceUsedBytes, s.workspaceUsedBytes + s.workspaceFreeBytes)), `${gib(s.workspaceUsedBytes)} used · ${Math.round(pct(s.workspaceUsedBytes, s.workspaceUsedBytes + s.workspaceFreeBytes))}%`)]
      : []),
  ];
}

const SESSION_STATUS: Record<SessionStatus, { text: string; color: string }> = {
  starting: { text: "Starting…", color: COLORS.busy },
  running: { text: "Working…", color: COLORS.busy },
  idle: { text: "Ready", color: COLORS.running },
  ended: { text: "Ended", color: COLORS.stopped },
  failed: { text: "Failed", color: COLORS.failed },
};

export const sessionStatus = (s: SessionStatus) => SESSION_STATUS[s];

/** A session's state for its tab and lists: waiting on the user stands out from merely ready. */
export const sessionState = (s: SessionInfo) => {
  const st = ownState(s);
  // Shells and monitors aren't work, so they leave the state as it is, and are said beside it.
  return s.shells && !s.asleep ? { ...st, text: `${st.text.replace(/…$/, "")} · ${s.shells} running in the background` } : st;
};

const ownState = (s: SessionInfo) =>
  s.asleep
    ? { text: "Sandbox stopped", color: COLORS.stopped }
    : s.asking
      ? { text: s.asking === "plan" ? "Plan to review" : s.asking === "approval" ? "Waiting for your approval" : "Has a question for you", color: COLORS.warn }
      : isWaiting(s) && s.status === "idle"
      ? { text: "Waiting on you", color: COLORS.warn }
      : isBusy(s)
        ? SESSION_STATUS.running
        : SESSION_STATUS[s.status];

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What a session Claude finishes after its tab closed says it is doing: finishing, or waiting on the user, who can open
 * it again to answer while it waits.
 */
export const finishingState = (s: SessionInfo): { text: string; color: string; pulse: boolean } =>
  s.asking ? { text: "Needs attention", color: COLORS.warn, pulse: false } : { text: "Finishing…", color: COLORS.busy, pulse: true };
