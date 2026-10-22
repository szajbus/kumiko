import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_HOME_IN_VM,
  mountsExpression,
  sameMounts,
  vmName,
  VM_PREFIX,
  WORKSPACE_DIR,
  type EditSpec,
  type SandboxInfo,
  type SandboxMeta,
  type SandboxSpec,
  type SandboxStatus,
} from "@kumiko/shared";
import { MetadataError, MetadataStore } from "./metadata.js";
import { eachLine, exitCode, runOk, type RunOptions } from "./proc.js";
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

/** The fields Kumiko reads from `limactl list --format json`. */
interface LimaInstance {
  name: string;
  status: string;
  cpus?: number;
  memory?: number;
  disk?: number;
  sshConfigFile?: string;
  vmType?: string;
  config?: { networkOpts?: { hostLoopback?: boolean | null } };
}

/** The first Lima that can keep a VM off the host's loopback: `networkOpts.hostLoopback`. */
const HOST_LOOPBACK_SINCE = [2, 3, 0];

/** Whether the VM can reach the host's loopback as Lima has it configured now; Lima's default is that it can. */
const reachesLoopback = (inst: LimaInstance) => inst.config?.networkOpts?.hostLoopback !== false;

/** The `--set` expression that lets the VM reach the host's loopback, or keeps it off. */
export const hostLoopbackExpression = (reachable: boolean) => `.networkOpts.hostLoopback = ${reachable}`;

/** A version's numbers from `limactl --version` ("limactl version 2.2.1"), or undefined if there are none. */
export function parseLimaVersion(out: string): number[] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

const atLeast = (v: number[], min: number[]) => {
  for (let i = 0; i < min.length; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
};

/**
 * What the user can do so Lima keeps a VM off the host's loopback, or undefined if it can already: it takes Lima 2.3
 * and a vz VM.
 */
function unblockable(version: number[] | undefined, inst: LimaInstance): string | undefined {
  if (!version) return "Kumiko couldn't tell which Lima is installed. Upgrade it to 2.3 or later (brew upgrade lima), then restart the sandbox.";
  if (!atLeast(version, HOST_LOOPBACK_SINCE)) return `Upgrade Lima to 2.3 or later (brew upgrade lima; this is ${version.join(".")}), then restart the sandbox.`;
  if (inst.vmType !== "vz") return `Lima can only block it in vz VMs, and this one is ${inst.vmType ?? "of an unknown type"}: recreate the sandbox from a template that uses vz.`;
  return undefined;
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

/** A command line as it would be typed, quoting only the arguments that need it. */
function commandLine(cmd: string, args: string[]): string {
  return [cmd, ...args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : shellQuote(a)))].join(" ");
}

/** Adds ~/.local/bin (where Claude Code installs) to PATH unless the shell's startup files already did. */
const LOCAL_BIN_ON_PATH = `case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac`;

/**
 * Points Claude at the project's Claude home, mounted at ~/.claude. Without it Claude writes `.claude.json` beside
 * ~/.claude, on the VM's disk, and the login and settings in it are lost when the VM is recreated.
 */
export const CLAUDE_CONFIG_EXPORT = `export CLAUDE_CONFIG_DIR="$HOME"/${CLAUDE_HOME_IN_VM.slice(2)}`;

/** A path in the VM for bash: quoted, with a leading "~/" left to the shell's $HOME. */
export function shellPath(p: string): string {
  return p.startsWith("~/") ? `"$HOME"/${shellQuote(p.slice(2))}` : shellQuote(p);
}

/**
 * Builds the `bash -s` preamble: ~/.local/bin (where Claude Code installs) on PATH, CLAUDE_CONFIG_DIR, one export
 * per forwarded variable that is set, a `cd` into `cwd` (skipped if it's missing), then `exec <cmd>`.
 */
