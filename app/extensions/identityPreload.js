'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Bridges chrome.identity.launchWebAuthFlow and chrome.tabs.create from the
// extension page's main world to the main process. The shim source installed by
// ExtensionManager reads this object; it is only present on extension-owned
// windows when the identity shim is enabled.
contextBridge.exposeInMainWorld('__tflExtensionBridge', {
  launchWebAuthFlow: (details) => ipcRenderer.invoke('extension-identity-launch-web-auth-flow', details),
  tabsCreate: (details) => ipcRenderer.invoke('extension-tabs-create', details),
});
