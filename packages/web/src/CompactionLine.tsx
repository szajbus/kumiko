import { useEffect, useState } from "react";
import type { SessionStream } from "./api";
import { compactionText, type CompactionItem } from "./compaction";
import { applyContextEvent, contextMeter, type ContextState } from "./context";
import { Markdown } from "./Markdown";
import { useFold } from "./useFold";

/**
 * Claude compacting its conversation: a rule across the chat with a pill saying how it went. Done, the pill opens the
 * summary Claude kept, which is all it knows now of the chat above.
 */
export function CompactionLine({ item }: { item: CompactionItem }) {
  const [open, setOpen] = useState(false);
  const elapsed = useElapsed(item.status === "running");
  return (
    <div className="compaction">
      <div className="compaction-line">
        <span className={`compaction-pill is-${item.status}`} title={item.status === "failed" ? item.error : undefined}>
          {item.status === "running" && <span className="spinner" aria-hidden="true" />}
          <span>{compactionText(item)}</span>
          {item.status === "running" && elapsed >= 1 && <span className="compaction-time">{clock(elapsed)}</span>}
          {item.summary && (
            <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
              Summary <span className={`tri${open ? "" : " is-right"}`} aria-hidden="true" />
            </button>
          )}
        </span>
      </div>
      {open && item.summary && (
        <div className="compaction-summary">
          <div className="compaction-summary-head">What Claude kept</div>
          <div className="compaction-summary-body">
            <Markdown text={item.summary} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Seconds since `running` became true, counting while it is. */
function useElapsed(running: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    setSeconds(0);
    const tick = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(tick);
  }, [running]);
  return seconds;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** How full the context is, folded from the session's events incrementally, as the chat is. */
export function useContextState(events: SessionStream["events"]): ContextState | undefined {
  return useFold<ContextState | undefined>(events, () => undefined, (state, added) => added.reduce(applyContextEvent, state));
}

/**
 * The meter in the composer's footer: quiet until the context nears auto-compaction, then saying how close it is, and
 * offering to compact now once it's very near.
 */
export function ContextMeterView({ context, onCompact }: { context?: ContextState; onCompact?: () => void }) {
  if (context?.compacting) {
    return (
      <span className="ctx is-running" role="status">
        <span className="spinner" aria-hidden="true" />
        Compacting…
      </span>
    );
  }
  const meter = contextMeter(context);
  if (!meter) return null;
  return (
    <>
      <span className={`ctx is-${meter.level}`} title={meter.title}>
        <span className="ctx-bar" role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={meter.percent}>
          <span style={{ width: `${meter.percent}%` }} />
        </span>
        {meter.text}
      </span>
      {meter.compactNow && onCompact && (
        <button type="button" className="ctx-act" title="Send /compact: Claude sums up the conversation so far, to free up its context" onClick={onCompact}>
          Compact now
        </button>
      )}
    </>
  );
}
