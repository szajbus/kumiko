// What the web UI gets from Electron: a native folder picker for mounts, and pictures of panes for Claude.
// `platform` lets the UI make room for the macOS traffic lights.
const { contextBridge, ipcRenderer, webFrame } = require("electron");

contextBridge.exposeInMainWorld("kumiko", {
  pickFolder: () => ipcRenderer.invoke("kumiko:pick-folder"),
  platform: process.platform,
  // Page zoom (Cmd +/-/0); the UI counter-scales the macOS header so it stays aligned with the traffic lights.
  getZoomFactor: () => webFrame.getZoomFactor(),
  // Pictures for Claude of what a pane shows: part of the window, or a preview's <webview>; PNGs in base64.
  capture: (rect) => ipcRenderer.invoke("kumiko:capture", rect),
  captureWebview: (id) => ipcRenderer.invoke("kumiko:capture-webview", id),
  // A page in a pane that the app blocked: the <webview>'s web contents id, and the page's URL.
  onPageBlocked: (cb) => {
    const handler = (_event, id, url) => cb(id, url);
    ipcRenderer.on("kumiko:page-blocked", handler);
    return () => ipcRenderer.removeListener("kumiko:page-blocked", handler);
  },
  // Cmd/Ctrl+W, and with Shift to delete the session too; intercepted in the main process before the menu can close the window.
  onCloseTab: (cb) => {
    const handler = (_event, deleteToo) => cb(Boolean(deleteToo));
    ipcRenderer.on("kumiko:close-tab", handler);
    return () => ipcRenderer.removeListener("kumiko:close-tab", handler);
  },
});
