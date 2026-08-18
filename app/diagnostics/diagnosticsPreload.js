'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('presenceDiagnosticsApi', {
  get: () => ipcRenderer.invoke('presence-sync-get-diagnostics'),
});
