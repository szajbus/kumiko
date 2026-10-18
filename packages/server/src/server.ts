import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ENV_NAME_PATTERN,
  NAME_PATTERN,
  vmName,
  type ApiError,
  type CreateResponse,
  type OpKind,
  type SandboxInfo,
  type SandboxSpec,
  type SandboxView,
  type ServerEvent,
  type TemplatesResponse,
} from "@bentomo/shared";
import { LimaProvider, type Log, type SandboxProvider } from "@bentomo/sandbox";
import { isLocalRequest } from "./guard.js";
import { BusyError, Operations } from "./operations.js";
import { serveWeb } from "./static.js";

export interface ServerOptions {
  provider?: SandboxProvider;
  /** 0 picks a free port. */
  port?: number;
  host?: string;
  /** The built web UI; omit to serve the API only. */
  webDir?: string;
  /** How often to re-read `limactl list`, in ms. */
  refreshMs?: number;
  /** Where forwarded variables are looked up for the form's "set on host" dots. */
  env?: () => NodeJS.ProcessEnv;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const provider = opts.provider ?? new LimaProvider({ env: opts.env });
  const env = opts.env ?? (() => process.env);
  const host = opts.host ?? "127.0.0.1";
  const ops = new Operations();
  const clients = new Set<WebSocket>();

  // ---- list state -------------------------------------------------------------------------

  let infos: SandboxInfo[] = [];
  let listError: string | undefined;
  let lastListJson = "";
  let refreshing: Promise<void> | undefined;
  let refreshAgain = false;

  const broadcast = (ev: ServerEvent) => {
    const msg = JSON.stringify(ev);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
  };

  const views = (): SandboxView[] => ops.views(infos);

  const pushListIfChanged = () => {
    const sandboxes = views();
    const json = JSON.stringify({ sandboxes, listError });
    if (json === lastListJson) return;
    lastListJson = json;
    broadcast({ type: "list", sandboxes, error: listError });
  };

  /** Re-reads the provider's list; concurrent calls coalesce into one extra run. */
  const refresh = (): Promise<void> => {
    if (refreshing) {
      refreshAgain = true;
      return refreshing;
    }
    refreshing = (async () => {
      do {
        refreshAgain = false;
        try {
          infos = await provider.list();
          listError = undefined;
        } catch (err) {
          listError = err instanceof Error ? err.message : String(err);
        }
        pushListIfChanged();
      } while (refreshAgain);
    })().finally(() => (refreshing = undefined));
    return refreshing;
  };

  ops.on("event", (ev) => {
    broadcast(ev);
    if (ev.type !== "log") pushListIfChanged();
  });
  ops.on("settled", () => void refresh());

  const timer = setInterval(() => void refresh(), opts.refreshMs ?? 5000);
  await refresh();

  // ---- routes -----------------------------------------------------------------------------

  const app = new Hono();
  const fail = (error: string, details?: string[]): ApiError => (details?.length ? { error, details } : { error });

  app.use("/api/*", async (c, next) => {
    if (!isLocalRequest(c.req.raw.headers)) return c.json(fail("Forbidden: not a local request."), 403);
    await next();
  });

  app.get("/api/sandboxes", async (c) => {
    await refresh();
    if (listError && infos.length === 0) return c.json(fail(listError), 500);
    return c.json(views());
  });

  let templatesCache: TemplatesResponse | undefined;
  app.get("/api/templates", async (c) => {
    try {
      templatesCache ??= await provider.templates();
      return c.json(templatesCache);
    } catch (err) {
      return c.json(fail(err instanceof Error ? err.message : String(err)), 500);
    }
  });

  /** Which of the given variable names are set in Bentomo's environment. Never returns values. */
  app.get("/api/env", (c) => {
    const names = (c.req.query("names") ?? "").split(",").map((n) => n.trim()).filter((n) => ENV_NAME_PATTERN.test(n));
    const e = env();
    return c.json(Object.fromEntries(names.map((n) => [n, e[n] !== undefined])));
  });

