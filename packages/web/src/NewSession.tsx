import { useEffect, useId, useState } from "react";
import type { ProjectView, ResumableSession } from "@kumiko/shared";
import { api, errorMessage, RequestError, useHome, type LiveState } from "./api";
import { toInput, type ComposerFile } from "./attachments";
import { Composer } from "./Composer";
import { ago, tilde } from "./format";
import { Resume, Trash } from "./icons";
import { resumableKey } from "./resumable";
import { Select } from "./Select";
import { plural, statusOf } from "./status";

interface Props {
  live: LiveState;
  /** The project to start in, when the tab was opened from one or restored. Read once, when the tab opens. */
  project?: string;
  /** Told the project picked, as it changes: "" when none is. */
  onProject(name: string): void;
  onStarted(id: string): void;
}

/** Two choices start a session: a project, and an opening prompt. A project whose sandbox is stopped has it started first. */
export function NewSession({ live, project: initial, onProject, onStarted }: Props) {
  const [picked, setPicked] = useState(initial ?? "");
  const [model, setModel] = useState("default");
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const home = useHome();
  const group = useId();

  // Preselect a running project, else any that can start, and move off one that goes or can't start any more. Not
  // before the list has arrived, which would drop the one it opened with.
  const pickable = live.projects.filter(canStart);
  const sandbox = pickable.some((s) => s.name === picked)
    ? picked
    : (pickable.find((s) => s.status === "running") ?? pickable[0])?.name ?? "";
  useEffect(() => {
    if (live.loaded && sandbox !== picked) setPicked(sandbox);
  }, [live.loaded, sandbox, picked]);
  useEffect(() => {
    if (live.loaded) onProject(sandbox);
  }, [live.loaded, sandbox]);

  const sb = live.projects.find((s) => s.name === sandbox);
  // The server starts a stopped sandbox before the session; say so while it does.
  const starting = submitting && sb !== undefined && sb.status !== "running";

  // The picked project's saved sessions that aren't open; re-read when a session opens or closes, or a project (and its saved sessions) goes.
  const [saved, setSaved] = useState<ResumableSession[]>([]);
  const [resuming, setResuming] = useState<string | undefined>();
  const key = resumableKey(live);
  useEffect(() => {
    let current = true;
    api.resumable().then((list) => current && setSaved(list), () => {});
    return () => {
      current = false;
    };
  }, [key]);

  // All of them while no project can be picked, to show what's there.
  const shown = sandbox ? saved.filter((r) => r.sandbox === sandbox) : saved;

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
      // 404: it's gone already, e.g. with its project.
      await api.deleteSavedSession(id).catch((err) => {
        if (!(err instanceof RequestError && err.status === 404)) throw err;
      });
      setSaved((list) => list.filter((r) => r.id !== id));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const start = async (prompt: string, files: ComposerFile[]) => {
    setError(undefined);
    setSubmitting(true);
    try {
      const { id } = await api.startSession(sandbox, prompt, model, files.map(toInput));
      onStarted(id);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="form-main new-session">
      <div className="form-intro">
        <h1 className="page-title">New session</h1>
        <p className="muted">
          Claude Code starts in the project's clone and gets to work on your prompt straight away. It makes a worktree when the task changes code, or
          when you ask for one. A stopped sandbox is started first.
        </p>
      </div>

      {live.loaded && live.projects.length === 0 ? (
        <p className="muted">
          No projects yet. <a href="#/new">Create one</a> first.
        </p>
      ) : (
        <div className="project-picks" role="radiogroup" aria-label="Project">
          {live.projects.map((p) => (
            <ProjectPick key={p.name} p={p} home={home} group={group} picked={p.name === sandbox} disabled={submitting || !canStart(p)} onPick={() => setPicked(p.name)} />
          ))}
        </div>
      )}

      <div className="new-session-foot">
        {starting && (
          <div className="chat-waiting">
            <span className="spinner" aria-hidden="true" />
            Starting {sandbox}'s sandbox…
          </div>
        )}
        {error && <div className="banner banner-error">{error}</div>}
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

      {shown.length > 0 && (
        <section className="card section">
          <div className="section-head">
            <h2>Resume a session</h2>
            <p className="muted form-note">Pick up where you left off, with the chat as it was. Most recent first.</p>
          </div>
          <ul className="resume-list">
            {shown.slice(0, RESUME_LIMIT).map((r) => {
              const p = live.projects.find((x) => x.name === r.sandbox);
              const can = p !== undefined && canStart(p);
              return (
                <li
                  key={r.id}
                  className={`resume-item${can && resuming === undefined ? " resume-item-live" : ""}`}
                  onClick={() => can && resuming === undefined && void resume(r.id)}
                >
                  <div className="resume-what">
                    <span className="resume-title" title={r.title ?? r.prompt}>
                      <span className="resume-project">{r.sandbox}</span> · {r.title ?? r.prompt}
                    </span>
                    <span className="dim resume-when">{can ? ago(r.updatedAt ?? r.startedAt) : `${ago(r.updatedAt ?? r.startedAt)} · sandbox can't start`}</span>
                  </div>
                  <div className="resume-actions" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="btn btn-secondary btn-compact" disabled={!can || resuming !== undefined} onClick={() => void resume(r.id)}>
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

/** A session can start in a running sandbox, or a stopped one, which is started for it; one busy is waited for. */
const canStart = (p: ProjectView) => !p.problem && (p.busy || p.status === "running" || p.status === "stopped");

interface PickProps {
  p: ProjectView;
  home?: string;
  group: string;
  picked: boolean;
  disabled: boolean;
  onPick(): void;
}

function ProjectPick({ p, home, group, picked, disabled, onPick }: PickProps) {
  const status = statusOf(p);
  return (
    <label className={`project-pick${picked ? " is-picked" : ""}${disabled ? " is-disabled" : ""}`}>
      <input type="radio" name={group} value={p.name} checked={picked} disabled={disabled} onChange={onPick} />
      <span className="project-pick-what">
        <span className="project-pick-name">{p.name}</span>
        <span className="mono dim project-pick-path" title={p.project.clonePath}>
          {tilde(p.project.clonePath, home)}
        </span>
      </span>
      <span className="project-pick-state">
        {p.problem ? (
          <span className="badge badge-warn" title={p.problem}>
            Folder missing
          </span>
        ) : (
          <span className="dim">{p.sessions > 0 ? `${plural(p.sessions, "active session")}` : "No active sessions"}</span>
        )}
        <span className="project-pick-status" style={{ color: status.color }}>
          {p.busy ? <span className="spinner" aria-hidden="true" /> : <span className="dot dot-small" style={{ background: status.color }} aria-hidden="true" />}
          {status.text}
        </span>
      </span>
    </label>
  );
}

const MODELS = ["default", "opus", "sonnet", "haiku"];
const RESUME_LIMIT = 20;
