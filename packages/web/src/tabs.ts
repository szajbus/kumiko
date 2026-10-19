import type { TabId } from "./Header";

/** The window's tabs as they were, to bring back on the next start. */
export interface SavedTabs {
  /** Session ids in tab order. */
  sessions: string[];
  newSession: boolean;
  active: TabId;
}

const KEY = "bentomo.tabs";

export function loadTabs(): SavedTabs | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<SavedTabs> | null;
    if (!v || !Array.isArray(v.sessions) || typeof v.active !== "string") return undefined;
    return { sessions: v.sessions.filter((x): x is string => typeof x === "string"), newSession: v.newSession === true, active: v.active as TabId };
  } catch {
    return undefined;
  }
}

export function saveTabs(tabs: SavedTabs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(tabs));
  } catch {
    // Storage full or blocked: the tabs just won't come back.
  }
}
