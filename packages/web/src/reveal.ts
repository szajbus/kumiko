/**
 * Paths Claude names that are files on this Mac, which the UI can show in the Finder: those under a folder shared
 * with the sandbox's VM (`SandboxView.shared`), as the VM names them.
 */

const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * The path in `text`, if it is one and nothing else: absolute or "~/…", on one line, without a ":line" or ":line:col"
 * after it, as Claude points at a line. Undefined for anything else, such as a URL or a command.
 */
export function pathIn(text: string): string | undefined {
  const t = text.trim();
  if (!(t.startsWith("/") || t.startsWith("~/")) || t.length > 1024 || /[\n\r\t]/.test(t)) return undefined;
  const p = t.replace(/:\d+(?::\d+)?$/, "");
  if (p.split("/").some((part) => part === "..")) return undefined;
  return p.length > 1 ? p : undefined;
}

/** The path in `text`, if it is one under one of `roots`. */
export function revealablePath(text: string, roots: readonly string[] | undefined): string | undefined {
  if (!roots?.length) return undefined;
  const p = pathIn(text);
  return p && roots.some((r) => within(p, r)) ? p : undefined;
}
