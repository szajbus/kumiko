// The one call the web UI gets from Electron: a native folder picker for mounts.
// `platform` lets the UI make room for the macOS traffic lights.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bentomo", {
  pickFolder: () => ipcRenderer.invoke("bentomo:pick-folder"),
  platform: process.platform,
});
