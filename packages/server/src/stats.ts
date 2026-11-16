import type { ChildProcess } from "node:child_process";
import { eachLine, shellQuote } from "@kumiko/sandbox";
import type { SandboxStats, StatsResponse } from "@kumiko/shared";

type Exec = (name: string, cmd: string, env: string[]) => ChildProcess;

/** The CPU counters of /proc/stat's first line: user, nice, system, idle, iowait, irq, softirq, steal. */
type CpuTimes = number[];

/**
 * Prints a reading every `seconds`: the CPU counters, MemTotal and MemAvailable (kB), the root filesystem's used and
 * available space (kB), the load average, and the workspace disk's used and available space (kB, or nothing when
 * nothing is mounted at /workspace), separated by `|`. It ends when the line can't be written, as when
 * Kumiko stops listening.
 */
export const statsScript = (seconds: number): string =>
  [
    "while :; do",
    `printf '%s|%s|%s|%s|%s\\n' "$(awk 'NR==1{print $2,$3,$4,$5,$6,$7,$8,$9; exit}' /proc/stat)"` +
      ` "$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print t,a}' /proc/meminfo)"` +
      ` "$(df -kP / | awk 'NR==2{print $3,$4}')" "$(cut -d' ' -f1 /proc/loadavg)"` +
      ` "$(mountpoint -q /workspace 2>/dev/null && df -kP /workspace | awk 'NR==2{print $3,$4}')" || exit`,
    `sleep ${seconds}`,
    "done",
  ].join("\n");

/** Reads one of `statsScript`'s lines, with the CPU counters of the line before to tell how busy the CPUs were since. */
export function parseStats(line: string, before?: CpuTimes): { stats: SandboxStats; cpu: CpuTimes } | undefined {
  const parts = line.split("|").map((p) => p.trim().split(/\s+/).map(Number));
  // Readings from before the workspace disk have four parts.
  if (parts.length !== 4 && parts.length !== 5) return undefined;
  const [cpu, [memTotal, memAvailable], [diskUsed, diskFree], [load], workspace = []] = parts;
  if (cpu.length !== 8 || [...cpu, memTotal, memAvailable, diskUsed, diskFree, load].some((n) => !Number.isFinite(n))) return undefined;
  const stats: SandboxStats = {
    load,
    memTotalBytes: memTotal * 1024,
    memUsedBytes: Math.max(0, memTotal - memAvailable) * 1024,
    diskUsedBytes: diskUsed * 1024,
    diskFreeBytes: diskFree * 1024,
  };
  const [wsUsed, wsFree] = workspace;
  if (workspace.length === 2 && Number.isFinite(wsUsed) && Number.isFinite(wsFree)) Object.assign(stats, { workspaceUsedBytes: wsUsed * 1024, workspaceFreeBytes: wsFree * 1024 });
  if (before) {
    const sum = (t: CpuTimes) => t.reduce((a, b) => a + b, 0);
    const idle = (t: CpuTimes) => t[3] + t[4];
    const total = sum(cpu) - sum(before);
    if (total > 0) stats.cpuPercent = Math.min(100, Math.max(0, (100 * (total - (idle(cpu) - idle(before)))) / total));
  }
  return { stats, cpu };
}

interface Sampler {
  child: ChildProcess;
  latest?: SandboxStats;
  cpu?: CpuTimes;
  idle: ReturnType<typeof setTimeout>;
}

export interface StatsOptions {
  /** How often each VM takes a reading, in seconds. */
  seconds?: number;
  /** How long a sampler keeps running after it was last asked for. */
  idleMs?: number;
  /** How long to wait before starting a sampler again after one ended by itself (ssh failed, say). */
  retryMs?: number;
}

/**
 * Keeps a reading of each running sandbox that's asked about, from one long-lived exec per VM rather than one per
 * request, as each exec costs an ssh connection. Samplers stop when nobody has asked for a while, or when their VM is
 * no longer running.
 */
export class StatsCache {
  private samplers = new Map<string, Sampler>();
  /** When each sandbox's sampler last ended by itself. */
  private ended = new Map<string, number>();
  private readonly seconds: number;
  private readonly idleMs: number;
  private readonly retryMs: number;

  constructor(private exec: Exec, opts: StatsOptions = {}) {
    this.seconds = opts.seconds ?? 3;
    this.idleMs = opts.idleMs ?? 30_000;
    this.retryMs = opts.retryMs ?? 10_000;
  }

  /** The latest reading of each of `running`, starting samplers where needed and stopping those of VMs not in it. */
  get(running: string[]): StatsResponse {
    for (const name of [...this.samplers.keys()]) if (!running.includes(name)) this.stop(name);
    const out: StatsResponse = {};
    for (const name of running) {
      const s = this.samplers.get(name) ?? this.start(name);
      if (!s) continue;
      s.idle.refresh();
      if (s.latest) out[name] = s.latest;
    }
    return out;
  }

  stop(name: string): void {
    const s = this.samplers.get(name);
    if (!s) return;
    this.samplers.delete(name);
    clearTimeout(s.idle);
    s.child.kill();
  }

  stopAll(): void {
    for (const name of [...this.samplers.keys()]) this.stop(name);
  }

  private start(name: string): Sampler | undefined {
    const ended = this.ended.get(name);
    if (ended !== undefined && Date.now() - ended < this.retryMs) return undefined;
    const child = this.exec(name, `bash -c ${shellQuote(statsScript(this.seconds))}`, []);
    child.stdin!.end();
    child.stderr!.resume();
    const idle = setTimeout(() => this.stop(name), this.idleMs);
    idle.unref();
    const s: Sampler = { child, idle };
    eachLine(child.stdout!, (line) => {
      const read = parseStats(line, s.cpu);
      if (!read) return;
      s.latest = read.stats;
      s.cpu = read.cpu;
    });
    const gone = () => {
      if (this.samplers.get(name) !== s) return;
      this.samplers.delete(name);
      clearTimeout(idle);
      this.ended.set(name, Date.now());
    };
    child.on("error", gone);
    child.on("close", gone);
    this.samplers.set(name, s);
    return s;
  }
}
