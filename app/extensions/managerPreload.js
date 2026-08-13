'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('extensionsApi', {
  state: () => ipcRenderer.invoke('extension-state'),
  setMasterEnabled: (enabled) => ipcRenderer.invoke('extension-set-master-enabled', { enabled }),
  list: () => ipcRenderer.invoke('extension-list'),
  details: (id) => ipcRenderer.invoke('extension-details', { id }),
  installCrx: (filePath) => ipcRenderer.invoke('extension-install-crx', { path: filePath }),
  pickCrx: () => ipcRenderer.invoke('extension-pick-crx'),
  loadUnpacked: (dirPath) => ipcRenderer.invoke('extension-load-unpacked', { path: dirPath }),
  pickUnpacked: () => ipcRenderer.invoke('extension-pick-unpacked'),
  remove: (id) => ipcRenderer.invoke('extension-remove', { id }),
  setEnabled: (id, enabled) => ipcRenderer.invoke('extension-set-enabled', { id, enabled }),
  reload: (id) => ipcRenderer.invoke('extension-reload', { id }),
  openFolder: (id) => ipcRenderer.invoke('extension-open-folder', { id }),
  exportMetadata: (id) => ipcRenderer.invoke('extension-export-metadata', { id }),
  openPopup: (id) => ipcRenderer.invoke('extension-open-popup', { id }),
  openOptions: (id) => ipcRenderer.invoke('extension-open-options', { id }),
});
