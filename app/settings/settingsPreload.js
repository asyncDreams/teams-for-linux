'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Thin, allowlisted bridge for the settings window. Only the five
 * `settings-config-*` channels are reachable, and every payload is a plain
 * JSON object validated in the main process.
 */
contextBridge.exposeInMainWorld('configSettingsApi', {
  getSchema: () => ipcRenderer.invoke('settings-config-schema'),
  getValues: () => ipcRenderer.invoke('settings-config-values'),
  setValue: (change) => ipcRenderer.invoke('settings-config-set', change),
  reset: (payload) => ipcRenderer.invoke('settings-config-reset', payload),
  restart: () => ipcRenderer.send('settings-config-restart'),
});