  const begin = (name: string, op: OpKind, work: (log: Log) => Promise<void>) => {
    ops.start(name, op, work);
  };

  app.post("/api/sandboxes", async (c) => {
    let body: SandboxSpec;
    try {
      body = await c.req.json<SandboxSpec>();
    } catch {
      return c.json(fail("Body must be a JSON SandboxSpec."), 400);
    }
    const name = String(body?.name ?? "").trim();
    if (ops.running(name)) return c.json(fail(`${vmName(name)} is busy ${ops.get(name)!.op}.`), 409);
    let v;
    try {
      v = await provider.validate(body);
    } catch (err) {
      return c.json(fail(err instanceof Error ? err.message : String(err)), 500);
    }
    if (v.errors.length) return c.json(fail("Invalid sandbox spec.", v.errors), 400);
    try {
      begin(v.spec.name, "creating", (log) => provider.create(v.spec, log));
    } catch (err) {
      if (err instanceof BusyError) return c.json(fail(err.message), 409);
      throw err;
    }
    void refresh();
    return c.json({ name: v.spec.name, warnings: v.warnings } satisfies CreateResponse, 202);
  });

  /** Looks up a sandbox the provider knows; 400 for a bad name, 404 for an unknown one. */
  const known = async (name: string): Promise<SandboxInfo | ApiError> => {
    if (!NAME_PATTERN.test(name)) return fail(`Invalid sandbox name "${name}".`);
    await refresh();
    return infos.find((i) => i.name === name) ?? fail(`${vmName(name)} does not exist.`);
  };

  const action = (op: OpKind, work: (info: SandboxInfo, log: Log) => Promise<void>) => async (c: Context) => {
    const name = c.req.param("name")!;
    const cur = ops.get(name);
    if (cur && !cur.endedAt) return c.json(fail(`${vmName(name)} is busy ${cur.op}.`), 409);
    const info = await known(name);
    if ("error" in info) return c.json(info, NAME_PATTERN.test(name) ? 404 : 400);
    try {
      begin(name, op, (log) => work(info, log));
    } catch (err) {
      if (err instanceof BusyError) return c.json(fail(err.message), 409);
      throw err;
    }
    return c.json({ name, op }, 202);
  };

  app.post("/api/sandboxes/:name/start", action("starting", (i, log) => provider.start(i.name, log)));
  app.post("/api/sandboxes/:name/stop", action("stopping", (i, log) => provider.stop(i.name, log)));
  app.delete("/api/sandboxes/:name", action("deleting", (i, log) => provider.delete(i.name, log)));

  app.post("/api/sandboxes/:name/provision", async (c, next) => {
    const info = await known(c.req.param("name") ?? "");
    if (!("error" in info) && !info.meta) return c.json(fail(`${vmName(info.name)} has no Bentomo metadata.`), 400);
    return next();
  }, action("provisioning", (i, log) => provider.provision(i.name, log)));

  /** Delete, then create again from the stored spec. */
  app.post("/api/sandboxes/:name/recreate", async (c, next) => {
    const info = await known(c.req.param("name") ?? "");
    if (!("error" in info) && !info.meta) return c.json(fail(`${vmName(info.name)} has no stored spec to recreate from.`), 400);
    return next();
  }, action("recreating", async (i, log) => {
    const spec = i.meta!.spec;
    await provider.delete(i.name, log);
    await provider.create(spec, log);
  }));

  app.all("/api/*", (c) => c.json(fail("Not found."), 404));
  if (opts.webDir) app.get("*", serveWeb(opts.webDir));

  // ---- http + websocket -------------------------------------------------------------------

  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: opts.port ?? 4317, hostname: host }, () => resolve(s as Server)) as Server;
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== "/api/events" || !isLocalRequest(req.headers)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      ws.on("error", () => clients.delete(ws));
      ws.send(JSON.stringify({ type: "snapshot", sandboxes: views(), logs: ops.logs(), error: listError } satisfies ServerEvent));
    });
  });

  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}`,
    port,
    close: async () => {
      clearInterval(timer);
      for (const ws of clients) ws.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
