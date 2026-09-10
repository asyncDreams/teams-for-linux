'use strict';

const {
  BrowserWindow,
} = require('electron');
const path = require('node:path');

/**
 * Sandboxed settings window (Phase 3b of the config-UX research). Mirrors the
 * DiagnosticsWindow pattern: contextIsolation + sandbox, a thin preload
 * bridge, and a single reusable window instance.
 */
class SettingsWindow {
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
      title: 'Configuration',
      width: 920,
      height: 720,
      minWidth: 720,
      minHeight: 480,
      show: false,
      autoHideMenuBar: true,
      parent: this.#mainWindow?.isDestroyed?.() ? undefined : this.#mainWindow,
      webPreferences: {
        preload: path.join(__dirname, 'settingsPreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.#window.loadFile(path.join(__dirname, 'settings.html'));
    this.#window.once('ready-to-show', () => {
      if (this.#window && !this.#window.isDestroyed()) this.#window.show();
    });
    this.#window.on('closed', () => {
      this.#window = null;
    });
    return this.#window;
  }
}

module.exports = SettingsWindow;
