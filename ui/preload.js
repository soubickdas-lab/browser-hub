const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hubApp", {
  connectClaude: () => ipcRenderer.invoke("hub:connectClaude"),
  copyMcpConfig: () => ipcRenderer.invoke("hub:copyMcpConfig"),
  openExtensionFolder: () => ipcRenderer.invoke("hub:openExtensionFolder"),
  extensionFolder: () => ipcRenderer.invoke("hub:extensionFolder"),
  diagnose: () => ipcRenderer.invoke("hub:diagnose"),
  paths: () => ipcRenderer.invoke("hub:paths"),
  copyText: (text) => ipcRenderer.invoke("hub:copyText", text),
  version: () => ipcRenderer.invoke("hub:version"),
  checkUpdate: () => ipcRenderer.invoke("hub:checkUpdate"),
  installUpdate: () => ipcRenderer.invoke("hub:installUpdate"),
});
