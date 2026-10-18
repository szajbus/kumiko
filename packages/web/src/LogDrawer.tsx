import { useLayoutEffect, useRef } from "react";
import { vmName, type LogLine, type SandboxView } from "@bentomo/shared";
import { opPill } from "./status";

const LINE_COLORS = { cmd: "#8A93A3", note: "#8A93A3", ok: "#7FD3A6", err: "#F29B8F" } as const;

export function LogDrawer({ name, sandbox, lines }: { name?: string; sandbox?: SandboxView; lines: LogLine[] }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow new output while the reader is at the bottom; leave them be once they scroll up.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, name]);
  useLayoutEffect(() => {
    stick.current = true;
  }, [name]);

  const pill = opPill(sandbox);

  return (
    <aside className="log-drawer" aria-label="Operation log">
      <div className="log-head">
        <div className="log-title">
          <span className="eyebrow">Log</span>
          <span className="mono log-vm">{name ? vmName(name) : "No sandbox selected"}</span>
        </div>
        {pill && (
          <span className="pill" style={{ color: pill.color, borderColor: pill.color }}>
            {pill.text}
          </span>
        )}
      </div>
      <div
        ref={box}
        className="log-box mono"
        role="log"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {!name && <div className="log-empty">Select a sandbox to see the output of its current or last operation.</div>}
        {name && lines.length === 0 && <div className="log-empty">No operation has run in this session yet.</div>}
        {lines.map((l, i) => (
          <div key={i} className="log-line" style={l.kind ? { color: LINE_COLORS[l.kind] } : undefined}>
            {l.text || " "}
          </div>
        ))}
      </div>
    </aside>
  );
}
