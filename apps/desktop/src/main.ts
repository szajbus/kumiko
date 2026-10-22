import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { app, BrowserWindow, dialog, ipcMain, session, shell, webContents, type NativeImage, type Session } from "electron";
import { frameMayLoad, isExternalUrl, isPreviewUrl, paneMayReach, paneNavigation } from "@kumiko/shared";
import { startServer, type RunningServer } from "@kumiko/server";
import { adoptLoginShellEnv } from "./shell-env.js";

const here = dirname(fileURLToPath(import.meta.url));

function webDir(): string {
  const packaged = join(process.resourcesPath, "web");
  if (app.isPackaged && existsSync(packaged)) return packaged;
  return resolve(here, "../../../packages/web/dist");
}

// macOS takes its icon from the bundle, Windows and Linux from the window; unpackaged, macOS would show Electron's in the Dock.
const icon = (file: string) => resolve(here, "../assets/icon", file);

/**
 * Development only: the window loads the UI from this URL (Vite's dev server, see dev.mjs) and the app starts no
 * server of its own; Vite proxies /api to one running on its own, so the UI and the server reload without the app.
 */
const devUrl = app.isPackaged ? undefined : process.env.KUMIKO_DEV_URL;
/** Where the window signs in to that server, with the token dev.mjs gave it (KUMIKO_TOKEN), and goes on to the UI. */
const devLoginUrl = devUrl && `${devUrl}/api/login?token=${encodeURIComponent(process.env.KUMIKO_TOKEN ?? "")}`;

let server: RunningServer | undefined;
let win: BrowserWindow | undefined;

/**
 * Opens a link in the default browser. Chat text comes from Claude and the code it reads, so only web and mail
 * links go out: shell.openExternal on file:, smb: or a custom scheme can open or run things on the host.
 */
function openOutside(target: string) {
  let link: URL;
  try {
    link = new URL(target);
  } catch {
    return;
  }
  if (link.protocol === "http:" || link.protocol === "https:" || link.protocol === "mailto:") void shell.openExternal(link.href);
}

const sameOrigin = (target: string, origin: string) => {
  try {
    return new URL(target).origin === origin;
  } catch {
    return false;
  }
};

function createWindow(url: string) {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: "Kumiko",
    backgroundColor: "#0F1115",
    ...(process.platform === "darwin" ? {} : { icon: icon("png/512x512.png") }),
    // On macOS the app header doubles as the title bar: 40px tall, the traffic lights (12px) centred in it.
    ...(process.platform === "darwin" ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 14, y: 14 } } : {}),
    show: false,
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // For previews of pages the sandboxes serve; locked down as each one attaches, below.
      webviewTag: true,
    },
  });
  // A page in a pane runs code that isn't the app's: no preload, no Node, sandboxed, and storage by what it shows, set
  // here from its URL whatever the page asked for: previews of this machine's pages, or external sites (km-web).
  win.webContents.on("will-attach-webview", (e, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webSecurity = true;
    prefs.allowRunningInsecureContent = false;
    if (isPreviewUrl(params.src)) prefs.partition = PREVIEWS;
    else if (isExternalUrl(params.src)) prefs.partition = SITES;
    else e.preventDefault();
  });
  win.once("ready-to-show", () => win?.show());
  // Keep the window on the app; anything else opens in the browser.
  // Compared by origin: a prefix check would let http://127.0.0.1:43170 pass for an app on port 4317.
  const origin = new URL(url).origin;
  // No windows: a page framed in the app's (an HTML artifact) could open them by script, with no click. The app's own
  // links go to the browser through kumiko:open-link, on a click.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-frame-navigate", (e) => {
    if (!e.isMainFrame && !frameMayLoad(e.url)) e.preventDefault();
  });
  win.webContents.on("will-navigate", (e, target) => {
    if (!sameOrigin(target, origin)) {
      e.preventDefault();
      openOutside(target);
    }
  });
  // Cmd/Ctrl+W closes the current tab, not the window; intercept it before the default menu accelerator does.
  // With Shift (the menu's Close Window on macOS) it also deletes the session.
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && (input.meta || input.control) && !input.alt && input.code === "KeyW") {
      e.preventDefault();
      win?.webContents.send("kumiko:close-tab", input.shift);
    }
  });
  if (devUrl) logPage(win);
  win.on("closed", () => (win = undefined));
  void win.loadURL(url);
}

