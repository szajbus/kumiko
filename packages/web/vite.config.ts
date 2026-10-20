import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The short sha of the commit being built, with a "+" when the working tree has uncommitted changes. */
function commitSha(): string {
  try {
    const run = (cmd: string) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return run("git rev-parse --short HEAD") + (run("git status --porcelain") ? "+" : "");
  } catch {
    return "unknown";
  }
}

const server = process.env.KUMIKO_SERVER ?? "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [react()],
  define: { __COMMIT_SHA__: JSON.stringify(commitSha()) },
  resolve: {
    alias: { "@kumiko/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) },
  },
  server: {
    proxy: { "/api": { target: server, ws: true } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
