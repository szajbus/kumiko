import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "@kumiko/shared";
import { api, RequestError, useLiveState } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { ProjectForm } from "./ProjectForm";
import { sessionTitle } from "./format";
import { Header, type NewSessionTab, type TabId } from "./Header";
import { NewSession } from "./NewSession";
import { ProjectList } from "./ProjectList";
import { ProjectPage } from "./ProjectPage";
import { SessionView } from "./SessionView";
import { landingAfterClose } from "./landing";
import { loadTabs, saveTabs } from "./tabs";

type Route =
  | { view: "list" }
  | { view: "new" }
  | { view: "project"; name: string }
  | { view: "edit"; name: string }
  /** Opens another New session tab. `project`: opened from a project's page, which it starts in. */
  | { view: "new-session"; project?: string }
  /** An open New session tab. */
  | { view: "draft"; key: string }
  | { view: "session"; id: string };

function parseHash(): Route {
  if (location.hash === "#/new") return { view: "new" };
  const d = /^#\/session\/draft\/([0-9]+)$/.exec(location.hash);
  if (d) return { view: "draft", key: d[1] };
  const n = /^#\/session\/new(?:\/([a-z0-9-]+))?$/.exec(location.hash);
  if (n) return { view: "new-session", project: n[1] };
  const s = /^#\/session\/([0-9a-f]{1,64})$/.exec(location.hash);
  if (s) return { view: "session", id: s[1] };
  const m = /^#\/project\/([a-z0-9-]+)(\/edit)?$/.exec(location.hash);
  if (!m) return { view: "list" };
  return m[2] ? { view: "edit", name: m[1] } : { view: "project", name: m[1] };
}

const go = (hash: string) => {
  location.hash = hash;
};

function Redirect({ to }: { to: string }) {
  useEffect(() => go(to), [to]);
  return null;
}

/** Claude is working in the session, so ending it cuts a turn short. */
const isWorking = (s: SessionInfo) => s.status === "running" || s.status === "starting";

const tabOf = (r: Route): TabId => (r.view === "draft" ? `new-session:${r.key}` : r.view === "session" ? `session:${r.id}` : "projects");

let lastKey = 0;
/** A key for another New session tab. */
const nextKey = () => String(++lastKey);

/** Shows a New session tab in place of the link that opened it, so going back doesn't open another. */
const showDraft = (key: string): Route => {
  history.replaceState(null, "", `#/session/draft/${key}`);
  return { view: "draft", key };
};

