import type { ComposerFile } from "./attachments";
import type { Pastes } from "./pastes";

/** A composer's unsent text, what the paste labels in it stand for, and the files to go with it. */
export interface Draft {
  text: string;
  pastes?: Pastes;
  files?: ComposerFile[];
}

/**
 * Unsent messages per composer, kept while it is unmounted (switching tabs). A rewind also puts the message it took out
 * of the conversation here, for the session's composer to start again with.
 */
export const drafts = new Map<string, Draft>();
