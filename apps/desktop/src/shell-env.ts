import { spawnSync } from "node:child_process";

const MARKER = "__KUMIKO_ENV__";

/**
 * Apps launched from the Dock or Finder get a bare environment: no Homebrew on PATH (so no limactl),
 * and none of the variables people export in their shell profile (so nothing to forward).
 * Read the login shell's environment once at startup and fill in what's missing.
 */
export function adoptLoginShellEnv(): void {
  if (process.platform === "win32") return;
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const res = spawnSync(shell, ["-ilc", `printf '\\0${MARKER}\\0'; env -0`], {
    encoding: "utf8",
    timeout: 8000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const out = res.stdout ?? "";
  const at = out.indexOf(`\0${MARKER}\0`);
  if (at >= 0) {
    for (const entry of out.slice(at + MARKER.length + 2).split("\0")) {
      const eq = entry.indexOf("=");
      if (eq <= 0) continue;
      const key = entry.slice(0, eq);
      if (key === "PATH" || process.env[key] === undefined) process.env[key] = entry.slice(eq + 1);
    }
  }
  // Common install locations for limactl, in case the profile didn't add them.
  const path = new Set((process.env.PATH ?? "").split(":").filter(Boolean));
  for (const p of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]) path.add(p);
  process.env.PATH = [...path].join(":");
}
