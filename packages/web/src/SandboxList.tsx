import type { LogLine, SandboxView, SandboxStats } from "@kumiko/shared";
import { SandboxActions, useActions, type Actions } from "./actions";
import { useSandboxStats, type LiveState } from "./api";
import { FinishingCard } from "./Finishing";
import { HomeNav } from "./HomeNav";
import { repoLabels } from "./format";
import { EmptyBento, Plus } from "./icons";
import { meters, plural, resources, statusOf, type Meter } from "./status";

interface Props {
  live: LiveState;
  onOpen(id: string): void;
  onNew(): void;
  /** A session reopened from the list, whose tab opens. */
  onSessionStarted(id: string): void;
}

export function SandboxList({ live, onOpen, onNew, onSessionStarted }: Props) {
  const actions = useActions();
  const stats = useSandboxStats();
  const empty = live.loaded && live.sandboxes.length === 0 && live.unreadable.length === 0;

  return (
    <>
      <main className="page">
        <HomeNav active="sandboxes" sandboxes={live.sandboxes.length} repos={live.mirrors?.mirrors.length} />
        <div className="page-head">
          <h1 className="page-title">Sandboxes</h1>
          {live.sandboxes.length > 0 && (
            <button type="button" className="btn btn-primary" onClick={onNew}>
              <Plus />
              New sandbox
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
            <strong>{live.unreadable.length === 1 ? "A sandbox's record is unreadable, so it isn't listed." : "Some sandboxes' records are unreadable, so they aren't listed."}</strong>
            {live.unreadable.map((why) => (
              <span key={why} className="mono">
                {why}
              </span>
            ))}
          </div>
        )}

        {!live.loaded && <p className="muted">Connecting…</p>}

        <FinishingCard sessions={live.sessions} onOpened={onSessionStarted} />

        {empty && (
          <div className="empty-state">
            <EmptyBento />
            <h2>No sandboxes yet</h2>
            <p className="muted">A sandbox is a VM of its own for Claude, with the repos you pick from your mirrors cloned onto its own disk.</p>
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
                <span>Sandbox</span>
                <span>Status</span>
                <span className="row-res">
                  <span>CPU</span>
                  <span>Memory</span>
                  <span>Workspace</span>
                </span>
                <span className="align-right">Actions</span>
              </div>
              {live.sandboxes.map((p) => (
                <Row key={p.name} p={p} stats={p.status === "running" && !p.busy ? stats[p.name] : undefined} log={live.logs[p.name]} actions={actions} onOpen={() => onOpen(p.name)} />
              ))}
            </div>
          </div>
        )}
      </main>

      {actions.overlay}
    </>
  );
}

function Row({ p, stats, log, actions, onOpen }: { p: SandboxView; stats?: SandboxStats; log?: LogLine[]; actions: Actions; onOpen(): void }) {
  const status = statusOf(p, log);
  // The columns' meters: the workspace disk's only once the reading has it.
  const usage = stats && meters(stats);
  const column = (label: Meter["label"]) => usage?.find((m) => m.label === label);
  return (
    <div className="table-row sandbox-row" onClick={onOpen}>
      {/* The row handles the click; the button makes it reachable by keyboard. */}
      <button type="button" className="row-name" aria-label={`Open ${p.name}`}>
        <span className="row-title">{p.name}</span>
        <span className="row-sub">
          {p.sandbox.repos.length === 0 && <span className="dim">No repos</span>}
          {repoLabels(p.sandbox.repos).map((label, i) => (
            <span key={label} className="repo-chip" title={p.sandbox.repos[i].repo}>
              {label}
            </span>
          ))}
          {p.waiting > 0 && <span className="badge badge-warn">{p.waiting} waiting on you</span>}
          {p.sessions > 0 && <span className="badge badge-sessions">{plural(p.sessions, "session")}</span>}
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

      <ResourceCells specs={resources(p)} usage={usage && [column("CPU"), column("Memory"), column("Workspace")]} />

      <SandboxActions sb={p} actions={actions} />
    </div>
  );
}

/** The sandbox's size, one column per resource, each with its meter under it while it runs. */
function ResourceCells({ specs, usage }: { specs?: string[]; usage?: (Meter | undefined)[] }) {
  if (!specs) return <span className="mono dim">—</span>;
  return (
    <span className="row-res">
      {specs.map((spec, i) => {
        const m = usage?.[i];
        return (
          <span key={i} className="row-res-cell" title={m && `${m.label}: ${m.text}`}>
            <span className="mono">{spec}</span>
            {m && (
              <span className="row-meter">
                <span className="meter" role="meter" aria-label={`${m.label} in use`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={m.percent}>
                  <span style={{ width: `${m.percent ?? 0}%`, background: m.color }} />
                </span>
                <span className="mono">{m.percent === undefined ? "—" : `${m.percent}%`}</span>
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}
