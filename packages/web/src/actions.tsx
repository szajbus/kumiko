import { useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import type { SandboxView } from "@bentomo/shared";
import { api, RequestError } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Dots, Play, Redo, Square, Trash, Wrench } from "./icons";

type Pending = { kind: "delete" | "recreate"; sandbox: SandboxView };

export interface Actions {
  start(name: string): void;
  stop(name: string): void;
  provision(name: string): void;
  askRecreate(sb: SandboxView): void;
  askDelete(sb: SandboxView): void;
  /** The confirm dialog and the error toast; render once per page. */
  overlay: React.ReactNode;
}

/** Sandbox actions with a confirm step for destructive ones and a toast when the server refuses. */
export function useActions({ onDeleted }: { onDeleted?(name: string): void } = {}): Actions {
  const [confirm, setConfirm] = useState<Pending | undefined>();
  const [error, setError] = useState<string | undefined>();

  const run = async (name: string, fn: (n: string) => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn(name);
      return true;
    } catch (err) {
      setError(err instanceof RequestError ? err.message : String(err));
      return false;
    }
  };

  const overlay = (
    <>
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === "delete" ? `Delete ${confirm.sandbox.vm}?` : `Recreate ${confirm.sandbox.vm}?`}
          confirmLabel={confirm.kind === "delete" ? `Delete ${confirm.sandbox.vm}` : `Recreate ${confirm.sandbox.vm}`}
          danger
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => {
            const { kind, sandbox } = confirm;
            setConfirm(undefined);
            if (kind === "recreate") void run(sandbox.name, api.recreate);
            else void run(sandbox.name, api.remove).then((ok) => ok && onDeleted?.(sandbox.name));
          }}
        >
          {confirm.kind === "delete" ? (
            <p>The VM and its disk are removed for good. Mounted host folders are not touched.</p>
          ) : (
            <p>The VM and its disk are deleted, then created again from the same settings and provisioned from scratch.</p>
          )}
        </ConfirmDialog>
      )}
      {/* A toast rather than a banner, so a failed action doesn't push the page around. */}
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button type="button" className="toast-close" onClick={() => setError(undefined)} aria-label="Dismiss">
            <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </>
  );

  return {
    start: (n) => void run(n, api.start),
    stop: (n) => void run(n, api.stop),
    provision: (n) => void run(n, api.provision),
    askRecreate: (sandbox) => setConfirm({ kind: "recreate", sandbox }),
    askDelete: (sandbox) => setConfirm({ kind: "delete", sandbox }),
    overlay,
  };
}

/** Start or Stop, plus a menu with Re-run provisioning, Recreate and Delete. `labeled` shows text on the main button. */
export function SandboxActions({ sb, actions, labeled }: { sb: SandboxView; actions: Actions; labeled?: boolean }) {
  const running = sb.status === "running";
  const failed = sb.meta?.setup === "provision_failed";
  const main = running
    ? { label: "Stop", icon: <Square />, disabled: sb.busy, onClick: () => actions.stop(sb.name) }
    : { label: "Start", icon: <Play />, disabled: sb.busy || sb.status === "unknown", onClick: () => actions.start(sb.name) };

  return (
    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
      {labeled ? (
        <button type="button" className="btn btn-secondary btn-compact" disabled={main.disabled} onClick={main.onClick}>
          {main.icon}
          {main.label}
        </button>
      ) : (
        <button type="button" className="icon-btn" disabled={main.disabled} onClick={main.onClick} aria-label={`${main.label} ${sb.vm}`} title={main.label}>
          {main.icon}
        </button>
      )}
      <Menu.Root modal={false}>
        <Menu.Trigger className="icon-btn" disabled={sb.busy} aria-label={`More actions for ${sb.vm}`} title="More">
          <Dots />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content className="menu" align="end" sideOffset={6} collisionPadding={8} aria-label={`Actions for ${sb.vm}`}>
            <Menu.Item className="menu-item" disabled={!failed} onSelect={() => actions.provision(sb.name)}>
              <Wrench />
              Re-run provisioning
            </Menu.Item>
            <Menu.Item className="menu-item" disabled={!sb.meta} onSelect={() => actions.askRecreate(sb)}>
              <Redo />
              Recreate
            </Menu.Item>
            <Menu.Separator className="menu-separator" />
            <Menu.Item className="menu-item danger" onSelect={() => actions.askDelete(sb)}>
              <Trash />
              Delete
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