/** The storage of pages in panes: previews of this machine's pages, and external sites, kept apart; in memory only. */
const PREVIEWS = "km-preview";
const SITES = "km-web";

/** Pages in panes get no permissions (camera, microphone, location, notifications…) and can't download. */
function guardPages(s: Session) {
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
  s.on("will-download", (e) => e.preventDefault());
}

/** The addresses a host name resolves to, remembered for a minute; none for one that doesn't resolve. */
const resolved = new Map<string, { at: number; addresses: Promise<string[]> }>();
function addressesOf(host: string): Promise<string[]> {
  const known = resolved.get(host);
  if (known && Date.now() - known.at < 60_000) return known.addresses;
  const addresses = lookup(host, { all: true }).then(
    (found) => found.map((a) => a.address),
    // Unresolvable: the request fails by itself.
    () => [],
  );
  resolved.set(host, { at: Date.now(), addresses });
  return addresses;
}

/**
 * Pages in panes can't reach private networks, and websites not this machine either (`paneMayReach`): a request to
 * such an address, or to a name that resolves to one (DNS rebinding), is cancelled. Otherwise a page could read the
 * intranet for Claude, by a picture.
 */
function guardPrivateNetwork(s: Session, pane: "preview" | "site") {
  s.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    let url: URL;
    try {
      url = new URL(details.url);
    } catch {
      return callback({ cancel: true });
    }
    if (["data:", "blob:", "about:"].includes(url.protocol)) return callback({});
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return callback({ cancel: true });
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // A page blocked whole goes away without a word from Chromium, so the pane showing it is told.
    const block = () => {
      if (details.resourceType === "mainFrame" && details.webContentsId !== undefined) {
        webContents.fromId(details.webContentsId)?.hostWebContents?.send("kumiko:page-blocked", details.webContentsId, details.url);
      }
      callback({ cancel: true });
    };
    if (!paneMayReach(pane, host)) return block();
    if (isIP(host)) return callback({});
    void addressesOf(host).then((addresses) => (addresses.every((a) => paneMayReach(pane, a)) ? callback({}) : block()));
  });
}

