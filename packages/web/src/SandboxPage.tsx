import { useEffect, useState } from "react";
import { isBusy, isWaiting, sandboxMountRole, vmName, WORKSPACE_DIR, workspaceDiskName, type LogLine, type SandboxView, type ResumableSession } from "@kumiko/shared";
import { SandboxActions, useActions } from "./actions";
import { AgentSetupCard } from "./AgentSetup";
import { api, errorMessage, useHome, useSandboxStats, type LiveState } from "./api";
import { Breadcrumbs } from "./Breadcrumbs";
import { FinishingItem } from "./Finishing";
import { ago, tilde } from "./format";
import { Disk, Folder, Pencil, Plus, Resume } from "./icons";
import { LogPanel } from "./LogPanel";
import { resumableKey } from "./resumable";
import { COLORS, failedAgentScripts, meters, plural, sandboxCreatedAt, sessionState, statusOf, type Meter } from "./status";
import { sandboxSessions } from "./wake";

interface Props {
  id: string;
  live: LiveState;
  onBack(): void;
  onEdit(): void;
  onNewSession(): void;
  /** A session reopened from the page, whose tab opens. */
  onSessionStarted(id: string): void;
}

/** One sandbox: what needs the user (sessions waiting) and its repos, then its VM and the VM's log. */
export function SandboxPage({ id, live, onBack, onEdit, onNewSession, onSessionStarted }: Props) {
  const p = live.sandboxes.find((x) => x.name === id);
  const lines = live.logs[id] ?? [];
  const actions = useActions({ onDeleted: onBack });
  const home = useHome();

  return (
    <>
      <main className="page">
        <Breadcrumbs items={[{ label: "Sandboxes", href: "#/" }, { label: id }]} />
        {!p ? (
          <div className="page-head">
            <div className="detail-title">
              <h1 className="page-title">{id}</h1>
              <span className="mono dim">{vmName(id)}</span>
            </div>
          </div>
        ) : (
          <DetailHead p={p} lines={lines}>
            <button
              type="button"
              className="btn btn-primary btn-compact"
              disabled={p.status !== "running" || p.busy}
              title={p.status === "running" ? "Start a Claude session in this sandbox" : "Start the sandbox first"}
              onClick={onNewSession}
            >
              <Plus />
              New session
            </button>
            <button type="button" className="btn btn-secondary btn-compact" disabled={p.busy || Boolean(p.metaError)} onClick={onEdit}>
              <Pencil />
              Edit
            </button>
            <SandboxActions sb={p} actions={actions} labeled />
          </DetailHead>
        )}

        {!p && live.loaded && <div className="banner banner-warn">There is no sandbox {id}{lines.length ? "; its last log is below." : "."}</div>}
        {p?.metaError && (
          <div className="banner banner-error">
            <strong>Kumiko's record of this sandbox's VM is unreadable.</strong>
            <span className="mono">{p.metaError}</span>
          </div>
        )}
        {p?.hostLoopbackOpen && (
          <div className="banner banner-warn">
            <strong>This sandbox can reach services on your Mac's localhost.</strong>
            <span>
              Claude in it can connect to anything listening on your Mac's 127.0.0.1, such as databases, dev servers and other
              apps' local APIs, many of which trust anything on localhost. {p.hostLoopbackOpen}
            </span>
          </div>
        )}
        {p?.status === "absent" && !p.busy && (
          <div className="banner banner-warn">
            {p.vm} doesn't exist: its creation failed, or it was deleted outside Kumiko. Rebuild it from the menu to use this sandbox.
          </div>
        )}

        {p && (
          <div className="detail-grid">
            <SessionsCard id={id} live={live} onOpened={onSessionStarted} />
            <ReposCard p={p} onAdd={onEdit} />
          </div>
        )}

        {p && <Details p={p} home={home} />}
        {p && <AgentSetupCard p={p} />}

        {(p || lines.length > 0) && <LogPanel sandbox={p} lines={lines} />}
      </main>

      {actions.overlay}
    </>
  );
}

