#!/usr/bin/env node
// Runs the server on its own, so the UI can be developed in a browser.
//   node packages/server/dist/src/main.js [--port 4317] [--web packages/web/dist]
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startServer } from "./server.js";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: process.env.KUMIKO_PORT ?? "4317" },
    web: { type: "string" },
  },
});

const here = dirname(fileURLToPath(import.meta.url));
const builtWeb = resolve(here, "../../../web/dist");
const webDir = values.web ? resolve(values.web) : existsSync(join(builtWeb, "index.html")) ? builtWeb : undefined;

// KUMIKO_TOKEN keeps the token across restarts, as dev.mjs's watcher makes; otherwise each start has a new one.
const server = await startServer({ port: Number(values.port), webDir, token: process.env.KUMIKO_TOKEN || undefined });
console.log(`Kumiko server on ${server.url}${webDir ? "" : " (API only; web UI not built)"}`);
console.log(`Open ${server.loginUrl} to sign a browser in; through the dev UI, the same path on its port.`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void server.close().then(() => process.exit(0)));
}
