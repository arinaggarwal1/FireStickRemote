const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fireTvDesktopUpdates", Object.freeze({
  getStatus: () => ipcRenderer.invoke("desktop-update:get"),
  check: () => ipcRenderer.invoke("desktop-update:check"),
  download: () => ipcRenderer.invoke("desktop-update:download"),
  install: () => ipcRenderer.invoke("desktop-update:install"),
  onState(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("desktop-update:state", listener);
    return () => ipcRenderer.removeListener("desktop-update:state", listener);
  },
}));
