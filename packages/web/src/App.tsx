import { useEffect, useMemo, useRef, useState } from "react";
import { isBusy, type SessionInfo } from "@kumiko/shared";
import { api, RequestError, useLiveState } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { HeaderCorner } from "./Corner";
import { SandboxForm } from "./SandboxForm";
import { sessionName, sessionTitle } from "./format";
import { Header, type NewSessionTab, type TabId } from "./Header";
import { NewSession } from "./NewSession";
import { SandboxList } from "./SandboxList";
import { SandboxPage } from "./SandboxPage";
import { ReposPage } from "./ReposPage";
import { Window } from "./Window";

/** How many session tabs stay mounted, the one on screen included, for switching back to at once. */
const KEEP_MOUNTED = 5;
import { landingAfterClose } from "./landing";
import { arrange, expandInFront, group, moveGroup, moveTab, replaceTab, unfolded } from "./order";
import { loadTabs, saveTabs } from "./tabs";

type Route =
  | { view: "list" }
  | { view: "new" }
  /** The repository mirrors, beside Sandboxes under the home button. */
  | { view: "repos" }
  | { view: "sandbox"; name: string }
  | { view: "edit"; name: string }
  /** Opens another New session tab. `sandbox`: opened from a sandbox's page, which it starts in. */
  | { view: "new-session"; sandbox?: string }
  /** An open New session tab. */
  | { view: "draft"; key: string }
  | { view: "session"; id: string };

