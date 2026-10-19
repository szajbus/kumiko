import type { SavedTabs as Saved } from "@bentomo/shared";
import { api } from "./api";
import type { TabId } from "./Header";

/** The window's tabs as they were, to bring back on the next start. */
export interface SavedTabs extends Saved {
  active: TabId;
}

/** The last run's tabs. The server keeps them: the desktop app's port, and with it this page's localStorage, changes every launch. */
export async function loadTabs(): Promise<SavedTabs | undefined> {
  const saved = await api.tabs().catch(() => null);
  return saved ? { ...saved, active: saved.active as TabId } : undefined;
}

let saving: Promise<unknown> = Promise.resolve();

/** Saves after any save still under way, so an older one can't land last. A failed save just means the tabs won't come back. */
export function saveTabs(tabs: SavedTabs): void {
  saving = saving.then(() => api.saveTabs(tabs)).catch(() => {});
}
