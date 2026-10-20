import { shellQuote } from "@kumiko/sandbox";
import type { Exec } from "./driver.js";

/**
 * Runs: an agent process detached from the SSH connection that started it, so it outlives the server. Each one has a
 * directory in the sandbox, on the sandbox's own disk (FIFOs don't cross virtiofs):
 * - `in`: a FIFO, the agent's stdin. A holder (`hold.pid`) keeps a writer on it, so the agent doesn't read EOF when
 *   an attachment goes away.
 * - `out`, `err`: the agent's stdout, appended to, and stderr. When the agent exits, a wrapper writes its code to
 *   `exit` and appends `{"type":"kumiko_exit","code":<n>}` to `out`, so whoever follows `out` learns of it in order.
 * - `pid`: the agent's; `boot`: the kernel's boot id when it started, since a pid means nothing after a reboot.
 * - `attach.pid`: the attachment that writes to `in` now. A new one replaces it: lines longer than PIPE_BUF aren't
 *   atomic in a FIFO, so only one may write at a time.
 * Runs are generic: any agent that speaks lines on stdin and stdout can run in one.
 */
export const RUNS_DIR = ".kumiko/runs";

/** A run's id; checked before it goes into a shell command. */
export const RUN_ID = /^[0-9a-z][0-9a-z-]{0,63}$/;

/** The line that ends a run's `out`, written once the agent has exited. Agents never send this type. */
export const RUN_EXIT_TYPE = "kumiko_exit";

/** An attachment's exit codes: the run doesn't exist, or its agent is gone without a trace (the VM restarted). */
export const RUN_GONE = 75;
export const RUN_LOST = 76;
/** The launcher's: it couldn't make the run's directory, or the agent didn't start. */
export const RUN_FAILED = 70;
/** What an attachment says on stderr once it is attached, so a launch that got this far is known to have started. */
export const ATTACHED = "kumiko: attached";

/**
 * One script for the three ways in, by its first argument, `bash -c <script> kumiko-run <mode> <run> <offset> [command]`:
 * - `launch`: makes the run, starts `command` in it in a session of its own (setsid, or perl's where there is none:
 *   macOS, in tests), waits for its pid, then attaches from the start.
 * - `run`: what `launch` starts detached: the holder, the agent, and the wrapper that records its exit.
 * - `attach`: replaces the run's attachment, then copies stdin to `in` and follows `out` from byte `offset`. EOF on
 *   stdin (the server detaching, or its connection dropping) ends it. SIGUSR1 closes `in` but keeps following `out`,
 *   for a stop that wants to see the agent's last words. SIGTERM ends it.
 * The detached copy re-runs this same script, from $BASH_EXECUTION_STRING.
 */
const RUN_SCRIPT = String.raw`
r="$HOME/${RUNS_DIR}/$2"
case "$1" in
run)
  sleep 2147483647 > "$r/in" & echo $! > "$r/hold.pid"
  bash -c "exec $4" < "$r/in" >> "$r/out" 2>> "$r/err" & p=$!
  echo $p > "$r/pid.new" && mv "$r/pid.new" "$r/pid"
  wait $p; c=$?
  kill "$(cat "$r/hold.pid")" 2>/dev/null
  echo $c > "$r/exit"
  printf '{"type":"${RUN_EXIT_TYPE}","code":%d}\n' $c >> "$r/out"
  exit 0 ;;
launch)
  mkdir -p "$r" && mkfifo "$r/in" && : > "$r/out" && : > "$r/err" || { echo "kumiko: couldn't make the run $r" >&2; exit ${RUN_FAILED}; }
  cat /proc/sys/kernel/random/boot_id > "$r/boot" 2>/dev/null
  if command -v setsid >/dev/null 2>&1; then
    setsid bash -c "$BASH_EXECUTION_STRING" kumiko-run run "$2" 0 "$4" < /dev/null > /dev/null 2>&1 &
  else
    perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' bash -c "$BASH_EXECUTION_STRING" kumiko-run run "$2" 0 "$4" < /dev/null > /dev/null 2>&1 &
  fi
  n=0
  until [ -s "$r/pid" ]; do
    n=$((n + 1)); [ $n -gt 500 ] && { echo "kumiko: the agent didn't start" >&2; exit ${RUN_FAILED}; }
    sleep 0.02
  done ;;
esac
[ -d "$r" ] || { echo "kumiko: there is no run $2" >&2; exit ${RUN_GONE}; }
if [ ! -f "$r/exit" ] && ! kill -0 "$(cat "$r/pid" 2>/dev/null)" 2>/dev/null; then
  sleep 0.3
  [ -f "$r/exit" ] || { echo "kumiko: the agent of run $2 is gone" >&2; exit ${RUN_LOST}; }
fi
old=$(cat "$r/attach.pid" 2>/dev/null) && kill "$old" 2>/dev/null
echo $$ > "$r/attach.pid"
echo "${ATTACHED}" >&2
tail -c +$(($3 + 1)) -F "$r/out" 2>/dev/null & t=$!
cat <&0 > "$r/in" & c=$!
trap 'kill $c 2>/dev/null' USR1
trap 'kill $t $c 2>/dev/null; exit 0' TERM
wait $c; s=$?
[ $s -eq 0 ] && { kill $t 2>/dev/null; exit 0; }
wait $t
`;

