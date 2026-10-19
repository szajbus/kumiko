import { useEffect, useState } from "react";
import { WORKSPACE_DIR, type ResumableSession } from "@bentomo/shared";
import { api, RequestError, type LiveState } from "./api";
import { Composer } from "./Composer";
import { sessionTitle } from "./Header";
import { Trash } from "./icons";
import { Select } from "./Select";

interface Props {
  live: LiveState;
  onStarted(id: string): void;
}

/** Two choices start a session: a running sandbox and an opening prompt. */
export function NewSession({ live, onStarted }: Props) {
  const running = live.sandboxes.filter((s) => s.status === "running" && !s.busy);
  const others = live.sandboxes.filter((s) => !running.includes(s));
  const [picked, setPicked] = useState("");
  const [error, setError] = useState<string | undefined>();

  // Preselect the first running sandbox, and move off one that stops.
  const sandbox = running.some((s) => s.name === picked) ? picked : running[0]?.name ?? "";
  useEffect(() => {
    if (sandbox !== picked) setPicked(sandbox);
  }, [sandbox, picked]);

  const sb = live.sandboxes.find((s) => s.name === sandbox);
  const workdir = sb ? sb.meta?.spec.workdir ?? WORKSPACE_DIR : undefined;

  // Saved sessions that aren't open; re-read when a session opens or closes.
  const [saved, setSaved] = useState<ResumableSession[]>([]);
  const [resuming, setResuming] = useState<string | undefined>();
  const open = live.sessions.map((s) => s.id).join();
  useEffect(() => {
    let current = true;
    api.resumable().then((list) => current && setSaved(list), () => {});
    return () => {
      current = false;
    };
  }, [open]);

  const resume = async (id: string) => {
    setError(undefined);
    setResuming(id);
    try {
      onStarted((await api.resumeSession(id)).id);
    } catch (err) {
      setError(err instanceof RequestError ? err.message : String(err));
    } finally {
      setResuming(undefined);
    }
  };

  const remove = async (id: string) => {
    setError(undefined);
    try {
      await api.deleteSavedSession(id);
      setSaved((list) => list.filter((r) => r.id !== id));
    } catch (err) {
      setError(err instanceof RequestError ? err.message : String(err));
    }
  };

  const start = async (prompt: string) => {
    setError(undefined);
    try {
      const { id } = await api.startSession(sandbox, prompt);
      onStarted(id);
      return true;
    } catch (err) {
      setError(err instanceof RequestError ? err.message : String(err));
      return false;
    }
  };

  return (
    <main className="form-main new-session">
      <div className="form-intro">
        <h1 className="page-title">New session</h1>
        <p className="muted">Claude Code starts in the sandbox's working directory and gets to work on your prompt straight away.</p>
      </div>

      <section className="card section">
        <div className="field">
          <label htmlFor="ns-sandbox">Sandbox</label>
          {live.loaded && live.sandboxes.length === 0 ? (
            <p className="muted form-note">
              No sandboxes yet. <a href="#/new">Create one</a> first.
            </p>
          ) : (
            <Select
              id="ns-sandbox"
              mono
              value={sandbox}
              placeholder={running.length ? "Pick a sandbox" : "No running sandboxes"}
              disabled={running.length === 0}
              onValueChange={setPicked}
              groups={[
                { options: running.map((s) => s.name) },
                ...(others.length ? [{ label: "Not running: start them from Sandboxes", options: others.map((s) => s.name), disabled: true }] : []),
              ]}
            />
          )}
          <span className="hint">
            {workdir ? (
              <>
                Starts in <span className="mono">{workdir}</span>
              </>
            ) : live.sandboxes.length > 0 ? (
              <>
                Start a sandbox from <a href="#/">Sandboxes</a> to begin.
              </>
            ) : null}
          </span>
        </div>

        <div className="field">
          <span className="field-label">Opening prompt</span>
          <Composer label="Opening prompt" submitLabel="Start" placeholder="What should Claude work on?" disabled={!sandbox} onSubmit={start} autoFocus />
        </div>
        {error && <div className="banner banner-error">{error}</div>}
      </section>

      {saved.length > 0 && (
        <section className="card section">
          <div className="section-head">
            <h2>Resume a session</h2>
            <p className="muted form-note">Pick up where you left off, with the chat as it was. Most recent first.</p>
          </div>
          <ul className="resume-list">
            {saved.slice(0, RESUME_LIMIT).map((r) => {
              const runs = live.sandboxes.some((x) => x.name === r.sandbox && x.status === "running" && !x.busy);
              return (
                <li key={r.id} className="resume-item">
                  <div className="resume-what">
                    <span className="resume-title" title={r.prompt}>
                      {sessionTitle(r)}
                    </span>
                    <span className="dim resume-when">{runs ? ago(r.updatedAt ?? r.startedAt) : `${ago(r.updatedAt ?? r.startedAt)} · sandbox not running`}</span>
                  </div>
                  <div className="resume-actions">
                    <button type="button" className="btn btn-secondary btn-compact" disabled={!runs || resuming !== undefined} onClick={() => void resume(r.id)}>
                      Resume
                    </button>
                    <button type="button" className="icon-btn" title="Delete session" aria-label="Delete session" disabled={resuming !== undefined} onClick={() => void remove(r.id)}>
                      <Trash />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}

const RESUME_LIMIT = 20;

/** "5 min ago", "3 h ago", "2 d ago". */
function ago(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 60 * 24) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / (60 * 24))} d ago`;
}
