import type { Pastes } from "./pastes";

/** A composer's unsent text, and what the paste labels in it stand for. */
export interface Draft {
  text: string;
  pastes?: Pastes;
}

/**
 * Unsent text per composer, kept while it is unmounted (switching tabs). A rewind also puts the message it took out
 * of the conversation here, for the session's composer to start again with.
 */
export const drafts = new Map<string, Draft>();
