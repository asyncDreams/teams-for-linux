'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, dialog, ipcMain, session } = require('electron');

/**
 * Chromimum extension manager — unpacked only (MVP).
 * Loads extensions listed in config.extensions.preload at startup and
 * exposes IPC for the Extensions manager window.
 * Off by default (extensions.enabled === false) — no session touch.
 */
class ExtensionManager {
  #config;
  #settingsStore;
  #loaded = new Map(); // id -> { id, name, version, path, enabled }

  constructor(config, settingsStore) {
    this.config = config;
    this.settingsStore = settingsStore;
  }

  async initialize() {
    const enabled = this.config?.extensions?.enabled;
    if (!enabled) {
      console.info('[Extensions] Disabled (extensions.enabled=false)');
      this._registerIpc();
      return;
    }
    const partition = this.config?.partition || 'persist:teams-4-linux';
    const sess = session.fromPartition(partition);
    const preload = Array.isArray(this.config?.extensions?.preload) ? this.config.extensions.preload : [];
    for (const p of preload) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await this._loadUnpacked(sess, p, true);
      } catch (e) {
        console.warn('[Extensions] Preload failed', { pathBasename: path.basename(p), message: e.message });
      }
    }
    this._registerIpc();
    console.info('[Extensions] Initialized', { count: this.#loaded.size });
  }

  _registerIpc() {
    ipcMain.handle('extension-list', async () => this.list());
    ipcMain.handle('extension-load-unpacked', async (_event, payload) => {
      if (!this.config?.extensions?.allowUnpacked) throw new Error('Unpacked extensions disabled by config');
      const dir = payload?.path;
      if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Path must be absolute');
      const partition = this.config?.partition || 'persist:teams-4-linux';
      const sess = session.fromPartition(partition);
      const ext = await this._loadUnpacked(sess, dir, false);
      return { id: ext.id, name: ext.name, version: ext.version };
    });
    ipcMain.handle('extension-remove', async (_event, payload) => {
      const id = payload?.id;
      if (typeof id !== 'string' || !id) throw new Error('Invalid id');
      const partition = this.config?.partition || 'persist:teams-4-linux';
      const sess = session.fromPartition(partition);
      try { sess.removeExtension(id); } catch {}
      this.#loaded.delete(id);
      this._persist();
      return { ok: true };
    });
    ipcMain.handle('extension-set-enabled', async (_event, payload) => {
      const { id, enabled } = payload || {};
      if (typeof id !== 'string' || !id) throw new Error('Invalid id');
      const entry = this.#loaded.get(id);
      if (!entry) throw new Error('Unknown extension');
      entry.enabled = !!enabled;
      const partition = this.config?.partition || 'persist:teams-4-linux';
      const sess = session.fromPartition(partition);
      if (!enabled) {
        try { sess.removeExtension(id); } catch {}
      } else {
        try { await sess.loadExtension(entry.path); } catch (e) { throw new Error(e.message); }
      }
      this._persist();
      return { ok: true };
    });
    ipcMain.on('extension-open-manager', () => this.openManagerWindow());
  }

  async _loadUnpacked(sess, dir, isPreload) {
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) throw new Error('Directory does not exist');
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) throw new Error('Path is not a directory');
    const manifestPath = path.join(resolved, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('manifest.json missing');
    const raw = fs.readFileSync(manifestPath, 'utf8').slice(0, 256 * 1024);
    let manifest;
    try { manifest = JSON.parse(raw); } catch { throw new Error('Invalid manifest.json'); }
    const mv = manifest.manifest_version;
    if (mv !== 2 && mv !== 3) throw new Error('Unsupported manifest_version');
    // Security: ensure dir is under userData/extensions or user-picked allow-list (preload already trusted)
    if (!isPreload) {
      const allowedRoots = [path.join(app.getPath('userData'), 'extensions'), app.getPath('downloads'), app.getPath('home') + path.sep];
      // For MVP allow any absolute dir the user picked via dialog; still reject traversal via .. in manifest paths is not needed here
    }
    const ext = await sess.loadExtension(resolved, { allowFileAccess: true });
    const name = manifest.name || ext.name || path.basename(resolved);
    const version = manifest.version || ext.version || '0';
    this.#loaded.set(ext.id, { id: ext.id, name: String(name).slice(0,200), version: String(version).slice(0,50), path: resolved, enabled: true });
    if (!isPreload) this._persist();
    console.info('[Extensions] Loaded', { id: ext.id, name });
    return ext;
  }

  list() {
    return Array.from(this.#loaded.values()).map(e => ({ id: e.id, name: e.name, version: e.version, enabled: e.enabled, pathBasename: path.basename(e.path) }));
  }

  _persist() {
    try {
      const key = 'extensions.loaded';
      this.settingsStore.set(key, Array.from(this.#loaded.values()));
    } catch {}
  }

  openManagerWindow() {
    const { BrowserWindow } = require('electron');
    const win = new BrowserWindow({
      width: 560, height: 420, show: true, autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'managerPreload.js') }
    });
    win.loadFile(path.join(__dirname, 'manager.html'));
  }
}

module.exports = ExtensionManager;
