import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
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
    },
  });
  win.once("ready-to-show", () => win?.show());
  // Keep the window on the app; anything else opens in the browser.
  // Compared by origin: a prefix check would let http://127.0.0.1:43170 pass for an app on port 4317.
  const origin = new URL(url).origin;
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    openOutside(target);
    return { action: "deny" };
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
  win.on("closed", () => (win = undefined));
  void win.loadURL(url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });

  adoptLoginShellEnv();

  ipcMain.handle("kumiko:pick-folder", async (e) => {
    const owner = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const opts: Electron.OpenDialogOptions = { title: "Choose a folder", properties: ["openDirectory", "createDirectory"] };
    const res = owner ? await dialog.showOpenDialog(owner, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? null : res.filePaths[0] ?? null;
  });

  app.whenReady().then(async () => {
    if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(icon("macos/icon-macos-1024.png"));
    try {
      server = await startServer({ port: Number(process.env.KUMIKO_PORT ?? 0), webDir: webDir() });
    } catch (err) {
      dialog.showErrorBox("Kumiko couldn't start its server", err instanceof Error ? err.message : String(err));
      app.quit();
      return;
    }
    createWindow(server.url);
    app.on("activate", () => {
      if (!win && server) createWindow(server.url);
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Quitting ends every session, so a turn Claude is still working on stops: ask first.
  let closing = false;
  let asking = false;
  app.on("before-quit", (e) => {
    if (!server || closing) return;
    e.preventDefault();
    if (asking) return;
    const working = server.working().length;
    const quit = () => {
      closing = true;
      void server!.close().finally(() => app.exit(0));
    };
    if (!working) return quit();
    asking = true;
    const opts: Electron.MessageBoxOptions = {
      type: "warning",
      message: working === 1 ? "Claude is still working in a session." : `Claude is still working in ${working} sessions.`,
      detail: "Quitting stops it, and the reply it is writing is lost. You can resume the session later.",
      buttons: ["Quit", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    };
    void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then(({ response }) => {
      asking = false;
      if (response === 0) quit();
    });
  });
}
