import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import { ENV_NAME_PATTERN, NAME_PATTERN, type SandboxSpec } from "@bentomo/shared";

export interface Validation {
  errors: string[];
  warnings: string[];
  /** The spec with mount paths expanded and normalized. */
  spec: SandboxSpec;
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const base = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(base);
}

/**
 * Checks everything that can be checked without asking the provider.
 * `env` is where forwarded variables will be read from (Bentomo's own environment).
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
  const cpus = num(input.cpus, "CPUs", 1);
  if (Number.isFinite(cpus) && !Number.isInteger(cpus)) errors.push("CPUs must be a whole number.");
  const memoryGiB = num(input.memoryGiB, "Memory", 1);
  const diskGiB = num(input.diskGiB, "Disk", 10);

  const mounts = (Array.isArray(input.mounts) ? input.mounts : []).map((m) => ({
    hostPath: normalize(expandHome(String(m?.hostPath ?? "").trim())).replace(/(.)\/+$/, "$1"),
    writable: Boolean(m?.writable),
  }));
  for (const m of mounts) {
    if (!m.hostPath || m.hostPath === ".") {
      errors.push("A mount has no folder selected.");
      continue;
    }
    if (!isAbsolute(m.hostPath)) {
      errors.push(`Mount ${m.hostPath} must be an absolute path.`);
      continue;
    }
    if (m.hostPath.includes(",")) {
      // limactl splits --mount-only values on commas.
      errors.push(`Mount ${m.hostPath} contains a comma, which limactl cannot accept.`);
      continue;
    }
    try {
      const st = await stat(m.hostPath);
      if (!st.isDirectory()) errors.push(`Mount ${m.hostPath} is not a folder.`);
    } catch {
      errors.push(`Mount ${m.hostPath} does not exist on the host.`);
    }
  }
  for (let i = 0; i < mounts.length; i++) {
    for (let j = i + 1; j < mounts.length; j++) {
      const a = mounts[i].hostPath, b = mounts[j].hostPath;
      if (a && b && (isWithin(a, b) || isWithin(b, a))) errors.push(`Mounts ${a} and ${b} overlap.`);
    }
  }

  const envNames = [...new Set((Array.isArray(input.env) ? input.env : []).map((e) => String(e).trim()).filter(Boolean))];
  for (const e of envNames) {
    if (!ENV_NAME_PATTERN.test(e)) errors.push(`${e} is not a valid variable name.`);
    else if (env[e] === undefined) warnings.push(`${e} is not set in Bentomo's environment; it will be skipped.`);
  }

  const template = input.template?.trim() || undefined;
  const provision = input.provision?.trim() ? input.provision.replace(/\r\n/g, "\n") : undefined;

  return {
    errors,
    warnings,
    spec: { name, template, cpus, memoryGiB, diskGiB, mounts, env: envNames, provision },
  };
}
