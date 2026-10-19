import { useEffect, useRef, useState } from "react";
import type { LoginAccount } from "@bentomo/shared";
import { api, errorMessage, RequestError } from "./api";

interface Props {
  /** The session the login is started from; the login itself is its project's. */
  sessionId: string;
  project: string;
  onDone(account: LoginAccount): void;
  onClose(): void;
}

type Step =
  | { step: "starting" }
  | { step: "code"; url: string }
  | { step: "checking"; url: string }
  | { step: "failed"; message: string; details: string[] };

/**
 * Logs Claude in for a project: the sandbox's Claude prints a sign-in link, the user signs in in their browser, and
 * pastes back the code the page shows. If the project is logged in already, it says so and closes.
 */
export function LoginDialog({ sessionId, project, onDone, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<Step>({ step: "starting" });
  const [code, setCode] = useState("");
  const finished = useRef(false);

  const start = async () => {
    setState({ step: "starting" });
    setCode("");
    try {
      const res = await api.login(sessionId);
      if ("loggedIn" in res) {
        finished.current = true;
        return onDone(res.loggedIn);
      }
      setState({ step: "code", url: res.url });
    } catch (err) {
      setState({ step: "failed", message: errorMessage(err), details: err instanceof RequestError ? err.details : [] });
    }
  };

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    void start();
    // Closing without finishing gives the waiting login up, so it doesn't sit in the sandbox for minutes.
    return () => {
      if (!finished.current) api.cancelLogin(sessionId).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state.step !== "code" || !code.trim()) return;
    setState({ step: "checking", url: state.url });
    try {
      const account = await api.loginCode(sessionId, code.trim());
      finished.current = true;
      onDone(account);
    } catch (err) {
      // A wrong code ends that login on the server; Try again starts a new one.
      setState({ step: "failed", message: errorMessage(err), details: err instanceof RequestError ? err.details : [] });
    }
  };

  const url = state.step === "code" || state.step === "checking" ? state.url : undefined;

  return (
    <dialog ref={ref} className="dialog login-dialog" onCancel={(e) => (e.preventDefault(), onClose())} aria-labelledby="login-title">
      <h2 id="login-title">Log in to Claude</h2>
      <form className="dialog-body login-steps" onSubmit={submit}>
        <p>
          Claude in <strong>{project}</strong> needs a login. You only do this once per project.
        </p>
        {state.step === "starting" && (
          <p className="muted">
            <span className="spinner" aria-hidden="true" /> Asking Claude for a sign-in link…
          </p>
        )}
        {url && (
          <>
            <div className="login-step">
              <span className="login-num">1</span>
              <div>
                <a className="btn btn-secondary btn-compact" href={url} target="_blank" rel="noreferrer">
                  Open the sign-in page
                </a>
                <p className="muted form-note">Opens in your browser. Sign in and copy the code.</p>
              </div>
            </div>
            <div className="login-step">
              <span className="login-num">2</span>
              <div className="login-code">
                <label htmlFor="login-code">Paste the code</label>
                <input
                  id="login-code"
                  className="input input-dark mono"
                  type="text"
                  value={code}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  disabled={state.step === "checking"}
                  onChange={(e) => setCode(e.target.value)}
                />
              </div>
            </div>
          </>
        )}
        {state.step === "failed" && (
          <div className="banner banner-error login-error">
            <strong>{state.message}</strong>
            {state.details.length > 0 && <pre className="mono">{state.details.join("\n")}</pre>}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          {state.step === "failed" ? (
            <button type="button" className="btn btn-primary" onClick={() => void start()}>
              Try again
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={state.step !== "code" || !code.trim()}>
              {state.step === "checking" ? "Logging in…" : "Log in"}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
