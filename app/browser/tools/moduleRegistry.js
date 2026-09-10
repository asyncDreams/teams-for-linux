'use strict';

/**
 * Declarative registry of the browser tool modules initialized by preload.js
 * on DOMContentLoaded.
 *
 * This file is the single source of truth for:
 *   1. WHICH browser modules are loaded into the Teams page.
 *   2. WHICH of them receive `ipcRenderer` during `init(config, ipcRenderer)`.
 *
 * It replaces the inline `modules` array + `modulesRequiringIpc` Set that used
 * to live in preload.js. That Set was accidentally deleted multiple times in
 * git history (issue #1902): the modules loaded fine, then crashed later with
 * `TypeError: Cannot read properties of undefined (reading 'send')` — a
 * user-reported outage for tray icons, MQTT status publishing, and other
 * IPC-dependent features.
 *
 * Invariants (enforced by tests/unit/preloadModules.test.js):
 *   - `settings`, `theme`, `trayIconRenderer` and `mqttStatusMonitor`
 *     (CLAUDE.md "Modules Requiring IPC Initialization") must declare
 *     `requiresIpc: true`.
 *   - A module declaring `requiresIpc: true` must accept `(config, ipcRenderer)`.
 *   - A module declaring `requiresIpc: false` must NOT declare an
 *     `ipcRenderer` parameter, because it will never receive one.
 *   - preload.js must initialize modules through `initBrowserModules()`
 *     instead of re-declaring its own list.
 *
 * To add a browser module: create the tool in this directory exporting
 * `init(config)` or `init(config, ipcRenderer)`, then add one entry to
 * BROWSER_MODULES below. Nothing else needs updating.
 */

/** @typedef {{ name: string, path: string, requiresIpc: boolean }} BrowserModuleEntry */

/** @type {ReadonlyArray<BrowserModuleEntry>} */
const BROWSER_MODULES = Object.freeze(
  [
    { name: "zoom", path: "./zoom", requiresIpc: false },
    { name: "shortcuts", path: "./shortcuts", requiresIpc: false },
    { name: "settings", path: "./settings", requiresIpc: true },
    { name: "theme", path: "./theme", requiresIpc: true },
    { name: "emulatePlatform", path: "./emulatePlatform", requiresIpc: false },
    { name: "webauthnOverride", path: "./webauthnOverride", requiresIpc: true },
    { name: "timestampCopyOverride", path: "./timestampCopyOverride", requiresIpc: false },
    { name: "trayIconRenderer", path: "./trayIconRenderer", requiresIpc: true },
    { name: "mqttStatusMonitor", path: "./mqttStatusMonitor", requiresIpc: true },
    { name: "meetingStartDetector", path: "./meetingStartDetector", requiresIpc: true },
    { name: "overrideMicConstraints", path: "./overrideMicConstraints", requiresIpc: false },
    { name: "disableAutogain", path: "./disableAutogain", requiresIpc: false },
    { name: "ignoreSystemMute", path: "./ignoreSystemMute", requiresIpc: false },
    { name: "speakingIndicator", path: "./speakingIndicator", requiresIpc: true },
    { name: "cameraResolution", path: "./cameraResolution", requiresIpc: false },
    { name: "cameraAspectRatio", path: "./cameraAspectRatio", requiresIpc: false },
    { name: "navigationButtons", path: "./navigationButtons", requiresIpc: false },
    { name: "framelessTweaks", path: "./frameless", requiresIpc: false },
    { name: "customStickers", path: "./customStickers", requiresIpc: true },
    { name: "dockIconRenderer", path: "./dockIconRenderer", requiresIpc: true },
    { name: "preventDeviceSwitching", path: "./preventDeviceSwitching", requiresIpc: false },
  ].map((entry) => Object.freeze(entry)),
);

/**
 * Modules called out in CLAUDE.md whose IPC requirement was repeatedly
 * regressed historically. Losing any of these from the `requiresIpc` set is
 * a user-facing outage, not a refactor.
 */
