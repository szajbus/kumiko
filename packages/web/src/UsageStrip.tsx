import { useEffect, useState } from "react";
import type { AccountUsage, UsageWindow } from "@kumiko/shared";
import { api, errorMessage } from "./api";
import { Corner } from "./Corner";
import { formatBytes, formatCost, planName, resetText } from "./format";

/** How often the numbers are re-read while the session is open, plus up to JITTER_MS so sessions don't all ask at once. */
const REFRESH_MS = 60_000;
const JITTER_MS = 30_000;

/** The windows shown, in order. */
const SHOWN = ["five_hour", "seven_day"];

interface Props {
  sessionId: string;
  /** The session's process is still running; there is nothing to ask once it has ended. */
  live: boolean;
  /** True between turns: a finished turn has just used some of the limits, so it triggers a refresh. */
  turnDone: boolean;
  /** Total cost of the session in USD; hidden while zero. */
  cost: number;
  /** Memory the session's chat takes on the server, when known. */
  bufferBytes?: number;
}

/**
 * In the title bar's corner: how much of each subscription limit is used, as two bars. Clicked, it opens into the
 * details: the Claude account and plan the session runs as, when the limits reset, and the session's memory and cost.
 */
export function UsageStrip({ sessionId, live, turnDone, cost, bufferBytes }: Props) {
  const [usage, setUsage] = useState<AccountUsage | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      api
        .usage(sessionId)
        .then((u) => !stopped && (setUsage(u), setError(undefined)))
        .catch((err) => !stopped && setError(errorMessage(err)))
        .finally(() => {
          if (!stopped) timer = setTimeout(load, REFRESH_MS + Math.random() * JITTER_MS);
        });
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // A finished turn restarts the timer along with the fetch.
  }, [sessionId, live, turnDone]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);

  // A failed read never hides the last numbers; it only adds a warning that they may be out of date.
  const fetchedAt = usage?.fetchedAt && new Date(usage.fetchedAt).toLocaleTimeString();
  const reason = error ? `Couldn't refresh usage: ${error}` : usage?.error;
  const problem = reason && (fetchedAt ? `Usage may be out of date (last read ${fetchedAt}). ${reason}` : reason);
  const shown = SHOWN.map((id) => ({ id, w: usage?.windows.find((w) => w.id === id) }));
  const windows = shown.flatMap(({ w }) => w ?? []);
  const summary = windows.map((w) => `${w.label}: ${Math.round(w.usedPercent)}% used`).join(" · ");
  return (
    <Corner
      label="Session details"
      title={[summary || "Session details", problem && `⚠ ${problem}`].filter(Boolean).join("\n")}
      summary={
        <>
          <span className="usage-bars">
            {shown.map(({ id, w }) => (
              <Bar key={id} w={w} />
            ))}
          </span>
          {problem && (
            <span className="usage-warning" aria-hidden="true">
              ⚠
            </span>
          )}
        </>
      }
    >
      {usage && (usage.email || usage.plan) && (
        <div className="usage-account" title="Claude account this project is logged in to">
          <span className="usage-email">{usage.email ?? "Logged in"}</span>
          {usage.plan && <span className="badge">{planName(usage.plan)}</span>}
        </div>
      )}
      <dl className="corner-list">
        {windows.map((w) => (
          <Window key={w.id} w={w} now={now} />
        ))}
        {bufferBytes !== undefined && (
          <>
            <dt title="Memory this session's chat takes in Kumiko's server, as of the last finished turn. Tool output past 64 KB isn't kept.">Memory</dt>
            <dd className="mono">{formatBytes(bufferBytes)}</dd>
          </>
        )}
        {cost > 0 && (
          <>
            <dt title="Total cost of this session">Cost</dt>
            <dd className="mono">{formatCost(cost)}</dd>
          </>
        )}
      </dl>
      {problem && <p className="usage-problem">⚠ {problem}</p>}
    </Corner>
  );
}

function level(used: number): string {
  return used >= 90 ? " is-high" : used >= 70 ? " is-warn" : "";
}

/** One window's bar in the title bar: an empty track until its numbers are in. */
function Bar({ w }: { w?: UsageWindow }) {
  const used = w ? Math.round(w.usedPercent) : 0;
  return (
    <span className={`usage-bar${level(used)}`}>
      <span style={{ width: `${used}%` }} />
    </span>
  );
}

function Window({ w, now }: { w: UsageWindow; now: number }) {
  const used = Math.round(w.usedPercent);
  const reset = w.resetsAt ? resetText(Date.parse(w.resetsAt) - now) : undefined;
  return (
    <>
      <dt>{w.label}</dt>
      <dd className={`usage-window${level(used)}`}>
        <span className="usage-line">
          <span className="usage-bar" role="meter" aria-label={`${w.label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={used}>
            <span style={{ width: `${used}%` }} />
          </span>
          <span className="mono usage-left">{used}% used</span>
        </span>
        {w.resetsAt && (
          <span className="usage-reset" title={new Date(w.resetsAt).toLocaleString()}>
            {reset ?? "resets"}
          </span>
        )}
      </dd>
    </>
  );
}
