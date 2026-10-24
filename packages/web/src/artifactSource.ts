import type { ArtifactType } from "@kumiko/shared";

/** Artifacts drawn from a source that can be shown instead, by the language it is in. */
export const SOURCE_LANG: Partial<Record<ArtifactType, string>> = { mermaid: "mermaid", svg: "xml", html: "html" };

/**
 * The language of the source an artifact shows instead of what it draws, or nothing when it shows that: its source shows
 * while Claude writes it, and when the user asks for it.
 */
export const shownSource = (type: ArtifactType, asked: boolean, writing: boolean): string | undefined =>
  asked || writing ? SOURCE_LANG[type] : undefined;
