import { useCallback, useEffect, useState } from "react";
import { AGENT_SETUP_DIR, type AgentScriptView, type AgentSetupResponse, type ProjectView } from "@kumiko/shared";
import { api } from "./api";
import { plural } from "./status";

/** The agent's setup scripts as the server has them now; `reload` asks again. Undefined until the first answer. */
export function useAgentSetup(id: string, key?: string): { setup?: AgentSetupResponse; reload(): void } {
  const [setup, setSetup] = useState<AgentSetupResponse | undefined>();
  const reload = useCallback(() => void api.agentSetup(id).then(setSetup, () => {}), [id]);
  useEffect(reload, [reload, key]);
  return { setup, reload };
}

/** The scripts that differ from the ones the VM was created with: what a recreate would run for the first time. */
export function unreviewed(setup: AgentSetupResponse): AgentScriptView[] {
  return setup.scripts.filter((s) => s.state !== "same");
}

/** A script's state as a badge: new or changed since the VM was created, or how it went then. */
function ScriptBadge({ s }: { s: AgentScriptView }) {
  if (s.state === "new") return <span className="badge badge-warn">New</span>;
  if (s.state === "changed") return <span className="badge badge-warn">Changed</span>;
  if (s.exitCode === undefined) return null;
  return s.exitCode === 0 ? <span className="badge badge-ok">Ran</span> : <span className="badge badge-failed">Failed · exit {s.exitCode}</span>;
}

function ScriptList({ scripts, open }: { scripts: AgentScriptView[]; open?: boolean }) {
  return (
    <div className="agent-scripts">
      {scripts.map((s) => (
        <details key={s.file} className="agent-script" open={open}>
          <summary>
            <span className="mono">{s.file}</span>
            <ScriptBadge s={s} />
          </summary>
          <pre className="mono preview">{s.script}</pre>
        </details>
      ))}
    </div>
  );
}

/** The scripts the agent keeps so its setup survives a recreate, on the project's page. */
export function AgentSetupCard({ p }: { p: ProjectView }) {
  // Asked again when the VM is created anew, or provisioning finishes, and whenever the card is opened.
  const { setup, reload } = useAgentSetup(p.name, `${p.meta?.createdAt}/${p.meta?.setup}`);
  if (!setup) return null;
  const changed = unreviewed(setup).length;
  const summary = setup.scripts.length ? ` · ${plural(setup.scripts.length, "script")}${changed ? ` · ${changed} new or changed` : ""}` : ": none";
  return (
    <details className="card details" onToggle={(e) => (e.currentTarget.open ? reload() : undefined)}>
      <summary>Agent's setup scripts{summary}</summary>
      <p className="muted details-empty">
        Claude keeps these in <span className="mono">~/.claude/{AGENT_SETUP_DIR}</span>, so what it installs comes back when the sandbox is recreated.
        They run after the provisioning script, in name order. New and changed ones haven't run in this sandbox's provisioning yet.
        {setup.skipped && " This sandbox was recreated without them."}
      </p>
      {setup.scripts.length > 0 && <ScriptList scripts={setup.scripts} />}
      {setup.removed.length > 0 && <p className="muted details-empty">Removed since the sandbox was created: {setup.removed.join(", ")}.</p>}
      {setup.ignored.length > 0 && (
        <p className="muted details-empty">Not run (not plain <span className="mono">*.sh</span> files, or over 64 KB): {setup.ignored.join(", ")}.</p>
      )}
    </details>
  );
}

/**
 * In a recreate dialog: whether the new VM runs the agent's setup scripts, with the ones that haven't run before shown
 * in full, so the user sees what would run. Nothing when there are none.
 */
export function AgentSetupChoice({ id, run, onChange }: { id: string; run: boolean; onChange(run: boolean): void }) {
  const { setup } = useAgentSetup(id);
  if (!setup?.scripts.length) return null;
  const fresh = unreviewed(setup);
  return (
    <div className="agent-choice">
      <label className="check">
        <input type="checkbox" checked={run} onChange={(e) => onChange(e.target.checked)} />
        Run the agent's setup scripts ({setup.scripts.length})
      </label>
      {fresh.length > 0 && (
        <>
          <p className="form-note muted">
            {fresh.length === setup.scripts.length ? "None of them has" : `${plural(fresh.length, "script")} ${fresh.length === 1 ? "hasn't" : "haven't"}`} run in this
            sandbox before:
          </p>
          <ScriptList scripts={fresh} />
        </>
      )}
    </div>
  );
}
