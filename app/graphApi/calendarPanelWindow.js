'use strict';

const { BrowserWindow } = require('electron');
const path = require('node:path');

/**
 * Calendar panel window — the richer Phase 3 calendar surface. Mirrors
 * app/notifications/historyWindow.js: sandboxed, context-isolated, loads a
 * local HTML file, parented to the main window.
 */
class CalendarPanelWindow {
  #mainWindow;
  #window = null;

  constructor(mainWindow) {
    this.#mainWindow = mainWindow;
  }

  show() {
    if (this.#window && !this.#window.isDestroyed()) {
      this.#window.show();
      this.#window.focus();
      return this.#window;
    }

    this.#window = new BrowserWindow({
      title: 'Calendar',
      width: 820,
      height: 640,
      minWidth: 560,
      minHeight: 420,
      show: false,
      autoHideMenuBar: true,
      parent: this.#mainWindow?.isDestroyed?.() ? undefined : this.#mainWindow,
      webPreferences: {
        preload: path.join(__dirname, 'calendarPanelPreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.#window.loadFile(path.join(__dirname, 'calendarPanel.html'));
    this.#window.once('ready-to-show', () => {
      if (this.#window && !this.#window.isDestroyed()) this.#window.show();
    });
    this.#window.on('closed', () => {
      this.#window = null;
    });
    return this.#window;
  }
}

module.exports = CalendarPanelWindow;
