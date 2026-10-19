/**
 * Unsent text per composer, kept while it is unmounted (switching tabs). A rewind also puts the message it took out
 * of the conversation here, for the session's composer to start again with.
 */
export const drafts = new Map<string, string>();