export function App() {
  const live = useLiveState();
  // A New session tab's link at start is the last run's: its keys are gone with it.
  const [staleLink] = useState(() => parseHash().view === "draft");
  // New session tabs are the window's own; each opens on demand and stays until started or closed.
  const [newSessions, setNewSessions] = useState<NewSessionTab[]>(() => {
    const r = parseHash();
    return r.view === "new-session" ? [{ key: nextKey(), project: r.project }] : [];
  });
  const [route, setRoute] = useState<Route>(() => {
    const r = parseHash();
    return r.view === "new-session" ? showDraft(newSessions[0].key) : r;
  });
  // Sessions being closed leave the tabs at once, without waiting for the server to confirm.
  const [ending, setEnding] = useState<ReadonlySet<string>>(new Set());
  const sessions = useMemo(() => live.sessions.filter((s) => !ending.has(s.id)), [live.sessions, ending]);
  // The session whose Cmd+Shift+W is waiting for confirmation.
  const [deleting, setDeleting] = useState<SessionInfo | undefined>();
  // The session Claude is working in whose closing is waiting for confirmation.
  const [stopping, setStopping] = useState<SessionInfo | undefined>();
  // The project whose page or session tab was last active, which a New session tab opened from elsewhere starts in.
  const recentProject = useRef<string | undefined>(undefined);
  useEffect(() => {
    const project =
      route.view === "project" || route.view === "edit" ? route.name : route.view === "session" ? sessions.find((s) => s.id === route.id)?.sandbox : undefined;
    if (project) recentProject.current = project;
  }, [route, sessions]);
  // Sessions this window just started: their tab opens before the session list may have caught up.
  const started = useRef(new Set<string>());
  // Sessions whose tabs were closed, most recent last, for Cmd+Shift+T to bring back. Deleted ones are dropped.
  const closed = useRef<string[]>([]);
  const reopening = useRef(false);
  // The Projects tab remembers where it was, so switching back returns to the same page.
  const projectsHash = useRef(tabOf(route) === "projects" ? location.hash || "#/" : "#/");

  // The previous run's tabs come back once the server's session list has arrived; saving waits until they have.
  const restoring = useRef(false);
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (!live.loaded || restoring.current) return;
    restoring.current = true;
    const open = new Set(live.sessions.map((s) => s.id));
    void (async () => {
      const saved = await loadTabs();
      if (!saved) {
        if (staleLink) go("#/");
        return setRestored(true);
      }
      // Sessions that are gone or can't be resumed just don't get a tab. One at a time: the server lists sessions in the
      // order they started, which is the tab order.
      const back = new Set<string>();
      for (const id of saved.sessions) {
        if (open.has(id) || (await api.resumeSession(id).then(() => true, () => false))) back.add(id);
        // Its tab may open before the session list has caught up with the resume.
        started.current.add(id);
      }
      // Keys are this window's own, so the saved active one is found by its place.
      const drafts = saved.newSessions.map((p) => ({ key: nextKey(), project: p || undefined }));
      setNewSessions((open) => [...drafts, ...open]);
      // A link that already points somewhere wins over the saved active tab.
      if (!location.hash || location.hash === "#/" || staleLink) {
        const draft = /^new-session:([0-9]+)$/.exec(saved.active);
        if (draft && drafts[Number(draft[1])]) go(`#/session/draft/${drafts[Number(draft[1])].key}`);
        else if (saved.active.startsWith("session:") && back.has(saved.active.slice(8))) go(`#/session/${saved.active.slice(8)}`);
        else if (staleLink) go("#/");
      }
      setRestored(true);
    })();
  }, [live.loaded, live.sessions]);

  useEffect(() => {
    if (!restored) return;
    // A New session tab is saved as active by its place, since keys don't outlive the window.
    const active = route.view === "draft" ? `new-session:${newSessions.findIndex((n) => n.key === route.key)}` : tabOf(route);
    saveTabs({ sessions: sessions.map((s) => s.id), newSessions: newSessions.map((n) => n.project ?? ""), active });
  }, [restored, sessions, newSessions, route]);

  useEffect(() => {
    const onHash = () => {
      let r = parseHash();
      if (r.view === "new-session") {
        const opened = { key: nextKey(), project: r.project ?? recentProject.current };
        setNewSessions((open) => [...open, opened]);
        r = showDraft(opened.key);
      }
      setRoute(r);
      if (tabOf(r) === "projects") projectsHash.current = location.hash || "#/";
      scrollTo(0, 0);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // The tabs in the order the header shows them.
  const tabs: TabId[] = [
    "projects",
    ...sessions.map((s): TabId => `session:${s.id}`),
    ...newSessions.map((n): TabId => `new-session:${n.key}`),
  ];

  const select = (tab: TabId) => {
    if (tab === "projects") go(projectsHash.current);
    else if (tab.startsWith("new-session:")) go(`#/session/draft/${tab.slice("new-session:".length)}`);
    else go(`#/session/${tab.slice("session:".length)}`);
  };

  const dropNewSession = (key: string) => setNewSessions((open) => open.filter((n) => n.key !== key));

  /** Names a New session tab after the project picked in it. */
  const pickedIn = (key: string, name: string) =>
    setNewSessions((open) => {
      const project = name || undefined;
      if (!open.some((n) => n.key === key && n.project !== project)) return open;
      return open.map((n) => (n.key === key ? { ...n, project } : n));
    });

  /** After closing the active tab, move to the tab to its left, else the left-most one left, else the Projects tab. */
  const leave = (tab: TabId) => {
    if (tabOf(route) === tab) select(landingAfterClose(tabs, tab));
  };

  /** Closes a session's tab at once and ends it on the server; the tab comes back if the server refuses. Resolves whether it ended. */
  const endSession = async (s: SessionInfo): Promise<boolean> => {
    leave(`session:${s.id}`);
    setEnding((all) => new Set(all).add(s.id));
    try {
      await api.endSession(s.id);
      closed.current = [...closed.current.filter((id) => id !== s.id), s.id];
      return true;
    } catch {
      setEnding((all) => {
        const rest = new Set(all);
        rest.delete(s.id);
        return rest;
      });
      return false;
    }
  };

  /** Closes a session's tab, then forgets its saved copy too, so it can't be resumed. */
  const deleteSession = async (s: SessionInfo) => {
    if (!(await endSession(s))) return;
    closed.current = closed.current.filter((id) => id !== s.id);
    // 404: Claude never answered, so nothing was saved.
    await api.deleteSavedSession(s.id).catch((err) => {
      if (!(err instanceof RequestError && err.status === 404)) console.error(err);
    });
  };

  /** Resumes the most recently closed session that still can be. One deleted since, e.g. from the New session tab, is skipped. */
  const reopen = async () => {
    if (reopening.current) return;
    reopening.current = true;
    try {
      while (closed.current.length) {
        const id = closed.current[closed.current.length - 1];
        // Reopened some other way in the meantime: it isn't closed any more.
        if (live.sessions.some((s) => s.id === id)) {
          closed.current = closed.current.slice(0, -1);
          continue;
        }
        try {
          await api.resumeSession(id);
        } catch (err) {
          // 404: its saved copy is gone. Anything else may pass, so it stays to try again.
          if (!(err instanceof RequestError && err.status === 404)) return console.error(err);
          closed.current = closed.current.filter((x) => x !== id);
          continue;
        }
        closed.current = closed.current.filter((x) => x !== id);
        return onSessionStarted(id);
      }
    } finally {
      reopening.current = false;
    }
  };

  const close = (tab: TabId) => {
    if (tab.startsWith("new-session:")) {
      dropNewSession(tab.slice("new-session:".length));
      return leave(tab);
    }
    const s = sessions.find((x) => `session:${x.id}` === tab);
    if (!s) return leave(tab);
    if (isWorking(s)) return setStopping(s);
    void endSession(s);
  };

  // Keyboard shortcuts act on the latest render's state, so the listeners below are installed once.
  const shortcut = useRef<(action: "new" | "reopen" | "next" | "prev" | "close" | "delete" | number) => void>(() => {});
  shortcut.current = (action) => {
    if (deleting || stopping) return;
    if (action === "delete") {
      const current = tabOf(route);
      return setDeleting(sessions.find((x) => `session:${x.id}` === current));
    }
    if (action === "new") return go("#/session/new");
    if (action === "reopen") return void reopen();
    // Cmd+1..9 jump to the nth session tab.
    if (typeof action === "number") {
      const target = sessions[action - 1];
      return target ? select(`session:${target.id}`) : undefined;
    }
    const current = tabOf(route);
    if (action === "close") return current === "projects" ? undefined : close(current);
    const i = tabs.indexOf(current);
    const step = action === "next" ? 1 : -1;
    select(tabs[(Math.max(i, 0) + step + tabs.length) % tabs.length]);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      // e.code, because Shift turns "[" into "{" and layouts differ.
      const digit = !e.shiftKey && /^Digit[1-9]$/.test(e.code) ? Number(e.code.slice(5)) : undefined;
      const action = digit ?? (e.shiftKey
        ? e.code === "BracketRight" ? "next" : e.code === "BracketLeft" ? "prev" : e.code === "KeyW" ? "delete" : e.code === "KeyT" ? "reopen" : undefined
        : e.code === "KeyT" ? "new" : e.code === "KeyW" ? "close" : undefined);
      if (!action) return;
      e.preventDefault();
      shortcut.current(action);
    };
    addEventListener("keydown", onKey);
    // Electron's menu claims Cmd+W for closing the window, so the shell forwards it instead.
    const offClose = window.kumiko?.onCloseTab?.((deleteToo) => shortcut.current(deleteToo ? "delete" : "close"));
    return () => {
      removeEventListener("keydown", onKey);
      offClose?.();
    };
  }, []);

  /** `from`: the New session tab it was started in, which closes. */
  const onSessionStarted = (id: string, from?: string) => {
    started.current.add(id);
    // A resumed session keeps its id, which is still marked as ending from when its tab was closed.
    setEnding((all) => {
      if (!all.has(id)) return all;
      const next = new Set(all);
      next.delete(id);
      return next;
    });
    if (from) dropNewSession(from);
    go(`#/session/${id}`);
  };

  return (
    <div className="app">
      <Header
        sessions={sessions}
        newSessions={newSessions}
        active={tabOf(route)}
        onSelect={select}
        onClose={close}
        onNewSession={() => go("#/session/new")}
      />
      {/* Kept mounted while their tabs are open, so a half-typed prompt survives switching tabs. */}
      {newSessions.map((n) => (
        <div key={n.key} hidden={!(route.view === "draft" && route.key === n.key)}>
          <NewSession live={live} project={n.project} onProject={(name) => pickedIn(n.key, name)} onStarted={(id) => onSessionStarted(id, n.key)} />
        </div>
      ))}
      {deleting && (
        <ConfirmDialog
          title="Delete this session?"
          confirmLabel="Delete session"
          danger
          enterConfirms
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => {
            const s = deleting;
            setDeleting(undefined);
            void deleteSession(s);
          }}
        >
          <p>
            <strong>{sessionTitle(deleting)}</strong> closes and its saved chat is deleted, so it can't be resumed.
            {isWorking(deleting) && " Claude is still working in it, and stops."}
          </p>
        </ConfirmDialog>
      )}
      {stopping && (
        <ConfirmDialog
          title="Stop Claude and close?"
          confirmLabel="Stop and close"
          danger
          onCancel={() => setStopping(undefined)}
          onConfirm={() => {
            const s = stopping;
            setStopping(undefined);
            void endSession(s);
          }}
        >
          <p>
            Claude is still working in <strong>{sessionTitle(stopping)}</strong>. Closing the tab stops it, and the reply
            it is writing is lost. You can resume the session later.
          </p>
        </ConfirmDialog>
      )}
      <Body
        route={route}
        live={live}
        started={started.current}
        onSessionStarted={onSessionStarted}
      />
    </div>
  );
}

