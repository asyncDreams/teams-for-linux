'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('calendarPanelApi', {
  getEvents: (payload) => ipcRenderer.invoke('calendar-panel-get-events', payload || {}),
  refresh: () => ipcRenderer.invoke('calendar-panel-refresh'),
});
