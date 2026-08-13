'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
} = require('electron');
const {
  extractCrx,
  readManifest,
  validateManifest,
} = require('./crx');
const {
  extensionPageUrl,
  getOptionsPage,
  getPopupPath,
} = require('./manifest');
const {
  buildShimSource,
  isAuthorizedRedirect,
  isValidAuthUrl,
} = require('./identityShim');
const ExtensionRegistry = require('./registry');

const MAX_RECORDS = 100;
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

/**
 * Manages optional Chromium extensions for the single Teams profile.
 *
 * Extensions remain opt-in: no session is touched unless extensions.enabled is
 * true. CRX archives are validated and extracted into userData/extensions;
 * unpacked directories are validated in place and their absolute paths are
 * persisted so they can be restored after a restart.
 */
class ExtensionManager {
  #config;
  #settingsStore;
  #legacyConfigStore;
  #loaded = new Map();
  #session = null;
  #extensionRoot;
  #metadataPath;
  #registry;
  #managerWindow = null;
  #registered = false;

  constructor(config, settingsStore, legacyConfigStore = null) {
    this.#config = config;
    this.#settingsStore = settingsStore;
    this.#legacyConfigStore = legacyConfigStore;
    this.#extensionRoot = path.join(app.getPath('userData'), 'extensions');
    this.#metadataPath = path.join(this.#extensionRoot, 'metadata.json');
    this.#registry = new ExtensionRegistry(this.#metadataPath, this.#settingsStore);
  }

