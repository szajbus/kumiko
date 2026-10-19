import { useEffect, useState } from "react";
import type { AccountUsage, UsageWindow } from "@bentomo/shared";
import { api, RequestError } from "./api";

/** How often the numbers are re-read while the session is open. */
const REFRESH_MS = 60_000;

interface Props {
  sessionId: string;
  /** The session's process is still running; there is nothing to ask once it has ended. */
  live: boolean;
  /** True between turns: a finished turn has just used some of the limits, so it triggers a refresh. */
  turnDone: boolean;
}

/** The Claude account the session runs as, and how much of each subscription limit is used and left. */
export function UsageStrip({ sessionId, live, turnDone }: Props) {
  const [usage, setUsage] = useState<AccountUsage | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    let stopped = false;
    const load = () =>
      api
        .usage(sessionId)
        .then((u) => !stopped && (setUsage(u), setError(undefined)))
        .catch((err) => !stopped && setError(err instanceof RequestError ? err.message : String(err)));
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // A finished turn restarts the timer along with the fetch.
  }, [sessionId, live, turnDone]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);

  if (!usage) return error ? <div className="usage-strip dim" title={error}>Usage unavailable</div> : null;
  const stale = error ? ` (couldn't refresh: ${error})` : "";
  return (
    <div className="usage-strip" title={`Updated ${new Date(usage.fetchedAt).toLocaleTimeString()}${stale}`}>
      {(usage.email || usage.plan) && (
        <span className="usage-account">
          <span className="usage-email" title="Claude account this sandbox is signed in to">
            {usage.email ?? "Signed in"}
          </span>
          {usage.plan && <span className="badge">{planName(usage.plan)}</span>}
        </span>
      )}
      {usage.windows.map((w) => (
        <Window key={w.id} w={w} now={now} />
      ))}
      {usage.error && (
        <span className="dim" title={usage.error}>
          Usage unavailable
        </span>
      )}
    </div>
  );
}

function Window({ w, now }: { w: UsageWindow; now: number }) {
  const used = Math.round(w.usedPercent);
  const left = 100 - used;
  const level = used >= 90 ? " is-high" : used >= 70 ? " is-warn" : "";
  const reset = w.resetsAt ? resetText(Date.parse(w.resetsAt) - now) : undefined;
  return (
    <span className={`usage-window${level}`} title={`${w.label}: ${used}% used, ${left}% left${w.resetsAt ? `. Resets ${new Date(w.resetsAt).toLocaleString()}` : ""}`}>
      <span>{w.label}</span>
      <span className="usage-bar" role="meter" aria-label={`${w.label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={used}>
        <span style={{ width: `${used}%` }} />
      </span>
      <span className="mono usage-left">{left}% left</span>
      {reset && <span className="dim">{reset}</span>}
    </span>
  );
}

function planName(plan: string): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** "resets in 2h 5m", "resets in 3d 4h"; empty once the time has passed. */
export function resetText(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const m = Math.ceil(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `resets in ${d}d ${h}h`;
  if (h > 0) return `resets in ${h}h ${m % 60}m`;
  return `resets in ${m}m`;
}
