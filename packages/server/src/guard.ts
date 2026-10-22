import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function parse(value: string): URL | undefined {
  try {
    return new URL(value.includes("://") ? value : `http://${value}`);
  } catch {
    return undefined;
  }
}

type AnyHeaders = IncomingHttpHeaders | Headers;

const header = (headers: AnyHeaders, k: string) => (headers instanceof Headers ? headers.get(k) ?? undefined : (headers[k] as string | undefined));

/**
 * The server only listens on 127.0.0.1, but a web page in any browser can still send it requests: other sites, and
 * pages served from this machine, including a project's dev server shown in a preview pane, which runs code from the
 * sandbox. So a request's Host must be local (against DNS rebinding), and its Origin, when a browser sends one, must be
 * the server's own: a local host on `port`. The dev UI's proxy rewrites its own pages' requests to that origin.
 */
export function isLocalRequest(headers: AnyHeaders, port: number): boolean {
  const host = header(headers, "host");
  if (!host || !LOCAL_HOSTS.has(parse(host)?.hostname ?? "")) return false;
  const origin = header(headers, "origin");
  if (origin === undefined) return true;
  const o = parse(origin);
  return Boolean(o && o.protocol === "http:" && LOCAL_HOSTS.has(o.hostname) && Number(o.port || 80) === port);
}

/** The cookie that carries the server's token for a browser. Cookies don't keep ports apart, so its name does. */
export const tokenCookie = (port: number) => `kumiko-${port}`;

/** Whether `given` is the token, compared in constant time. */
export function isToken(given: string | undefined, token: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Whether a request carries the server's token: a script's as `Authorization: Bearer`, a browser's in its cookie.
 * Checking Host and Origin isn't enough on its own: a sandbox reaches this machine's loopback through Lima's host
 * address, and the agent in it sends whatever headers it likes. The token is something it can't learn.
 */
export function hasToken(headers: AnyHeaders, token: string, port: number): boolean {
  const bearer = /^Bearer (\S+)$/.exec(header(headers, "authorization") ?? "")?.[1];
  if (isToken(bearer, token)) return true;
  const name = tokenCookie(port);
  for (const part of (header(headers, "cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name && isToken(part.slice(at + 1).trim(), token)) return true;
  }
  return false;
}