  async initialize() {
    fs.mkdirSync(this.#extensionRoot, { recursive: true, mode: 0o700 });
    this.#loadPersistedRecords();
    this.#registerIpc();

    if (this.#config?.extensions?.enabled !== true) {
      console.info('[Extensions] Disabled (extensions.enabled=false)');
      return;
    }

    this.#session = this.#getSession();
    const preload = Array.isArray(this.#config.extensions.preload)
      ? this.#config.extensions.preload
      : [];
    for (const extensionPath of preload) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.#loadUnpacked(extensionPath, 'preload');
      } catch (error) {
        console.warn('[Extensions] Preload failed', {
          pathBasename: path.basename(String(extensionPath)),
          message: error.message,
        });
      }
    }

    for (const record of Array.from(this.#loaded.values())) {
      if (!record.enabled || !record.path || this.#hasLoadedPath(record.path)) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.#loadPersistedRecord(record);
      } catch (error) {
        record.lastError = error.message;
        this.#loaded.set(record.id, record);
        console.warn('[Extensions] Restore failed', {
          id: record.id,
          message: error.message,
        });
      }
    }
    this.#persist();
    console.info('[Extensions] Initialized', { count: this.#loaded.size });
  }

  #registerIpc() {
    if (this.#registered) return;
    this.#registered = true;

    // Extension manager list/read operations are intentionally limited to metadata.
    ipcMain.handle('extension-state', async () => this.state());
    // Toggle the extension master switch from the manager UI; unlike extension
    // actions this remains available while the feature is disabled.
    ipcMain.handle('extension-set-master-enabled', async (_event, payload) => this.setMasterEnabled(payload?.enabled));
    ipcMain.handle('extension-list', async () => this.list());
    ipcMain.handle('extension-details', async (_event, payload) => this.details(payload?.id));
    ipcMain.handle('extension-load-unpacked', async (_event, payload) => {
      this.#assertEnabled();
      if (this.#config.extensions.allowUnpacked !== true) {
        throw new Error('Unpacked extensions are disabled by config');
      }
      return this.#loadUnpacked(payload?.path, 'unpacked');
    });
    ipcMain.handle('extension-install-crx', async (_event, payload) => {
      this.#assertEnabled();
      if (this.#config.extensions.allowCrx !== true) {
        throw new Error('CRX installation is disabled by config');
      }
      return this.#installCrx(payload?.path);
    });
    ipcMain.handle('extension-pick-unpacked', async () => {
      this.#assertEnabled();
      return this.#pickUnpacked();
    });
    ipcMain.handle('extension-pick-crx', async () => {
      this.#assertEnabled();
      return this.#pickCrx();
    });
    ipcMain.handle('extension-remove', async (_event, payload) => this.remove(payload?.id));
    ipcMain.handle('extension-set-enabled', async (_event, payload) => this.setEnabled(payload?.id, payload?.enabled));
    ipcMain.handle('extension-reload', async (_event, payload) => {
      this.#assertEnabled();
      return this.reload(payload?.id);
    });
    ipcMain.handle('extension-open-folder', async (_event, payload) => {
      this.#assertEnabled();
      const record = this.#getRecord(payload?.id);
      await shell.openPath(record.path);
      return { ok: true };
    });
    // Open the extension action popup (sign-in/settings surface) in a window
    // that shares the Teams partition so chrome-extension URLs resolve.
    ipcMain.handle('extension-open-popup', async (_event, payload) => this.openPopup(payload?.id));
    // Open the extension options page declared by options_ui/options_page.
    ipcMain.handle('extension-open-options', async (_event, payload) => this.openOptions(payload?.id));
    // chrome.identity.launchWebAuthFlow shim: runs a popup OAuth flow and returns
    // the redirect URL. Only reachable from extension windows carrying the shim.
    ipcMain.handle('extension-identity-launch-web-auth-flow', async (_event, details) => {
      this.#assertEnabled();
      this.#assertIdentityShimEnabled();
      return this.#launchWebAuthFlow(details);
    });
    // chrome.tabs.create shim: opens an https URL externally.
    ipcMain.handle('extension-tabs-create', async (_event, details) => {
      this.#assertEnabled();
      this.#assertIdentityShimEnabled();
      return this.#tabsCreate(details);
    });
    ipcMain.handle('extension-export-metadata', async (_event, payload) => {
      this.#assertEnabled();
      return this.#exportMetadata(payload?.id);
    });

    // Menu events are main-process only; they do not expose paths or data to the
    // Teams renderer and therefore do not use renderer IPC validation.
    app.on('extension-open-manager', () => this.openManagerWindow());
    app.on('extension-install-crx', () => this.#pickCrx().catch((error) => this.#showError(error)));
    app.on('extension-load-unpacked', () => this.#pickUnpacked().catch((error) => this.#showError(error)));
  }

  #assertEnabled() {
    if (this.#config?.extensions?.enabled !== true) {
      throw new Error('Chromium extensions are disabled by config');
    }
  }

  #identityShimEnabled() {
    return this.#config?.extensions?.identityShim?.enabled === true;
  }

  #assertIdentityShimEnabled() {
    if (!this.#identityShimEnabled()) {
      throw new Error('The chrome.identity/tabs shim is disabled by config');
    }
  }

  #identityShimConfig() {
    const shim = this.#config?.extensions?.identityShim || {};
    return {
      enabled: shim.enabled === true,
      allowedRedirectHosts: Array.isArray(shim.allowedRedirectHosts)
        ? shim.allowedRedirectHosts.map(String)
        : [],
    };
  }

  #getSession() {
    if (!this.#session) {
      const partition = this.#config?.partition || 'persist:teams-4-linux';
      this.#session = session.fromPartition(partition);
    }
    return this.#session;
  }

