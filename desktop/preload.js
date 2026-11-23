const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cadbury", {
  moveBy: (dx, dy) => ipcRenderer.send("move-by", dx, dy),
  panel: (open) => ipcRenderer.send("panel", open),
  menu: (info) => ipcRenderer.send("menu", info),
  notify: (body) => ipcRenderer.send("notify", body),
  onMenu: (fn) => ipcRenderer.on("menu", (_e, action, arg) => fn(action, arg)),
  onCursor: (fn) => ipcRenderer.on("cursor", (_e, p) => fn(p)),
  onHotkey: (fn) => ipcRenderer.on("hotkey", () => fn()),
});