export function execScript(cmd: string, names: string[], env: NodeJS.ProcessEnv, cwd?: string): string {
  const lines = [LOCAL_BIN_ON_PATH, CLAUDE_CONFIG_EXPORT];
  lines.push(...names.filter((n) => env[n] !== undefined).map((n) => `export ${n}=${shellQuote(env[n]!)}`));
  if (cwd) lines.push(`cd ${shellPath(cwd)} 2>/dev/null || true`);
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
  do tag = `KUMIKO_PROVISION_${randomBytes(6).toString("hex")}`;
  while (script.includes(tag));
  return `bash -c "$(cat <<'${tag}'\n${PROVISION_PRELUDE}${script}\n${tag}\n)"`;
}

/** True when Claude Code is installed for the VM user and linked into /usr/local/bin, on every shell's PATH. */
const CLAUDE_CHECK = `test -x "$HOME/.local/bin/claude" && test "$(readlink /usr/local/bin/claude)" = "$HOME/.local/bin/claude"`;

/**
 * Installs Claude Code with the official native installer (into ~/.local/bin, no Node needed), unless it's
 * there already, and links it into /usr/local/bin so login, non-login and `limactl shell` sessions all find it.
 */
export const CLAUDE_INSTALL = [
  `set -o pipefail`,
  `if ! command -v curl >/dev/null; then sudo apt-get update -qq && sudo apt-get install -y -qq curl; fi`,
  `if [ ! -x "$HOME/.local/bin/claude" ]; then curl -fsSL https://claude.ai/install.sh | bash; fi`,
  `sudo ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude`,
  `claude --version`,
].join("\n");

export class LimaProvider implements SandboxProvider {
  readonly id = "lima" as const;
  readonly metadata: MetadataStore;
  private readonly limactl: string;
  private readonly ssh: string;
  private readonly env: () => NodeJS.ProcessEnv;

  constructor(opts: LimaOptions = {}) {
    this.limactl = opts.limactl ?? process.env.KUMIKO_LIMACTL ?? "limactl";
    this.ssh = opts.ssh ?? process.env.KUMIKO_SSH ?? "ssh";
    this.metadata = opts.metadata ?? new MetadataStore();
    this.env = opts.env ?? (() => process.env);
  }

  private limaHome(): string {
    return process.env.LIMA_HOME || join(homedir(), ".lima");
  }

  /**
   * Runs limactl, failing with its output tail. It runs in the temp directory because `limactl edit` saves a
   * config it rejects as lima.REJECTED.yaml in the current one, which would otherwise be wherever the app started.
   */
  private limactlRun(args: string[], opts: RunOptions = {}) {
    return runOk(this.limactl, args, { lima: true, cwd: tmpdir(), ...opts });
  }

  /** Lima's version, asked again every few minutes, so an upgrade is noticed without restarting Kumiko. */
  private version?: { at: number; numbers: Promise<number[] | undefined> };
  private limaVersion(): Promise<number[] | undefined> {
    if (this.version && Date.now() - this.version.at < 5 * 60_000) return this.version.numbers;
    const numbers = this.limactlRun(["--version"], { captureStdout: true }).then((r) => parseLimaVersion(r.stdout), () => undefined);
    this.version = { at: Date.now(), numbers };
    return numbers;
  }

  /** Why Lima can't keep this VM off the host's loopback, or undefined if it can. */
  private async loopbackUnblockable(inst: LimaInstance): Promise<string | undefined> {
    return unblockable(await this.limaVersion(), inst);
  }


  /**
   * Gives a stopped VM the host loopback access its spec asks for, if Lima doesn't have it so already: off unless the
   * spec allows it. Where Lima can't block it, says so instead.
   */
  private async applyHostLoopback(name: string, spec: SandboxSpec, log: Log): Promise<void> {
    const inst = (await this.instances()).find((i) => i.name === vmName(name));
    if (!inst || toStatus(inst.status) !== "stopped") return;
    const want = spec.hostLoopback === true;
    if (reachesLoopback(inst) === want) return;
    const why = await this.loopbackUnblockable(inst);
    if (why) {
      if (!want) log(`warning: this sandbox can reach services on your Mac's localhost (127.0.0.1). ${why}`);
      return;
    }
    const args = ["edit", "--tty=false", vmName(name), `--set=${hostLoopbackExpression(want)}`];
    log(`$ ${commandLine("limactl", args)}`, "cmd");
    await this.limactlRun(args, { log });
  }

