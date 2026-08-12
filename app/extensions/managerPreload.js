const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('extensionsApi', {
  list: () => ipcRenderer.invoke('extension-list'),
  loadUnpacked: (dirPath) => ipcRenderer.invoke('extension-load-unpacked', { path: dirPath }),
  remove: (id) => ipcRenderer.invoke('extension-remove', { id }),
  setEnabled: (id, enabled) => ipcRenderer.invoke('extension-set-enabled', { id, enabled }),
  pickDirectory: async () => {
    // Use Electron's dialog via a small helper channel is not needed — manager window can use showOpenDialog via ipc?
    // Fallback: prompt for path string
    const p = globalThis.prompt ? globalThis.prompt('Absolute path to unpacked extension directory:') : null;
    return p || null;
  }
});