  #validatePath(value, label = 'Path') {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw new Error(`${label} must be an absolute path`);
    }
    return path.resolve(value);
  }

  #loadPersistedRecords() {
    for (const record of this.#registry.load()) {
      const normalized = normalizeRecord(record);
      if (normalized) this.#loaded.set(normalized.id, normalized);
    }
  }

  async #loadPersistedRecord(record) {
    const manifest = readManifest(record.path);
    const extension = await this.#getSession().loadExtension(record.path, { allowFileAccess: true });
    const next = makeRecord(extension, manifest, record.path, record.source, record);
    next.enabled = record.enabled !== false;
    next.loaded = true;
    this.#replaceRecord(record.id, next);
    return this.#publicRecord(next);
  }

  async #loadUnpacked(inputPath, source) {
    const resolved = this.#validatePath(inputPath, 'Extension directory');
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error('Extension directory does not exist');
    }
    const manifest = readManifest(resolved);
    const existing = this.#findByPath(resolved);
    if (existing) {
      if (!existing.loaded) return this.setEnabled(existing.id, true);
      return this.#publicRecord(existing);
    }
    const extension = await this.#getSession().loadExtension(resolved, { allowFileAccess: true });
    const record = makeRecord(extension, manifest, resolved, source);
    record.loaded = true;
    this.#loaded.set(record.id, record);
    this.#persist();
    return this.#publicRecord(record);
  }

  async #installCrx(inputPath) {
    const resolved = this.#validatePath(inputPath, 'CRX file');
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error('CRX file does not exist');
    const sourceHash = hashFile(resolved);
    const existing = Array.from(this.#loaded.values()).find((entry) => entry.sourceHash === sourceHash);
    if (existing) return { ...this.#publicRecord(existing), duplicate: true };

    const temporaryRoot = path.join(
      this.#extensionRoot,
      `.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
    );
    let temporaryExtensionPath;
    let temporaryId;
    try {
      const extracted = extractCrx(resolved, temporaryRoot);
      temporaryExtensionPath = extracted.extensionPath;
      const temporaryExtension = await this.#getSession().loadExtension(temporaryExtensionPath, { allowFileAccess: true });
      temporaryId = temporaryExtension.id;
      try { this.#getSession().removeExtension(temporaryId); } catch { /* already unloaded */ }

      if (!EXTENSION_ID_PATTERN.test(temporaryId)) throw new Error('Electron returned an invalid extension id');
      const finalPath = path.join(this.#extensionRoot, temporaryId);
      if (fs.existsSync(finalPath)) {
        throw new Error('An extension with this id is already installed');
      }
      fs.renameSync(temporaryExtensionPath, finalPath);
      temporaryExtensionPath = null;
      const extension = await this.#getSession().loadExtension(finalPath, { allowFileAccess: true });
      const record = makeRecord(extension, extracted.manifest, finalPath, 'crx');
      record.loaded = true;
      record.sourceHash = sourceHash;
      record.sourceFileName = path.basename(resolved);
      this.#loaded.set(record.id, record);
      this.#persist();
      return this.#publicRecord(record);
    } finally {
      if (temporaryId) {
        try { this.#getSession().removeExtension(temporaryId); } catch { /* best effort cleanup */ }
      }
      if (fs.existsSync(temporaryRoot)) fs.rmSync(temporaryRoot, { recursive: true, force: true });
      if (temporaryExtensionPath && fs.existsSync(temporaryExtensionPath)) {
        fs.rmSync(temporaryExtensionPath, { recursive: true, force: true });
      }
    }
  }

  async #pickCrx() {
    const result = await dialog.showOpenDialog(this.#managerWindow && !this.#managerWindow.isDestroyed() ? this.#managerWindow : undefined, {
      title: 'Install Chromium extension',
      properties: ['openFile'],
      filters: [{ name: 'Chrome extension', extensions: ['crx'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return this.#installCrx(result.filePaths[0]);
  }

  async #pickUnpacked() {
    const result = await dialog.showOpenDialog(this.#managerWindow && !this.#managerWindow.isDestroyed() ? this.#managerWindow : undefined, {
      title: 'Load unpacked extension',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return this.#loadUnpacked(result.filePaths[0], 'unpacked');
  }

  async remove(id) {
    const record = this.#getRecord(id);
    try { this.#getSession().removeExtension(record.id); } catch { /* disabled or already unloaded */ }
    this.#loaded.delete(record.id);
    if (record.source === 'crx' && isWithin(this.#extensionRoot, record.path)) {
      fs.rmSync(record.path, { recursive: true, force: true });
    }
    this.#persist();
    return { ok: true };
  }

  async setEnabled(id, enabled) {
    const record = this.#getRecord(id);
    const nextEnabled = enabled === true;
    if (!nextEnabled) {
      try { this.#getSession().removeExtension(record.id); } catch { /* already disabled */ }
      record.enabled = false;
      record.loaded = false;
      this.#loaded.set(record.id, record);
      this.#persist();
      return this.#publicRecord(record);
    }
    this.#assertEnabled();
    if (!fs.existsSync(record.path)) throw new Error('Extension path no longer exists');
    const manifest = readManifest(record.path);
    const extension = await this.#getSession().loadExtension(record.path, { allowFileAccess: true });
    const replacement = makeRecord(extension, manifest, record.path, record.source, record);
    replacement.enabled = true;
    replacement.loaded = true;
    this.#replaceRecord(record.id, replacement);
    this.#persist();
    return this.#publicRecord(replacement);
  }

  openPopup(id) {
    this.#assertEnabled();
    const record = this.#getRecord(id);
    if (!record.popupPath) throw new Error('This extension has no popup');
    this.#openExtensionPage(record, record.popupPath, record.name, { width: 420, height: 560 });
    return { ok: true };
  }

  openOptions(id) {
    this.#assertEnabled();
    const record = this.#getRecord(id);
    if (!record.optionsPath) throw new Error('This extension has no options page');
    this.#openExtensionPage(record, record.optionsPath, `${record.name} — Options`, { width: 800, height: 620 });
    return { ok: true };
  }

  #openExtensionPage(record, relPath, title, dimensions) {
    const url = extensionPageUrl(record.id, relPath);
    if (!url) throw new Error('Invalid extension page path');
    const partition = this.#config?.partition || 'persist:teams-4-linux';
    const shimEnabled = this.#identityShimEnabled();
    const window = new BrowserWindow({
      width: dimensions.width,
      height: dimensions.height,
      title,
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        preload: shimEnabled ? path.join(__dirname, 'identityPreload.js') : undefined,
      },
    });
    if (shimEnabled) {
      window.webContents.on('did-finish-load', () => {
        window.webContents.executeJavaScript(buildShimSource()).catch(() => {
          // The shim is best-effort; an unload race must never break the page.
        });
      });
    }
    window.loadURL(url);
    return window;
  }

  /**
   * Runs a popup OAuth flow for chrome.identity.launchWebAuthFlow. Opens the
   * authorization URL in a window that shares the Teams partition (so existing
   * SSO cookies apply) and resolves once the provider redirects to the declared
   * redirect_uri.
   * @param {object} details { url, redirect_uri, interactive }
   * @returns {Promise<string>}
   */
  #launchWebAuthFlow(details) {
    const url = typeof details?.url === 'string' ? details.url : null;
    const redirectUri = typeof details?.redirect_uri === 'string'
      ? details.redirect_uri
      : (typeof details?.redirectUri === 'string' ? details.redirectUri : null);
    if (!isValidAuthUrl(url)) {
      return Promise.reject(new Error('launchWebAuthFlow requires an https url'));
    }
    const { allowedRedirectHosts } = this.#identityShimConfig();
    const extensionId = Array.from(this.#loaded.values()).find((r) => r.loaded)?.id || null;
    if (!isAuthorizedRedirect(redirectUri, allowedRedirectHosts, extensionId)) {
      return Promise.reject(new Error('launchWebAuthFlow redirect_uri is not allowed'));
    }

    return new Promise((resolve, reject) => {
      const partition = this.#config?.partition || 'persist:teams-4-linux';
      const authWindow = new BrowserWindow({
        width: 520,
        height: 700,
        autoHideMenuBar: true,
        webPreferences: { partition, nodeIntegration: false, contextIsolation: true },
      });
      let settled = false;
      const finish = (targetUrl) => {
        if (settled) return;
        settled = true;
        if (!authWindow.isDestroyed()) authWindow.destroy();
        resolve(targetUrl);
      };
      const fail = (message) => {
        if (settled) return;
        settled = true;
        if (!authWindow.isDestroyed()) authWindow.destroy();
        reject(new Error(message));
      };
      const onRedirect = (event, targetUrl) => {
        if (typeof targetUrl === 'string' && targetUrl.startsWith(redirectUri)) {
          event.preventDefault();
          finish(targetUrl);
        }
      };
      authWindow.webContents.on('will-redirect', onRedirect);
      authWindow.webContents.on('did-navigate', (_event, targetUrl) => {
        if (typeof targetUrl === 'string' && targetUrl.startsWith(redirectUri)) finish(targetUrl);
      });
      authWindow.on('closed', () => fail('Web auth flow window was closed before completing'));
      authWindow.loadURL(url).catch((error) => fail(error.message));
    });
  }

  /**
   * Opens a URL from chrome.tabs.create in the system browser. Only https (or
   * loopback http) is permitted so an extension cannot pivot to a local scheme.
   * @param {object} details { url }
   * @returns {Promise<object>}
   */
  async #tabsCreate(details) {
    const url = typeof details?.url === 'string' ? details.url : null;
    if (!isValidAuthUrl(url)) {
      throw new Error('tabs.create requires an https url');
    }
    await shell.openExternal(url);
    return { id: Date.now(), windowId: 1 };
  }

  async reload(id) {
    const record = this.#getRecord(id);
    try { this.#getSession().removeExtension(record.id); } catch { /* best effort */ }
    const manifest = readManifest(record.path);
    const extension = await this.#getSession().loadExtension(record.path, { allowFileAccess: true });
    const replacement = makeRecord(extension, manifest, record.path, record.source, record);
    replacement.enabled = true;
    replacement.loaded = true;
    this.#replaceRecord(record.id, replacement);
    this.#persist();
    return this.#publicRecord(replacement);
  }

  async setMasterEnabled(enabled) {
    const nextEnabled = enabled === true;
    this.#config.extensions = {
      ...(this.#config.extensions || {}),
      enabled: nextEnabled,
    };
    this.#legacyConfigStore?.set('extensions', this.#config.extensions);

    if (!nextEnabled) {
      if (this.#session) {
        for (const record of this.#loaded.values()) {
          try { this.#session.removeExtension(record.id); } catch { /* already unloaded */ }
          record.loaded = false;
        }
      }
      this.#persist();
      return this.state();
    }

    this.#session = this.#getSession();
    const preload = Array.isArray(this.#config.extensions.preload)
      ? this.#config.extensions.preload
      : [];
    for (const extensionPath of preload) {
      if (this.#hasLoadedPath(extensionPath)) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.#loadUnpacked(extensionPath, 'preload');
      } catch (error) {
        console.warn('[Extensions] Preload failed after enabling', {
          pathBasename: path.basename(String(extensionPath)),
          message: error.message,
        });
      }
    }
    for (const record of Array.from(this.#loaded.values())) {
      if (!record.enabled || !record.path || this.#hasLoadedPath(record.path)) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.#loadPersistedRecord(record);
      } catch (error) {
        record.lastError = error.message;
        this.#loaded.set(record.id, record);
      }
    }
    this.#persist();
    return this.state();
  }

  state() {
    return {
      enabled: this.#config?.extensions?.enabled === true,
      allowCrx: this.#config?.extensions?.allowCrx !== false,
      allowUnpacked: this.#config?.extensions?.allowUnpacked !== false,
      developerMode: this.#config?.extensions?.developerMode === true,
    };
  }

  list() {
    return Array.from(this.#loaded.values()).map((record) => this.#publicRecord(record));
  }

  details(id) {
    return this.#publicRecord(this.#getRecord(id), true);
  }

  async #exportMetadata(id) {
    const record = this.#getRecord(id);
    const result = await dialog.showSaveDialog(this.#managerWindow && !this.#managerWindow.isDestroyed() ? this.#managerWindow : undefined, {
      title: 'Export extension metadata',
      defaultPath: path.join(app.getPath('downloads'), `${safeFileName(record.name)}-metadata.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, `${JSON.stringify(this.#publicRecord(record, true), null, 2)}\n`, { mode: 0o600 });
    return { canceled: false, path: result.filePath };
  }

  #getRecord(id) {
    if (typeof id !== 'string' || !id) throw new Error('Invalid extension id');
    const record = this.#loaded.get(id);
    if (!record) throw new Error('Unknown extension');
    return record;
  }

  #findByPath(extensionPath) {
    return Array.from(this.#loaded.values()).find((record) => record.path === extensionPath);
  }

  #hasLoadedPath(extensionPath) {
    return Boolean(this.#findByPath(extensionPath)?.loaded);
  }

  #replaceRecord(previousId, next) {
    if (previousId !== next.id) this.#loaded.delete(previousId);
    this.#loaded.set(next.id, next);
  }

  #persist() {
    const records = Array.from(this.#loaded.values()).slice(0, MAX_RECORDS);
    try {
      this.#registry.save(records);
    } catch (error) {
      console.warn('[Extensions] Metadata persistence failed', { message: error.message });
    }
  }

  #publicRecord(record, includeManifest = false) {
    const result = {
      id: record.id,
      name: record.name,
      version: record.version,
      description: record.description,
      enabled: record.enabled === true,
      source: record.source,
      path: record.path,
      pathBasename: path.basename(record.path),
      installDate: record.installDate,
      sizeBytes: record.sizeBytes,
      iconPath: record.iconPath,
      permissions: record.permissions,
      hostPermissions: record.hostPermissions,
      manifestVersion: record.manifestVersion,
      sourceFileName: record.sourceFileName,
      popupPath: record.popupPath || null,
      optionsPath: record.optionsPath || null,
      optionsInTab: record.optionsInTab === true,
      lastError: record.lastError || null,
    };
    if (includeManifest) result.manifest = record.manifest;
    return result;
  }

  openManagerWindow() {
    if (this.#managerWindow && !this.#managerWindow.isDestroyed()) {
      this.#managerWindow.show();
      this.#managerWindow.focus();
      return;
    }
    this.#managerWindow = new BrowserWindow({
      width: 820,
      height: 620,
      minWidth: 620,
      minHeight: 460,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'managerPreload.js'),
      },
    });
    this.#managerWindow.once('ready-to-show', () => this.#managerWindow?.show());
    this.#managerWindow.on('closed', () => { this.#managerWindow = null; });
    this.#managerWindow.loadFile(path.join(__dirname, 'manager.html'));
  }

  #showError(error) {
    dialog.showErrorBox('Extension installation failed', error?.message || 'Unable to install the extension');
  }
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !EXTENSION_ID_PATTERN.test(record.id)) return null;
  if (typeof record.path !== 'string' || !path.isAbsolute(record.path)) return null;
  return {
    id: record.id,
    name: typeof record.name === 'string' ? record.name.slice(0, 200) : 'Extension',
    version: typeof record.version === 'string' ? record.version.slice(0, 128) : '0',
    description: typeof record.description === 'string' ? record.description.slice(0, 1000) : '',
    enabled: record.enabled !== false,
    loaded: false,
    source: record.source === 'crx' ? 'crx' : 'unpacked',
    path: path.resolve(record.path),
    installDate: Number.isFinite(record.installDate) ? record.installDate : Date.now(),
    sizeBytes: Number.isFinite(record.sizeBytes) ? record.sizeBytes : 0,
    iconPath: typeof record.iconPath === 'string' ? record.iconPath.slice(0, 512) : null,
    permissions: stringArray(record.permissions),
    hostPermissions: stringArray(record.hostPermissions),
    manifestVersion: record.manifestVersion === 2 ? 2 : 3,
    popupPath: typeof record.popupPath === 'string' ? record.popupPath.slice(0, 512) : null,
    optionsPath: typeof record.optionsPath === 'string' ? record.optionsPath.slice(0, 512) : null,
    optionsInTab: record.optionsInTab === true,
    sourceHash: typeof record.sourceHash === 'string' ? record.sourceHash : null,
    sourceFileName: typeof record.sourceFileName === 'string' ? record.sourceFileName.slice(0, 255) : null,
    manifest: sanitizeManifest(record.manifest),
    lastError: null,
  };
}

