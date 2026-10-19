/**
 * Unsent text per composer, kept while it is unmounted (switching tabs). A rewind also puts the message it took out
 * of the conversation here, under the new session's id, for its composer to start with.
 */
export const drafts = new Map<string, string>();
