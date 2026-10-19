import { useEffect, useState } from "react";
import type { AccountUsage, UsageWindow } from "@bentomo/shared";
import { api, errorMessage } from "./api";
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

/** The session's memory and cost, how much of each subscription limit is used, and the Claude account it runs as. */
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

  // A failed read never hides the last numbers; it only adds a warning.
  const problem = usage?.error ?? (error && `Couldn't refresh usage: ${error}`);
  const windows = SHOWN.flatMap((id) => usage?.windows.find((w) => w.id === id) ?? []);
  return (
    <div className="usage-strip" title={usage ? `Usage updated ${new Date(usage.fetchedAt).toLocaleTimeString()}` : undefined}>
      {bufferBytes !== undefined && (
        <span className="usage-item" title="Memory this session's chat takes in Bentomo's server, as of the last finished turn. Tool output past 64 KB isn't kept.">
          <span>Memory</span>
          <span className="mono">{formatBytes(bufferBytes)}</span>
        </span>
      )}
      {cost > 0 && (
        <span className="usage-item" title="Total cost of this session">
          <span>Cost</span>
          <span className="mono">{formatCost(cost)}</span>
        </span>
      )}
      {windows.map((w) => (
        <Window key={w.id} w={w} now={now} />
      ))}
      {problem && (
        <span className="usage-warning" role="img" aria-label="Usage warning" title={problem}>
          ⚠
        </span>
      )}
      {usage && (usage.email || usage.plan) && (
        <span className="usage-account" title="Claude account this sandbox is signed in to">
          <span className="usage-email">{usage.email ?? "Signed in"}</span>
          {usage.plan && <span className="badge">{planName(usage.plan)}</span>}
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
  const when = w.resetsAt ? `${reset ?? "resets"} (${new Date(w.resetsAt).toLocaleString()})` : undefined;
  return (
    <span className={`usage-window${level}`} title={`${w.label}: ${used}% used, ${left}% left${when ? `; ${when}` : ""}`}>
      <span>{w.label}</span>
      <span className="usage-bar" role="meter" aria-label={`${w.label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={used}>
        <span style={{ width: `${used}%` }} />
      </span>
      <span className="mono usage-left">{used}% used</span>
    </span>
  );
}
