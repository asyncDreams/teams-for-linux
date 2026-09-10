'use strict';

/**
 * In-app configuration settings service (Phase 3b of the config-UX research:
 * docs-site/docs/development/research/documentation-and-config-ux-research.md).
 *
 * Gives the settings window a schema-driven view over app/config/options.js
 * and a validated, persisted override store — the same store the menu toggles
 * already use (legacyConfigStore === electron-store "config" === the yargs
 * user config file userData/config.json). Overrides therefore survive restart
 * through the existing boot-merge path, with no new persistence format.
 *
 * Semantics:
 *  - The schema (types, defaults, applyMode, choices) is derived from
 *    app/config/options.js, the same single source of truth that generates
 *    the docs; the UI can never offer an unknown option.
 *  - Writes are validated against that schema before they touch config or
 *    disk. Values equal to the schema default are removed from the override
 *    store, so the store stays a minimal delta over the config file.
 *  - `applyMode: "live"` options also update the running process and notify
 *    the Teams renderer over the existing `config-changed` channel; the rest
 *    are marked "restart" and the window offers a restart action.
 *
 * The module imports Electron only inside initialize(), like
 * NotificationHistoryService, so the logic stays unit-testable in plain Node.
 */

const configOptions = require('../config/options');

/** Options excluded from the settings UI. Secrets stay config-file-only so a
 * shared screen through this window never shows a credential. */
const HIDDEN_OPTIONS = new Set([
  'clientCertPassword',
]);

/** Options that require expert knowledge and raw JSON editing; the UI still
 * exposes them, but only through the advanced JSON editor. */
const ADVANCED_OPTIONS = new Set([
  'chromeUserAgent',
  'electronCLIFlags',
  'customCACertsFingerprints',
  'meetupJoinRegEx',
]);

const MAX_STRING_LENGTH = 4096;
const MAX_ARRAY_LENGTH = 100;

/**
 * Derives the UI grouping for an option name. Pure function, exported for
 * tests and reused by the renderer over the schema snapshot.
 * @param {string} name
 * @returns {string}
 */
function groupFor(name) {
  if (Object.hasOwn(GROUP_RULES, name)) return GROUP_RULES[name];
  for (const [group, prefixes] of Object.entries(GROUP_PREFIXES)) {
    if (prefixes.some((prefix) => name.startsWith(prefix))) return group;
  }
  return 'general';
}

const GROUP_RULES = {
  url: 'Connection',
  partition: 'Connection',
  chromeUserAgent: 'Connection',
  proxyServer: 'Connection',
  network: 'Connection',
  authServerWhitelist: 'Connection',
  hosts: 'Connection',
  menubar: 'Window',
  frame: 'Window',
  alwaysOnTop: 'Window',
  minimized: 'Window',
  closeAppOnCross: 'Window',
  minimizeOnClose: 'Window',
  class: 'Window',
  appTitle: 'Window',
  useMutationTitleLogic: 'Window',
  appIcon: 'Window',
  appIconType: 'Window',
  followSystemTheme: 'Window',
  trayIconEnabled: 'Window',
  disableNotifications: 'Notifications',
  disableNotificationSound: 'Notifications',
  disableNotificationSoundIfNotAvailable: 'Notifications',
  disableNotificationWindowFlash: 'Notifications',
  disableBadgeCount: 'Notifications',
  defaultNotificationUrgency: 'Notifications',
  notifications: 'Notifications',
  notificationMethod: 'Notifications',
  customNotification: 'Notifications',
  enableIncomingCallToast: 'Notifications',
  incomingCallCommand: 'Notifications',
  incomingCallCommandArgs: 'Notifications',
  spellCheckerLanguages: 'Meeting & Chat',
  meetupJoinRegEx: 'Meeting & Chat',
  onNewWindowOpenMeetupJoinUrlInApp: 'Meeting & Chat',
  meetupJoinPopOutWindow: 'Meeting & Chat',
  msTeamsProtocols: 'Meeting & Chat',
  screenSharing: 'Meeting & Chat',
  awayOnSystemIdle: 'Presence & Idle',
  idleDetection: 'Presence & Idle',
  appIdleTimeout: 'Presence & Idle',
  appIdleTimeoutCheckInterval: 'Presence & Idle',
  appActiveCheckInterval: 'Presence & Idle',
  presence: 'Presence & Idle',
  shortcuts: 'Shortcuts',
  globalShortcuts: 'Shortcuts',
  disableGlobalShortcuts: 'Shortcuts',
  isCustomBackgroundEnabled: 'Appearance & Assets',
  customBGServiceBaseUrl: 'Appearance & Assets',
  customBGServiceConfigFetchInterval: 'Appearance & Assets',
  customCSSName: 'Appearance & Assets',
  customCSSLocation: 'Appearance & Assets',
  customStickers: 'Appearance & Assets',
  disableTimestampOnCopy: 'Appearance & Assets',
  ssoBasicAuthUser: 'Auth & Certificates',
  ssoBasicAuthPasswordCommand: 'Auth & Certificates',
  clientCertPath: 'Auth & Certificates',
  clientCertPassword: 'Auth & Certificates',
  customCACertsFingerprints: 'Auth & Certificates',
  auth: 'Auth & Certificates',
  cacheManagement: 'Storage & Cache',
  clearStorageData: 'Storage & Cache',
  storage: 'Storage & Cache',
  download: 'Storage & Cache',
  webDebug: 'Advanced',
  disableGpu: 'Advanced',
  emulateWinChromiumPlatform: 'Advanced',
  wayland: 'Advanced',
  electronCLIFlags: 'Advanced',
  logConfig: 'Advanced',
  defaultURLHandler: 'Advanced',
  multiAccount: 'Advanced',
  extensions: 'Advanced',
  mqtt: 'Advanced',
  graphApi: 'Advanced',
  quickChat: 'Advanced',
  media: 'Advanced',
  linux: 'Advanced',
  watchConfigFile: 'Advanced',
};

