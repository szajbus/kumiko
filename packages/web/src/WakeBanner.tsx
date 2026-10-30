import { useEffect, useState } from "react";
import type { LogLine, SandboxView } from "@kumiko/shared";
import { LogPanel } from "./LogPanel";
import { wakeProgress } from "./wake";

/** The sandbox of an asleep session and its log, for its banner to say what starting it is doing. */
export interface WakeContext {
  sandbox?: SandboxView;
  log: LogLine[];
}

/**
 * The banner of a session opened asleep: a button that starts its sandbox, then, while the sandbox and Claude start,
 * however the sandbox was started, a spinner, the time since, the step under way, and the log's last line, with the
 * whole log a click away.
 */
export function WakeBanner({ wake, waking, onStart }: { wake?: WakeContext; waking: boolean; onStart(): void }) {
  const starting = waking || wake?.sandbox?.busy === true;
  const since = useSince(starting);
  const [showLog, setShowLog] = useState(false);
  if (!starting) {
    return (
      <div className="banner banner-info">
        <span className="banner-text">Start the sandbox to resume this session.</span>
        <button type="button" className="btn btn-primary btn-compact" onClick={onStart}>
          Start sandbox
        </button>
      </div>
    );
  }
  const progress = wakeProgress(wake?.sandbox, wake?.log ?? []);
  return (
    <div className="banner banner-info wake-banner" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="banner-text">
        <strong>{progress.text}</strong>
        {since !== undefined && <span className="wake-elapsed"> · {elapsed(since)}</span>}
      </span>
      {wake?.sandbox && (
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setShowLog(!showLog)}>
          {showLog ? "Hide log" : "Show log"}
        </button>
      )}
      <div className="wake-steps">
        {progress.steps.map((s, n) => (
          <span key={s.label} className={`wake-step is-${s.state}`}>
            {n > 0 && <span className="wake-sep" aria-hidden="true">›</span>}
            {s.state === "done" ? "✓ " : ""}
            {s.label}
          </span>
        ))}
      </div>
      {progress.line && !showLog && <div className="wake-line mono">{progress.line}</div>}
      {showLog && wake?.sandbox && (
        <div className="wake-log">
          <LogPanel sandbox={wake.sandbox} lines={wake.log} />
        </div>
      )}
    </div>
  );
}

/** When `on` last became true, re-rendering every second while it stays so; undefined while it is false. */
function useSince(on: boolean): number | undefined {
  const [since, setSince] = useState<number | undefined>();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on) return setSince(undefined);
    setSince(Date.now());
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
  return since;
}

const elapsed = (since: number) => {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