function makeRecord(extension, manifest, extensionPath, source, previous = null) {
  validateManifest(manifest);
  const optionsPage = getOptionsPage(manifest);
  return {
    id: extension.id,
    name: String(manifest.name || extension.name || path.basename(extensionPath)).slice(0, 200),
    version: String(manifest.version || extension.version || '0').slice(0, 128),
    description: typeof manifest.description === 'string' ? manifest.description.slice(0, 1000) : '',
    enabled: true,
    loaded: false,
    source: source === 'crx' ? 'crx' : 'unpacked',
    path: path.resolve(extensionPath),
    installDate: previous?.installDate || Date.now(),
    sizeBytes: directorySize(extensionPath),
    iconPath: getIconPath(manifest, extensionPath),
    permissions: stringArray(manifest.permissions),
    hostPermissions: stringArray([...(manifest.host_permissions || []), ...(manifest.permissions || []).filter((value) => value.includes('://'))]),
    manifestVersion: manifest.manifest_version,
    popupPath: getPopupPath(manifest),
    optionsPath: optionsPage?.path || null,
    optionsInTab: optionsPage?.openInTab === true,
    sourceHash: previous?.sourceHash || null,
    sourceFileName: previous?.sourceFileName || null,
    manifest: sanitizeManifest(manifest),
    lastError: null,
  };
}

function sanitizeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return {};
  return {
    manifest_version: manifest.manifest_version,
    name: String(manifest.name || '').slice(0, 200),
    version: String(manifest.version || '').slice(0, 128),
    description: typeof manifest.description === 'string' ? manifest.description.slice(0, 1000) : '',
    permissions: stringArray(manifest.permissions),
    host_permissions: stringArray(manifest.host_permissions),
    optional_permissions: stringArray(manifest.optional_permissions),
    content_scripts: Array.isArray(manifest.content_scripts) ? manifest.content_scripts.slice(0, 100).map((script) => ({
      matches: stringArray(script?.matches),
      js: stringArray(script?.js),
      css: stringArray(script?.css),
      run_at: typeof script?.run_at === 'string' ? script.run_at : null,
    })) : [],
    background: manifest.background && typeof manifest.background === 'object' ? {
      service_worker: typeof manifest.background.service_worker === 'string' ? manifest.background.service_worker : null,
      scripts: stringArray(manifest.background.scripts),
    } : null,
    action: sanitizeAction(manifest.action),
    browser_action: sanitizeAction(manifest.browser_action),
    page_action: sanitizeAction(manifest.page_action),
    options_ui: manifest.options_ui && typeof manifest.options_ui === 'object' ? {
      page: typeof manifest.options_ui.page === 'string' ? manifest.options_ui.page.slice(0, 512) : null,
      open_in_tab: manifest.options_ui.open_in_tab === true,
    } : null,
    options_page: typeof manifest.options_page === 'string' ? manifest.options_page.slice(0, 512) : null,
    icons: manifest.icons && typeof manifest.icons === 'object' ? Object.fromEntries(Object.entries(manifest.icons).slice(0, 20).map(([size, value]) => [String(size), String(value).slice(0, 512)])) : {},
  };
}

