import { useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import type { SandboxView } from "@kumiko/shared";
import { api, errorMessage } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Dots, Play, Redo, Restart, Square, Trash } from "./icons";
import { plural } from "./status";

type Pending = { kind: "delete" | "recreate" | "restart" | "stop"; sandbox: SandboxView };

/** What each dialog asks about: deleting takes the whole sandbox, the others only its VM. */
const TITLES = {
  delete: (p: SandboxView) => `Delete sandbox ${p.name}?`,
  recreate: (p: SandboxView) => `Rebuild ${p.vm}?`,
  restart: (p: SandboxView) => `Restart ${p.vm}?`,
  stop: (p: SandboxView) => `Stop ${p.vm}?`,
} as const;
const LABELS = { delete: "Delete sandbox", recreate: "Rebuild sandbox", restart: "Restart sandbox", stop: "Stop sandbox" } as const;

/** The line a confirm dialog adds when the sandbox has live agent sessions. */
export function sessionsNote(sb: SandboxView) {
  return sb.sessions > 0 ? <p className="dialog-note">{plural(sb.sessions, "live agent session")} in it will end first.</p> : null;
}

export interface Actions {
  start(name: string): void;
  /** Stops at once, or asks first when the sandbox has live sessions. */
  stop(sb: SandboxView): void;
  /** Restarts at once, or asks first when the sandbox has live sessions. */
  restart(sb: SandboxView): void;
  askRecreate(sb: SandboxView): void;
  askDelete(sb: SandboxView): void;
  /** The confirm dialog and the error toast; render once per page. */
  overlay: React.ReactNode;
}

/** Sandbox and VM actions with a confirm step for destructive ones and a toast when the server refuses. */
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
          title={TITLES[confirm.kind](confirm.sandbox)}
          confirmLabel={LABELS[confirm.kind]}
          danger={confirm.kind === "delete"}
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => {
            const { kind, sandbox } = confirm;
            setConfirm(undefined);
            if (kind === "recreate") void run(sandbox.name, api.recreate);
            else if (kind === "stop") void run(sandbox.name, api.stop);
            else if (kind === "restart") void run(sandbox.name, api.restart);
            else void run(sandbox.name, api.remove).then((ok) => ok && onDeleted?.(sandbox.name));
          }}
        >
          {confirm.kind === "delete" && (
            <>
              <p>
                This deletes the sandbox's VM and its workspace disk, with everything in <span className="mono">/workspace</span>: clones, worktrees
                and work that isn't pushed. Its Claude home (its login and Claude's history) and its saved sessions go too. You can't undo this.
              </p>
              <p>Branches on GitHub and folders mounted from this Mac stay as they are.</p>
            </>
          )}
          {confirm.kind === "recreate" && (
            <>
              <p>The VM is deleted and created again from its settings: Claude Code, your provisioning script, then Claude's setup scripts.</p>
              <p>
                <span className="mono">/workspace</span> stays as it is: clones, worktrees, stashes, uncommitted work, <span className="mono">node_modules</span>.
                So do Claude's home, with its login and history, and the Kumiko folder.
              </p>
            </>
          )}
          {confirm.kind === "stop" && <p>The sandbox shuts down. Saved sessions can be resumed once it runs again.</p>}
          {confirm.kind === "restart" && <p>The sandbox shuts down and starts again, with its disks as they were. Saved sessions can be resumed once it runs.</p>}
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
    restart: (sandbox) => (sandbox.sessions > 0 ? setConfirm({ kind: "restart", sandbox }) : void run(sandbox.name, api.restart)),
    askRecreate: (sandbox) => setConfirm({ kind: "recreate", sandbox }),
    askDelete: (sandbox) => setConfirm({ kind: "delete", sandbox }),
    overlay,
  };
}

/** Start or Stop the VM, plus a menu with Restart, Rebuild and Delete. `labeled` shows text on the main button. */
export function SandboxActions({ sb, actions, labeled }: { sb: SandboxView; actions: Actions; labeled?: boolean }) {
  const running = sb.status === "running";
  const main = running
    ? { label: "Stop", icon: <Square />, disabled: sb.busy, onClick: () => actions.stop(sb) }
    : { label: "Start", icon: <Play />, disabled: sb.busy || sb.status === "unknown" || sb.status === "absent", onClick: () => actions.start(sb.name) };

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
            <Menu.Item className="menu-item" disabled={!running} onSelect={() => actions.restart(sb)}>
              <Restart />
              Restart sandbox
            </Menu.Item>
            <Menu.Item className="menu-item" disabled={Boolean(sb.metaError)} onSelect={() => actions.askRecreate(sb)}>
              <Redo />
              Rebuild sandbox…
            </Menu.Item>
            <Menu.Separator className="menu-separator" />
            <Menu.Item className="menu-item danger" onSelect={() => actions.askDelete(sb)}>
              <Trash />
              Delete sandbox…
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
