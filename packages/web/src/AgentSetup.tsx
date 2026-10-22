import { useCallback, useEffect, useState } from "react";
import { AGENT_SETUP_DIR, KUMIKO_HOME_IN_VM, type AgentScript, type AgentSetupResponse, type ProjectView } from "@kumiko/shared";
import { api, errorMessage } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Trash } from "./icons";
import { plural } from "./status";

/** How a script went when the VM was created; nothing for one that hasn't run in it as it is now. */
function ScriptBadge({ s }: { s: AgentScript }) {
  if (s.exitCode === undefined) return null;
  return s.exitCode === 0 ? <span className="badge badge-ok">Ran</span> : <span className="badge badge-failed">Failed · exit {s.exitCode}</span>;
}

/** The scripts the agent keeps so its setup survives a recreate, on the project's page. */
export function AgentSetupCard({ p }: { p: ProjectView }) {
  const [setup, setSetup] = useState<AgentSetupResponse | undefined>();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const reload = useCallback(() => void api.agentSetup(p.name).then(setSetup, () => {}), [p.name]);
  // Asked again when the VM is created anew, or provisioning finishes, and whenever the card is opened.
  useEffect(reload, [reload, p.meta?.createdAt, p.meta?.setup]);
  if (!setup) return null;
  const remove = async () => {
    setConfirm(false);
    setError(undefined);
    await api.deleteAgentSetup(p.name).catch((err: unknown) => setError(errorMessage(err)));
    reload();
  };
  return (
    <>
      <details className="card details" onToggle={(e) => (e.currentTarget.open ? reload() : undefined)}>
        <summary>Agent's setup scripts{setup.scripts.length ? ` · ${plural(setup.scripts.length, "script")}` : ": none"}</summary>
        <p className="muted details-empty">
          Claude keeps these in <span className="mono">{KUMIKO_HOME_IN_VM}/{AGENT_SETUP_DIR}</span>, so what it installs comes back when the sandbox is recreated.
          They run after the provisioning script, in name order.
        </p>
        {setup.scripts.length > 0 && (
          <div className="agent-scripts">
            {setup.scripts.map((s) => (
              <details key={s.file} className="agent-script">
                <summary>
                  <span className="mono">{s.file}</span>
                  <ScriptBadge s={s} />
                </summary>
                <pre className="mono preview">{s.script}</pre>
              </details>
            ))}
          </div>
        )}
        {setup.ignored.length > 0 && <p className="muted details-empty">Not run: {setup.ignored.join(", ")}.</p>}
        {(setup.scripts.length > 0 || setup.ignored.length > 0) && (
          <div className="agent-actions">
            {error && <span className="form-note" style={{ color: "var(--danger)" }}>{error}</span>}
            <button type="button" className="btn btn-secondary btn-compact" disabled={p.busy} onClick={() => setConfirm(true)}>
              <Trash />
              Delete scripts
            </button>
          </div>
        )}
      </details>
      {confirm && (
        <ConfirmDialog title="Delete the agent's setup scripts?" confirmLabel="Delete scripts" danger onCancel={() => setConfirm(false)} onConfirm={() => void remove()}>
          <p>
            This deletes <span className="mono">{KUMIKO_HOME_IN_VM}/{AGENT_SETUP_DIR}</span> and everything in it. The sandbox keeps what they set up until you
            recreate it; then it starts from your provisioning script only. Claude starts new scripts as its work needs them.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
