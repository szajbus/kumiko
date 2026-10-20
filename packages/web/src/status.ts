import { isWaiting, type LogLine, type OpKind, type SandboxView, type SessionInfo, type SessionStatus } from "@kumiko/shared";

export const COLORS = {
  running: "#4CC38A",
  stopped: "#9AA1AD",
  busy: "#8FA6F0",
  failed: "#F07A6A",
  warn: "#E3A24A",
} as const;

const OP_LABEL: Record<OpKind, string> = {
  creating: "Creating",
  starting: "Starting",
  stopping: "Stopping",
  deleting: "Deleting",
  recreating: "Recreating",
  editing: "Saving changes",
};

const OP_DONE: Record<OpKind, string> = {
  creating: "Created",
  starting: "Started",
  stopping: "Stopped",
  deleting: "Deleted",
  recreating: "Recreated",
  editing: "Saved",
};

const OP_FAILED: Record<OpKind, string> = {
  creating: "Create failed",
  starting: "Start failed",
  stopping: "Stop failed",
  deleting: "Delete failed",
  recreating: "Recreate failed",
  editing: "Save failed",
};

/** The status cell: what the sandbox is doing or how it is. */
export function statusOf(sb: SandboxView, log: LogLine[] = []): { text: string; color: string } {
  if (sb.busy && sb.operation) {
    // Once a create or start reaches installing Claude Code or the provisioning script, say so.
    const step = log.findLast((l) => l.kind === "note" && l.text.startsWith("— "))?.text;
    const label = step?.startsWith("— installing Claude") ? "Installing Claude Code" : step?.startsWith("— provisioning") ? "Provisioning" : OP_LABEL[sb.operation.op];
    return { text: `${label}…`, color: COLORS.busy };
  }
  if (sb.meta?.setup === "provision_failed") return { text: "Provisioning failed", color: COLORS.failed };
  switch (sb.status) {
    case "running":
      return sb.meta?.setup === "creating"
        ? { text: "Running · not provisioned", color: COLORS.warn }
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
export function opPill(sb: SandboxView | undefined, op = sb?.operation): { text: string; color: string } | undefined {
  if (!op) return undefined;
  if (!op.endedAt) return { text: OP_LABEL[op.op], color: COLORS.busy };
  if (op.result === "error") {
    const code = sb?.meta?.setup === "provision_failed" ? sb.meta.provisionExitCode : undefined;
    return { text: code !== undefined ? `Provisioning failed · exit ${code}` : OP_FAILED[op.op], color: COLORS.failed };
  }
  return { text: OP_DONE[op.op], color: COLORS.stopped };
}

export function resources(sb: SandboxView): string {
  if (sb.cpus === undefined && sb.memoryGiB === undefined) {
    const s = sb.meta?.spec;
    return s ? `${s.cpus} · ${s.memoryGiB} GiB · ${s.diskGiB} GiB` : "—";
  }
  return `${sb.cpus ?? "?"} · ${sb.memoryGiB ?? "?"} GiB · ${sb.diskGiB ?? "?"} GiB`;
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
export const sessionState = (s: SessionInfo) =>
  isWaiting(s) && s.status === "idle" ? { text: "Waiting on you", color: COLORS.warn } : SESSION_STATUS[s.status];

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