function sanitizeAction(action) {
  if (!action || typeof action !== 'object') return null;
  return {
    default_popup: typeof action.default_popup === 'string' ? action.default_popup.slice(0, 512) : null,
    default_title: typeof action.default_title === 'string' ? action.default_title.slice(0, 256) : null,
  };
}

function getIconPath(manifest, extensionPath) {
  const icons = manifest.icons;
  if (!icons || typeof icons !== 'object') return null;
  const relative = icons['128'] || icons['48'] || icons['32'] || Object.values(icons)[0];
  if (typeof relative !== 'string') return null;
  const candidate = path.resolve(extensionPath, relative);
  return isWithin(extensionPath, candidate) && fs.existsSync(candidate) ? candidate : null;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, 100).map((item) => item.slice(0, 512)) : [];
}

function directorySize(root) {
  let total = 0;
  const visit = (entry) => {
    if (total > 250 * 1024 * 1024) return;
    let stat;
    try { stat = fs.lstatSync(entry); } catch { return; }
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) visit(path.join(entry, child));
    } else if (stat.isFile()) {
      total += stat.size;
    }
  };
  visit(root);
  return total;
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function isWithin(root, candidate) {
  const resolvedRoot = path.resolve(root) + path.sep;
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate.startsWith(resolvedRoot);
}

function safeFileName(value) {
  return String(value || 'extension').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'extension';
}

module.exports = ExtensionManager;