  private async instances(): Promise<LimaInstance[]> {
    const res = await this.limactlRun(["list", "--format", "json"], { captureStdout: true });
    return parseLimaList(res.stdout).filter((i) => i.name.startsWith(VM_PREFIX));
  }

  /**
   * Kumiko's VMs, plus `absent` entries for records whose VM doesn't exist: a create that failed, or a VM deleted
   * outside Kumiko. Those can be recreated from the record.
   */
  async list(): Promise<SandboxInfo[]> {
    const [instances, { metas, errors }, version] = await Promise.all([this.instances(), this.metadata.readAll(), this.limaVersion()]);
    /** Why a VM of Kumiko's reaches the host's loopback though its spec says it shouldn't; a stopped one is set on start. */
    const loopbackOpen = (i: LimaInstance, spec: SandboxSpec | undefined): string | undefined => {
      if (!spec || spec.hostLoopback === true || !reachesLoopback(i)) return undefined;
      const why = unblockable(version, i);
      if (why) return why;
      return toStatus(i.status) === "running" ? "Restart the sandbox to block it." : undefined;
    };
    const absent: SandboxInfo[] = [...metas]
      .filter(([name]) => !instances.some((i) => i.name === vmName(name)))
      .map(([name, meta]) => ({ name, status: "absent", meta }));
    return instances
      .map((i): SandboxInfo => {
        const name = i.name.slice(VM_PREFIX.length);
        const open = loopbackOpen(i, metas.get(name)?.spec);
        return {
          name,
          status: toStatus(i.status),
          cpus: i.cpus,
          memoryGiB: gib(i.memory),
          diskGiB: gib(i.disk),
          meta: metas.get(name),
          ...(errors.has(name) ? { metaError: errors.get(name) } : {}),
          ...(open ? { hostLoopbackOpen: open } : {}),
        };
      })
      .concat(absent)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async templates(): Promise<{ templates: string[]; preferred: string }> {
    const res = await this.limactlRun(["create", "--list-templates"], { captureStdout: true });
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

    log(`$ ${commandLine("limactl", args)}`, "cmd");
    // A failed create keeps the record: it is the spec a recreate builds the VM from.
    await this.limactlRun(args, { log });
    await this.start(spec.name, log);
  }

  /**
   * Starts the VM and makes sure its working directory exists. On the first successful start, runs provisioning
   * (Claude Code, then the user's script); on later ones, reinstalls Claude Code only if it went missing.
   */
  async start(name: string, log: Log): Promise<void> {
    const vm = vmName(name);
    const known = await this.metadata.read(name).catch(() => undefined);
    if (known) await this.applyHostLoopback(name, known.spec, log);
    log(`$ limactl start --tty=false ${vm}`, "cmd");
    await this.limactlRun(["start", "--tty=false", vm], { log });
    // An unreadable record doesn't stop the VM from starting; it is only set up as one Kumiko didn't create.
    const meta = await this.metadata.read(name).catch((err: unknown) => {
      if (!(err instanceof MetadataError)) throw err;
      log(`warning: ${err.message}`);
      return undefined;
    });
    if (meta) await this.prepareShells(name, meta.spec.workdir ?? WORKSPACE_DIR, log);
    if (meta?.setup === "creating") await this.runProvisioning(name, log);
    else if (meta && (await this.ensureClaude(name, log)) !== 0) log("warning: couldn't reinstall Claude Code; it is missing in the sandbox.");
  }

  /** Installs Claude Code if it's missing; silent when it's there. Returns the installer's exit code, 0 when nothing ran. */
  private async ensureClaude(name: string, log: Log): Promise<number> {
    const check = this.exec(name, `bash -c ${shellQuote(CLAUDE_CHECK)}`, []);
    check.stdin!.end();
    check.stdout!.resume();
    check.stderr!.resume();
    if ((await exitCode(check)) === 0) return 0;
    log("— installing Claude Code —", "note");
    return this.runScript(name, CLAUDE_INSTALL, [], log);
  }

  /** Runs a script the way provisioning does (traced, stops at the first failure), streaming it to the log. */
  private async runScript(name: string, script: string, env: string[], log: Log, cwd?: string): Promise<number> {
    const child = this.exec(name, provisionCommand(script), env, { cwd });
    child.stdin!.end();
    eachLine(child.stdout!, (l) => log(l));
    eachLine(child.stderr!, (l) => log(l));
    return exitCode(child);
  }

  /**
   * Prepares the VM's shells on every start, so changes to the working directory reach them. A failure is only a warning.
   * - Creates the working directory if it's missing and hands it to the VM user if they can't write to it
   *   (Lima creates /workspace as root when mounting under it).
   * - Puts ~/.local/bin, where Claude Code installs, on PATH for every shell: ~/.config/kumiko/env.sh is
   *   sourced from the top of ~/.bashrc (before Debian's early return, so `ssh host cmd` gets it too) and from ~/.profile.
   * - Moves interactive shells that land in ~ to the working directory: without --workdir, `limactl shell` tries
   *   the host's current directory and home, which rarely exist in the VM, and falls back to ~. That one is
   *   ~/.config/kumiko/shell.sh, sourced from the end of ~/.bashrc, which only interactive shells reach.
   */
  private async prepareShells(name: string, workdir: string, log: Log): Promise<void> {
    const env = `# Written by Kumiko on every start: ~/.local/bin (Claude Code) on PATH, and Claude's config in the project's Claude home.\n` +
      `${LOCAL_BIN_ON_PATH}\n${CLAUDE_CONFIG_EXPORT}\n`;
    const rc = `# Written by Kumiko on every start: interactive shells that land in ~ move to the working directory.\n` +
      `if [ "$PWD" = "$HOME" ]; then cd ${shellPath(workdir)} 2>/dev/null || true; fi\n`;
    const source = (file: string) => `[ -f ~/.config/kumiko/${file} ] && . ~/.config/kumiko/${file}`;
    const script = [
      `set -e`,
      `d=${shellPath(workdir)}; sudo mkdir -p "$d"; [ -w "$d" ] || sudo chown "$(id -u):$(id -g)" "$d"`,
      `mkdir -p ~/.config/kumiko`,
      `cat > ~/.config/kumiko/env.sh <<'KUMIKO_RC'\n${env}KUMIKO_RC`,
      `cat > ~/.config/kumiko/shell.sh <<'KUMIKO_RC'\n${rc}KUMIKO_RC`,
      `touch ~/.bashrc ~/.profile`,
      `if ! grep -qF .config/kumiko/env.sh ~/.bashrc; then { printf '# Added by Kumiko\\n%s\\n\\n' ${shellQuote(source("env.sh"))}; cat ~/.bashrc; } > ~/.bashrc.kumiko && mv ~/.bashrc.kumiko ~/.bashrc; fi`,
      `grep -qF .config/kumiko/shell.sh ~/.bashrc || printf '\\n# Added by Kumiko\\n%s\\n' ${shellQuote(source("shell.sh"))} >> ~/.bashrc`,
      `grep -qF .config/kumiko/env.sh ~/.profile || printf '\\n# Added by Kumiko\\n%s\\n' ${shellQuote(source("env.sh"))} >> ~/.profile`,
    ].join("\n");
    const child = this.exec(name, `bash -c ${shellQuote(script)}`, []);
    child.stdin!.end();
    const out: string[] = [];
    eachLine(child.stdout!, (l) => out.push(l));
    eachLine(child.stderr!, (l) => out.push(l));
    const code = await exitCode(child);
    if (code === 0) return;
    for (const l of out) log(l);
    log(`warning: couldn't prepare the working directory ${workdir} or the shell setup (exit ${code}).`);
  }

  async stop(name: string, log: Log): Promise<void> {
    const vm = vmName(name);
    log(`$ limactl stop ${vm}`, "cmd");
    await this.limactlRun(["stop", vm], { log });
    log("Stopped.", "ok");
  }

  /** Deletes the VM and Kumiko's record of it. A VM that is already gone only has its record removed. */
  async delete(name: string, log: Log): Promise<void> {
    const vm = vmName(name);
    if (!(await this.instances()).some((i) => i.name === vm)) {
      await this.metadata.remove(name);
      log(`${vm} doesn't exist; nothing to delete.`, "note");
      return;
    }
    log(`$ limactl delete --force ${vm}`, "cmd");
    await this.limactlRun(["delete", "--force", vm], { log });
    await this.metadata.remove(name);
    log("Deleted.", "ok");
  }

  async validateEdit(name: string, patch: EditSpec, opts: { recreate?: boolean; restart?: boolean } = {}): Promise<Validation> {
    const { errors, warnings, spec } = await this.planEdit(name, patch, opts);
    return { errors, warnings, spec };
  }

  async edit(name: string, patch: EditSpec, log: Log): Promise<void> {
    const plan = await this.planEdit(name, patch);
    if (plan.errors.length) throw new ProviderError(plan.errors.join("\n"));
    for (const w of plan.warnings) log(`warning: ${w}`);
    const vm = vmName(name);
    if (plan.limaArgs.length) {
      const args = ["edit", "--tty=false", vm, ...plan.limaArgs];
      log(`$ ${commandLine("limactl", args)}`, "cmd");
      await this.limactlRun(args, { log });
    }
    await this.metadata.update(name, { spec: plan.spec });
    if (plan.prepareShells) await this.prepareShells(name, plan.spec.workdir ?? WORKSPACE_DIR, log);
    log(plan.limaArgs.length ? "Saved. Resource and mount changes apply on the next start." : "Saved.", "ok");
  }

  /** Works out what an edit changes and which `limactl edit` flags that needs. */
  private async planEdit(
    name: string,
    patch: EditSpec,
    { recreate = false, restart = false }: { recreate?: boolean; restart?: boolean } = {},
  ): Promise<Validation & { limaArgs: string[]; prepareShells?: boolean }> {
    const vm = vmName(name);
    let meta: SandboxMeta | undefined;
    try {
      meta = await this.metadata.read(name);
    } catch (err) {
      if (!(err instanceof MetadataError)) throw err;
      return { errors: [err.message], warnings: [], spec: {} as SandboxSpec, limaArgs: [] };
    }
    const inst = (await this.instances()).find((i) => i.name === vm);
    if (!meta || !inst) {
      const why = !inst ? `${vm} does not exist.` : `${vm} was not created by Kumiko, so it can't be edited.`;
      return { errors: [why], warnings: [], spec: meta?.spec ?? ({} as SandboxSpec), limaArgs: [] };
    }

    // Only these fields can change; an empty provision string clears the script.
    const { cpus, memoryGiB, diskGiB, mounts, env, provision, workdir, hostLoopback } = patch;
    const defined = Object.fromEntries(Object.entries({ cpus, memoryGiB, diskGiB, mounts, env, provision, workdir, hostLoopback }).filter(([, v]) => v !== undefined));
    const merged: SandboxSpec = { ...meta.spec, ...defined, name: meta.spec.name, template: meta.spec.template };
    const v = await validateSpec(merged, this.env());
    const { spec } = v;
    const errors = [...v.errors];
    if (recreate) return { errors, warnings: v.warnings, spec, limaArgs: [] };

    // Compare against what Lima has now, so edits made outside Kumiko are respected.
    const limaArgs: string[] = [];
    if (spec.cpus !== (inst.cpus ?? meta.spec.cpus)) limaArgs.push(`--cpus=${spec.cpus}`);
    if (spec.memoryGiB * GiB !== (inst.memory ?? meta.spec.memoryGiB * GiB)) limaArgs.push(`--memory=${spec.memoryGiB}`);
    const diskNow = inst.disk ?? meta.spec.diskGiB * GiB;
    if (spec.diskGiB * GiB < diskNow) errors.push(`Disk can only grow; it is ${gib(diskNow)} GiB now.`);
    else if (spec.diskGiB * GiB > diskNow) limaArgs.push(`--disk=${spec.diskGiB}`);
    const sets: string[] = [];
    if (!sameMounts(spec.mounts, meta.spec.mounts)) {
      if (spec.mounts.length) sets.push(mountsExpression(spec.mounts));
      else limaArgs.push("--mount-none");
    }
    const wantLoopback = spec.hostLoopback === true;
    if (wantLoopback !== reachesLoopback(inst)) {
      const why = await this.loopbackUnblockable(inst);
      if (!why) sets.push(hostLoopbackExpression(wantLoopback));
      else if (!wantLoopback) v.warnings.push(`This sandbox can reach services on your Mac's localhost (127.0.0.1). ${why}`);
    }
    if (sets.length) limaArgs.push(`--set=${sets.join(" | ")}`);

    if (limaArgs.length && !restart && toStatus(inst.status) !== "stopped") {
      errors.push(`Stop ${vm} to change its resources, mounts or access to your Mac's localhost, or save and restart it. Variables and the provisioning script can change while it runs.`);
    }
    // A stopped VM gets its new working directory on the next start; a running one right after saving.
    const prepareShells = spec.workdir !== (meta.spec.workdir ?? WORKSPACE_DIR) && toStatus(inst.status) === "running";
    return { errors, warnings: v.warnings, spec, limaArgs, prepareShells };
  }

  private async runProvisioning(name: string, log: Log): Promise<void> {
    const meta = await this.metadata.read(name);
    if (!meta) return;
    const fail = async (what: string, code: number) => {
      await this.metadata.update(name, { setup: "provision_failed", provisionExitCode: code });
      log(`${what} failed with exit code ${code}.`, "err");
      log("The sandbox is kept: inspect it, fix the script and recreate it, or delete it.", "note");
      throw new ProviderError(`${what} failed with exit code ${code}.`, code);
    };

    const claude = await this.ensureClaude(name, log);
    if (claude !== 0) return fail("Installing Claude Code", claude);

    const script = meta.spec.provision;
    if (!script) {
      await this.metadata.update(name, { setup: "ready", provisionExitCode: undefined });
      log("Ready. No provisioning script.", "ok");
      return;
    }
    const forwarded = meta.spec.env.filter((n) => this.env()[n] !== undefined);
    log("— provisioning (runs once, as the sandbox user) —", "note");
    if (forwarded.length) log(`forwarding ${forwarded.join(", ")}`, "note");

    const code = await this.runScript(name, script, meta.spec.env, log, meta.spec.workdir ?? WORKSPACE_DIR);
    if (code === 0) {
      await this.metadata.update(name, { setup: "ready", provisionExitCode: undefined });
      log("Provisioning finished.", "ok");
      return;
    }
    return fail("Provisioning", code);
  }

  /**
   * Runs `cmd` in the VM over SSH. Forwarded variables are written to the remote `bash -s` as exports,
   * so their values never appear in process arguments, and are read fresh on every call.
   * Everything written to stdin after the preamble reaches `cmd`.
   */
  exec(name: string, cmd: string, env: string[], opts: { cwd?: string } = {}): ChildProcess {
    const vm = vmName(name);
    const sshConfig = join(this.limaHome(), vm, "ssh.config");
    const child = spawn(this.ssh, ["-F", sshConfig, "-T", `lima-${vm}`, "bash", "-s"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Writing to a process that has gone (the VM stopped, ssh couldn't connect) fails with EPIPE, and an unhandled
    // stream error would take the whole server down. The exit code already says what happened.
    child.stdin!.on("error", () => {});
    child.stdin!.write(execScript(cmd, env, this.env(), opts.cwd));
    return child;
  }
}
