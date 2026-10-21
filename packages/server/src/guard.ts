import type { IncomingHttpHeaders } from "node:http";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function parse(value: string): URL | undefined {
  try {
    return new URL(value.includes("://") ? value : `http://${value}`);
  } catch {
    return undefined;
  }
}

/**
 * The server only listens on 127.0.0.1, but a web page in any browser can still send it requests: other sites, and
 * pages served from this machine, including a project's dev server shown in a preview pane, which runs code from the
 * sandbox. So a request's Host must be local (against DNS rebinding), and its Origin, when a browser sends one, must be
 * the server's own: a local host on `port`. The dev UI's proxy rewrites its own pages' requests to that origin.
 */
export function isLocalRequest(headers: IncomingHttpHeaders | Headers, port: number): boolean {
  const get = (k: string) => (headers instanceof Headers ? headers.get(k) ?? undefined : (headers[k] as string | undefined));
  const host = get("host");
  if (!host || !LOCAL_HOSTS.has(parse(host)?.hostname ?? "")) return false;
  const origin = get("origin");
  if (origin === undefined) return true;
  const o = parse(origin);
  return Boolean(o && o.protocol === "http:" && LOCAL_HOSTS.has(o.hostname) && Number(o.port || 80) === port);
}