function DetailHead({ p, lines, children }: { p: SandboxView; lines: LogLine[]; children: React.ReactNode }) {
  const status = statusOf(p, lines);
  return (
    <div className="page-head">
      <div className="detail-title">
        <h1 className="page-title">{p.name}</h1>
        <span className="row-sub">
          <span className="badge mono">{p.vm}</span>
        </span>
      </div>
      <div className="detail-head-right">
        <span className="row-status" style={{ color: status.color }}>
          {p.busy ? <span className="spinner" aria-hidden="true" /> : <span className="dot" style={{ background: status.color }} aria-hidden="true" />}
          {status.text}
        </span>
        {children}
      </div>
    </div>
  );
}

/** How many closed sessions the card shows before "Show older". */
const CLOSED_SHOWN = 5;

/**
 * The sandbox's sessions: the open ones, those waiting on the user first, then those Claude finishes after their tab
 * closed, then the closed ones, most recent first, to resume.
 */
function SessionsCard({ id, live, onOpened }: { id: string; live: LiveState; onOpened(id: string): void }) {
  // Re-read when a session opens or closes, or a sandbox (and its saved sessions) goes.
  const [saved, setSaved] = useState<ResumableSession[]>([]);
  const key = resumableKey(live);
  useEffect(() => {
    let current = true;
    api.resumable().then((list) => current && setSaved(list), () => {});
    return () => {
      current = false;
    };
  }, [key]);
  const { open, closed } = sandboxSessions(id, live.sessions, saved);
  const finishing = live.sessions.filter((s) => s.sandbox === id && s.closing);
  const waiting = open.filter(isWaiting).length;
  const [all, setAll] = useState(false);
  const [resuming, setResuming] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const resume = async (sid: string) => {
    setError(undefined);
    setResuming(sid);
    try {
      onOpened((await api.resumeSession(sid)).id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setResuming(undefined);
    }
  };
  const shown = all ? closed : closed.slice(0, CLOSED_SHOWN);
  return (
    <section className="card section" aria-labelledby="p-sessions">
      <div className="card-head">
        <h2 id="p-sessions">Sessions</h2>
        {waiting > 0 && <span className="badge badge-warn">{waiting} waiting on you</span>}
      </div>
      {!open.length && !finishing.length && !closed.length && <p className="muted">No sessions yet.</p>}
      {error && <div className="banner banner-error">{error}</div>}
      {(open.length > 0 || finishing.length > 0) && (
        <>
          {closed.length > 0 && <h3 className="item-group">Open</h3>}
          <ul className="item-list">
            {open.map((s) => {
              const st = sessionState(s);
              return (
                <li key={s.id} className="item">
                  <a className="item-main" href={`#/session/${s.id}`} title={s.prompt}>
                    <span className="item-title">{s.title ?? s.prompt}</span>
                  </a>
                  <span className="row-status item-state" style={{ color: st.color }}>
                    <span className={`dot dot-small${isBusy(s) ? " dot-pulse" : ""}`} style={{ background: st.color }} aria-hidden="true" />
                    {st.text}
                  </span>
                </li>
              );
            })}
            {finishing.map((s) => (
              <FinishingItem key={s.id} s={s} onOpened={onOpened} />
            ))}
          </ul>
        </>
      )}
      {closed.length > 0 && (
        <>
          <h3 className="item-group">Closed</h3>
          <ul className="item-list">
            {shown.map((s) => (
              <li key={s.id} className="item">
                <span className="item-main" title={s.prompt}>
                  <span className="item-title">{s.title ?? s.prompt}</span>
                  <span className="item-sub muted">
                    {s.description ? `${s.description} · ` : ""}
                    {ago(s.updatedAt ?? s.startedAt)}
                  </span>
                </span>
                <span className="item-actions">
                  <span className="row-status item-state muted">
                    <span className="dot dot-small" style={{ background: COLORS.closed }} aria-hidden="true" />
                    Closed
                  </span>
                  <button type="button" className="btn btn-secondary btn-small" disabled={resuming !== undefined} onClick={() => void resume(s.id)}>
                    <Resume />
                    {resuming === s.id ? "Resuming…" : "Resume"}
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {closed.length > CLOSED_SHOWN && (
            <button type="button" className="link-btn" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show ${plural(closed.length - CLOSED_SHOWN, "older closed session")}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

const REPO_STATE = {
  cloned: { text: "Cloned", badge: "badge-ok" },
  cloning: { text: "Cloning…", badge: "" },
  failed: { text: "Clone failed", badge: "badge-failed" },
} as const;

/** The sandbox's repos, each with its folder in /workspace and how its clone is, as Kumiko last found it. */
function ReposCard({ p, onAdd }: { p: SandboxView; onAdd(): void }) {
  return (
    <section className="card section" aria-labelledby="p-repos">
      <div className="card-head">
        <h2 id="p-repos">Repos</h2>
        <button type="button" className="btn btn-secondary btn-small" disabled={p.busy || Boolean(p.metaError)} onClick={onAdd}>
          <Plus />
          Add repo
        </button>
      </div>
      {p.repos.length === 0 && <p className="muted">No repos yet. Add one from your mirrors, and Kumiko clones it into {WORKSPACE_DIR}.</p>}
      <ul className="item-list">
        {p.repos.map((r) => {
          const slash = r.repo.indexOf("/");
          return (
            <li key={r.repo} className="item">
              <div className="item-main">
                <span className="item-title">
                  <span className="dim">{r.repo.slice(0, slash + 1)}</span>
                  {r.repo.slice(slash + 1)}
                </span>
                <span className="mono dim item-sub">
                  {WORKSPACE_DIR}/{r.folder}
                </span>
                {/* Why it failed, or why it can't be looked at yet: git in the VM can't reach the mirrors. */}
                {r.error && <span className="item-sub item-error" title={r.error}>{r.error}</span>}
              </div>
              <span className="item-badges">
                {r.state === "pending" ? (
                  <span className="dim item-quiet">{p.status === "running" ? "Not cloned yet" : "Checked when the sandbox starts"}</span>
                ) : r.state === "cloning" ? (
                  <span className="row-status item-state" style={{ color: COLORS.warn }}>
                    <span className="spinner" aria-hidden="true" />
                    {REPO_STATE.cloning.text}
                  </span>
                ) : (
                  <span className={`badge ${REPO_STATE[r.state].badge}`} title={r.error}>
                    {REPO_STATE[r.state].text}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const MOUNT_ROLE = { "claude-home": "Claude home", "kumiko-home": "Kumiko folder" } as const;

function Details({ p, home }: { p: SandboxView; home?: string }) {
  const spec = p.meta?.spec;
  const envSet = useEnvSet(spec?.env ?? []);
  const gib = (n?: number) => (n === undefined ? "—" : `${n} GiB`);
  const created = sandboxCreatedAt(p);
  const stats = useSandboxStats()[p.name];
  // While it runs, each resource shows how much of it is in use, empty until the first reading is in.
  const usage = p.status === "running" && !p.busy ? (stats ? meters(stats) : []) : undefined;
  const meter = (label: Meter["label"]) => usage && <MeterLine m={usage.find((m) => m.label === label) ?? { label, text: "—", color: COLORS.stopped }} />;
  const workspace = p.workspaceGiB ?? spec?.workspaceGiB;
  // The Claude home and Kumiko folder first, as the form lists them, then the user's own.
  const mounts = spec ? [...spec.mounts.filter((m) => sandboxMountRole(m)), ...spec.mounts.filter((m) => !sandboxMountRole(m))] : [];

  return (
    <>
      <div className="form-group-head">
        <h2>Sandbox</h2>
      </div>
      <section className="card facts" aria-label="Sandbox">
        <Fact label="CPUs" usage={meter("CPU")}>{p.cpus ?? spec?.cpus ?? "—"}</Fact>
        <Fact label="Memory" usage={meter("Memory")}>{gib(p.memoryGiB ?? spec?.memoryGiB)}</Fact>
        <Fact label="Workspace" usage={meter("Workspace")}>{gib(workspace)}</Fact>
        <Fact label="System disk" usage={meter("Disk")}>{gib(p.diskGiB ?? spec?.diskGiB)}</Fact>
        <Fact label="Template" mono>
          {spec ? spec.template || "template:default" : "—"}
        </Fact>
        <Fact label="Setup">
          <SetupState p={p} />
        </Fact>
        <Fact label="Created">{created ? new Date(created).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—"}</Fact>
      </section>

      {spec && (
        <div className="detail-grid">
          <section className="card section" aria-labelledby="d-mounts">
            <h2 id="d-mounts">Mounts</h2>
            {workspace !== undefined && (
              <div className="detail-mount mount-grid">
                <span className="mount-icon">
                  <Disk />
                </span>
                <span className="mono path">
                  Workspace disk <span className="dim">{workspaceDiskName(p.name)}</span>
                </span>
                <span className="row-sub">
                  <span className="badge">Persistent</span>
                </span>
                <span className="mount-at">at</span>
                <span className="mono path">{WORKSPACE_DIR}</span>
              </div>
            )}
            {mounts.map((m) => {
              const role = sandboxMountRole(m);
              return (
                <div key={m.hostPath + (m.guestPath ?? "")} className="detail-mount mount-grid">
                  <span className="mount-icon">
                    <Folder />
                  </span>
                  <span className="mono path" title={m.hostPath}>
                    {tilde(m.hostPath, home)}
                  </span>
                  <span className="row-sub">
                    {role && <span className="badge">{MOUNT_ROLE[role]}</span>}
                    <span className="badge">{m.writable ? "Writable" : "Read-only"}</span>
                  </span>
                  <span className="mount-at">at</span>
                  <span className="mono path">{(m.guestPath ?? m.hostPath) === m.hostPath ? "the same path" : m.guestPath}</span>
                </div>
              );
            })}
          </section>

          <section className="card section" aria-labelledby="d-env">
            <h2 id="d-env">Environment</h2>
            {spec.env.length === 0 && <p className="muted">No variables forwarded.</p>}
            {spec.env.map((n) => (
              <div key={n} className="detail-env">
                <span className="mono">{n}</span>
                {envSet[n] !== undefined && (
                  <span className="env-state" style={{ color: envSet[n] ? COLORS.running : COLORS.warn }}>
                    <span className="dot dot-small" style={{ background: envSet[n] ? COLORS.running : COLORS.warn }} aria-hidden="true" />
                    {envSet[n] ? "Set on host" : "Not set: skipped"}
                  </span>
                )}
              </div>
            ))}
          </section>
        </div>
      )}

      {spec && (
        <details className="card details">
          <summary>Provisioning script{spec.provision ? ` · ${plural(spec.provision.split("\n").length, "line")}` : ": none"}</summary>
          <p className="muted details-empty">Claude Code is installed first, and reinstalled on start if it goes missing.</p>
          {spec.provision ? <pre className="mono preview">{spec.provision}</pre> : <p className="muted details-empty">No provisioning script.</p>}
        </details>
      )}
    </>
  );
}

function Fact({ label, mono, usage, children }: { label: string; mono?: boolean; usage?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="fact">
      <span className="eyebrow">{label}</span>
      <span className={`fact-value${mono ? " mono" : ""}`}>{children}</span>
      {usage}
    </div>
  );
}

/** How much of a resource the running VM uses: a bar, and the numbers under it. */
function MeterLine({ m }: { m: Meter }) {
  const alarm = m.percent !== undefined && m.percent >= 95;
  return (
    <>
      <span className="meter" role="meter" aria-label={`${m.label} in use`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={m.percent}>
        <span style={{ width: `${m.percent ?? 0}%`, background: m.color }} />
      </span>
      <span className="meter-text" style={alarm ? { color: m.color } : undefined}>
        {m.text}
      </span>
    </>
  );
}

function SetupState({ p }: { p: SandboxView }) {
  switch (p.meta?.setup) {
    case "ready": {
      const failed = failedAgentScripts(p);
      if (failed.length) return <span style={{ color: COLORS.warn }}>Ready · agent setup failed: {failed.join(", ")}</span>;
      return <span style={{ color: COLORS.running }}>Ready</span>;
    }
    case "provision_failed":
      return <span style={{ color: COLORS.failed }}>Provisioning failed{p.meta.provisionExitCode !== undefined ? ` · exit ${p.meta.provisionExitCode}` : ""}</span>;
    case "creating":
      return <span style={{ color: COLORS.warn }}>{p.busy ? "In progress" : "Not provisioned"}</span>;
    default:
      return <>—</>;
  }
}

function useEnvSet(names: string[]): Record<string, boolean> {
  const [set, setSet] = useState<Record<string, boolean>>({});
  const key = names.join(",");
  useEffect(() => {
    if (!key) return;
    api.env(key.split(",")).then(setSet, () => {});
  }, [key]);
  return set;
}
