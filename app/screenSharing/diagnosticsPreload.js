"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("screenSharingDiagnosticsApi", {
  get: () => ipcRenderer.invoke("screen-sharing-get-diagnostics"),
});
