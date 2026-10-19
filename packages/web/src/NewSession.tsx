import { useEffect, useState } from "react";
import { WORKSPACE_DIR } from "@bentomo/shared";
import { api, RequestError, type LiveState } from "./api";
import { Composer } from "./Composer";
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
    </main>
  );
}