const GROUP_PREFIXES = {
  Notifications: ['notification'],
  'Meeting & Chat': ['meetup', 'meeting'],
  'Presence & Idle': ['idle', 'away'],
};

/** UI display order for groups. Unknown groups sort after these. */
const GROUP_ORDER = [
  'Connection',
  'Window',
  'Notifications',
  'Meeting & Chat',
  'Presence & Idle',
  'Shortcuts',
  'Appearance & Assets',
  'Auth & Certificates',
  'Storage & Cache',
  'Advanced',
];

/**
 * Clones a plain config value defensively (no prototype pollution, bounded
 * depth/size). Pure function.
 */
function safeClone(value, depth = 0) {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'string') return value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;
  if (type === 'boolean' || type === 'number') return value;
  if (depth > 6) return null;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((entry) => safeClone(entry, depth + 1));
  }
  if (type !== 'object') return null;
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, 60)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    result[key] = safeClone(entry, depth + 1);
  }
  return result;
}

/**
 * Reads a dot-path ("electron.clickAction") from an object. Pure function.
 * @returns {{found: boolean, value: any}}
 */
function getPathValue(object, dotPath) {
  let cursor = object;
  for (const segment of String(dotPath).split('.')) {
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, segment)) {
      return { found: false, value: undefined };
    }
    cursor = cursor[segment];
  }
  return { found: true, value: cursor };
}

/**
 * Sets a dot-path on a target object, creating plain intermediate objects.
 * Mutates `target`; returns it for chaining. Pure of prototype pollution:
 * dangerous keys are rejected.
 * @returns {object} the mutated target
 */
function setByPath(target, dotPath, value) {
  const segments = String(dotPath).split('.');
  for (const segment of segments) {
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
      throw new Error(`Rejected unsafe key in path: ${dotPath}`);
    }
  }
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (!cursor[segment] || typeof cursor[segment] !== 'object' || Array.isArray(cursor[segment])) {
      cursor[segment] = {};
    }
    cursor = cursor[segment];
  }
  cursor[segments[segments.length - 1]] = value;
  return target;
}

/**
 * Deletes a dot-path leaf and prunes now-empty intermediate objects.
 * Returns true when something was removed. Pure of side effects beyond the
 * mutation of `target`.
 */
function deleteByPath(target, dotPath) {
  const segments = String(dotPath).split('.');
  let cursor = target;
  const chain = [];
  for (const segment of segments) {
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, segment)) {
      return false;
    }
    chain.push({ parent: cursor, key: segment });
    cursor = cursor[segment];
  }
  if (!chain.length) return false;
  const last = chain[chain.length - 1];
  delete last.parent[last.key];
  // Prune empty parents (keep the root object even when empty).
  for (let i = chain.length - 2; i >= 0; i -= 1) {
    const { parent, key } = chain[i];
    const child = parent[key];
    if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) {
      delete parent[key];
    } else {
      break;
    }
  }
  return true;
}

