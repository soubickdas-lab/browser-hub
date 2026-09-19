const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hubApp", {
  connectClaude: () => ipcRenderer.invoke("hub:connectClaude"),
  copyMcpConfig: () => ipcRenderer.invoke("hub:copyMcpConfig"),
  openExtensionFolder: () => ipcRenderer.invoke("hub:openExtensionFolder"),
  extensionFolder: () => ipcRenderer.invoke("hub:extensionFolder"),
});
