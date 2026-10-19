import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { Context } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/** Serves the built web UI from `root`, falling back to index.html for client-side routes. */
export function serveWeb(root: string) {
  const base = normalize(root + sep);
  return async (c: Context) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.notFound(); // malformed percent-encoding
    }
    let file = normalize(join(base, path));
    if (!file.startsWith(base)) return c.notFound();
    try {
      if (!(await stat(file)).isFile()) file = join(base, "index.html");
    } catch {
      file = join(base, "index.html");
    }
    try {
      const body = await readFile(file);
      const type = TYPES[extname(file)] ?? "application/octet-stream";
      const cache = file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
      return c.body(body, 200, { "content-type": type, "cache-control": cache });
    } catch {
      return c.text("Web UI not built. Run `npm run build`.", 404);
    }
  };
}
