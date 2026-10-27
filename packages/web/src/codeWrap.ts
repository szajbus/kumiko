/** A choice of whether to wrap long lines, kept until the app quits, that everything showing those lines follows. */
export interface WrapChoice {
  get(): boolean;
  set(value: boolean): void;
  subscribe(listener: () => void): () => void;
}

function wrapChoice(initial: boolean): WrapChoice {
  let wrapped = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => wrapped,
    set(value) {
      if (value === wrapped) return;
      wrapped = value;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Whether code blocks wrap their long lines: one choice for every block in the window. The Wrap button on any block
 * changes it for all of them.
 */
export const codeWrap = wrapChoice(false);

/**
 * Whether artifacts' source wraps its long lines: one choice for every artifact pane. It starts wrapped, as the source
 * of a page or drawing is read rather than copied from line by line.
 */
export const sourceWrap = wrapChoice(true);

/**
 * Whether Markdown artifacts fill their pane's width rather than keep to the chat's: one choice for every artifact pane.
 */
export const markdownFull = wrapChoice(false);
