import type { LogLine, ProjectView } from "@kumiko/shared";
import { SandboxActions, useActions, type Actions } from "./actions";
import { useHome, type LiveState } from "./api";
import { tilde } from "./format";
import { EmptyBento, Plus } from "./icons";
import { plural, resources, statusOf } from "./status";

interface Props {
  live: LiveState;
  onOpen(id: string): void;
  onNew(): void;
}

export function ProjectList({ live, onOpen, onNew }: Props) {
  const actions = useActions();
  const home = useHome();
  const empty = live.loaded && live.projects.length === 0 && live.unreadable.length === 0;

  return (
    <>
      <main className="page">
        <div className="page-head">
          <h1 className="page-title">Projects</h1>
          {live.projects.length > 0 && (
            <button type="button" className="btn btn-primary" onClick={onNew}>
              <Plus />
              New project
            </button>
          )}
        </div>

        {!live.connected && live.loaded && <div className="banner banner-warn">Lost connection to the Kumiko server. Reconnecting…</div>}
        {live.listError && (
          <div className="banner banner-error">
            <strong>Can't read Lima's instances.</strong>
            <span className="mono">{live.listError}</span>
          </div>
        )}

        {live.unreadable.length > 0 && (
          <div className="banner banner-error">
            <strong>{live.unreadable.length === 1 ? "A project's record is unreadable, so it isn't listed." : "Some projects' records are unreadable, so they aren't listed."}</strong>
            {live.unreadable.map((why) => (
              <span key={why} className="mono">
                {why}
              </span>
            ))}
          </div>
        )}

        {!live.loaded && <p className="muted">Connecting…</p>}

        {empty && (
          <div className="empty-state">
            <EmptyBento />
            <h2>No projects yet</h2>
            <p className="muted">Pick a git clone on this machine. Kumiko gives it a sandbox of its own, where Claude works in worktrees beside the clone.</p>
            <button type="button" className="btn btn-primary" onClick={onNew}>
              <Plus />
              New project
            </button>
          </div>
        )}

        {live.projects.length > 0 && (
          <div className="table-card">
            <div className="table-inner">
              <div className="table-row table-headrow">
                <span>Project</span>
                <span>Sandbox</span>
                <span>CPU · Memory · Disk</span>
                <span className="align-right">Actions</span>
              </div>
              {live.projects.map((p) => (
                <Row key={p.name} p={p} home={home} log={live.logs[p.name]} actions={actions} onOpen={() => onOpen(p.name)} />
              ))}
            </div>
          </div>
        )}
      </main>

      {actions.overlay}
    </>
  );
}

function Row({ p, home, log, actions, onOpen }: { p: ProjectView; home?: string; log?: LogLine[]; actions: Actions; onOpen(): void }) {
  const status = statusOf(p, log);
  return (
    <div className="table-row sandbox-row" onClick={onOpen}>
      {/* The row handles the click; the button makes it reachable by keyboard. */}
      <button type="button" className="row-name" aria-label={`Open ${p.name}`}>
        <span className="row-title">{p.name}</span>
        <span className="row-sub">
          <span className="mono dim" title={p.project.clonePath}>
            {tilde(p.project.clonePath, home)}
          </span>
          {p.waiting > 0 && <span className="badge badge-warn">{p.waiting} waiting on you</span>}
          {p.sessions > 0 && <span className="badge badge-sessions">{plural(p.sessions, "session")}</span>}
          {p.problem && (
            <span className="badge badge-warn" title={p.problem}>
              Folder missing
            </span>
          )}
          {p.metaError && (
            <span className="badge badge-warn" title={p.metaError}>
              Record unreadable
            </span>
          )}
        </span>
      </button>

      <div className="row-status" style={{ color: status.color }}>
        {p.busy ? <span className="spinner" aria-hidden="true" /> : <span className="dot" style={{ background: status.color }} aria-hidden="true" />}
        <span>{status.text}</span>
      </div>

      <span className="mono row-res">{resources(p)}</span>

      <SandboxActions sb={p} actions={actions} />
    </div>
  );
}
