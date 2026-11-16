import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, RequestError } from "./api";
import { lossGroups, type LossCheck } from "./loss";

/** How often Kumiko looks again while the VM it was asked to start comes up, and for how long at most. */
const START_POLL_MS = 2000;
const START_WAIT_MS = 10 * 60_000;

/**
 * What the sandbox's VM has that isn't pushed, looked up when the dialog opens: in the repos in `only`, or all of
 * them. A VM that isn't running can be started from the list, which looks again once it runs.
 */
export function useLossCheck(name: string, only?: string[]): { check: LossCheck; startAndCheck(): void } {
  const [check, setCheck] = useState<LossCheck>({ kind: "checking" });
  const alive = useRef(true);
  const key = only?.join("\n");

  /** Looks once; false when the VM isn't running. */
  const look = useCallback(async (): Promise<boolean> => {
    try {
      const res = await api.unpushed(name);
      if (alive.current) setCheck({ kind: "done", groups: lossGroups(res.repos, key === undefined ? undefined : key.split("\n")) });
      return true;
    } catch (err) {
      if (err instanceof RequestError && err.status === 409) return false;
      if (alive.current) setCheck({ kind: "error", message: errorMessage(err) });
      return true;
    }
  }, [name, key]);

  useEffect(() => {
    alive.current = true;
    void look().then((ok) => !ok && alive.current && setCheck({ kind: "stopped" }));
    return () => {
      alive.current = false;
    };
  }, [look]);

  const startAndCheck = () => {
    setCheck({ kind: "stopped", starting: true });
    void (async () => {
      // Already starting, from elsewhere, is as good.
      await api.start(name).catch(() => {});
      const end = Date.now() + START_WAIT_MS;
      while (alive.current && Date.now() < end) {
        if (await look()) return;
        await new Promise((r) => setTimeout(r, START_POLL_MS));
      }
      if (alive.current) setCheck({ kind: "error", message: "The sandbox didn't start, so Kumiko can't see what isn't pushed." });
    })();
  };

  return { check, startAndCheck };
}

/**
 * What would be lost, as the dialogs show it: still looking, nothing, or each repo's unpushed branches, uncommitted
 * worktrees and stashes. `wholeDisk` adds that everything else on the workspace disk goes too.
 */
export function LossList({ check, onStart, wholeDisk }: { check: LossCheck; onStart(): void; wholeDisk?: boolean }) {
  switch (check.kind) {
    case "checking":
      return (
        <div className="loss loss-plain" role="status">
          <span className="spinner" aria-hidden="true" /> Checking for work that isn't pushed…
        </div>
      );
    case "stopped":
      return (
        <div className="loss loss-warn">
          <span>The sandbox is stopped, so Kumiko can't see what isn't pushed.</span>
          <button type="button" className="btn btn-secondary btn-small" disabled={check.starting} onClick={onStart}>
            {check.starting && <span className="spinner" aria-hidden="true" />}
            {check.starting ? "Starting…" : "Start it and check"}
          </button>
        </div>
      );
    case "error":
      return <div className="loss loss-warn">Kumiko couldn't check what isn't pushed: {check.message}</div>;
    case "done":
      if (!check.groups.length) {
        return (
          <div className="loss loss-ok">
            <span>Everything is pushed: {wholeDisk ? "nothing in the repos would be lost." : "nothing would be lost."}</span>
            {wholeDisk && <DiskFoot />}
          </div>
        );
      }
      return (
        <div className="loss">
          <div className="loss-head">Would be lost:</div>
          {check.groups.map((g) => (
            <div key={g.repo} className="loss-group">
              <div className="loss-repo mono">{g.repo}</div>
              {g.error && <div className="loss-error">Couldn't look: {g.error}</div>}
              {g.rows.map((r) => (
                <div key={`${r.what} ${r.badge}`} className="loss-row">
                  <span className="mono loss-what">{r.what}</span>
                  <span className={`badge${r.tone === "plain" ? "" : ` badge-${r.tone}`}`}>{r.badge}</span>
                </div>
              ))}
            </div>
          ))}
          {wholeDisk && <DiskFoot />}
        </div>
      );
  }
}

/** What goes with the workspace disk that Kumiko can't list. */
function DiskFoot() {
  return (
    <div className="loss-foot">
      Plus anything else on the disk: ignored files such as <code className="mono">node_modules</code> and <code className="mono">.env</code>, and folders
      outside the repos.
    </div>
  );
}