const runDir = (id: string) => `"$HOME"/${RUNS_DIR}/${checkRun(id)}`;

function checkRun(id: string): string {
  if (!RUN_ID.test(id)) throw new Error(`Not a run id: ${id}`);
  return id;
}

/** The command that starts `command` in a new run and attaches to it. */
export function launchCommand(run: string, command: string): string {
  return `bash -c ${shellQuote(RUN_SCRIPT)} kumiko-run launch ${checkRun(run)} 0 ${shellQuote(command)}`;
}

/** The command that attaches to a run, following its `out` from byte `offset`. */
export function attachCommand(run: string, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`Not an offset: ${offset}`);
  return `bash -c ${shellQuote(RUN_SCRIPT)} kumiko-run attach ${checkRun(run)} ${offset}`;
}

/** Ends the agent's input: the holder goes, and the attachment closes `in` but keeps following `out`. */
export const closeInputCommand = (run: string) => {
  const r = runDir(run);
  return `bash -c ${shellQuote(`kill "$(cat ${r}/hold.pid)" 2>/dev/null; kill -USR1 "$(cat ${r}/attach.pid)" 2>/dev/null; true`)}`;
};

/** Signals the agent itself. */
export const signalCommand = (run: string, signal: "TERM" | "KILL") =>
  `bash -c ${shellQuote(`kill -${signal} "$(cat ${runDir(run)}/pid)" 2>/dev/null; true`)}`;

/** The last lines of the agent's stderr. */
export const stderrCommand = (run: string, lines: number) => `tail -n ${lines} ${runDir(run)}/err`;


/** The state of a run's agent: still running, exited (its last words are in `out`), or gone without a trace. */
export type RunState = "alive" | "exited" | "lost";

/** Lists every run with its state, one `<id> <state>` per line. */
const LIST_SCRIPT = String.raw`
b=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)
for r in "$HOME/${RUNS_DIR}"/*/; do
  [ -d "$r" ] || continue
  if [ -f "$r/exit" ]; then s=exited
  elif [ "$(cat "$r/boot" 2>/dev/null)" = "$b" ] && kill -0 "$(cat "$r/pid" 2>/dev/null)" 2>/dev/null; then s=alive
  else s=lost; fi
  echo "$(basename "$r") $s"
done
`;

/** Stops and deletes the runs named as arguments: the agent, its holder and its attachment. Pids are only signalled in the boot that wrote them. */
const REMOVE_SCRIPT = String.raw`
b=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)
for id in "$@"; do
  r="$HOME/${RUNS_DIR}/$id"
  [ -d "$r" ] || continue
  if [ "$(cat "$r/boot" 2>/dev/null)" = "$b" ]; then
    for f in attach.pid hold.pid pid; do kill "$(cat "$r/$f" 2>/dev/null)" 2>/dev/null; done
  fi
  rm -rf "$r"
done
`;

/** Stops what is left of a run and deletes it. */
export const removeCommand = (...runs: string[]) => `bash -c ${shellQuote(REMOVE_SCRIPT)} kumiko-runs ${runs.map(checkRun).join(" ")}`;

const LIST_TIMEOUT_MS = 15_000;

/** Runs a short command in the sandbox; resolves with its stdout, rejects if it fails or takes too long. */
export function execOutput(exec: Exec, sandbox: string, cmd: string, timeoutMs = LIST_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = exec(sandbox, cmd, []);
    child.stdin!.end();
    let out = "";
    let err = "";
    child.stdout!.setEncoding("utf8").on("data", (c: string) => (out += c));
    child.stderr!.setEncoding("utf8").on("data", (c: string) => (err += c));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`No answer from ${sandbox} in ${timeoutMs / 1000} s.`));
    }, timeoutMs);
    child.on("error", (e) => (clearTimeout(timer), reject(e)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`exit ${code}${err.trim() ? `: ${err.trim().split("\n").at(-1)}` : ""}`));
    });
  });
}

/** The runs in each sandbox, for the server to find its sessions' agents again and to clean up those it has lost. */
export class Runs {
  constructor(private readonly exec: Exec) {}

  /** Every run in the sandbox and the state of its agent. Rejects if the sandbox can't be asked. */
  async list(sandbox: string): Promise<Map<string, RunState>> {
    const out = await execOutput(this.exec, sandbox, `bash -c ${shellQuote(LIST_SCRIPT)}`);
    const runs = new Map<string, RunState>();
    for (const line of out.split("\n")) {
      const [id, state] = line.trim().split(" ");
      if (id && RUN_ID.test(id) && (state === "alive" || state === "exited" || state === "lost")) runs.set(id, state);
    }
    return runs;
  }

  /** Stops the runs' agents and deletes the runs. */
  async remove(sandbox: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await execOutput(this.exec, sandbox, removeCommand(...ids));
  }
}
