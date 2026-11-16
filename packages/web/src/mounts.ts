import { WORKSPACE_DIR } from "@kumiko/shared";

// The checks the sandbox form makes on extra mounts as they are typed. Plain functions, so they can be tested without a browser.

export interface MountRow {
  id: number;
  hostPath: string;
  /** Where it lands in the VM; empty means the same path as on the host. */
  guestPath: string;
  writable: boolean;
}

/** An absolute path or ~/…, but not / or ~ alone. */
const vmPathShape = (t: string) => (t.startsWith("/") && t !== "/") || (t.startsWith("~/") && t.length > 2);

/** Whether a path in the sandbox is /workspace or inside it: the workspace disk's, where no folder can be mounted. */
export const inWorkspace = (p: string) => {
  const t = p.trim().replace(/\/+$/, "");
  return t === WORKSPACE_DIR || t.startsWith(`${WORKSPACE_DIR}/`);
};

/** Why a mount's path in the sandbox won't do, or undefined when it's fine. Empty means the host folder's own path. */
export function guestPathProblem(row: Pick<MountRow, "id" | "hostPath" | "guestPath">, rows: Pick<MountRow, "id" | "hostPath" | "guestPath">[]): string | undefined {
  const t = row.guestPath.trim();
  const at = t || row.hostPath.trim();
  if (at && inWorkspace(at)) return `Not inside ${WORKSPACE_DIR}: that's the sandbox's own disk.`;
  if (!t) return undefined;
  if (!vmPathShape(t)) return "Use an absolute path or ~/…, not / or ~ alone.";
  if (rows.some((r) => r.id !== row.id && (r.guestPath.trim() || r.hostPath.trim()) === t)) return "Another mount already uses this path.";
  return undefined;
}
