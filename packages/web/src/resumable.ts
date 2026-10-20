/**
 * What the list of resumable sessions depends on: the open sessions, which aren't in it, and the projects, whose
 * deletion takes their saved sessions with them. The list is read again whenever this changes.
 */
export function resumableKey(live: { sessions: readonly { id: string }[]; projects: readonly { name: string }[] }): string {
  return `${live.sessions.map((s) => s.id).join()}|${live.projects.map((p) => p.name).join()}`;
}