/**
 * Validates a candidate value against one schema leaf descriptor.
 * @param {object} descriptor - { type, choices? }
 * @param {any} value
 * @returns {{ok: boolean, error?: string, value?: any}} value is the
 *   normalised value when ok (numbers coerced from numeric strings).
 */
function validateValueAgainstSchema(descriptor, value) {
  const type = descriptor?.type;
  if (type === 'boolean') {
    if (typeof value !== 'boolean') return { ok: false, error: 'expected boolean' };
    return { ok: true, value };
  }
  if (type === 'number') {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (typeof value === 'boolean' || value === null || value === '' || !Number.isFinite(numeric)) {
      return { ok: false, error: 'expected a finite number' };
    }
    return { ok: true, value: numeric };
  }
  if (type === 'string') {
    if (typeof value !== 'string') return { ok: false, error: 'expected a string' };
    if (value.length > MAX_STRING_LENGTH) return { ok: false, error: 'string too long' };
    if (Array.isArray(descriptor.choices) && descriptor.choices.length && !descriptor.choices.includes(value)) {
      return { ok: false, error: `expected one of: ${descriptor.choices.join(', ')}` };
    }
    return { ok: true, value };
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return { ok: false, error: 'expected an array' };
    if (value.length > MAX_ARRAY_LENGTH) return { ok: false, error: 'array too large' };
    return { ok: true, value: safeClone(value) };
  }
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'expected an object' };
    }
    return { ok: true, value: safeClone(value) };
  }
  return { ok: false, error: `unsupported type: ${type}` };
}

/**
 * Builds the schema entries the settings UI renders, straight from
 * app/config/options.js metadata. Pure function.
 *
 * Each entry: { name, type, group, advanced, applyMode, description, default,
 * fields? (object options), choices? (scalar enums) }
 *
 * @returns {Array<object>}
 */
