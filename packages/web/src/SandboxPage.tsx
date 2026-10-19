import { useEffect, useState } from "react";
import { vmName, type LogLine, type SandboxView } from "@bentomo/shared";
import { SandboxActions, useActions } from "./actions";
import { api, type LiveState } from "./api";
import { Header } from "./Header";
import { Folder, Pencil } from "./icons";
import { LogPanel } from "./LogPanel";
import { COLORS, statusOf } from "./status";

interface Props {
  name: string;
  live: LiveState;
  onBack(): void;
  onEdit(): void;
}

/** One sandbox: what it is, what it's doing, and its log at full width. */
export function SandboxPage({ name, live, onBack, onEdit }: Props) {
  const sb = live.sandboxes.find((s) => s.name === name);
  const lines = live.logs[name] ?? [];
  const actions = useActions({ onDeleted: onBack });
  const home = useHome();

  return (
    <div className="app">
      <Header>
        <a
          href="#/"
          className="link-back"
          onClick={(e) => {
            e.preventDefault();
            onBack();
          }}
        >
          ← Back to sandboxes
        </a>
      </Header>

      <main className="page">
        {!sb ? (
          <div className="page-head">
            <div className="detail-title">
              <h1 className="page-title">{name}</h1>
              <span className="mono dim">{vmName(name)}</span>
            </div>
          </div>
        ) : (
          <DetailHead sb={sb} lines={lines}>
            {sb.meta && (
              <button type="button" className="btn btn-secondary btn-compact" disabled={sb.busy} onClick={onEdit}>
                <Pencil />
                Edit
              </button>
            )}
            <SandboxActions sb={sb} actions={actions} labeled />
          </DetailHead>
        )}

        {!sb && live.loaded && (
          <div className="banner banner-warn">
            {vmName(name)} doesn't exist{lines.length ? "; its last log is below." : "."}
          </div>
        )}

        {sb && <Details sb={sb} home={home} />}

        {(sb || lines.length > 0) && <LogPanel sandbox={sb} lines={lines} />}
      </main>

      {actions.overlay}
    </div>
  );
}

function DetailHead({ sb, lines, children }: { sb: SandboxView; lines: LogLine[]; children: React.ReactNode }) {
  const status = statusOf(sb, lines);
  return (
    <div className="page-head">
      <div className="detail-title">
        <h1 className="page-title">{sb.name}</h1>
        <span className="row-sub">
          <span className="mono dim">{sb.vm}</span>
          <span className="badge">Lima</span>
        </span>
      </div>
      <div className="detail-head-right">
        <span className="row-status" style={{ color: status.color }}>
          {sb.busy ? <span className="spinner" aria-hidden="true" /> : <span className="dot" style={{ background: status.color }} aria-hidden="true" />}
          {status.text}
        </span>
        {children}
      </div>
    </div>
  );
}

function Details({ sb, home }: { sb: SandboxView; home?: string }) {
  const spec = sb.meta?.spec;
  const envSet = useEnvSet(spec?.env ?? []);
  const tilde = (p: string) => (home && (p === home || p.startsWith(home + "/")) ? `~${p.slice(home.length)}` : p);
  const gib = (n?: number) => (n === undefined ? "—" : `${n} GiB`);

  return (
    <>
      <section className="card facts" aria-label="Details">
        <Fact label="CPUs">{sb.cpus ?? spec?.cpus ?? "—"}</Fact>
        <Fact label="Memory">{gib(sb.memoryGiB ?? spec?.memoryGiB)}</Fact>
        <Fact label="Disk">{gib(sb.diskGiB ?? spec?.diskGiB)}</Fact>
        <Fact label="Template" mono>
          {spec ? spec.template || "template:default" : "—"}
        </Fact>
        <Fact label="Setup">
          <SetupState sb={sb} />
        </Fact>
        <Fact label="Created">{sb.meta ? new Date(sb.meta.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—"}</Fact>
      </section>

      {!sb.meta && (
        <p className="muted">This VM wasn't created by Bentomo, so there are no mounts, variables or provisioning on record.</p>
      )}

      {spec && (
        <div className="detail-grid">
          <section className="card section" aria-labelledby="d-mounts">
            <h2 id="d-mounts">Mounts</h2>
            {spec.mounts.length === 0 && <p className="muted">None.</p>}
            {spec.mounts.map((m) => (
              <div key={m.hostPath + (m.guestPath ?? "")} className="detail-mount mount-grid">
                <span className="mount-icon">
                  <Folder />
                </span>
                <span className="mono path" title={m.hostPath}>
                  {tilde(m.hostPath)}
                </span>
                <span className="badge">{m.writable ? "Writable" : "Read-only"}</span>
                <span className="mount-at">at</span>
                <span className="mono path">{m.guestPath ?? m.hostPath}</span>
              </div>
            ))}
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
          <summary>Provisioning script{spec.provision ? ` · ${spec.provision.split("\n").length} lines` : ": none"}</summary>
          {spec.provision ? <pre className="mono preview">{spec.provision}</pre> : <p className="muted details-empty">No provisioning command.</p>}
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

function SetupState({ sb }: { sb: SandboxView }) {
  switch (sb.meta?.setup) {
    case "ready":
      return <span style={{ color: COLORS.running }}>Ready</span>;
    case "provision_failed":
      return <span style={{ color: COLORS.failed }}>Provisioning failed{sb.meta.provisionExitCode !== undefined ? ` · exit ${sb.meta.provisionExitCode}` : ""}</span>;
    case "creating":
      return <span style={{ color: COLORS.warn }}>{sb.busy ? "In progress" : "Not provisioned"}</span>;
    default:
      return <>—</>;
  }
}

function useHome(): string | undefined {
  const [home, setHome] = useState<string | undefined>();
  useEffect(() => {
    api.defaults().then((d) => setHome(d.home), () => {});
  }, []);
  return home;
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
