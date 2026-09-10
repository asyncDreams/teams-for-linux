'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, rmSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// Regression guard for issue #1902 and the CLAUDE.md "Modules Requiring IPC
// Initialization" rule.
//
// The browser-module list and the "which modules receive ipcRenderer during
// init" decision used to live as an inline array + hand-maintained Set in
// `app/browser/preload.js`. That Set was accidentally deleted multiple times
// in git history: the modules still loaded, then crashed later inside their
// handlers with `TypeError: Cannot read properties of undefined (reading
// 'send')` — a user-reported outage for tray icons and MQTT status.
//
// Both concerns now live in the declarative registry
// `app/browser/tools/moduleRegistry.js`; preload.js delegates to
// `initBrowserModules()`. These tests enforce the registry's invariants and
// cross-check its declarations against the real modules, so the #1902-class
// mistake becomes a test failure instead of a user-reported bug.

const PRELOAD_PATH = join(__dirname, '..', '..', 'app', 'browser', 'preload.js');
const TOOLS_DIR = join(__dirname, '..', '..', 'app', 'browser', 'tools');

// Tool modules `require("electron")` at load time. Stub it before any of
// them load so this test runs in plain Node with no Electron runtime.
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {},
};

const {
  BROWSER_MODULES,
  CRITICAL_IPC_MODULES,
  initBrowserModules,
  validateRegistry,
} = require(join(TOOLS_DIR, 'moduleRegistry'));

describe('browser module registry (issue #1902 guard)', () => {
  it('is internally consistent (validateRegistry)', () => {
    const errors = validateRegistry();
    assert.deepStrictEqual(
      errors,
      [],
      `Registry self-validation failed:\n${errors.join('\n')}`,
    );
  });

  it('marks every CLAUDE.md-critical module as requiresIpc', () => {
    for (const name of CRITICAL_IPC_MODULES) {
      const entry = BROWSER_MODULES.find((module) => module.name === name);
      assert.ok(
        entry,
        `"${name}" is missing from BROWSER_MODULES. See CLAUDE.md ` +
          '"Modules Requiring IPC Initialization" and issue #1902.',
      );
      assert.strictEqual(
        entry.requiresIpc,
        true,
        `"${name}" must declare requiresIpc: true. This module needs ipcRenderer ` +
          'during init or its IPC calls throw at runtime (issue #1902).',
      );
    }
  });

  it('loads every registered module in plain Node and exports init', () => {
    for (const entry of BROWSER_MODULES) {
      const instance = require(join(TOOLS_DIR, entry.path));
      assert.strictEqual(
        typeof instance?.init,
        'function',
        `Module "${entry.name}" (${entry.path}) does not export an init function. ` +
          'preload.js initialises every registry entry through moduleInstance.init().',
      );
    }
  });

  it('declares requiresIpc consistently with each init signature', () => {
    for (const entry of BROWSER_MODULES) {
      const instance = require(join(TOOLS_DIR, entry.path));
      const arity = instance.init.length;

      if (entry.requiresIpc) {
        assert.ok(
          arity >= 2,
          `"${entry.name}" declares requiresIpc: true but init() accepts only ` +
            `${arity} parameter(s). Keep the signature as init(config, ipcRenderer) ` +
            'or fix the registry declaration if the module no longer needs IPC.',
        );
      } else {
        assert.ok(
          arity <= 1,
          `"${entry.name}" declares requiresIpc: false but init() declares an ` +
            `ipcRenderer parameter (arity ${arity}) that it will never receive. ` +
            'Drop the unused parameter or set requiresIpc: true if it is needed.',
        );
      }
    }
  });

  it('dispatcher passes ipcRenderer only to modules that require it', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'tfl-registry-'));
    // Fixture modules live in their own files/module scope, so they record
    // calls through a shared global rather than a test-local closure.
    const calls = [];
    globalThis.__registryTestCalls = calls;

    try {
      // Fake modules on disk so initBrowserModules() exercises its real
      // require() path. Unique names keep require.cache out of the way.
      const nonce = `${process.pid}-${Math.random().toString(36).slice(2)}`;
      const noIpcPath = join(fixtureDir, `no-ipc-${nonce}.js`);
      const ipcPath = join(fixtureDir, `with-ipc-${nonce}.js`);
      const boomPath = join(fixtureDir, `boom-${nonce}.js`);

      writeFileSync(
        noIpcPath,
        `module.exports = { init(config) { globalThis.__registryTestCalls.push(['no-ipc', config]); } };`,
      );
      writeFileSync(
        ipcPath,
        `module.exports = { init(config, ipcRenderer) { globalThis.__registryTestCalls.push(['with-ipc', config, ipcRenderer]); } };`,
      );
      writeFileSync(boomPath, `module.exports = { init() { throw new Error('boom'); } };`);

      const config = { marker: 'cfg' };
      const ipcRenderer = { marker: 'ipc' };

      const result = initBrowserModules({
        config,
        ipcRenderer,
        modules: [
          { name: 'no-ipc', path: noIpcPath, requiresIpc: false },
          { name: 'with-ipc', path: ipcPath, requiresIpc: true },
          { name: 'boom', path: boomPath, requiresIpc: true },
        ],
      });

      assert.deepStrictEqual(calls, [
        ['no-ipc', config],
        ['with-ipc', config, ipcRenderer],
      ]);
      assert.strictEqual(result.successCount, 2);
      assert.strictEqual(result.total, 3);
      assert.deepStrictEqual(result.failures, [
        { name: 'boom', error: 'boom' },
      ]);
    } finally {
      delete globalThis.__registryTestCalls;
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('dispatcher fails fast when a requiresIpc module gets no ipcRenderer', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'tfl-registry-'));

    try {
      const nonce = `${process.pid}-${Math.random().toString(36).slice(2)}`;
      const ipcPath = join(fixtureDir, `with-ipc-${nonce}.js`);
      writeFileSync(
        ipcPath,
        `module.exports = { init(config, ipcRenderer) { if (!ipcRenderer) throw new Error('no ipc'); } };`,
      );

      const result = initBrowserModules({
        config: {},
        modules: [{ name: 'with-ipc', path: ipcPath, requiresIpc: true }],
      });

      assert.strictEqual(result.successCount, 0);
      assert.match(result.failures[0].error, /requiresIpc: true but no ipcRenderer/);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('preload.js initializes modules through the registry', () => {
    const source = readFileSync(PRELOAD_PATH, 'utf8');

    assert.match(
      source,
      /require\(["']\.\/tools\/moduleRegistry["']\)/,
      'preload.js must require ./tools/moduleRegistry — the declarative list in ' +
        'moduleRegistry.js is the single source of truth for browser module init.',
    );
    assert.ok(
      !/modulesRequiringIpc/.test(source),
      'preload.js still contains a modulesRequiringIpc list. That decision moved ' +
        'into app/browser/tools/moduleRegistry.js (requiresIpc flags) — declare it ' +
        'there instead so tests keep guarding issue #1902.',
    );
  });
});
