import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mountsExpression,
  vmName,
  VM_PREFIX,
  type EditSpec,
  type Mount,
  type SandboxInfo,
  type SandboxSpec,
  type SandboxStatus,
} from "@bentomo/shared";
import { MetadataStore } from "./metadata.js";
import { eachLine, exitCode, run, runOk } from "./proc.js";
import { ProviderError, type Log, type SandboxProvider } from "./provider.js";
import { validateSpec, type Validation } from "./validate.js";

const GiB = 1024 ** 3;

export interface LimaOptions {
  /** Path to limactl; defaults to the one on PATH. */
  limactl?: string;
  /** Path to ssh; defaults to the one on PATH. */
  ssh?: string;
  metadata?: MetadataStore;
  /** Where forwarded variables are read from, on every exec. Defaults to process.env. */
  env?: () => NodeJS.ProcessEnv;
}

/** The fields Bentomo reads from `limactl list --format json`. */
interface LimaInstance {
  name: string;
  status: string;
  cpus?: number;
  memory?: number;
  disk?: number;
  sshConfigFile?: string;
}

export function parseLimaList(stdout: string): LimaInstance[] {
  const text = stdout.trim();
  if (!text) return [];
  // Lima prints one JSON object per line; accept a JSON array too.
  if (text.startsWith("[")) return JSON.parse(text) as LimaInstance[];
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LimaInstance);
}

function toStatus(s: string): SandboxStatus {
  switch (s.toLowerCase()) {
    case "running": return "running";
    case "stopped": return "stopped";
    case "broken": return "broken";
    default: return "unknown";
  }
}

const gib = (bytes?: number) => (bytes ? Math.round((bytes / GiB) * 10) / 10 : undefined);

/** Single-quotes a value for bash. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Builds the `bash -s` preamble: one export per forwarded variable that is set, then `exec <cmd>`. */
export function execScript(cmd: string, names: string[], env: NodeJS.ProcessEnv): string {
  const lines = names.filter((n) => env[n] !== undefined).map((n) => `export ${n}=${shellQuote(env[n]!)}`);
  lines.push(`exec ${cmd}`);
  return lines.join("\n") + "\n";
}

/**
 * Stops at the first failing command and echoes each command before running it. Unlike `set -x`, the
 * DEBUG trap prints the command as written, so `$GITHUB_TOKEN` shows up as its name, not its value.
 * stderr joins stdout so the log keeps the order things happened in.
 */
const PROVISION_PRELUDE = `exec 2>&1\nset -e\ntrap 'printf "+ %s\\n" "$BASH_COMMAND" >&2' DEBUG\n`;

/**
 * The command that runs a provisioning script. The script is handed to `bash -c` through a quoted heredoc,
 * so commands inside it that read stdin (apt, curl | sh, ssh) can't swallow the rest of the script.
 */
export function provisionCommand(script: string): string {
  let tag: string;
  do tag = `BENTOMO_PROVISION_${randomBytes(6).toString("hex")}`;
  while (script.includes(tag));
  return `bash -c "$(cat <<'${tag}'\n${PROVISION_PRELUDE}${script}\n${tag}\n)"`;
}

export class LimaProvider implements SandboxProvider {
  readonly id = "lima" as const;
  readonly metadata: MetadataStore;
  private readonly limactl: string;
  private readonly ssh: string;
  private readonly env: () => NodeJS.ProcessEnv;

  constructor(opts: LimaOptions = {}) {
    this.limactl = opts.limactl ?? process.env.BENTOMO_LIMACTL ?? "limactl";
    this.ssh = opts.ssh ?? process.env.BENTOMO_SSH ?? "ssh";
    this.metadata = opts.metadata ?? new MetadataStore();
    this.env = opts.env ?? (() => process.env);
  }

  private limaHome(): string {
    return process.env.LIMA_HOME || join(homedir(), ".lima");
  }

  private async instances(): Promise<LimaInstance[]> {
    const res = await runOk(this.limactl, ["list", "--format", "json"], { captureStdout: true, lima: true });
    return parseLimaList(res.stdout).filter((i) => i.name.startsWith(VM_PREFIX));
  }

