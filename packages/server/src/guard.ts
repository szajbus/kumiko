import type { IncomingHttpHeaders } from "node:http";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostname(value: string): string | undefined {
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * The server only listens on 127.0.0.1, but a web page in any browser can still send it requests.
 * Refuse requests whose Host isn't local (DNS rebinding) or whose Origin is another site (CSRF).
 */
export function isLocalRequest(headers: IncomingHttpHeaders | Headers): boolean {
  const get = (k: string) => (headers instanceof Headers ? headers.get(k) ?? undefined : (headers[k] as string | undefined));
  const host = get("host");
  if (!host || !LOCAL_HOSTS.has(hostname(host) ?? "")) return false;
  const origin = get("origin");
  return origin === undefined || LOCAL_HOSTS.has(hostname(origin) ?? "");
}
