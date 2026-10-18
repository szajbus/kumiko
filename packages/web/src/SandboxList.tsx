import { useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import type { LogLine, SandboxView } from "@bentomo/shared";
import { api, RequestError, type LiveState } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Header } from "./Header";
import { Dots, EmptyBento, Play, Plus, Redo, Square, Trash, Wrench } from "./icons";
import { LogDrawer } from "./LogDrawer";
import { resources, statusOf } from "./status";

interface Props {
  live: LiveState;
  selected?: string;
  onSelect(name: string): void;
  onNew(): void;
}

type Pending = { kind: "delete" | "recreate"; sandbox: SandboxView };

export function SandboxList({ live, selected, onSelect, onNew }: Props) {
  const [confirm, setConfirm] = useState<Pending | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();

  const run = async (name: string, fn: (n: string) => Promise<unknown>) => {
    setActionError(undefined);
    onSelect(name);
    try {
      await fn(name);
    } catch (err) {
      setActionError(err instanceof RequestError ? err.message : String(err));
    }
  };

  const sel = live.sandboxes.find((s) => s.name === selected);
  const empty = live.loaded && live.sandboxes.length === 0;
  // An empty list needs no drawer, except to show why a create failed before Lima knew the VM.
  const showDrawer = live.sandboxes.length > 0 || Boolean(selected && live.logs[selected]?.at(-1)?.kind === "err");

  return (
    <div className="app app-list">
      <Header />

      <div className="list-layout">
        <main className="list-main">
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
                  <Row
                    key={sb.name}
                    sb={sb}
                    log={live.logs[sb.name]}
                    selected={sb.name === selected}
                    onSelect={() => onSelect(sb.name)}
                    onStart={() => run(sb.name, api.start)}
                    onStop={() => run(sb.name, api.stop)}
                    onProvision={() => run(sb.name, api.provision)}
                    onRecreate={() => setConfirm({ kind: "recreate", sandbox: sb })}
                    onDelete={() => setConfirm({ kind: "delete", sandbox: sb })}
                  />
                ))}
              </div>
            </div>
          )}
        </main>

        {showDrawer && <LogDrawer name={selected} sandbox={sel} lines={(selected && live.logs[selected]) || []} />}
      </div>

      {/* A toast rather than a banner, so a failed action doesn't push the table around. */}
      {actionError && (
        <div className="toast" role="alert">
          <span>{actionError}</span>
          <button type="button" className="toast-close" onClick={() => setActionError(undefined)} aria-label="Dismiss">
            <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.kind === "delete" ? `Delete ${confirm.sandbox.vm}?` : `Recreate ${confirm.sandbox.vm}?`}
          confirmLabel={confirm.kind === "delete" ? `Delete ${confirm.sandbox.vm}` : `Recreate ${confirm.sandbox.vm}`}
          danger
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => {
            const { kind, sandbox } = confirm;
            setConfirm(undefined);
            void run(sandbox.name, kind === "delete" ? api.remove : api.recreate);
          }}
        >
          {confirm.kind === "delete" ? (
            <p>The VM and its disk are removed for good. Mounted host folders are not touched.</p>
          ) : (
            <p>The VM and its disk are deleted, then created again from the same settings and provisioned from scratch.</p>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}

interface RowProps {
  sb: SandboxView;
  log?: LogLine[];
  selected: boolean;
  onSelect(): void;
  onStart(): void;
  onStop(): void;
  onProvision(): void;
  onRecreate(): void;
  onDelete(): void;
}

function Row(p: RowProps) {
  const { sb } = p;
  const status = statusOf(sb, p.log);
  const running = sb.status === "running";
  const failed = sb.meta?.setup === "provision_failed";

  return (
    <div className={`table-row sandbox-row${p.selected ? " is-selected" : ""}`}>
      <button type="button" className="row-name" onClick={p.onSelect} aria-label={`Show log for ${sb.vm}`} aria-pressed={p.selected}>
        <span className="row-title">{sb.name}</span>
        <span className="row-sub">
          <span className="mono dim">{sb.vm}</span>
          <span className="badge">Lima</span>
        </span>
      </button>

      <div className="row-status" style={{ color: status.color }}>
        {sb.busy ? <span className="spinner" aria-hidden="true" /> : <span className="dot" style={{ background: status.color }} aria-hidden="true" />}
        <span>{status.text}</span>
      </div>

      <span className="mono row-res">{resources(sb)}</span>

      <div className="row-actions">
        {running ? (
          <button type="button" className="icon-btn" disabled={sb.busy} onClick={p.onStop} aria-label={`Stop ${sb.vm}`} title="Stop">
            <Square />
          </button>
        ) : (
          <button
            type="button"
            className="icon-btn"
            disabled={sb.busy || sb.status === "unknown"}
            onClick={p.onStart}
            aria-label={`Start ${sb.vm}`}
            title="Start"
          >
            <Play />
          </button>
        )}
        <Menu.Root modal={false}>
          <Menu.Trigger className="icon-btn" disabled={sb.busy} aria-label={`More actions for ${sb.vm}`} title="More">
            <Dots />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content className="menu" align="end" sideOffset={6} collisionPadding={8} aria-label={`Actions for ${sb.vm}`}>
              <Menu.Item className="menu-item" disabled={!failed} onSelect={p.onProvision}>
                <Wrench />
                Re-run provisioning
              </Menu.Item>
              <Menu.Item className="menu-item" disabled={!sb.meta} onSelect={p.onRecreate}>
                <Redo />
                Recreate
              </Menu.Item>
              <Menu.Separator className="menu-separator" />
              <Menu.Item className="menu-item danger" onSelect={p.onDelete}>
                <Trash />
                Delete
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
      </div>
    </div>
  );
}
