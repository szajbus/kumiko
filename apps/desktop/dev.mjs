// Runs the app for development: the server rebuilds and restarts as its code changes, the UI hot-reloads through
// Vite, and the Electron window loads it from there (KUMIKO_DEV_URL), so neither needs the app restarted.
// Changes to the Electron main process or preload still do. Quitting the app stops everything.
//   npm run dev:desktop
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Whether nothing listens on `port` at `host`. A host this machine doesn't have (no IPv6, say) counts as free. */
const freeOn = (port, host) =>
  new Promise((done) => {
    const probe = createServer();
    probe.once("error", (err) => done(err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT"));
    probe.listen(port, host, () => probe.close(() => done(true)));
  });

/** The first port from `from` up that is free on both loopbacks, since "localhost" can be either. */
const freePort = async (from) => {
  for (let port = from; port < from + 100; port++) {
    if ((await freeOn(port, "127.0.0.1")) && (await freeOn(port, "::1"))) {
      if (port !== from) console.log(`Port ${from} is in use; using ${port}.`);
      return port;
    }
  }
  throw new Error(`No free port from ${from} to ${from + 99}.`);
};

// KUMIKO_PORT and KUMIKO_WEB_PORT pick where to start looking.
const port = await freePort(Number(process.env.KUMIKO_PORT ?? 4317));
const webPort = await freePort(Number(process.env.KUMIKO_WEB_PORT ?? 5173));
const devUrl = `http://localhost:${webPort}`;
// One token for every restart of the server, so the window stays signed in through them.
const token = randomBytes(32).toString("hex");

const children = [];
const run = (cmd, args, opts = {}) => {
  const child = spawn(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  children.push(child);
  return child;
};
const stop = () => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// Built once up front, so the server has something to run before the watcher's first pass.
const tsc = resolve(root, "node_modules/.bin/tsc");
if (spawnSync(tsc, ["-b", "packages/server"], { cwd: root, stdio: "inherit" }).status !== 0) process.exit(1);
if (spawnSync(process.execPath, ["build.mjs"], { cwd: resolve(root, "apps/desktop"), stdio: "inherit" }).status !== 0) process.exit(1);

run(tsc, ["-b", "packages/server", "--watch", "--preserveWatchOutput"]);
run(process.execPath, ["--watch", "packages/server/dist/src/main.js", "--port", String(port)], { env: { ...process.env, KUMIKO_TOKEN: token } });
// Vite itself, not through npm, which doesn't pass the signal on when it is stopped.
run(resolve(root, "node_modules/.bin/vite"), ["--port", String(webPort), "--strictPort"], {
  cwd: resolve(root, "packages/web"),
  env: { ...process.env, KUMIKO_SERVER: `http://127.0.0.1:${port}` },
});

// The window opens once Vite answers.
for (let i = 0; ; i++) {
  try {
    await fetch(devUrl);
    break;
  } catch {
    if (i > 300) throw new Error(`Vite didn't come up on ${devUrl}.`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
run(electron, ["."], { cwd: resolve(root, "apps/desktop"), env: { ...process.env, KUMIKO_DEV_URL: devUrl, KUMIKO_TOKEN: token } }).on("exit", stop);
