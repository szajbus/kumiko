import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, posix, sep } from "node:path";
import { ENV_NAME_PATTERN, MINIMUMS, NAME_PATTERN, WORKSPACE_DIR, type SandboxSpec, type ValidSpec } from "@kumiko/shared";

export interface Validation {
  errors: string[];
  warnings: string[];
  /** The spec with mount paths expanded and normalized. */
  spec: ValidSpec;
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function isWithin(child: string, parent: string, separator = sep): boolean {
  if (child === parent) return true;
  const base = parent.endsWith(separator) ? parent : parent + separator;
  return child.startsWith(base);
}

/** Normalizes a path inside the VM: absolute, or "~/…" for the VM user's home. Undefined if it is neither. */
export function normalizeGuestPath(p: string): string | undefined {
  const t = p.trim();
  if (t.startsWith("~/")) {
    const rest = posix.normalize(t.slice(2)).replace(/\/+$/, "");
    return rest && rest !== "." && !rest.startsWith("..") ? `~/${rest}` : undefined;
  }
  if (!t.startsWith("/")) return undefined;
  const n = posix.normalize(t).replace(/(.)\/+$/, "$1");
  return n === "/" ? undefined : n;
}

/**
 * Checks everything that can be checked without asking the provider.
 * `env` is where forwarded variables will be read from (Kumiko's own environment).
 */
export async function validateSpec(input: SandboxSpec, env: NodeJS.ProcessEnv = process.env): Promise<Validation> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const name = String(input.name ?? "").trim();
  if (!NAME_PATTERN.test(name)) {
    errors.push("Name must be 1–30 lowercase letters, digits or dashes, not starting or ending with a dash.");
  }

  const num = (v: unknown, label: string, min: number) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) errors.push(`${label} must be a number of at least ${min}.`);
    return n;
  };
  const cpus = num(input.cpus, "CPUs", MINIMUMS.cpus);
  if (Number.isFinite(cpus) && !Number.isInteger(cpus)) errors.push("CPUs must be a whole number.");
  const memoryGiB = num(input.memoryGiB, "Memory", MINIMUMS.memoryGiB);
  const diskGiB = num(input.diskGiB, "Disk", MINIMUMS.diskGiB);
  const hasWorkspace = input.workspaceGiB !== undefined && input.workspaceGiB !== null;
  const workspaceGiB = hasWorkspace ? num(input.workspaceGiB, "Workspace disk", MINIMUMS.workspaceGiB) : undefined;
  if (workspaceGiB !== undefined && Number.isFinite(workspaceGiB) && !Number.isInteger(workspaceGiB)) errors.push("Workspace disk must be a whole number of GiB.");

  const mounts = (Array.isArray(input.mounts) ? input.mounts : []).map((m): { hostPath: string; writable: boolean; guestPath: string; alias?: string } => {
    const hostPath = normalize(expandHome(String(m?.hostPath ?? "").trim())).replace(/(.)\/+$/, "$1");
    const rawGuest = String(m?.guestPath ?? "").trim();
    const alias = typeof m?.alias === "string" && m.alias.trim() ? m.alias.trim() : undefined;
    return { hostPath, writable: Boolean(m?.writable), guestPath: rawGuest || hostPath, ...(alias ? { alias } : {}) };
  });
  for (const m of mounts) {
    if (!m.hostPath || m.hostPath === ".") {
      errors.push("An extra mount has no folder. Pick one, or remove the row.");
      continue;
    }
    if (!isAbsolute(m.hostPath)) {
      errors.push(`Mount ${m.hostPath} must be an absolute path.`);
      continue;
    }
    try {
      const st = await stat(m.hostPath);
      if (!st.isDirectory()) errors.push(`Mount ${m.hostPath} is not a folder.`);
    } catch {
      errors.push(`Mount ${m.hostPath} does not exist on the host.`);
    }
  }
  for (const m of mounts) {
    if (m.guestPath === m.hostPath && !isAbsolute(m.hostPath)) continue; // already reported above
    const g = normalizeGuestPath(m.guestPath);
    if (!g) errors.push(`${m.guestPath} can't be a path in the sandbox: use an absolute path or ~/…, not / or ~.`);
    else if (g.includes("{{")) errors.push(`${m.guestPath} can't contain "{{".`);
    else m.guestPath = g;
  }
  // Two mounts can share a host folder, but not a place in the VM.
  for (let i = 0; i < mounts.length; i++) {
    for (let j = i + 1; j < mounts.length; j++) {
      const a = mounts[i].guestPath, b = mounts[j].guestPath;
      if (isWithin(a, b, "/") || isWithin(b, a, "/")) errors.push(`Mounts at ${a} and ${b} overlap in the sandbox.`);
    }
  }
  // A mount's alias is a link Kumiko makes in the VM: not in a mount, which would put it in a folder on the host.
  for (const m of mounts) {
    if (m.alias === undefined) continue;
    const g = normalizeGuestPath(m.alias);
    if (!g || g.includes("{{")) {
      errors.push(`${m.alias} can't be a path in the sandbox: use an absolute path or ~/…, not / or ~.`);
      continue;
    }
    m.alias = g;
    for (const o of mounts) {
      if (isWithin(g, o.guestPath, "/") || isWithin(o.guestPath, g, "/")) errors.push(`The link at ${g} and the mount at ${o.guestPath} overlap in the sandbox.`);
    }
  }

  // The workspace disk is mounted at /workspace: a folder from the host can't be there too, nor inside it.
  if (hasWorkspace) {
    for (const m of mounts) {
      if (isWithin(m.guestPath, WORKSPACE_DIR, "/")) errors.push(`${m.guestPath} can't be a mount: ${WORKSPACE_DIR} is the sandbox's workspace disk.`);
    }
  }

  const envNames = [...new Set((Array.isArray(input.env) ? input.env : []).map((e) => String(e).trim()).filter(Boolean))];
  for (const e of envNames) {
    if (!ENV_NAME_PATTERN.test(e)) errors.push(`${e} is not a valid variable name.`);
    else if (env[e] === undefined) warnings.push(`${e} is not set in Kumiko's environment; it will be skipped.`);
  }

  const rawWorkdir = String(input.workdir ?? "").trim() || WORKSPACE_DIR;
  const workdir = normalizeGuestPath(rawWorkdir);
  if (!workdir) errors.push(`${rawWorkdir} can't be the working directory: use an absolute path or ~/…, not / or ~.`);

  const template = input.template?.trim() || undefined;
  // It goes to limactl as an argument of its own, where one starting with "-" would be taken for an option.
  if (template && (template.startsWith("-") || /[\0\r\n]/.test(template))) errors.push(`${template} isn't a template: name one like template:debian-12, a file or a URL.`);
  const provision = input.provision?.trim() ? input.provision.replace(/\r\n/g, "\n") : undefined;

  return {
    errors,
    warnings,
    spec: { name, template, cpus, memoryGiB, diskGiB, ...(workspaceGiB !== undefined ? { workspaceGiB } : {}), mounts, env: envNames, provision, workdir: workdir ?? rawWorkdir, ...(input.hostLoopback === true ? { hostLoopback: true } : {}) },
  };
}