  async list(): Promise<SandboxInfo[]> {
    const [instances, metas] = await Promise.all([this.instances(), this.metadata.readAll()]);
    return instances
      .map((i) => {
        const name = i.name.slice(VM_PREFIX.length);
        return {
          name,
          status: toStatus(i.status),
          cpus: i.cpus,
          memoryGiB: gib(i.memory),
          diskGiB: gib(i.disk),
          meta: metas.get(name),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async templates(): Promise<{ templates: string[]; preferred: string }> {
    const res = await runOk(this.limactl, ["create", "--list-templates"], { captureStdout: true, lima: true });
    const templates = res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((t) => `template:${t}`);
    const preferred =
      ["template:debian-12", "template:debian"].find((t) => templates.includes(t)) ??
      templates.find((t) => t.startsWith("template:debian")) ??
      "template:default";
    return { templates, preferred };
  }

  /** Validates a spec, including that the VM name is free. */
  async validate(input: SandboxSpec): Promise<Validation> {
    const v = await validateSpec(input, this.env());
    if (v.errors.length === 0) {
      const taken = (await this.instances()).some((i) => i.name === vmName(v.spec.name));
      if (taken) v.errors.push(`${vmName(v.spec.name)} already exists.`);
    }
    return v;
  }

  async create(input: SandboxSpec, log: Log): Promise<void> {
    const v = await this.validate(input);
    if (v.errors.length) throw new ProviderError(v.errors.join("\n"));
    for (const w of v.warnings) log(`warning: ${w}`);
    const spec = v.spec;
    const vm = vmName(spec.name);

    await this.metadata.write(spec.name, {
      spec,
      provider: "lima",
      createdAt: new Date().toISOString(),
      setup: "creating",
    });

    const args = [
      "create",
      "--tty=false",
      `--name=${vm}`,
      `--cpus=${spec.cpus}`,
      `--memory=${spec.memoryGiB}`,
      `--disk=${spec.diskGiB}`,
    ];
    if (spec.mounts.length === 0) args.push("--mount-none");
    else args.push(`--set=${mountsExpression(spec.mounts)}`);
    args.push(spec.template || "template:default");

    log(`$ limactl ${args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : shellQuote(a))).join(" ")}`, "cmd");
    try {
      await runOk(this.limactl, args, { log, lima: true });
    } catch (err) {
      // Nothing was created, so there is nothing to keep metadata for.
      if (!(await this.instances()).some((i) => i.name === vm)) await this.metadata.remove(spec.name);
      throw err;
    }
    await this.start(spec.name, log);
  }

  /** Starts the VM; on the first successful start of a sandbox still being set up, runs provisioning. */
  async start(name: string, log: Log): Promise<void> {
    const vm = vmName(name);
    log(`$ limactl start --tty=false ${vm}`, "cmd");
    await runOk(this.limactl, ["start", "--tty=false", vm], { log, lima: true });
    const meta = await this.metadata.read(name);
    if (meta?.setup === "creating") await this.runProvisioning(name, log);
  }

  async stop(name: string, log: Log): Promise<void> {
    const vm = vmName(name);
    log(`$ limactl stop ${vm}`, "cmd");
    await runOk(this.limactl, ["stop", vm], { log, lima: true });
    log("Stopped.", "ok");
  }

  async delete(name: string, log: Log): Promise<void> {
    const vm = vmName(name);
    log(`$ limactl delete --force ${vm}`, "cmd");
    await runOk(this.limactl, ["delete", "--force", vm], { log, lima: true });
    await this.metadata.remove(name);
    log("Deleted.", "ok");
  }

  async validateEdit(name: string, patch: EditSpec, opts: { recreate?: boolean } = {}): Promise<Validation> {
    const { errors, warnings, spec } = await this.planEdit(name, patch, opts.recreate);
    return { errors, warnings, spec };
  }

  async edit(name: string, patch: EditSpec, log: Log): Promise<void> {
    const plan = await this.planEdit(name, patch);
    if (plan.errors.length) throw new ProviderError(plan.errors.join("\n"));
    for (const w of plan.warnings) log(`warning: ${w}`);
    const vm = vmName(name);
    if (plan.limaArgs.length) {
      const args = ["edit", "--tty=false", vm, ...plan.limaArgs];
      log(`$ limactl ${args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : shellQuote(a))).join(" ")}`, "cmd");
      await runOk(this.limactl, args, { log, lima: true });
    }
    await this.metadata.update(name, { spec: plan.spec });
    log(plan.limaArgs.length ? "Saved. Resource and mount changes apply on the next start." : "Saved.", "ok");
  }

  /** Works out what an edit changes and which `limactl edit` flags that needs. */
  private async planEdit(name: string, patch: EditSpec, recreate = false): Promise<Validation & { limaArgs: string[] }> {
    const vm = vmName(name);
    const meta = await this.metadata.read(name);
    const inst = (await this.instances()).find((i) => i.name === vm);
    if (!meta || !inst) {
      const why = !inst ? `${vm} does not exist.` : `${vm} was not created by Bentomo, so it can't be edited.`;
      return { errors: [why], warnings: [], spec: meta?.spec ?? ({} as SandboxSpec), limaArgs: [] };
    }

    // Only these fields can change; an empty provision string clears the script.
    const { cpus, memoryGiB, diskGiB, mounts, env, provision } = patch;
    const defined = Object.fromEntries(Object.entries({ cpus, memoryGiB, diskGiB, mounts, env, provision }).filter(([, v]) => v !== undefined));
    const merged: SandboxSpec = { ...meta.spec, ...defined, name: meta.spec.name, template: meta.spec.template };
    const v = await validateSpec(merged, this.env());
    const { spec } = v;
    const errors = [...v.errors];
    if (recreate) return { errors, warnings: v.warnings, spec, limaArgs: [] };

    // Compare against what Lima has now, so edits made outside Bentomo are respected.
    const limaArgs: string[] = [];
    if (spec.cpus !== (inst.cpus ?? meta.spec.cpus)) limaArgs.push(`--cpus=${spec.cpus}`);
    if (spec.memoryGiB * GiB !== (inst.memory ?? meta.spec.memoryGiB * GiB)) limaArgs.push(`--memory=${spec.memoryGiB}`);
    const diskNow = inst.disk ?? meta.spec.diskGiB * GiB;
    if (spec.diskGiB * GiB < diskNow) errors.push(`Disk can only grow; it is ${gib(diskNow)} GiB now.`);
    else if (spec.diskGiB * GiB > diskNow) limaArgs.push(`--disk=${spec.diskGiB}`);
    const key = (ms: Mount[]) => JSON.stringify(ms.map((m) => [m.hostPath, m.guestPath ?? m.hostPath, m.writable]));
    if (key(spec.mounts) !== key(meta.spec.mounts)) limaArgs.push(spec.mounts.length ? `--set=${mountsExpression(spec.mounts)}` : "--mount-none");

    if (limaArgs.length && toStatus(inst.status) !== "stopped") {
      errors.push(`Stop ${vm} to change its resources or mounts. Variables and the provisioning script can change while it runs.`);
    }
    return { errors, warnings: v.warnings, spec, limaArgs };
  }

  private async runProvisioning(name: string, log: Log): Promise<void> {
    const meta = await this.metadata.read(name);
    if (!meta) return;
    const script = meta.spec.provision;
    if (!script) {
      await this.metadata.update(name, { setup: "ready", provisionExitCode: undefined });
      log("READY. No provisioning command.", "ok");
      return;
    }
    const forwarded = meta.spec.env.filter((n) => this.env()[n] !== undefined);
    log("— provisioning (runs once, as the VM user) —", "note");
    if (forwarded.length) log(`forwarding ${forwarded.join(", ")}`, "note");

    const child = this.exec(name, provisionCommand(script), meta.spec.env);
    child.stdin!.end();
    eachLine(child.stdout!, (l) => log(l));
    eachLine(child.stderr!, (l) => log(l));
    const code = await exitCode(child);

    if (code === 0) {
      await this.metadata.update(name, { setup: "ready", provisionExitCode: undefined });
      log("Provisioning finished.", "ok");
      return;
    }
    await this.metadata.update(name, { setup: "provision_failed", provisionExitCode: code });
    log(`Provisioning failed with exit code ${code}.`, "err");
    log("The sandbox is kept: inspect it, fix the script and recreate it, or delete it.", "note");
    throw new ProviderError(`Provisioning failed with exit code ${code}.`, code);
  }

  /**
   * Runs `cmd` in the VM over SSH. Forwarded variables are written to the remote `bash -s` as exports,
   * so their values never appear in process arguments, and are read fresh on every call.
   * Everything written to stdin after the preamble reaches `cmd`.
   */
  exec(name: string, cmd: string, env: string[]): ChildProcess {
    const vm = vmName(name);
    const sshConfig = join(this.limaHome(), vm, "ssh.config");
    const child = spawn(this.ssh, ["-F", sshConfig, "-T", `lima-${vm}`, "bash", "-s"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin!.write(execScript(cmd, env, this.env()));
    return child;
  }
}
