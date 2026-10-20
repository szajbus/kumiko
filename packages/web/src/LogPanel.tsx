import { useLayoutEffect, useRef } from "react";
import type { LogLine, SandboxView } from "@kumiko/shared";
import { opPill } from "./status";

const LINE_COLORS = { cmd: "#8A93A3", note: "#8A93A3", ok: "#7FD3A6", err: "#F29B8F" } as const;

/** The current or last operation's output, following new lines while the reader is at the bottom. */
export function LogPanel({ sandbox, lines }: { sandbox?: SandboxView; lines: LogLine[] }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const pill = opPill(sandbox);

  return (
    <section className="card log-panel" aria-labelledby="log-title">
      <div className="log-head">
        <h2 id="log-title">Log</h2>
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
        {lines.length === 0 && <div className="log-empty">No operation has run on this sandbox since Kumiko started.</div>}
        {lines.map((l, i) => (
          <div key={i} className="log-line" style={l.kind ? { color: LINE_COLORS[l.kind] } : undefined}>
            {l.text || " "}
          </div>
        ))}
      </div>
    </section>
  );
}
