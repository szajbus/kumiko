import type { LogLine, SandboxView } from "@bentomo/shared";
import { SandboxActions, useActions, type Actions } from "./actions";
import type { LiveState } from "./api";
import { EmptyBento, Plus } from "./icons";
import { plural, resources, statusOf } from "./status";

interface Props {
  live: LiveState;
  onOpen(name: string): void;
  onNew(): void;
}

export function SandboxList({ live, onOpen, onNew }: Props) {
  const actions = useActions();
  const empty = live.loaded && live.sandboxes.length === 0;

  return (
    <>

      <main className="page">
        <div className="page-head">
          <h1 className="page-title">Sandboxes</h1>
          {live.sandboxes.length > 0 && (
            <button type="button" className="btn btn-primary" onClick={onNew}>
              <Plus />
              New sandbox
            </button>
          )}
        </div>

        {!live.connected && live.loaded && <div className="banner banner-warn">Lost connection to the Bentomo server. Reconnecting…</div>}
        {live.listError && (
          <div className="banner banner-error">
            <strong>Can't read Lima's instances.</strong>
            <span className="mono">{live.listError}</span>
          </div>
        )}

        {!live.loaded && <p className="muted">Connecting…</p>}

        {empty && (
          <div className="empty-state">
            <EmptyBento />
            <h2>No sandboxes yet</h2>
            <p className="muted">Create a Lima VM with its own folders, variables and setup script.</p>
            <button type="button" className="btn btn-primary" onClick={onNew}>
              <Plus />
              New sandbox
            </button>
          </div>
        )}

        {live.sandboxes.length > 0 && (
          <div className="table-card">
            <div className="table-inner">
              <div className="table-row table-headrow">
                <span>Name</span>
                <span>Status</span>
                <span>CPU · Memory · Disk</span>
                <span className="align-right">Actions</span>
              </div>
              {live.sandboxes.map((sb) => (
                <Row key={sb.name} sb={sb} log={live.logs[sb.name]} actions={actions} onOpen={() => onOpen(sb.name)} />
              ))}
            </div>
          </div>
        )}
      </main>

      {actions.overlay}
    </>
  );
}

function Row({ sb, log, actions, onOpen }: { sb: SandboxView; log?: LogLine[]; actions: Actions; onOpen(): void }) {
  const status = statusOf(sb, log);
  return (
    <div className="table-row sandbox-row" onClick={onOpen}>
      {/* The row handles the click; the button makes it reachable by keyboard. */}
      <button type="button" className="row-name" aria-label={`Open ${sb.vm}`}>
        <span className="row-title">{sb.name}</span>
        <span className="row-sub">
          <span className="mono dim">{sb.vm}</span>
          <span className="badge">Lima</span>
          {sb.sessions > 0 && <span className="badge badge-sessions">{plural(sb.sessions, "session")}</span>}
        </span>
      </button>

      <div className="row-status" style={{ color: status.color }}>
        {sb.busy ? <span className="spinner" aria-hidden="true" /> : <span className="dot" style={{ background: status.color }} aria-hidden="true" />}
        <span>{status.text}</span>
      </div>

      <span className="mono row-res">{resources(sb)}</span>

      <SandboxActions sb={sb} actions={actions} />
    </div>
  );
}