/** Development only: what the page logs, and its crashes and failed loads, go to the terminal, where they can be seen without DevTools. */
function logPage(w: BrowserWindow) {
  const page = w.webContents;
  page.on("console-message", (e) => {
    console.log(`[page ${e.level}] ${e.message}${e.sourceId ? ` (${e.sourceId}:${e.lineNumber})` : ""}`);
  });
  page.on("render-process-gone", (_e, d) => console.log(`[page] renderer gone: ${d.reason} (exit ${d.exitCode})`));
  page.on("did-fail-load", (_e, code, desc, target) => console.log(`[page] failed to load ${target}: ${desc} (${code})`));
  page.on("did-navigate", (_e, target, code) => console.log(`[page] loaded ${target} (${code})`));
  page.on("did-navigate-in-page", (_e, target) => console.log(`[page] moved to ${target}`));
  page.on("did-finish-load", () => console.log("[page] finished loading"));
  page.on("unresponsive", () => console.log("[page] unresponsive"));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });

  adoptLoginShellEnv();

  // Inside a preview, links stay on this machine's pages; inside an external site, on external sites. Others, and new
  // windows, don't open: a page's script can ask for them without a click, and the browser would load them with the
  // user's logins, on their network. The pane says where the page wanted to go, and the user can open it from there.
  app.on("web-contents-created", (_e, contents) => {
    // WebRTC connects on its own, past the requests guardPrivateNetwork sees, so only through a proxy, which is none.
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    if (contents.getType() !== "webview") return;
    const pane = contents.session === session.fromPartition(SITES) ? "site" : "preview";
    const ask = (target: string) => paneNavigation(pane, target) === "ask" && contents.hostWebContents?.send("kumiko:page-wants", contents.id, target);
    contents.setWindowOpenHandler(({ url: target }) => {
      ask(target);
      return { action: "deny" };
    });
    contents.on("will-navigate", (e, target) => {
      if (paneNavigation(pane, target) === "stay") return;
      e.preventDefault();
      ask(target);
    });
  });

  // A link the user clicked in the app's own page, not in a frame in it, opens in the browser.
  ipcMain.on("kumiko:open-link", (e, target: unknown) => {
    if (e.sender !== win?.webContents || e.senderFrame?.parent !== null || typeof target !== "string") return;
    openOutside(target);
  });

  // Pictures of panes for Claude, as PNGs in base64, no wider than it needs to see them.
  const png = (image: NativeImage) => (image.getSize().width > 1600 ? image.resize({ width: 1600 }) : image).toPNG().toString("base64");
  // The whole page, cropped here to `rect` (in page pixels): a picture never shows more than the pane it is of.
  ipcMain.handle("kumiko:capture", async (e, rect: Electron.Rectangle) => {
    if (e.sender !== win?.webContents) throw new Error("Not the app's window.");
    const full = await e.sender.capturePage();
    const scale = full.getSize().width / win.getContentBounds().width;
    const size = full.getSize();
    const crop = {
      x: Math.max(0, Math.round(rect.x * scale)),
      y: Math.max(0, Math.round(rect.y * scale)),
      width: Math.round(rect.width * scale),
      height: Math.round(rect.height * scale),
    };
    crop.width = Math.min(crop.width, size.width - crop.x);
    crop.height = Math.min(crop.height, size.height - crop.y);
    if (crop.width <= 0 || crop.height <= 0) throw new Error("The pane isn't on screen.");
    return png(full.crop(crop));
  });
  ipcMain.handle("kumiko:capture-webview", async (e, id: number) => {
    const guest = webContents.fromId(id);
    if (!guest || guest.hostWebContents !== e.sender) throw new Error("Not a preview in the app's window.");
    // No page loaded, nothing of its own to show: the pane is captured instead.
    if (!guest.getURL() || guest.getURL() === "about:blank") throw new Error("No page loaded.");
    return png(await guest.capturePage());
  });

  ipcMain.handle("kumiko:pick-folder", async (e) => {
    const owner = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const opts: Electron.OpenDialogOptions = { title: "Choose a folder", properties: ["openDirectory", "createDirectory"] };
    const res = owner ? await dialog.showOpenDialog(owner, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? null : res.filePaths[0] ?? null;
  });

  app.whenReady().then(async () => {
    guardPages(session.fromPartition(PREVIEWS));
    guardPages(session.fromPartition(SITES));
    guardPrivateNetwork(session.fromPartition(PREVIEWS), "preview");
    guardPrivateNetwork(session.fromPartition(SITES), "site");
    if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(icon("macos/icon-macos-1024.png"));
    if (devLoginUrl) {
      createWindow(devLoginUrl);
      app.on("activate", () => {
        if (!win) createWindow(devLoginUrl);
      });
      return;
    }
    try {
      server = await startServer({ port: Number(process.env.KUMIKO_PORT ?? 0), webDir: webDir() });
    } catch (err) {
      dialog.showErrorBox("Kumiko couldn't start its server", err instanceof Error ? err.message : String(err));
      app.quit();
      return;
    }
    createWindow(server.loginUrl);
    app.on("activate", () => {
      if (!win && server) createWindow(server.loginUrl);
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Quitting leaves Claude working in the sandboxes, and the app picks its sessions up when it opens again. When Claude
  // is working, say so, and offer to stop it instead, as closing each tab would.
  let closing = false;
  let asking = false;
  app.on("before-quit", (e) => {
    if (!server || closing) return;
    e.preventDefault();
    if (asking) return;
    const working = server.working().length;
    const quit = (endSessions: boolean) => {
      closing = true;
      void server!.close({ endSessions }).finally(() => app.exit(0));
    };
    if (!working) return quit(false);
    asking = true;
    const opts: Electron.MessageBoxOptions = {
      type: "info",
      message: working === 1 ? "Claude is still working in a session." : `Claude is still working in ${working} sessions.`,
      detail: "Claude keeps working in the background. Reopen Kumiko to see it.",
      buttons: ["Quit", "Stop Claude and Quit", "Cancel"],
      defaultId: 0,
      cancelId: 2,
    };
    void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then(({ response }) => {
      asking = false;
      if (response === 0) quit(false);
      else if (response === 1) quit(true);
    });
  });
}
