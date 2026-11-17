import { execFile } from "node:child_process";
import { join, posix } from "node:path";
import type { Mount } from "@kumiko/shared";

const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

/** A path in the VM made absolute and normalized: "~/…" with the VM user's home `vmHome`. Undefined when it can't be. */
function absolute(path: string, vmHome: string | undefined): string | undefined {
  const p = path.startsWith("~/") ? (vmHome ? `${vmHome}${path.slice(1)}` : undefined) : path;
  return p?.startsWith("/") ? posix.normalize(p).replace(/(.)\/+$/, "$1") : undefined;
}

/** Each place in the VM a mount is at, as the spec names it: where it is mounted, then its alias, if it has one. */
const placesOf = (m: Mount) => [m.guestPath ?? m.hostPath, ...(m.alias ? [m.alias] : [])];

/**
 * Where a path in the VM is on the host, through the VM's `mounts`; undefined if it isn't in one of them. A path with
 * "~/", or under a mount at one, needs the VM user's home, `vmHome`. The innermost mount wins, as in the VM.
 */
export function hostPathFor(vmPath: string, mounts: Mount[], vmHome?: string): string | undefined {
  const p = absolute(vmPath.trim(), vmHome);
  if (!p) return undefined;
  let best: { at: string; host: string } | undefined;
  for (const m of mounts) {
    for (const place of placesOf(m)) {
      const at = absolute(place, vmHome);
      if (at && within(p, at) && (!best || at.length > best.at.length)) best = { at, host: m.hostPath };
    }
  }
  return best && join(best.host, posix.relative(best.at, p));
}

/**
 * The places in the VM that are folders on the host, for the UI to offer to reveal a path under one: each mount's,
 * as the spec names it ("~/…" too) and absolute where `vmHome` is known.
 */
export function sharedRoots(mounts: Mount[], vmHome?: string): string[] {
  const roots = mounts.flatMap((m) => placesOf(m).flatMap((p) => [p, absolute(p, vmHome)]));
  return [...new Set(roots.filter((r): r is string => Boolean(r)))];
}

/** Shows a file or folder on the host in the Finder, selected; elsewhere, opens the folder it is in. */
export function revealOnHost(path: string): Promise<void> {
  const [cmd, args] = process.platform === "darwin" ? ["open", ["-R", path]] : ["xdg-open", [posix.dirname(path)]];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, _out, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve()));
  });
}