interface BodyProps {
  route: Route;
  live: ReturnType<typeof useLiveState>;
  started: Set<string>;
  onSessionStarted(id: string): void;
}

function Body({ route, live, started, onSessionStarted }: BodyProps) {
  switch (route.view) {
    case "new":
      return <ProjectForm onCancel={() => go("#/")} onCreated={(name) => go(`#/project/${name}`)} />;
    case "project":
      return (
        <ProjectPage
          key={route.name}
          id={route.name}
          live={live}
          onBack={() => go("#/")}
          onEdit={() => go(`#/project/${route.name}/edit`)}
          onNewSession={() => go(`#/session/new/${route.name}`)}
        />
      );
    case "edit": {
      const p = live.projects.find((s) => s.name === route.name);
      const back = () => go(`#/project/${route.name}`);
      // Wait for the list before deciding; a project whose VM record can't be read can't be edited.
      if (!live.loaded) return null;
      if (!p || p.metaError) return <Redirect to={`#/project/${route.name}`} />;
      return <ProjectForm key={`edit-${route.name}`} editing={p} onCancel={back} onCreated={back} />;
    }
    case "new-session":
    case "draft":
      return null; // rendered by App, which keeps New session tabs mounted
    case "session": {
      const s = live.sessions.find((x) => x.id === route.id);
      if (!live.loaded || (!s && started.has(route.id))) return null;
      if (!s) return <Redirect to="#/" />;
      return <SessionView key={s.id} session={s} onForked={(id) => onSessionStarted(id)} />;
    }
    default:
      return <ProjectList live={live} onOpen={(name) => go(`#/project/${name}`)} onNew={() => go("#/new")} />;
  }
}