function buildSchemaEntries() {
  const entries = [];
  for (const [name, meta] of Object.entries(configOptions)) {
    if (HIDDEN_OPTIONS.has(name)) continue;
    if (!meta || typeof meta !== 'object' || !('default' in meta) || !meta.type) continue;
    const entry = {
      name,
      type: meta.type,
      group: groupFor(name),
      advanced: ADVANCED_OPTIONS.has(name),
      applyMode: meta.applyMode === 'live' ? 'live' : 'restart',
      description: typeof meta.describe === 'string' ? meta.describe : '',
      default: safeClone(meta.default),
    };
    if (Array.isArray(meta.choices) && meta.type !== 'object') {
      entry.choices = [...meta.choices];
    }
    if (meta.type === 'object' && meta.fields && typeof meta.fields === 'object') {
      entry.fields = Object.entries(meta.fields)
        .filter(([, field]) => field && typeof field === 'object')
        .map(([path, field]) => ({
          path,
          type: field.type || 'string',
          description: typeof field.describe === 'string' ? field.describe : '',
          default: safeClone(getPathValue(meta.default, path).value),
          ...(Array.isArray(field.choices) ? { choices: [...field.choices] } : {}),
        }));
    }
    entries.push(entry);
  }
  entries.sort((a, b) => {
    const groupDelta = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
    if (groupDelta !== 0) return groupDelta;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

/**
 * Builds the persisted-override delta: only leaves whose value differs from
 * the schema default are kept. Pure function.
 *
 * @param {object} currentValues - full effective values keyed by option name
 * @param {Array<object>} entries - schema entries from buildSchemaEntries()
 * @returns {object} overrides safe to hand to the config store
 */
function diffOverrides(currentValues, entries) {
  const overrides = {};
  for (const entry of entries) {
    const current = currentValues[entry.name];
    if (entry.type === 'object' && entry.fields?.length) {
      const objectOverrides = {};
      for (const field of entry.fields) {
        const { found, value } = getPathValue(current ?? {}, field.path);
        const baseline = getPathValue(entry.default ?? {}, field.path);
        if (!found) continue;
        if (!sameValue(value, baseline.found ? baseline.value : field.default)) {
          setByPath(objectOverrides, field.path, safeClone(value));
        }
      }
      if (Object.keys(objectOverrides).length) overrides[entry.name] = objectOverrides;
      continue;
    }
    if (!sameValue(current, entry.default)) {
      overrides[entry.name] = safeClone(current);
    }
  }
  return overrides;
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Merges persisted overrides into the running config at boot. Mirrors the
 * loadMenuToggleSettings merge semantics (shallow spread for objects, with a
 * second level for known nested stores) but is driven by the override delta
 * itself, so any option changed through the settings UI is restored.
 *
 * Pure function over its arguments; exported for index.js and tests.
 *
 * @param {object} config - the startup config object (mutated in place)
 * @param {object} overrides - persisted override delta
 * @param {Array<object>} entries - schema entries (buildSchemaEntries())
 */
function mergeOverridesIntoConfig(config, overrides, entries) {
  if (!overrides || typeof overrides !== 'object') return;
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  for (const [name, stored] of Object.entries(overrides)) {
    const entry = byName.get(name);
    if (!entry) continue; // Unknown keys are ignored, never injected.
    if (entry.type === 'object' && stored && typeof stored === 'object' && !Array.isArray(stored)) {
      const base = config[name] && typeof config[name] === 'object' ? config[name] : {};
      config[name] = { ...base, ...stored };
      continue;
    }
    config[name] = stored;
  }
}

/**
 * Wires the settings IPC handlers. Constructed lazily by Menus; the
 * constructor only captures dependencies so no Electron import happens at
 * require time (unit-testability).
 */
class ConfigSettingsService {
  #startupConfig;
  #legacyConfigStore;
  #onLiveChange;
  #onRestart;
  #entries;
  #initialized = false;

  /**
   * @param {object} configGroup - AppConfiguration instance
   * @param {object} [hooks]
   * @param {Function} [hooks.onLiveChange] - called after a live option
   *   changes so the host (Menus) can broadcast `config-changed` to the Teams
   *   renderer, exactly like the menu toggles do
   * @param {Function} [hooks.onRestart] - called when the user requests a
   *   restart from the settings window
   */
  constructor(configGroup, { onLiveChange = null, onRestart = null } = {}) {
    this.#startupConfig = configGroup.startupConfig;
    this.#legacyConfigStore = configGroup.legacyConfigStore;
    this.#onLiveChange = typeof onLiveChange === 'function' ? onLiveChange : null;
    this.#onRestart = typeof onRestart === 'function' ? onRestart : null;
    this.#entries = buildSchemaEntries();
  }

  /** Schema snapshot for the renderer (no runtime values included). */
  getSchema() {
    return {
      entries: this.#entries.map((entry) => ({ ...entry, default: safeClone(entry.default) })),
      groups: [...GROUP_ORDER],
    };
  }

  /**
   * Current effective values (schema-known options only, defensively cloned)
   * plus the persisted override delta so the UI can show provenance.
   */
  getValues() {
    const values = {};
    for (const entry of this.#entries) {
      values[entry.name] = safeClone(this.#startupConfig[entry.name]);
    }
    return {
      values,
      overrides: this.#readOverrides(),
    };
  }

  /**
   * Applies one value change: validates against the schema, updates the
   * running config, and persists the recalculated override delta.
   *
   * @param {{name: string, path?: string, value: any}} change
   * @returns {{ok: boolean, error?: string, applyMode?: string}}
   */
  setValue({ name, path, value } = {}) {
    const entry = this.#entries.find((candidate) => candidate.name === name);
    if (!entry) return { ok: false, error: 'Unknown option' };

    // Object leaf path (e.g. notifications → electron.clickAction)
    if (entry.type === 'object' && path) {
      const field = entry.fields?.find((candidate) => candidate.path === path);
      if (!field) return { ok: false, error: 'Unknown option field' };
      const validated = validateValueAgainstSchema(field, value);
      if (!validated.ok) return { ok: false, error: validated.error };
      const base = this.#startupConfig[name];
      const currentObject = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
      setByPath(currentObject, path, validated.value);
      this.#startupConfig[name] = currentObject;
      this.#persistOverrides();
      if (entry.applyMode === 'live') this.#applyLiveChange();
      return { ok: true, applyMode: entry.applyMode };
    }

    const validated = validateValueAgainstSchema(entry, value);
    if (!validated.ok) return { ok: false, error: validated.error };
    this.#startupConfig[name] = validated.value;
    this.#persistOverrides();
    if (entry.applyMode === 'live') this.#applyLiveChange();
    return { ok: true, applyMode: entry.applyMode };
  }

  /**
   * Restores schema defaults. Without arguments resets every option;
   * with { name } resets a single option (including its nested fields).
   * @returns {{ok: boolean, error?: string, applyMode?: string}}
   */
  reset({ name } = {}) {
    if (!name) {
      for (const entry of this.#entries) {
        this.#startupConfig[entry.name] = safeClone(entry.default);
      }
      this.#persistOverrides();
      return { ok: true, applyMode: 'restart' };
    }
    const entry = this.#entries.find((candidate) => candidate.name === name);
    if (!entry) return { ok: false, error: 'Unknown option' };
    this.#startupConfig[name] = safeClone(entry.default);
    this.#persistOverrides();
    if (entry.applyMode === 'live') this.#applyLiveChange();
    return { ok: true, applyMode: entry.applyMode };
  }

  /** Requests an app restart through the injected callback. */
  restartApp() {
    if (this.#onRestart) {
      this.#onRestart();
      return true;
    }
    return false;
  }

  /** Registers the IPC handlers. Called once from Menus construction. */
  initialize() {
    if (this.#initialized) return;
    this.#initialized = true;
    const { ipcMain } = require('electron');

    // Return the settings schema (types, defaults, applyMode, grouping).
    ipcMain.handle('settings-config-schema', () => this.getSchema());
    // Return current effective values plus the persisted override delta.
    ipcMain.handle('settings-config-values', () => this.getValues());
    // Validate and apply one option change; persists the override delta.
    ipcMain.handle('settings-config-set', (_event, change) => {
      try {
        return this.setValue(change);
      } catch {
        console.error('[SETTINGS] Failed to apply config change');
        return { ok: false, error: 'Failed to apply change' };
      }
    });
    // Restore defaults for one option or all options.
    ipcMain.handle('settings-config-reset', (_event, payload) => {
      try {
        return this.reset(payload || {});
      } catch {
        console.error('[SETTINGS] Failed to reset config');
        return { ok: false, error: 'Failed to reset' };
      }
    });
    // Fire-and-forget restart request from the settings window.
    ipcMain.on('settings-config-restart', () => this.restartApp());
  }

  /**
   * Recomputes the override delta from the live config and writes it to the
   * config store (removing keys that returned to default).
   */
  #persistOverrides() {
    const values = {};
    for (const entry of this.#entries) {
      values[entry.name] = this.#startupConfig[entry.name];
    }
    const overrides = diffOverrides(values, this.#entries);
    for (const key of Object.keys(this.#legacyConfigStore.store)) {
      if (this.#entries.some((entry) => entry.name === key)) {
        this.#legacyConfigStore.delete(key);
      }
    }
    for (const [name, value] of Object.entries(overrides)) {
      this.#legacyConfigStore.set(name, value);
    }
  }

  #readOverrides() {
    const overrides = {};
    for (const entry of this.#entries) {
      if (this.#legacyConfigStore.has(entry.name)) {
        overrides[entry.name] = safeClone(this.#legacyConfigStore.get(entry.name));
      }
    }
    return overrides;
  }

  /**
   * Notifies the host about a live config change. The host (Menus) owns the
   * `config-changed` broadcast and the menu rebuild, so live options behave
   * identically to the menu toggles.
   */
  #applyLiveChange() {
    if (this.#onLiveChange) {
      try {
        this.#onLiveChange();
      } catch {
        // Live notify is best-effort; the value is already persisted.
      }
    }
  }
}

module.exports = ConfigSettingsService;
module.exports.buildSchemaEntries = buildSchemaEntries;
module.exports.groupFor = groupFor;
module.exports.GROUP_ORDER = GROUP_ORDER;
module.exports.validateValueAgainstSchema = validateValueAgainstSchema;
module.exports.diffOverrides = diffOverrides;
module.exports.mergeOverridesIntoConfig = mergeOverridesIntoConfig;
module.exports.getPathValue = getPathValue;
module.exports.setByPath = setByPath;
module.exports.deleteByPath = deleteByPath;
module.exports.safeClone = safeClone;
