import { useEffect, useState } from "react";
import type { ResumableSession } from "@bentomo/shared";
import { api, errorMessage, useHome, type LiveState } from "./api";
import { Composer } from "./Composer";
import { ago, sessionTitle, tilde } from "./format";
import { Resume, Trash } from "./icons";
import { Select } from "./Select";

interface Props {
  live: LiveState;
  /** The project to start in, when the tab was opened from one. */
  project?: string;
  onStarted(id: string): void;
}

/** Two choices start a session: a project whose VM runs, and an opening prompt. */
export function NewSession({ live, project: initial, onStarted }: Props) {
  const running = live.projects.filter((s) => s.status === "running" && !s.busy);
  const others = live.projects.filter((s) => !running.includes(s));
  const [picked, setPicked] = useState(initial ?? "");
  const [model, setModel] = useState("default");
  const [error, setError] = useState<string | undefined>();
  const home = useHome();
  useEffect(() => {
    if (initial) setPicked(initial);
  }, [initial]);

  // Preselect the first running project, and move off one that stops.
  const sandbox = running.some((s) => s.name === picked) ? picked : running[0]?.name ?? "";
  useEffect(() => {
    if (sandbox !== picked) setPicked(sandbox);
  }, [sandbox, picked]);

  const sb = live.projects.find((s) => s.name === sandbox);
  const workdir = sb?.project.clonePath;

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
      setError(errorMessage(err));
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
      setError(errorMessage(err));
    }
  };

  const start = async (prompt: string) => {
    setError(undefined);
    try {
      const { id } = await api.startSession(sandbox, prompt, model);
      onStarted(id);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  };

  return (
    <main className="form-main new-session">
      <div className="form-intro">
        <h1 className="page-title">New session</h1>
        <p className="muted">
          Claude Code starts in the project's clone and gets to work on your prompt straight away. It makes a worktree when the task changes code, or
          when you ask for one.
        </p>
      </div>

      <section className="card section">
        <div className="field">
          <label htmlFor="ns-sandbox">Project</label>
          {live.loaded && live.projects.length === 0 ? (
            <p className="muted form-note">
              No projects yet. <a href="#/new">Create one</a> first.
            </p>
          ) : (
            <Select
              id="ns-sandbox"
              mono
              value={sandbox}
              placeholder={running.length ? "Pick a project" : "No project's sandbox is running"}
              disabled={running.length === 0}
              onValueChange={setPicked}
              groups={[
                { options: running.map((s) => s.name) },
                ...(others.length ? [{ label: "Sandbox not running: start it from Projects", options: others.map((s) => s.name), disabled: true }] : []),
              ]}
            />
          )}
          <span className="hint">
            {workdir ? (
              <>
                Starts in <span className="mono">{tilde(workdir, home)}</span>
              </>
            ) : live.projects.length > 0 ? (
              <>
                Start a project's sandbox from <a href="#/">Projects</a> to begin.
              </>
            ) : null}
          </span>
        </div>

        <div className="field">
          <span className="field-label">Opening prompt</span>
          <Composer label="Opening prompt" submitLabel="Start" placeholder="What should Claude work on?" disabled={!sandbox} onSubmit={start} autoFocus
            footer={
              <>
                <span className="badge badge-bypass" title="Claude runs tools without asking for permission. The sandbox is the boundary.">
                  Bypass permissions
                </span>
                <Select compact value={model} placeholder="Model" groups={[{ options: MODELS }]} onValueChange={setModel} />
              </>
            }
          />
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
              const runs = live.projects.some((x) => x.name === r.sandbox && x.status === "running" && !x.busy);
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
                      <Resume />
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

const MODELS = ["default", "opus", "sonnet", "haiku"];
const RESUME_LIMIT = 20;
