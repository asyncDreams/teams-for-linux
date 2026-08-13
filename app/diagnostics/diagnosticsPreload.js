'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Both datasets are exposed from a single hub window; the renderer selects
// which panel to show and polls each channel independently.
contextBridge.exposeInMainWorld('presenceDiagnosticsApi', {
  get: () => ipcRenderer.invoke('presence-sync-get-diagnostics'),
});

contextBridge.exposeInMainWorld('screenSharingDiagnosticsApi', {
  get: () => ipcRenderer.invoke('screen-sharing-get-diagnostics'),
});
