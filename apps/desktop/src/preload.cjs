// The one call the web UI gets from Electron: a native folder picker for mounts.
// `platform` lets the UI make room for the macOS traffic lights.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bentomo", {
  pickFolder: () => ipcRenderer.invoke("bentomo:pick-folder"),
  platform: process.platform,
  // Cmd/Ctrl+W, and with Shift to delete the session too; intercepted in the main process before the menu can close the window.
  onCloseTab: (cb) => {
    const handler = (_event, deleteToo) => cb(Boolean(deleteToo));
    ipcRenderer.on("bentomo:close-tab", handler);
    return () => ipcRenderer.removeListener("bentomo:close-tab", handler);
  },
});
