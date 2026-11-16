import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitHubAccount, GitHubRepo, MirrorView } from "@kumiko/shared";
import { api, errorMessage, useHome, type LiveState } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { formatBytes, tilde } from "./format";
import { HomeNav } from "./HomeNav";
import { Plus, Redo, Trash } from "./icons";
import { filterRepos, highlight, mirrorStatus, repoOwners, reposOf } from "./repos";

/**
 * The repository mirrors: the GitHub repos the user picked, each kept by Kumiko as a bare mirror on the host, which
 * the sandboxes get their code from. The gh login on the host lists the repos to pick from.
 */
export function ReposPage({ live }: { live: LiveState }) {
  const home = useHome();
  const [account, setAccount] = useState<GitHubAccount | undefined>();
  const [checking, setChecking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<MirrorView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const now = useNow(30_000);

  const check = useCallback(() => {
    setChecking(true);
    api
      .githubAccount()
      .then(setAccount, (err) => setAccount({ status: "error", detail: errorMessage(err) }))
      .finally(() => setChecking(false));
  }, []);
  useEffect(check, [check]);

  const mirrors = live.mirrors?.mirrors ?? [];
  const signedIn = account?.status === "signed-in";
  const act = (p: Promise<unknown>) => void p.then(() => setError(undefined), (err) => setError(errorMessage(err)));

  return (
    <>
      <main className="page">
        <HomeNav active="repos" sandboxes={live.sandboxes.length} repos={mirrors.length} />
        <div className="page-head">
          <div className="detail-title">
            <h1 className="page-title">Repository mirrors</h1>
            <p className="page-explain">
              Kumiko keeps a mirror of each repository on this Mac and manages it for you. Your sandboxes get the code from these mirrors, so they never hold GitHub
              credentials.
            </p>
          </div>
          <div className="repos-head-right">
            <AccountChip account={account} />
            {signedIn && mirrors.length > 0 && (
              <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
                <Plus />
                Add repository
              </button>
            )}
          </div>
        </div>

        {!live.connected && live.loaded && <div className="banner banner-warn">Lost connection to the Kumiko server. Reconnecting…</div>}
        {live.mirrors?.error && (
          <div className="banner banner-error">
            <strong>Kumiko's list of repositories is unreadable.</strong>
            <span className="mono">{live.mirrors.error}</span>
          </div>
        )}
        {error && (
          <div className="banner banner-error">
            <span className="banner-text">{error}</span>
            <button type="button" className="btn btn-secondary btn-compact" onClick={() => setError(undefined)}>
              Dismiss
            </button>
          </div>
        )}
        {account && account.status !== "signed-in" && <GhBanner account={account} checking={checking} onCheck={check} />}

        {!live.loaded && <p className="muted">Connecting…</p>}

        {live.loaded && mirrors.length === 0 && (
          <div className="empty-state">
            <h2>No mirrors yet</h2>
            <p className="muted">Pick the GitHub repositories your sandboxes work on. Kumiko keeps a mirror of each on this Mac, so the sandboxes never need GitHub credentials.</p>
            {signedIn && (
              <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
                <Plus />
                Add repository
              </button>
            )}
          </div>
        )}

        {mirrors.length > 0 && (
          <div className="table-card">
            <div className="table-inner">
              <div className="table-row table-headrow repos-row">
                <span>Repository</span>
                <span>Last fetch</span>
                <span>Size</span>
                <span className="align-right">Actions</span>
              </div>
              {mirrors.map((m) => (
                <MirrorRow key={m.repo} m={m} home={home} now={now} onFetch={() => act(api.fetchMirror(m.repo))} onRemove={() => setRemoving(m)} />
              ))}
            </div>
          </div>
        )}
      </main>

      {adding && <AddRepoDialog login={signedIn ? account.login : undefined} added={mirrors} onAdd={(r) => act(api.addMirror(r.repo, r.private))} onClose={() => setAdding(false)} />}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.repo}?`}
          confirmLabel="Remove"
          danger
          onCancel={() => setRemoving(undefined)}
          onConfirm={() => {
            act(api.removeMirror(removing.repo));
            setRemoving(undefined);
          }}
        >
          <p>
            Kumiko deletes its mirror on this Mac{removing.size !== undefined ? ` (${formatBytes(removing.size)})` : ""}. Nothing changes on GitHub, and you can add it
            again any time; it's cloned afresh then.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

/** Re-renders every `ms`, so "5 min ago" keeps up. */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function MirrorRow({ m, home, now, onFetch, onRemove }: { m: MirrorView; home?: string; now: number; onFetch(): void; onRemove(): void }) {
  const st = mirrorStatus(m, now);
  const slash = m.repo.indexOf("/");
  return (
    <div className="table-row repos-row">
      <div className="row-name repos-name">
        <span className="row-title">
          <span className="repos-owner">{m.repo.slice(0, slash + 1)}</span>
          {m.repo.slice(slash + 1)}
        </span>
        <span className="row-sub">
          {m.private && <span className="badge">private</span>}
          {m.state === "failed" && <span className="badge badge-failed">Fetch failed</span>}
          <span className="mono dim" title={m.path}>
            {tilde(m.path, home)}
          </span>
        </span>
      </div>
      <div className="row-status" style={{ color: st.color }}>
        {st.busy ? <span className="spinner" aria-hidden="true" /> : <span className="dot" style={{ background: st.color }} aria-hidden="true" />}
        <span className="repos-status">
          <span>{st.text}</span>
          {st.sub && <span className="repos-status-sub">{st.sub}</span>}
        </span>
      </div>
      <span className="mono repos-size">{m.size !== undefined ? formatBytes(m.size) : "—"}</span>
      <div className="row-actions">
        <button type="button" className="icon-btn" aria-label={`Fetch ${m.repo} now`} title="Fetch now" disabled={st.busy} onClick={onFetch}>
          <Redo />
        </button>
        <button type="button" className="icon-btn icon-btn-danger" aria-label={`Remove ${m.repo}`} title="Remove" onClick={onRemove}>
          <Trash />
        </button>
      </div>
      {m.state === "failed" && m.error && <pre className="repos-error">{m.error.message}</pre>}
    </div>
  );
}

/** Who Kumiko is on GitHub: gh's account on this Mac, with its avatar; amber when there is none. */
function AccountChip({ account }: { account?: GitHubAccount }) {
  if (!account) return null;
  if (account.status === "signed-in") {
    return (
      <div className="account-chip" title={account.name ? `${account.name} (${account.login}) on GitHub` : `${account.login} on GitHub`}>
        {account.avatarUrl ? <img className="account-avatar" src={account.avatarUrl} alt="" referrerPolicy="no-referrer" /> : <span className="account-avatar account-avatar-none" aria-hidden="true" />}
        <span className="account-who">
          <strong>{account.login}</strong>
          <span>
            <span className="account-ok" aria-hidden="true" />
            GitHub
          </span>
        </span>
      </div>
    );
  }
  const why = account.status === "missing" ? "gh isn't installed" : account.status === "signed-out" ? "Not signed in" : "Can't ask gh";
  return (
    <div className="account-chip is-warn">
      <span className="account-avatar account-avatar-none" aria-hidden="true">
        ?
      </span>
      <span className="account-who">
        <strong>GitHub</strong>
        <span>{why}</span>
      </span>
    </div>
  );
}

/** What to do when gh can't list the repos: install it, or sign it in. */
function GhBanner({ account, checking, onCheck }: { account: Exclude<GitHubAccount, { status: "signed-in" }>; checking: boolean; onCheck(): void }) {
  const [title, text, command] =
    account.status === "missing"
      ? ["The GitHub CLI, gh, isn't installed.", "Kumiko lists your repositories with it. Install it, sign it in, then check again.", "brew install gh"]
      : account.status === "signed-out"
        ? ["gh isn't signed in to GitHub.", "Sign it in from Terminal on this Mac, then check again.", "gh auth login"]
        : ["Kumiko couldn't ask gh who you are on GitHub.", "", undefined];
  const detail = account.status === "missing" ? undefined : account.detail;
  return (
    <div className="banner banner-warn gh-banner">
      <strong>{title}</strong>
      {text && <span>{text}</span>}
      {command && <CopyCommand command={command} />}
      {detail && <span className="mono gh-detail">{detail}</span>}
      <button type="button" className="btn btn-secondary btn-compact" disabled={checking} onClick={onCheck}>
        {checking ? "Checking…" : "Check again"}
      </button>
    </div>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copy-command">
      <code>{command}</code>
      <button
        type="button"
        className="link-btn"
        onClick={() =>
          void navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

/**
 * A searchable list of one owner's repos, by name: the gh account's own at first, or an organization's picked above.
 * Picking one adds it, and the dialog stays for more.
 */
export function AddRepoDialog({ login, added, onAdd, onClose }: { login?: string; added: MirrorView[]; onAdd(r: GitHubRepo): void; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [repos, setRepos] = useState<GitHubRepo[] | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const [picked, setPicked] = useState<string | undefined>();

  const load = useCallback(() => {
    setRepos(undefined);
    setLoadError(undefined);
    api.githubRepos().then((r) => setRepos(r.repos), (err) => setLoadError(errorMessage(err)));
  }, []);
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
    load();
  }, [load]);

  const isAdded = useMemo(() => {
    const keys = new Set(added.map((m) => m.repo.toLowerCase()));
    return (r: GitHubRepo) => keys.has(r.repo.toLowerCase());
  }, [added]);
  const owners = useMemo(() => repoOwners(repos ?? [], login), [repos, login]);
  const owner = picked ?? login ?? owners[0]?.owner ?? "";
  const ofOwner = useMemo(() => reposOf(repos ?? [], owner), [repos, owner]);
  const shown = useMemo(() => filterRepos(ofOwner, query), [ofOwner, query]);
  const current = Math.min(at, Math.max(0, shown.length - 1));

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setAt(Math.max(0, Math.min(shown.length - 1, current + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = shown[current];
      if (r && !isAdded(r)) onAdd(r);
    }
  };

  return (
    <dialog ref={ref} className="dialog add-repo-dialog" onCancel={(e) => (e.preventDefault(), onClose())} aria-labelledby="add-repo-title">
      <h2 id="add-repo-title">Add a repository</h2>
      <p className="add-repo-lead">Your repositories and your organizations', as gh lists them. Kumiko clones the one you pick into a mirror on this Mac.</p>
      <div className="add-repo-filters">
        <select
          className="input add-repo-owner"
          aria-label="Owner"
          value={owner}
          disabled={!repos}
          onChange={(e) => {
            setPicked(e.target.value);
            setAt(0);
          }}
        >
          {(owners.length ? owners : [{ owner, count: 0 }]).map((o) => (
            <option key={o.owner} value={o.owner}>
              {repos ? `${o.owner} (${o.count})` : o.owner}
            </option>
          ))}
        </select>
        <input
          className="input add-repo-search"
          type="search"
          placeholder="Search by name or description"
          aria-label="Search repositories"
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setAt(0);
          }}
          onKeyDown={onKey}
        />
      </div>
      <div className="add-repo-list">
        {loadError ? (
          <div className="add-repo-empty banner-error-text">{loadError}</div>
        ) : !repos ? (
          <div className="add-repo-empty">
            <span className="spinner" aria-hidden="true" /> Loading your repositories…
          </div>
        ) : shown.length === 0 ? (
          <div className="add-repo-empty muted">{ofOwner.length ? "No repository matches." : `gh lists no repositories of ${owner}.`}</div>
        ) : (
          <ul ref={listRef} role="listbox" aria-label="Repositories">
            {shown.map((r, i) => {
              const done = isAdded(r);
              const [a, b, c] = highlight(r.repo.slice(r.repo.indexOf("/") + 1), query);
              return (
                <li
                  key={r.repo}
                  data-index={i}
                  role="option"
                  aria-selected={i === current}
                  className={`add-repo-item${i === current ? " is-current" : ""}${done ? " is-added" : ""}`}
                  onMouseMove={() => i !== current && setAt(i)}
                  onClick={() => !done && onAdd(r)}
                >
                  <span className="add-repo-main">
                    <span className="add-repo-name">
                      {a}
                      {b && <mark>{b}</mark>}
                      {c}
                    </span>
                    {r.description && <span className="add-repo-desc">{r.description}</span>}
                  </span>
                  {r.private && <span className="badge">private</span>}
                  {r.fork && <span className="badge">fork</span>}
                  {r.archived && <span className="badge">archived</span>}
                  {done ? (
                    <span className="badge badge-ok">Added</span>
                  ) : (
                    <button type="button" className="btn btn-primary add-repo-add" tabIndex={-1}>
                      Add
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="add-repo-foot">
        <span className="muted">
          {repos && `${shown.length === ofOwner.length ? ofOwner.length : `${shown.length} of ${ofOwner.length}`} ${ofOwner.length === 1 ? "repository" : "repositories"} · `}
          <button type="button" className="link-btn" onClick={load} disabled={!repos && !loadError}>
            Reload list
          </button>
        </span>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
