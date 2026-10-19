import { useEffect, useRef, useState } from "react";
import type { SessionInfo } from "@bentomo/shared";
import { api, useLiveState } from "./api";
import { CreateForm } from "./CreateForm";
import { Header, type TabId } from "./Header";
import { NewSession } from "./NewSession";
import { SandboxList } from "./SandboxList";
import { SandboxPage } from "./SandboxPage";
import { SessionView } from "./SessionView";

type Route =
  | { view: "list" }
  | { view: "new" }
  | { view: "sandbox"; name: string }
  | { view: "edit"; name: string }
  | { view: "new-session" }
  | { view: "session"; id: string };

function parseHash(): Route {
  if (location.hash === "#/new") return { view: "new" };
  if (location.hash === "#/session/new") return { view: "new-session" };
  const s = /^#\/session\/([0-9a-f]+)$/.exec(location.hash);
  if (s) return { view: "session", id: s[1] };
  const m = /^#\/sandbox\/([a-z0-9-]+)(\/edit)?$/.exec(location.hash);
  if (!m) return { view: "list" };
  return m[2] ? { view: "edit", name: m[1] } : { view: "sandbox", name: m[1] };
}

const go = (hash: string) => {
  location.hash = hash;
};

function Redirect({ to }: { to: string }) {
  useEffect(() => go(to), [to]);
  return null;
}

const tabOf = (r: Route): TabId => (r.view === "new-session" ? "new-session" : r.view === "session" ? `session:${r.id}` : "sandboxes");

export function App() {
  const live = useLiveState();
  const [route, setRoute] = useState<Route>(parseHash);
  // The New session tab is the window's own; it opens on demand and stays until started or closed.
  const [newSessionOpen, setNewSessionOpen] = useState(() => parseHash().view === "new-session");
  // Sessions this window just started: their tab opens before the session list may have caught up.
  const started = useRef(new Set<string>());
  // The Sandboxes tab remembers where it was, so switching back returns to the same page.
  const sandboxesHash = useRef(tabOf(route) === "sandboxes" ? location.hash || "#/" : "#/");

  useEffect(() => {
    const onHash = () => {
      const r = parseHash();
      setRoute(r);
      if (tabOf(r) === "sandboxes") sandboxesHash.current = location.hash || "#/";
      if (r.view === "new-session") setNewSessionOpen(true);
      scrollTo(0, 0);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const select = (tab: TabId) => {
    if (tab === "sandboxes") go(sandboxesHash.current);
    else if (tab === "new-session") go("#/session/new");
    else go(`#/session/${tab.slice("session:".length)}`);
  };

  /** After closing the active tab, fall back to the Sandboxes tab. */
  const leave = (tab: TabId) => {
    if (tabOf(route) === tab) go(sandboxesHash.current);
  };

  const endSession = (s: SessionInfo) => {
    leave(`session:${s.id}`);
    void api.endSession(s.id).catch(() => {});
  };

  const close = (tab: TabId) => {
    if (tab === "new-session") {
      setNewSessionOpen(false);
      return leave(tab);
    }
    const s = live.sessions.find((x) => `session:${x.id}` === tab);
    if (!s) return leave(tab);
    endSession(s);
  };

  // Keyboard shortcuts act on the latest render's state, so the listeners below are installed once.
  const shortcut = useRef<(action: "new" | "next" | "prev" | "close" | number) => void>(() => {});
  shortcut.current = (action) => {
    if (action === "new") return go("#/session/new");
    // Cmd+1..9 jump to the nth session tab.
    if (typeof action === "number") {
      const target = live.sessions[action - 1];
      return target ? select(`session:${target.id}`) : undefined;
    }
    const tabs: TabId[] = ["sandboxes", ...live.sessions.map((s): TabId => `session:${s.id}`), ...(newSessionOpen ? ["new-session" as const] : [])];
    const current = tabOf(route);
    if (action === "close") return current === "sandboxes" ? undefined : close(current);
    const i = tabs.indexOf(current);
    const step = action === "next" ? 1 : -1;
    select(tabs[(Math.max(i, 0) + step + tabs.length) % tabs.length]);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      // e.code, because Shift turns "[" into "{" and layouts differ.
      const digit = !e.shiftKey && /^Digit[1-9]$/.test(e.code) ? Number(e.code.slice(5)) : undefined;
      const action = digit ?? e.shiftKey
        ? e.code === "BracketRight" ? "next" : e.code === "BracketLeft" ? "prev" : undefined
        : e.code === "KeyT" ? "new" : e.code === "KeyW" ? "close" : undefined;
      if (!action) return;
      e.preventDefault();
      shortcut.current(action);
    };
    addEventListener("keydown", onKey);
    // Electron's menu claims Cmd+W for closing the window, so the shell forwards it instead.
    const offClose = window.bentomo?.onCloseTab?.(() => shortcut.current("close"));
    return () => {
      removeEventListener("keydown", onKey);
      offClose?.();
    };
  }, []);

  return (
    <div className="app">
      <Header
        sessions={live.sessions}
        newSessionOpen={newSessionOpen}
        active={tabOf(route)}
        onSelect={select}
        onClose={close}
        onNewSession={() => go("#/session/new")}
      />
      <Body
        route={route}
        live={live}
        started={started.current}
        onSessionStarted={(id, keepNewTab) => {
          started.current.add(id);
          if (!keepNewTab) setNewSessionOpen(false);
          go(`#/session/${id}`);
        }}
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
      return <CreateForm onCancel={() => go("#/")} onCreated={(name) => go(`#/sandbox/${name}`)} />;
    case "sandbox":
      return (
        <SandboxPage key={route.name} name={route.name} live={live} onBack={() => go("#/")} onEdit={() => go(`#/sandbox/${route.name}/edit`)} />
      );
    case "edit": {
      const sb = live.sandboxes.find((s) => s.name === route.name);
      const back = () => go(`#/sandbox/${route.name}`);
      // Wait for the list before deciding; then edit only sandboxes Bentomo created.
      if (!live.loaded) return null;
      if (!sb?.meta) return <Redirect to={`#/sandbox/${route.name}`} />;
      return <CreateForm key={`edit-${route.name}`} editing={sb} onCancel={back} onCreated={back} />;
    }
    case "new-session":
      return <NewSession live={live} onStarted={onSessionStarted} />;
    case "session": {
      const s = live.sessions.find((x) => x.id === route.id);
      if (!live.loaded || (!s && started.has(route.id))) return null;
      if (!s) return <Redirect to="#/" />;
      return <SessionView key={s.id} session={s} onForked={(id) => onSessionStarted(id, true)} />;
    }
    default:
      return <SandboxList live={live} onOpen={(name) => go(`#/sandbox/${name}`)} onNew={() => go("#/new")} />;
  }
}
