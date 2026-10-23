import { useCallback, useEffect, useState } from "react";
import { isBusy, isWaiting, projectMountRole, vmName, type LogLine, type ProjectView, type SessionInfo, type WorktreeStatus, type WorktreesResponse } from "@kumiko/shared";
import { SandboxActions, useActions } from "./actions";
import { AgentSetupCard } from "./AgentSetup";
import { api, errorMessage, useHome, type LiveState } from "./api";
import { Breadcrumbs } from "./Breadcrumbs";
import { FinishingItem } from "./Finishing";
import { sessionTitle, tilde } from "./format";
import { Folder, Pencil, Plus, Redo } from "./icons";
import { LogPanel } from "./LogPanel";
import { COLORS, failedAgentScripts, plural, sandboxCreatedAt, sessionState, statusOf } from "./status";

interface Props {
  id: string;
  live: LiveState;
  onBack(): void;
  onEdit(): void;
  onNewSession(): void;
  /** A session reopened from the page, whose tab opens. */
  onSessionStarted(id: string): void;
}

/** One project: what needs the user (sessions waiting, worktrees with work in them), then its VM and the VM's log. */
export function ProjectPage({ id, live, onBack, onEdit, onNewSession, onSessionStarted }: Props) {
  const p = live.projects.find((x) => x.name === id);
  const lines = live.logs[id] ?? [];
  const actions = useActions({ onDeleted: onBack });
  const home = useHome();
  const sessions = live.sessions.filter((s) => s.sandbox === id);

  return (
    <>
      <main className="page">
        <Breadcrumbs items={[{ label: "Projects", href: "#/" }, { label: id }]} />
        {!p ? (
          <div className="page-head">
            <div className="detail-title">
              <h1 className="page-title">{id}</h1>
              <span className="mono dim">{vmName(id)}</span>
            </div>
          </div>
        ) : (
          <DetailHead p={p} home={home} lines={lines}>
            <button
              type="button"
              className="btn btn-primary btn-compact"
              disabled={p.status !== "running" || p.busy}
              title={p.status === "running" ? "Start a Claude session in this project" : "Start the sandbox first"}
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

        {!p && live.loaded && <div className="banner banner-warn">There is no project {id}{lines.length ? "; its last log is below." : "."}</div>}
        {p?.problem && (
          <div className="banner banner-error">
            <strong>A folder this project needs is missing.</strong>
            <span>{p.problem}</span>
          </div>
        )}
        {p?.metaError && (
          <div className="banner banner-error">
            <strong>Kumiko's record of this project's sandbox is unreadable.</strong>
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
            {p.vm} doesn't exist: its creation failed, or it was deleted outside Kumiko. Recreate it from the menu to use this project.
          </div>
        )}

        {p && (
          <div className="detail-grid">
            <SessionsCard sessions={sessions} onOpened={onSessionStarted} />
            <WorktreesCard p={p} home={home} />
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

function DetailHead({ p, home, lines, children }: { p: ProjectView; home?: string; lines: LogLine[]; children: React.ReactNode }) {
  const status = statusOf(p, lines);
  return (
    <div className="page-head">
      <div className="detail-title">
        <h1 className="page-title">{p.name}</h1>
        <span className="row-sub">
          <span className="mono dim" title={p.project.clonePath}>
            {tilde(p.project.clonePath, home)}
          </span>
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

/** The project's open sessions, the ones waiting on the user first, then those Claude finishes after their tab closed. */
function SessionsCard({ sessions: all, onOpened }: { sessions: SessionInfo[]; onOpened(id: string): void }) {
  const sessions = all.filter((s) => !s.closing);
  const sorted = [...sessions].sort((a, b) => Number(isWaiting(b)) - Number(isWaiting(a)));
  const waiting = sessions.filter(isWaiting).length;
  const finishing = all.filter((s) => s.closing);
  return (
    <section className="card section" aria-labelledby="p-sessions">
      <div className="card-head">
        <h2 id="p-sessions">Sessions</h2>
        {waiting > 0 && <span className="badge badge-warn">{waiting} waiting on you</span>}
      </div>
      {sorted.length === 0 && !finishing.length && <p className="muted">No open sessions. Resume saved ones from a New session tab.</p>}
      <ul className="item-list">
        {sorted.map((s) => {
          const st = sessionState(s);
          return (
            <li key={s.id} className="item">
              <a className="item-main" href={`#/session/${s.id}`} title={s.prompt}>
                <span className="item-title">{sessionTitle(s)}</span>
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
    </section>
  );
}

const POLL_MS = 10_000;

/** Reads the project's worktrees now, then every 10 seconds while the window is visible. */
function useWorktrees(id: string, enabled: boolean) {
  const [data, setData] = useState<WorktreesResponse | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.worktrees(id));
      setError(undefined);
    } catch (err) {
      // The last good list stays up; the error says why it may be stale.
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, load]);

  return { data, error, loading, reload: load };
}

/** What needs doing with a worktree comes first: uncommitted or unpushed work, then ones ready to clean up. */
const rank = (w: WorktreeStatus) => (w.main ? 0 : w.dirty || w.unpushed > 0 ? 1 : w.merged || w.prunable ? 2 : 3);

function WorktreesCard({ p, home }: { p: ProjectView; home?: string }) {
  const { data, error, loading, reload } = useWorktrees(p.name, !p.problem);
  const list = [...(data?.worktrees ?? [])].sort((a, b) => rank(a) - rank(b));
  const inWorktrees = (path: string) => (path.startsWith(p.project.worktreesPath + "/") ? path.slice(p.project.worktreesPath.length + 1) : tilde(path, home));

  return (
    <section className="card section" aria-labelledby="p-worktrees">
      <div className="card-head">
        <h2 id="p-worktrees">Worktrees</h2>
        <button type="button" className="icon-btn icon-btn-small" title="Check again" aria-label="Check worktrees again" disabled={loading || Boolean(p.problem)} onClick={() => void reload()}>
          <Redo />
        </button>
      </div>
      {p.problem && <p className="muted">Unavailable while a folder is missing.</p>}
      {error && <div className="banner banner-error">{error}</div>}
      {!p.problem && !data && !error && <p className="muted">Reading…</p>}
      {data && list.length === 1 && <p className="muted">No worktrees yet. Claude makes one in {tilde(p.project.worktreesPath, home)} when a task changes code.</p>}
      <ul className="item-list">
        {list.map((w) => (
          <li key={w.path} className="item">
            <div className="item-main">
              <span className="item-title mono">{w.branch ?? `detached at ${w.head?.slice(0, 7) ?? "?"}`}</span>
              {/* Worktrees usually sit in a folder named after their branch; only say where when it isn't. */}
              {(w.main || inWorktrees(w.path) !== w.branch) && (
                <span className="mono dim item-sub" title={w.path}>
                  {w.main ? "the clone" : inWorktrees(w.path)}
                </span>
              )}
            </div>
            <span className="item-badges">
              <WorktreeBadges w={w} />
            </span>
          </li>
        ))}
      </ul>
      {data && (
        <p className="muted form-note">
          {data.defaultBranch ? (
            <>
              Merged means contained in <span className="mono">{data.defaultBranch}</span> as of the last fetch.
            </>
          ) : (
            "No remote default branch, so nothing shows as merged."
          )}
        </p>
      )}
    </section>
  );
}

function WorktreeBadges({ w }: { w: WorktreeStatus }) {
  if (w.prunable) return <span className="badge badge-warn" title="Its folder is gone; `git worktree prune` removes the entry.">Folder gone</span>;
  if (w.error) return <span className="badge badge-warn" title={w.error}>Can't read</span>;
  const clean = !w.dirty && w.unpushed === 0;
  return (
    <>
      {w.locked && <span className="badge">Locked</span>}
      {w.dirty && <span className="badge badge-warn">Uncommitted changes</span>}
      {w.unpushed > 0 && (
        <span className="badge badge-sessions" title={w.upstream ? `Ahead of ${w.upstream}` : "On no remote"}>
          {plural(w.unpushed, "unpushed commit")}
        </span>
      )}
      {w.merged && (
        <span className="badge badge-ok" title="Contained in the remote's default branch">
          {clean ? "Merged · ready to clean up" : "Merged"}
        </span>
      )}
      {clean && !w.merged && !w.locked && <span className="dim item-quiet">Clean</span>}
    </>
  );
}

const MOUNT_ROLE = { clone: "Clone", worktrees: "Worktrees", "claude-home": "Claude home", "kumiko-home": "Kumiko folder" } as const;

function Details({ p, home }: { p: ProjectView; home?: string }) {
  const spec = p.meta?.spec;
  const envSet = useEnvSet(spec?.env ?? []);
  const gib = (n?: number) => (n === undefined ? "—" : `${n} GiB`);
  const created = sandboxCreatedAt(p);

  return (
    <>
      <div className="form-group-head">
        <h2>Sandbox</h2>
      </div>
      <section className="card facts" aria-label="Sandbox">
        <Fact label="CPUs">{p.cpus ?? spec?.cpus ?? "—"}</Fact>
        <Fact label="Memory">{gib(p.memoryGiB ?? spec?.memoryGiB)}</Fact>
        <Fact label="Disk">{gib(p.diskGiB ?? spec?.diskGiB)}</Fact>
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
            {spec.mounts.map((m) => {
              const role = projectMountRole(p.project, m);
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

function Fact({ label, mono, children }: { label: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <div className="fact">
      <span className="eyebrow">{label}</span>
      <span className={`fact-value${mono ? " mono" : ""}`}>{children}</span>
    </div>
  );
}

function SetupState({ p }: { p: ProjectView }) {
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
