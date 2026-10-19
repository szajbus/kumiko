import { useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import type { SandboxView } from "@bentomo/shared";
import { api, errorMessage } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Dots, Play, Redo, Square, Trash } from "./icons";
import { plural } from "./status";

type Pending = { kind: "delete" | "recreate" | "stop"; sandbox: SandboxView };

const TITLES = { delete: "Delete", recreate: "Recreate", stop: "Stop" } as const;

/** The line a confirm dialog adds when the sandbox has live agent sessions. */
export function sessionsNote(sb: SandboxView) {
  return sb.sessions > 0 ? <p className="dialog-note">{plural(sb.sessions, "live agent session")} in it will end first.</p> : null;
}

export interface Actions {
  start(name: string): void;
  /** Stops at once, or asks first when the sandbox has live sessions. */
  stop(sb: SandboxView): void;
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
      setError(errorMessage(err));
      return false;
    }
  };

  const overlay = (
    <>
      {confirm && (
        <ConfirmDialog
          title={`${TITLES[confirm.kind]} ${confirm.sandbox.vm}?`}
          confirmLabel={`${TITLES[confirm.kind]} ${confirm.sandbox.vm}`}
          danger={confirm.kind !== "stop"}
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => {
            const { kind, sandbox } = confirm;
            setConfirm(undefined);
            if (kind === "recreate") void run(sandbox.name, api.recreate);
            else if (kind === "stop") void run(sandbox.name, api.stop);
            else void run(sandbox.name, api.remove).then((ok) => ok && onDeleted?.(sandbox.name));
          }}
        >
          {confirm.kind === "delete" && <p>The VM and its disk are removed for good. Mounted host folders are not touched.</p>}
          {confirm.kind === "recreate" && <p>The VM and its disk are deleted, then created again from the same settings and provisioned from scratch.</p>}
          {confirm.kind === "stop" && <p>The VM shuts down. Claude's transcripts stay in it.</p>}
          {sessionsNote(confirm.sandbox)}
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
    stop: (sandbox) => (sandbox.sessions > 0 ? setConfirm({ kind: "stop", sandbox }) : void run(sandbox.name, api.stop)),
    askRecreate: (sandbox) => setConfirm({ kind: "recreate", sandbox }),
    askDelete: (sandbox) => setConfirm({ kind: "delete", sandbox }),
    overlay,
  };
}

/** Start or Stop, plus a menu with Recreate and Delete. `labeled` shows text on the main button. */
export function SandboxActions({ sb, actions, labeled }: { sb: SandboxView; actions: Actions; labeled?: boolean }) {
  const running = sb.status === "running";
  const main = running
    ? { label: "Stop", icon: <Square />, disabled: sb.busy, onClick: () => actions.stop(sb) }
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
