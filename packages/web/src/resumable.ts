/**
 * What the list of resumable sessions depends on: the open sessions, which aren't in it unless their tab closed while
 * Claude finishes, and the projects, whose deletion takes their saved sessions with them. The list is read again
 * whenever this changes.
 */
export function resumableKey(live: { sessions: readonly { id: string; closing?: { delete: boolean } }[]; projects: readonly { name: string }[] }): string {
  const sessions = live.sessions.map((s) => (s.closing ? `${s.id}:${s.closing.delete ? "deleting" : "closing"}` : s.id));
  return `${sessions.join()}|${live.projects.map((p) => p.name).join()}`;
}
