// The one call the web UI gets from Electron: a native folder picker for mounts.
// `platform` lets the UI make room for the macOS traffic lights.
const { contextBridge, ipcRenderer, webFrame } = require("electron");

contextBridge.exposeInMainWorld("kumiko", {
  pickFolder: () => ipcRenderer.invoke("kumiko:pick-folder"),
  platform: process.platform,
  // Page zoom (Cmd +/-/0); the UI counter-scales the macOS header so it stays aligned with the traffic lights.
  getZoomFactor: () => webFrame.getZoomFactor(),
  // Cmd/Ctrl+W, and with Shift to delete the session too; intercepted in the main process before the menu can close the window.
  onCloseTab: (cb) => {
    const handler = (_event, deleteToo) => cb(Boolean(deleteToo));
    ipcRenderer.on("kumiko:close-tab", handler);
    return () => ipcRenderer.removeListener("kumiko:close-tab", handler);
  },
});
