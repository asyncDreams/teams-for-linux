'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notificationHistoryApi', {
  list: (filters) => ipcRenderer.invoke('notification-history-list', filters || {}),
  markRead: (id) => ipcRenderer.invoke('notification-history-mark-read', id),
  markAllRead: () => ipcRenderer.invoke('notification-history-mark-all-read'),
  clear: (id) => ipcRenderer.invoke('notification-history-clear', id),
  clearAll: () => ipcRenderer.invoke('notification-history-clear-all'),
  exportJson: () => ipcRenderer.invoke('notification-history-export'),
  unreadCount: () => ipcRenderer.invoke('notification-history-unread-count'),
  open: (id) => ipcRenderer.invoke('notification-history-open', id),
});