const CRITICAL_IPC_MODULES = Object.freeze([
  "settings",
  "theme",
  "trayIconRenderer",
  "mqttStatusMonitor",
]);

/**
 * Validate registry self-consistency. Returns an array of human-readable
 * errors (empty when valid) so tests can report every problem without
 * throwing from module scope.
 *
 * @returns {string[]}
 */
function validateRegistry() {
  const errors = [];
  const seenNames = new Set();

  for (const entry of BROWSER_MODULES) {
    if (!entry.name || typeof entry.name !== "string") {
      errors.push(`Registry entry with invalid name: ${JSON.stringify(entry)}`);
      continue;
    }
    if (seenNames.has(entry.name)) {
      errors.push(`Duplicate registry entry for module "${entry.name}"`);
    }
    seenNames.add(entry.name);

    if (typeof entry.path !== "string" || !entry.path.startsWith("./")) {
      errors.push(`Module "${entry.name}" has an invalid path: ${JSON.stringify(entry.path)}`);
    }
    if (typeof entry.requiresIpc !== "boolean") {
      errors.push(`Module "${entry.name}" must declare a boolean requiresIpc flag`);
    }
  }

  for (const name of CRITICAL_IPC_MODULES) {
    const entry = BROWSER_MODULES.find((module) => module.name === name);
    if (!entry) {
      errors.push(
        `CRITICAL: "${name}" is missing from BROWSER_MODULES — see CLAUDE.md ` +
          `"Modules Requiring IPC Initialization" and issue #1902`,
      );
    } else if (!entry.requiresIpc) {
      errors.push(
        `CRITICAL: "${name}" must declare requiresIpc: true — see CLAUDE.md ` +
          `"Modules Requiring IPC Initialization" and issue #1902`,
      );
    }
  }

  return errors;
}

/**
 * Initialize every registered browser module against the Teams page.
 *
 * Failures are contained per module (one broken tool must not prevent the
 * others from loading) but are never silent: every failure is logged with
 * the module name and recorded in the returned result. A module declared
 * `requiresIpc: true` without an available `ipcRenderer` fails immediately
 * with a named error instead of crashing later inside its handlers with the
 * opaque "Cannot read properties of undefined" from issue #1902.
 *
 * @param {object} params
 * @param {object} params.config Resolved app configuration.
 * @param {object} [params.ipcRenderer] Preload ipcRenderer.
 * @param {string} [params.logTag] Prefix for log lines.
 * @param {ReadonlyArray<BrowserModuleEntry>} [params.modules] Entries to
 *   initialize; defaults to BROWSER_MODULES. Injectable so tests can exercise
 *   the dispatcher against fake modules without loading the real tools.
 * @returns {{
 *   successCount: number,
 *   total: number,
 *   failures: Array<{ name: string, error: string }>,
 * }}
 */
function initBrowserModules({ config, ipcRenderer, logTag = "Preload", modules = BROWSER_MODULES }) {
  const failures = [];
  let successCount = 0;

  for (const entry of modules) {
    try {
      if (entry.requiresIpc && !ipcRenderer) {
        throw new Error("declared requiresIpc: true but no ipcRenderer was provided");
      }

      const moduleInstance = require(entry.path);
      if (typeof moduleInstance?.init !== "function") {
        throw new Error("module does not export an init function");
      }

      if (entry.requiresIpc) {
        moduleInstance.init(config, ipcRenderer);
      } else {
        moduleInstance.init(config);
      }
      successCount += 1;
    } catch (err) {
      const message = err?.message || String(err);
      console.error(`${logTag}: Failed to load ${entry.name}:`, message);
      failures.push({ name: entry.name, error: message });
    }
  }

  return { successCount, total: modules.length, failures };
}

module.exports = {
  BROWSER_MODULES,
  CRITICAL_IPC_MODULES,
  initBrowserModules,
  validateRegistry,
};
