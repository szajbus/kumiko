import type { LogLine, OpKind, SandboxView } from "@bentomo/shared";

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
  provisioning: "Provisioning",
  recreating: "Recreating",
  editing: "Saving changes",
};

const OP_NOUN: Record<OpKind, string> = {
  creating: "create",
  starting: "start",
  stopping: "stop",
  deleting: "delete",
  provisioning: "provisioning",
  recreating: "recreate",
  editing: "edit",
};

/** The status cell: what the sandbox is doing or how it is. */
export function statusOf(sb: SandboxView, log: LogLine[] = []): { text: string; color: string } {
  if (sb.busy && sb.operation) {
    // Once a create or start reaches the provisioning step, say so.
    const provisioning = sb.operation.op !== "provisioning" && log.some((l) => l.kind === "note" && l.text.startsWith("— provisioning"));
    return { text: `${OP_LABEL[provisioning ? "provisioning" : sb.operation.op]}…`, color: COLORS.busy };
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
    return { text: code !== undefined ? `Failed · exit ${code}` : `Failed: ${OP_NOUN[op.op]}`, color: COLORS.failed };
  }
  return { text: `Last: ${OP_NOUN[op.op]}`, color: COLORS.stopped };
}

export function resources(sb: SandboxView): string {
  if (sb.cpus === undefined && sb.memoryGiB === undefined) {
    const s = sb.meta?.spec;
    return s ? `${s.cpus} · ${s.memoryGiB} GiB · ${s.diskGiB} GiB` : "—";
  }
  return `${sb.cpus ?? "?"} · ${sb.memoryGiB ?? "?"} GiB · ${sb.diskGiB ?? "?"} GiB`;
}
