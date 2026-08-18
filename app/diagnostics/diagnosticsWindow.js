'use strict';

const { BrowserWindow } = require('electron');
const path = require('node:path');

class DiagnosticsWindow {
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
      title: 'Diagnostics',
      width: 760,
      height: 600,
      minWidth: 600,
      minHeight: 440,
      show: false,
      autoHideMenuBar: true,
      parent: this.#mainWindow?.isDestroyed?.() ? undefined : this.#mainWindow,
      webPreferences: {
        preload: path.join(__dirname, 'diagnosticsPreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.#window.loadFile(path.join(__dirname, 'diagnostics.html'));
    this.#window.once('ready-to-show', () => {
      if (this.#window && !this.#window.isDestroyed()) this.#window.show();
    });
    this.#window.on('closed', () => {
      this.#window = null;
    });
    return this.#window;
  }
}

module.exports = DiagnosticsWindow;
