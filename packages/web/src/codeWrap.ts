/**
 * Whether code blocks wrap their long lines: one choice for every block in the window, kept until the app quits. The
 * Wrap button on any block changes it for all of them.
 */
let wrapped = false;
const listeners = new Set<() => void>();

export const codeWrap = {
  get: (): boolean => wrapped,
  set(value: boolean): void {
    if (value === wrapped) return;
    wrapped = value;
    for (const l of listeners) l();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
