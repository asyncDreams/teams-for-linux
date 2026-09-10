'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('calendarPanelApi', {
  getEvents: (payload) => ipcRenderer.invoke('calendar-panel-get-events', payload || {}),
  refresh: () => ipcRenderer.invoke('calendar-panel-refresh'),
  respond: (payload) => ipcRenderer.invoke('calendar-panel-respond', payload || {}),
  // Asks the main process to open the join URL — in a pop-out meeting window
  // when meetupJoinPopOutWindow is enabled, else in the main window. The
  // panel renderer itself has no Teams session, so it must never load the
  // join URL directly.
  join: (payload) => ipcRenderer.invoke('calendar-panel-join', payload || {}),
});