function parseHash(): Route {
  if (location.hash === "#/new") return { view: "new" };
  if (location.hash === "#/repos") return { view: "repos" };
  const d = /^#\/session\/draft\/([0-9]+)$/.exec(location.hash);
  if (d) return { view: "draft", key: d[1] };
  const n = /^#\/session\/new(?:\/([a-z0-9-]+))?$/.exec(location.hash);
  if (n) return { view: "new-session", sandbox: n[1] };
  const s = /^#\/session\/([0-9a-f]{1,64})$/.exec(location.hash);
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

const tabOf = (r: Route): TabId => (r.view === "draft" ? `new-session:${r.key}` : r.view === "session" ? `session:${r.id}` : "sandboxes");

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
    return r.view === "new-session" ? [{ key: nextKey(), sandbox: r.sandbox }] : [];
  });
  const [route, setRoute] = useState<Route>(() => {
    const r = parseHash();
    return r.view === "new-session" ? showDraft(newSessions[0].key) : r;
  });
  // Sessions being closed leave the tabs at once, without waiting for the server to confirm. So do those it says are
  // closing, which Claude finishes out of sight.
  const [ending, setEnding] = useState<ReadonlySet<string>>(new Set());
  const sessions = useMemo(() => live.sessions.filter((s) => !ending.has(s.id) && !s.closing), [live.sessions, ending]);
  // Changes only when a name does, so the windows' chats don't draw again for every change to a session.
  const namesKey = JSON.stringify(live.sessions.map((s) => [s.id, sessionName(s)]));
  const sessionNames = useMemo(() => new Map(JSON.parse(namesKey) as [string, string][]), [namesKey]);
  // The session tabs looked at last, most recent first: their windows stay mounted, so switching back is instant.
  const [recent, setRecent] = useState<string[]>([]);
  const onSession = route.view === "session" ? route.id : undefined;
  useEffect(() => {
    if (onSession) setRecent((r) => [onSession, ...r.filter((id) => id !== onSession)].slice(0, KEEP_MOUNTED));
  }, [onSession]);
  // In a fixed order, not by recency: a window moved in the page would lose its scroll positions.
  const keep = new Set((onSession ? [onSession, ...recent.filter((id) => id !== onSession)] : recent).slice(0, KEEP_MOUNTED));
  const kept = sessions.filter((s) => keep.has(s.id));
  // The order the tabs were dragged into. Tabs it doesn't name yet follow, sessions then New session tabs.
  const [order, setOrder] = useState<TabId[]>([]);
  // The sandboxes whose tabs are hidden behind their label.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // The session whose Cmd+Shift+W is waiting for confirmation.
  const [deleting, setDeleting] = useState<SessionInfo | undefined>();
  /** A session asked to close while commands Claude left running in the background would go with it. */
  const [stopping, setStopping] = useState<SessionInfo | undefined>();
  // The title bar's corner, where the open session shows its usage.
  const [corner, setCorner] = useState<HTMLDivElement | null>(null);
  // The sandbox whose page or session tab was last active, which a New session tab opened from elsewhere starts in.
  const recentSandbox = useRef<string | undefined>(undefined);
  useEffect(() => {
    const sandbox =
      route.view === "sandbox" || route.view === "edit" ? route.name : route.view === "session" ? sessions.find((s) => s.id === route.id)?.sandbox : undefined;
    if (sandbox) recentSandbox.current = sandbox;
  }, [route, sessions]);
  // Sessions this window just started: their tab opens before the session list may have caught up.
  const started = useRef(new Set<string>());
  // A snapshot after the first is a server that restarted. It lists the sessions whose Claude it picked up again; the
  // tabs' sessions it doesn't list are resumed, as at launch, and wait for it like ones just started. Any other wait is over, as the snapshot
  // lists all the server has. Like at launch, a stopped sandbox isn't started for them: they come back asleep.
  const shown = useRef<string[]>([]);
  const resuming = useRef<string[]>([]);
  const snapshotSeen = useRef(live.snapshots);
  if (snapshotSeen.current !== live.snapshots) {
    const restarted = snapshotSeen.current > 0;
    snapshotSeen.current = live.snapshots;
    resuming.current = restarted ? shown.current.filter((id) => !live.sessions.some((s) => s.id === id)) : [];
    started.current = new Set(resuming.current);
  }
  shown.current = [...new Set([...sessions.map((s) => s.id), ...started.current])];
  const [resumed, setResumed] = useState(0);
  useEffect(() => {
    const ids = resuming.current;
    if (!ids.length) return;
    void (async () => {
      for (const id of ids) if (!(await api.resumeSession(id, { start: false }).then(() => true, () => false))) started.current.delete(id);
      resuming.current = [];
      // Tabs whose session couldn't come back stop waiting, and the tabs are saved again.
      setResumed((n) => n + 1);
    })();
  }, [live.snapshots]);
  // Sessions whose tabs were closed, most recent last, for Cmd+Shift+T to bring back. Deleted ones are dropped, unless
  // Claude is finishing in them first: until it has, they can still come back.
  const closed = useRef<string[]>([]);
  const reopening = useRef(false);
  // The Sandboxes tab remembers where it was, so switching back returns to the same page.
  const sandboxesHash = useRef(tabOf(route) === "sandboxes" ? location.hash || "#/" : "#/");

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
      // order they started, which is the tab order. Those whose sandbox is stopped come back asleep, without starting it.
      const back = new Set<string>();
      for (const id of saved.sessions) {
        if (open.has(id)) back.add(id);
        else if (await api.resumeSession(id, { start: false }).then(() => true, () => false)) {
          back.add(id);
          // Its tab may open before the session list has caught up with the resume.
          started.current.add(id);
        }
      }
      // Keys are this window's own, so the saved active one is found by its place.
      const drafts = saved.newSessions.map((p) => ({ key: nextKey(), sandbox: p || undefined }));
      setNewSessions((open) => [...drafts, ...open]);
      const draftAt = (tab: string) => drafts[Number(/^new-session:([0-9]+)$/.exec(tab)?.[1] ?? NaN)];
      const savedOrder = saved.order.flatMap((t): TabId[] =>
        t.startsWith("session:") ? [t as TabId] : draftAt(t) ? [`new-session:${draftAt(t).key}`] : [],
      );
      setOrder((o) => [...savedOrder, ...o]);
      setCollapsed(new Set(saved.collapsed));
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
    // Not while the server is away or its sessions are coming back, which would save the tabs without them.
    if (!restored || !live.connected || resuming.current.length) return;
    // A New session tab is saved as active by its place, since keys don't outlive the window.
    const byPlace = (tab: TabId): TabId =>
      tab.startsWith("new-session:") ? `new-session:${newSessions.findIndex((n) => `new-session:${n.key}` === tab)}` : tab;
    saveTabs({
      sessions: sessions.map((s) => s.id),
      newSessions: newSessions.map((n) => n.sandbox ?? ""),
      active: byPlace(tabOf(route)),
      order: open.map(byPlace),
      // Only sandboxes with tabs: one whose last tab closed opens expanded next time.
      collapsed: [...collapsed].filter((name) => open.some((t) => sandboxOf(t) === name)),
    });
  }, [restored, live.connected, resumed, sessions, newSessions, order, collapsed, route]);

  useEffect(() => {
    const onHash = () => {
      let r = parseHash();
      if (r.view === "new-session") {
        const opened = { key: nextKey(), sandbox: r.sandbox ?? recentSandbox.current };
        setNewSessions((open) => [...open, opened]);
        r = showDraft(opened.key);
      }
      setRoute(r);
      if (tabOf(r) === "sandboxes") sandboxesHash.current = location.hash || "#/";
      scrollTo(0, 0);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  /** The sandbox a tab is in: its session's, or the one picked in a New session tab, if any. */
  const sandboxOf = (tab: TabId): string | undefined =>
    tab.startsWith("session:")
      ? sessions.find((s) => `session:${s.id}` === tab)?.sandbox
      : newSessions.find((n) => `new-session:${n.key}` === tab)?.sandbox;
  // The tabs in the order the header shows them: Sandboxes, then the rest, each sandbox's together.
  const open = group(
    arrange(order, [...sessions.map((s): TabId => `session:${s.id}`), ...newSessions.map((n): TabId => `new-session:${n.key}`)]),
    sandboxOf,
  );
  const tabs: TabId[] = ["sandboxes", ...open];
  // The tabs not hidden in a collapsed sandbox, the active one always among them.
  const visible = unfolded(open, sandboxOf, collapsed, tabOf(route));

  // A tab that comes to the front, by a link, a shortcut or a new session, brings its collapsed sandbox's tabs back;
  // so does one open at launch, once the saved tabs have come back collapsed. Only then: not when its session drops
  // out of the list for a moment, as when the server restarts, and comes back.
  const activeSandbox = sandboxOf(tabOf(route));
  const [expandActive] = useState(() =>
    expandInFront<string>((sandbox) => setCollapsed((c) => (c.has(sandbox) ? new Set([...c].filter((n) => n !== sandbox)) : c))),
  );
  useEffect(() => expandActive(`${restored}:${tabOf(route)}`, activeSandbox), [tabOf(route), activeSandbox, restored]);

  const select = (tab: TabId) => {
    if (tab === "sandboxes") go(sandboxesHash.current);
    else if (tab.startsWith("new-session:")) go(`#/session/draft/${tab.slice("new-session:".length)}`);
    else go(`#/session/${tab.slice("session:".length)}`);
  };

  const dropNewSession = (key: string) => setNewSessions((open) => open.filter((n) => n.key !== key));

  /** Names a New session tab after the sandbox picked in it. */
  const pickedIn = (key: string, name: string) =>
    setNewSessions((open) => {
      const sandbox = name || undefined;
      if (!open.some((n) => n.key === key && n.sandbox !== sandbox)) return open;
      return open.map((n) => (n.key === key ? { ...n, sandbox } : n));
    });

  /** After closing the active tab, move to the tab to its left, else the left-most one left, else the Sandboxes tab. */
  const leave = (tab: TabId) => {
    if (tabOf(route) === tab) select(landingAfterClose(tabs, tab));
  };

  /**
   * Closes a session's tab at once, and on the server, where Claude finishes its turn first unless `stop`; the tab comes
   * back if the server refuses. With `delete`, the saved chat goes too, so it can't be resumed once Claude is done.
   */
  const closeSession = async (s: SessionInfo, opts: { delete?: boolean; stop?: boolean } = {}) => {
    leave(`session:${s.id}`);
    setEnding((all) => new Set(all).add(s.id));
    try {
      const { finishing } = await api.closeSession(s.id, opts);
      closed.current = [...closed.current.filter((id) => id !== s.id), ...(opts.delete && !finishing ? [] : [s.id])];
    } catch {
      setEnding((all) => {
        const rest = new Set(all);
        rest.delete(s.id);
        return rest;
      });
    }
  };

  /** Resumes the most recently closed session that still can be. One deleted since, e.g. from the New session tab, is skipped. */
  const reopen = async () => {
    if (reopening.current) return;
    reopening.current = true;
    try {
      while (closed.current.length) {
        const id = closed.current[closed.current.length - 1];
        // Reopened some other way in the meantime: it isn't closed any more.
        if (live.sessions.some((s) => s.id === id && !s.closing && !ending.has(id))) {
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
    // Closing stops them; while subagents work, the session finishes first, and they run on until it has.
    if (s.shells && !isBusy(s)) return setStopping(s);
    void closeSession(s);
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
    // Cmd+1..9 jump to the nth tab after Sandboxes.
    if (typeof action === "number") {
      const target = visible[action - 1];
      return target ? select(target) : undefined;
    }
    const current = tabOf(route);
    if (action === "close") return current === "sandboxes" ? undefined : close(current);
    // Through the tabs on show, skipping those of collapsed sandboxes.
    const cycle: TabId[] = ["sandboxes", ...visible];
    const i = cycle.indexOf(current);
    const step = action === "next" ? 1 : -1;
    select(cycle[(Math.max(i, 0) + step + cycle.length) % cycle.length]);
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
    const offClose = window.kumiko?.onCloseTab((deleteToo) => shortcut.current(deleteToo ? "delete" : "close"));
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
    // It takes the place of the New session tab it was started in; one reopened goes last.
    setOrder((o) => replaceTab<TabId>(arrange(o, open), from ? `new-session:${from}` : undefined, `session:${id}`));
    go(`#/session/${id}`);
  };

  return (
    <div className="app">
      <Header
        sessions={sessions}
        newSessions={newSessions}
        order={open}
        active={tabOf(route)}
        onSelect={select}
        onClose={close}
        onMove={(tab, target, after) => setOrder(group(moveTab(open, tab, target, after), sandboxOf))}
        onMoveGroup={(moving, target, after) => setOrder(moveGroup(open, sandboxOf, moving, target, after))}
        collapsed={collapsed}
        onToggleGroup={(name) => setCollapsed((c) => (c.has(name) ? new Set([...c].filter((n) => n !== name)) : new Set([...c, name])))}
        onOpenSandbox={(name) => go(`#/sandbox/${name}`)}
        onNewSession={() => go("#/session/new")}
        cornerRef={setCorner}
      />
      {/* Kept mounted while their tabs are open, so a half-typed prompt survives switching tabs. */}
      {newSessions.map((n) => (
        <div key={n.key} hidden={!(route.view === "draft" && route.key === n.key)}>
          <NewSession live={live} sandbox={n.sandbox} onSandbox={(name) => pickedIn(n.key, name)} onStarted={(id) => onSessionStarted(id, n.key)} />
        </div>
      ))}
      {stopping && (
        <ConfirmDialog
          title={`Close “${sessionTitle(stopping)}”?`}
          confirmLabel="Stop them and close"
          danger
          enterConfirms
          onCancel={() => setStopping(undefined)}
          onConfirm={() => {
            const s = stopping;
            setStopping(undefined);
            void closeSession(s);
          }}
        >
          <p>
            Claude has {stopping.shells === 1 ? "a command" : `${stopping.shells} commands`} running in the background. Closing the session stops{" "}
            {stopping.shells === 1 ? "it" : "them"}.
          </p>
        </ConfirmDialog>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Close “${sessionTitle(deleting)}” and delete it from history?`}
          confirmLabel={isBusy(deleting) ? "Delete when done" : "Close and delete"}
          danger
          enterConfirms
          alternative={
            isBusy(deleting)
              ? {
                  label: "Stop and delete",
                  onClick: () => {
                    const s = deleting;
                    setDeleting(undefined);
                    void closeSession(s, { delete: true, stop: true });
                  },
                }
              : undefined
          }
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => {
            const s = deleting;
            setDeleting(undefined);
            void closeSession(s, { delete: true });
          }}
        >
          {isBusy(deleting) && (
            <p>
              Claude is still working in it and will be allowed to finish (up to 30 minutes), or you can stop it now with{" "}
              <strong>Stop and delete</strong>.
            </p>
          )}
        </ConfirmDialog>
      )}
      <HeaderCorner.Provider value={corner}>
        <Body
          route={route}
          live={live}
          started={started.current}
          onSessionStarted={onSessionStarted}
        />
        {/* The tab on screen and those looked at before it, hidden; Body decides whether there is one to show. */}
        {kept.map((s) => (
          <div key={s.id} className={`session-kept${s.id === onSession ? "" : " is-hidden"}`} aria-hidden={s.id !== onSession || undefined}>
            <Window
              session={s}
              active={s.id === onSession}
              onForked={(id) => onSessionStarted(id)}
              sessionNames={sessionNames}
              wake={s.asleep ? { sandbox: live.sandboxes.find((p) => p.name === s.sandbox), log: live.logs[s.sandbox] ?? [] } : undefined}
            />
          </div>
        ))}
      </HeaderCorner.Provider>
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
    case "repos":
      return <ReposPage live={live} />;
    case "new":
      return <SandboxForm mirrors={live.mirrors?.mirrors ?? []} onCancel={() => go("#/")} onCreated={(name) => go(`#/sandbox/${name}`)} />;
    case "sandbox":
      return (
        <SandboxPage
          key={route.name}
          id={route.name}
          live={live}
          onBack={() => go("#/")}
          onEdit={() => go(`#/sandbox/${route.name}/edit`)}
          onNewSession={() => go(`#/session/new/${route.name}`)}
          onSessionStarted={onSessionStarted}
        />
      );
    case "edit": {
      const p = live.sandboxes.find((s) => s.name === route.name);
      const back = () => go(`#/sandbox/${route.name}`);
      // Wait for the list before deciding; a sandbox whose VM record can't be read can't be edited.
      if (!live.loaded) return null;
      if (!p || p.metaError) return <Redirect to={`#/sandbox/${route.name}`} />;
      return <SandboxForm key={`edit-${route.name}`} editing={p} mirrors={live.mirrors?.mirrors ?? []} onCancel={back} onCreated={back} />;
    }
    case "new-session":
    case "draft":
      return null; // rendered by App, which keeps New session tabs mounted
    case "session": {
      // One Claude finishes after its tab closed has no tab.
      const s = live.sessions.find((x) => x.id === route.id && !x.closing);
      if (!live.loaded || (!s && started.has(route.id))) return null;
      if (!s) return <Redirect to="#/" />;
      return null; // rendered by App, which keeps the session tabs looked at last mounted
    }
    default:
      return <SandboxList live={live} onOpen={(name) => go(`#/sandbox/${name}`)} onNew={() => go("#/new")} onSessionStarted={onSessionStarted} />;
  }
}
