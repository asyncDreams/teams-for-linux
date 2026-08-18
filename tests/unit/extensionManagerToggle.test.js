'use strict';

const { afterEach, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const electronPath = require.resolve('electron');
const managerPath = require.resolve('../../app/extensions/manager');
const managerHtmlPath = path.join(__dirname, '../../app/extensions/manager.html');

let originalElectron;
let ExtensionManager;
let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tfl-extension-toggle-'));
  originalElectron = require.cache[electronPath];
  const mockSession = {
    loadExtension: async () => ({ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    removeExtension: () => {},
  };
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      app: {
        getPath: () => root,
        on: () => {},
      },
      BrowserWindow: class {},
      dialog: {},
      ipcMain: { handle: () => {} },
      session: { fromPartition: () => mockSession },
      shell: {},
    },
  };
  delete require.cache[managerPath];
  ExtensionManager = require(managerPath);
});

afterEach(() => {
  delete require.cache[managerPath];
  if (originalElectron) require.cache[electronPath] = originalElectron;
  else delete require.cache[electronPath];
  fs.rmSync(root, { recursive: true, force: true });
});

function makeStore() {
  const values = new Map();
  return {
    get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    set: (key, value) => values.set(key, value),
  };
}

describe('extension master toggle', () => {
  it('enables the extension session and persists the selection', async () => {
    const config = { extensions: { enabled: false, allowCrx: true, allowUnpacked: true, preload: [] } };
    const legacyConfigStore = makeStore();
    const manager = new ExtensionManager(config, makeStore(), legacyConfigStore);

    assert.equal(manager.state().enabled, false);
    const state = await manager.setMasterEnabled(true);

    assert.equal(state.enabled, true);
    assert.equal(config.extensions.enabled, true);
    assert.equal(legacyConfigStore.get('extensions').enabled, true);
  });

  it('disables the extension session without requiring a restart', async () => {
    const config = { extensions: { enabled: true, allowCrx: true, allowUnpacked: true, preload: [] } };
    const legacyConfigStore = makeStore();
    const manager = new ExtensionManager(config, makeStore(), legacyConfigStore);

    const state = await manager.setMasterEnabled(false);

    assert.equal(state.enabled, false);
    assert.equal(config.extensions.enabled, false);
    assert.equal(legacyConfigStore.get('extensions').enabled, false);
  });
});

describe('extension manager UI', () => {
  it('exposes a master toggle while support is disabled', () => {
    const html = fs.readFileSync(managerHtmlPath, 'utf8');
    assert.match(html, /id="master-toggle"/);
    assert.match(html, /setMasterEnabled/);
    assert.match(html, /Turn on Enable extensions/);
  });
});
