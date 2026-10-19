import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "@bentomo/shared";
import { api, RequestError, useLiveState } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { ProjectForm } from "./ProjectForm";
import { sessionTitle } from "./format";
import { Header, type TabId } from "./Header";
import { NewSession } from "./NewSession";
import { ProjectList } from "./ProjectList";
import { ProjectPage } from "./ProjectPage";
import { SessionView } from "./SessionView";
import { loadTabs, saveTabs } from "./tabs";

type Route =
  | { view: "list" }
  | { view: "new" }
  | { view: "project"; name: string }
  | { view: "edit"; name: string }
  /** `project`: opened from a project's page, which it starts in. */
  | { view: "new-session"; project?: string }
  | { view: "session"; id: string };

function parseHash(): Route {
  if (location.hash === "#/new") return { view: "new" };
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

const tabOf = (r: Route): TabId => (r.view === "new-session" ? "new-session" : r.view === "session" ? `session:${r.id}` : "projects");

export function App() {
  const live = useLiveState();
  const [route, setRoute] = useState<Route>(parseHash);
  // The New session tab is the window's own; it opens on demand and stays until started or closed.
  // Sessions being closed leave the tabs at once, without waiting for the server to confirm.
  const [ending, setEnding] = useState<ReadonlySet<string>>(new Set());
  const sessions = useMemo(() => live.sessions.filter((s) => !ending.has(s.id)), [live.sessions, ending]);
  // The session whose Cmd+Shift+W is waiting for confirmation.
  const [deleting, setDeleting] = useState<SessionInfo | undefined>();
  const [newSessionOpen, setNewSessionOpen] = useState(() => parseHash().view === "new-session");
  // The project the New session tab was last opened from, if any.
  const [newSessionProject, setNewSessionProject] = useState(() => {
    const r = parseHash();
    return r.view === "new-session" ? r.project : undefined;
  });
  // Sessions this window just started: their tab opens before the session list may have caught up.
  const started = useRef(new Set<string>());
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
      if (!saved) return setRestored(true);
      // Sessions that are gone or can't be resumed just don't get a tab. One at a time: the server lists sessions in the
      // order they started, which is the tab order.
      const back = new Set<string>();
      for (const id of saved.sessions) {
        if (open.has(id) || (await api.resumeSession(id).then(() => true, () => false))) back.add(id);
        // Its tab may open before the session list has caught up with the resume.
        started.current.add(id);
      }
      if (saved.newSession) setNewSessionOpen(true);
      // A link that already points somewhere wins over the saved active tab.
      if (!location.hash || location.hash === "#/") {
        if (saved.active === "new-session" && saved.newSession) go("#/session/new");
        else if (saved.active.startsWith("session:") && back.has(saved.active.slice(8))) go(`#/session/${saved.active.slice(8)}`);
      }
      setRestored(true);
    })();
  }, [live.loaded, live.sessions]);

  useEffect(() => {
    if (restored) saveTabs({ sessions: sessions.map((s) => s.id), newSession: newSessionOpen, active: tabOf(route) });
  }, [restored, sessions, newSessionOpen, route]);

  useEffect(() => {
    const onHash = () => {
      const r = parseHash();
      setRoute(r);
      if (tabOf(r) === "projects") projectsHash.current = location.hash || "#/";
      if (r.view === "new-session") {
        setNewSessionOpen(true);
        if (r.project) setNewSessionProject(r.project);
      }
      scrollTo(0, 0);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const select = (tab: TabId) => {
    if (tab === "projects") go(projectsHash.current);
    else if (tab === "new-session") go("#/session/new");
    else go(`#/session/${tab.slice("session:".length)}`);
  };

  /** After closing the active tab, fall back to the Projects tab. */
  const leave = (tab: TabId) => {
    if (tabOf(route) === tab) go(projectsHash.current);
  };

  /** Closes a session's tab at once and ends it on the server; the tab comes back if the server refuses. Resolves whether it ended. */
  const endSession = async (s: SessionInfo): Promise<boolean> => {
    leave(`session:${s.id}`);
    setEnding((all) => new Set(all).add(s.id));
    try {
      await api.endSession(s.id);
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
    // 404: Claude never answered, so nothing was saved.
    await api.deleteSavedSession(s.id).catch((err) => {
      if (!(err instanceof RequestError && err.status === 404)) console.error(err);
    });
  };

  const close = (tab: TabId) => {
    if (tab === "new-session") {
      setNewSessionOpen(false);
      return leave(tab);
    }
    const s = sessions.find((x) => `session:${x.id}` === tab);
    if (!s) return leave(tab);
    void endSession(s);
  };

  // Keyboard shortcuts act on the latest render's state, so the listeners below are installed once.
  const shortcut = useRef<(action: "new" | "next" | "prev" | "close" | "delete" | number) => void>(() => {});
  shortcut.current = (action) => {
    if (deleting) return;
    if (action === "delete") {
      const current = tabOf(route);
      return setDeleting(sessions.find((x) => `session:${x.id}` === current));
    }
    if (action === "new") return go("#/session/new");
    // Cmd+1..9 jump to the nth session tab.
    if (typeof action === "number") {
      const target = sessions[action - 1];
      return target ? select(`session:${target.id}`) : undefined;
    }
    const tabs: TabId[] = ["projects", ...sessions.map((s): TabId => `session:${s.id}`), ...(newSessionOpen ? ["new-session" as const] : [])];
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
        ? e.code === "BracketRight" ? "next" : e.code === "BracketLeft" ? "prev" : e.code === "KeyW" ? "delete" : undefined
        : e.code === "KeyT" ? "new" : e.code === "KeyW" ? "close" : undefined);
      if (!action) return;
      e.preventDefault();
      shortcut.current(action);
    };
    addEventListener("keydown", onKey);
    // Electron's menu claims Cmd+W for closing the window, so the shell forwards it instead.
    const offClose = window.bentomo?.onCloseTab?.((deleteToo) => shortcut.current(deleteToo ? "delete" : "close"));
    return () => {
      removeEventListener("keydown", onKey);
      offClose?.();
    };
  }, []);

  const onSessionStarted = (id: string, keepNewTab?: boolean) => {
    started.current.add(id);
    if (!keepNewTab) setNewSessionOpen(false);
    go(`#/session/${id}`);
  };

  return (
    <div className="app">
      <Header
        sessions={sessions}
        newSessionOpen={newSessionOpen}
        active={tabOf(route)}
        onSelect={select}
        onClose={close}
        onNewSession={() => go("#/session/new")}
      />
      {/* Kept mounted while its tab is open, so a half-typed prompt survives switching tabs. */}
      {newSessionOpen && (
        <div hidden={route.view !== "new-session"}>
          <NewSession live={live} project={newSessionProject} onStarted={(id) => onSessionStarted(id)} />
        </div>
      )}
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
  /** `keepNewTab` for a fork, which doesn't come from the New session tab. */
  onSessionStarted(id: string, keepNewTab?: boolean): void;
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
      return null; // rendered by App, which keeps it mounted
    case "session": {
      const s = live.sessions.find((x) => x.id === route.id);
      if (!live.loaded || (!s && started.has(route.id))) return null;
      if (!s) return <Redirect to="#/" />;
      return <SessionView key={s.id} session={s} onForked={(id) => onSessionStarted(id, true)} />;
    }
    default:
      return <ProjectList live={live} onOpen={(name) => go(`#/project/${name}`)} onNew={() => go("#/new")} />;
  }
}
