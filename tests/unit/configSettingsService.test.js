'use strict';

/**
 * Unit tests for the in-app configuration settings service (Phase 3b of the
 * config-UX research). The service is Electron-free until initialize(), so
 * the pure helpers and the store behaviour are testable in plain Node with a
 * fake config group.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  buildSchemaEntries,
  groupFor,
  GROUP_ORDER,
  validateValueAgainstSchema,
  diffOverrides,
  mergeOverridesIntoConfig,
  getPathValue,
  setByPath,
  deleteByPath,
  safeClone,
} = require('../../app/settings/configSettingsService');

function makeFakeConfigGroup(overrides = {}) {
  const entries = buildSchemaEntries();
  const startupConfig = {};
  for (const entry of entries) {
    startupConfig[entry.name] = safeClone(entry.default);
  }
  Object.assign(startupConfig, overrides);
  const stored = {};
  return {
    startupConfig,
    legacyConfigStore: {
      get store() {
        return stored;
      },
      has: (key) => Object.hasOwn(stored, key),
      get: (key) => stored[key],
      set: (key, value) => {
        stored[key] = value;
      },
      delete: (key) => {
        delete stored[key];
      },
    },
  };
}

describe('buildSchemaEntries', () => {
  it('derives one entry per documented option with grouping and applyMode', () => {
    const entries = buildSchemaEntries();
    assert.ok(entries.length >= 60, 'covers the documented options');
    const url = entries.find((entry) => entry.name === 'url');
    assert.ok(url, 'url option present');
    assert.strictEqual(url.type, 'string');
    assert.strictEqual(url.group, 'Connection');
    assert.strictEqual(url.applyMode, 'restart');
    const disableNotifications = entries.find((entry) => entry.name === 'disableNotifications');
    assert.strictEqual(disableNotifications.applyMode, 'live');
    assert.strictEqual(disableNotifications.group, 'Notifications');
  });

  it('never exposes the client certificate password to the UI', () => {
    const names = buildSchemaEntries().map((entry) => entry.name);
    assert.ok(!names.includes('clientCertPassword'), 'secret stays config-file-only');
  });

  it('sorts entries by group order then by name', () => {
    const entries = buildSchemaEntries();
    for (let i = 1; i < entries.length; i += 1) {
      const previous = GROUP_ORDER.indexOf(entries[i - 1].group);
      const current = GROUP_ORDER.indexOf(entries[i].group);
      if (previous === current) {
        assert.ok(entries[i - 1].name.localeCompare(entries[i].name) <= 0);
      } else {
        assert.ok(previous <= current);
      }
    }
  });

  it('maps object options to per-field descriptors with defaults', () => {
    const notifications = buildSchemaEntries().find((entry) => entry.name === 'notifications');
    assert.ok(notifications, 'notifications option present');
    assert.strictEqual(notifications.type, 'object');
    assert.ok(Array.isArray(notifications.fields) && notifications.fields.length > 0);
    for (const field of notifications.fields) {
      assert.ok(typeof field.path === 'string' && field.path.length > 0);
      assert.ok('default' in field);
    }
  });
});

describe('groupFor', () => {
  it('uses explicit rules first, then prefixes, then general', () => {
    assert.strictEqual(groupFor('url'), 'Connection');
    assert.strictEqual(groupFor('notificationSoundsVolume'.replace('SoundsVolume', 'Method')), 'Notifications');
    assert.strictEqual(groupFor('totallyUnknownOption'), 'general');
  });
});

describe('validateValueAgainstSchema', () => {
  it('accepts booleans and rejects everything else', () => {
    assert.strictEqual(validateValueAgainstSchema({ type: 'boolean' }, true).ok, true);
    assert.strictEqual(validateValueAgainstSchema({ type: 'boolean' }, 'true').ok, false);
  });

  it('coerces numeric strings and rejects NaN', () => {
    assert.deepStrictEqual(validateValueAgainstSchema({ type: 'number' }, '42'), { ok: true, value: 42 });
    assert.strictEqual(validateValueAgainstSchema({ type: 'number' }, 'abc').ok, false);
    assert.strictEqual(validateValueAgainstSchema({ type: 'number' }, '').ok, false);
  });

  it('enforces choice enums for strings', () => {
    const descriptor = { type: 'string', choices: ['web', 'electron'] };
    assert.strictEqual(validateValueAgainstSchema(descriptor, 'web').ok, true);
    assert.strictEqual(validateValueAgainstSchema(descriptor, 'nope').ok, false);
  });

  it('strips prototype-polluting keys from objects', () => {
    const result = validateValueAgainstSchema({ type: 'object' }, { a: 1, __proto__: { evil: true } });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(Object.hasOwn(result.value, '__proto__'), false);
  });

  it('requires arrays to be arrays', () => {
    assert.strictEqual(validateValueAgainstSchema({ type: 'array' }, [1, 2]).ok, true);
    assert.strictEqual(validateValueAgainstSchema({ type: 'array' }, 'not-array').ok, false);
  });
});

describe('path helpers', () => {
  it('reads, writes and deletes dot paths', () => {
    const object = { notifications: { electron: { clickAction: 'everything' } } };
    assert.deepStrictEqual(getPathValue(object, 'notifications.electron.clickAction'), {
      found: true,
      value: 'everything',
    });
    setByPath(object, 'notifications.requestPermission', true);
    assert.strictEqual(object.notifications.requestPermission, true);
    assert.strictEqual(deleteByPath(object, 'notifications.electron.clickAction'), true);
    assert.deepStrictEqual(object.notifications, { requestPermission: true });
  });

  it('rejects unsafe path segments', () => {
    assert.throws(() => setByPath({}, '__proto__.polluted', true));
  });

  it('reports missing paths as not found', () => {
    assert.strictEqual(getPathValue({}, 'missing.path').found, false);
  });
});

describe('diffOverrides', () => {
  it('keeps only values that differ from the schema defaults', () => {
    const entries = buildSchemaEntries();
    const url = entries.find((entry) => entry.name === 'url');
    const overrides = diffOverrides({ url: 'https://org.example.com' }, [url]);
    assert.deepStrictEqual(overrides, { url: 'https://org.example.com' });
  });

  it('drops values that are back at default', () => {
    const entries = buildSchemaEntries();
    const url = entries.find((entry) => entry.name === 'url');
    assert.deepStrictEqual(diffOverrides({ url: url.default }, [url]), {});
  });

  it('diffs object options field by field', () => {
    const entries = buildSchemaEntries();
    const notifications = entries.find((entry) => entry.name === 'notifications');
    assert.ok(notifications?.fields?.length);
    const field = notifications.fields[0];
    const current = safeClone(notifications.default) || {};
    setByPath(current, field.path, 'changed-value');
    const overrides = diffOverrides({ notifications: current }, [notifications]);
    assert.ok(overrides.notifications, 'override recorded for changed field');
  });
});

describe('mergeOverridesIntoConfig', () => {
  it('restores persisted overrides and ignores unknown keys', () => {
    const entries = buildSchemaEntries();
    const url = entries.find((entry) => entry.name === 'url');
    const config = { url: url.default };
    mergeOverridesIntoConfig(config, { url: 'https://custom.example.com', notAnOption: 'x' }, entries);
    assert.strictEqual(config.url, 'https://custom.example.com');
    assert.strictEqual(config.notAnOption, undefined);
  });

  it('spreads stored object deltas over the current object', () => {
    const entries = buildSchemaEntries();
    const notifications = entries.find((entry) => entry.name === 'notifications');
    assert.ok(notifications?.fields?.length);
    const field = notifications.fields[0];
    const stored = {};
    setByPath(stored, field.path, 'stored-value');
    const config = { notifications: safeClone(notifications.default) || {} };
    mergeOverridesIntoConfig(config, { notifications: stored }, entries);
    assert.strictEqual(getPathValue(config.notifications, field.path).value, 'stored-value');
  });
});

describe('ConfigSettingsService', () => {
  it('validates writes, persists deltas and reports apply mode', () => {
    delete require.cache[require.resolve('../../app/settings/configSettingsService')];
    const ConfigSettingsService = require('../../app/settings/configSettingsService');
    const configGroup = makeFakeConfigGroup();
    const service = new ConfigSettingsService(configGroup);
    const result = service.setValue({ name: 'url', value: 'https://org.example.com' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.applyMode, 'restart');
    assert.strictEqual(configGroup.startupConfig.url, 'https://org.example.com');
    assert.strictEqual(configGroup.legacyConfigStore.get('url'), 'https://org.example.com');

    const rejected = service.setValue({ name: 'disableNotifications', value: 'yes' });
    assert.strictEqual(rejected.ok, false);

    const unknown = service.setValue({ name: 'nope', value: 1 });
    assert.strictEqual(unknown.ok, false);
  });

  it('live options notify through the injected hook and clear overrides on reset', () => {
    delete require.cache[require.resolve('../../app/settings/configSettingsService')];
    const ConfigSettingsService = require('../../app/settings/configSettingsService');
    const configGroup = makeFakeConfigGroup();
    let liveChanges = 0;
    const service = new ConfigSettingsService(configGroup, {
      onLiveChange: () => {
        liveChanges += 1;
      },
    });
    const result = service.setValue({ name: 'disableNotifications', value: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.applyMode, 'live');
    assert.strictEqual(liveChanges, 1);
    assert.strictEqual(configGroup.legacyConfigStore.get('disableNotifications'), true);

    const reset = service.reset({ name: 'disableNotifications' });
    assert.strictEqual(reset.ok, true);
    assert.strictEqual(liveChanges, 2);
    assert.strictEqual(configGroup.legacyConfigStore.has('disableNotifications'), false);
  });

  it('reset all restores every schema default', () => {
    delete require.cache[require.resolve('../../app/settings/configSettingsService')];
    const ConfigSettingsService = require('../../app/settings/configSettingsService');
    const configGroup = makeFakeConfigGroup({ url: 'https://org.example.com' });
    const service = new ConfigSettingsService(configGroup);
    assert.strictEqual(service.reset({}).ok, true);
    const url = buildSchemaEntries().find((entry) => entry.name === 'url');
    assert.strictEqual(configGroup.startupConfig.url, url.default);
    assert.deepStrictEqual(configGroup.legacyConfigStore.store, {});
  });

  it('restart requests go through the injected callback only', () => {
    delete require.cache[require.resolve('../../app/settings/configSettingsService')];
    const ConfigSettingsService = require('../../app/settings/configSettingsService');
    const withoutHook = new ConfigSettingsService(makeFakeConfigGroup());
    assert.strictEqual(withoutHook.restartApp(), false);
    let restarts = 0;
    const withHook = new ConfigSettingsService(makeFakeConfigGroup(), {
      onRestart: () => {
        restarts += 1;
      },
    });
    assert.strictEqual(withHook.restartApp(), true);
    assert.strictEqual(restarts, 1);
  });

  it('schema and value reads are defensive clones', () => {
    delete require.cache[require.resolve('../../app/settings/configSettingsService')];
    const ConfigSettingsService = require('../../app/settings/configSettingsService');
    const configGroup = makeFakeConfigGroup();
    const service = new ConfigSettingsService(configGroup);
    const schema = service.getSchema();
    const urlEntry = schema.entries.find((entry) => entry.name === 'url');
    urlEntry.default = 'mutated';
    assert.notStrictEqual(service.getSchema().entries.find((entry) => entry.name === 'url').default, 'mutated');
    const values = service.getValues();
    values.values.url = 'mutated';
    assert.notStrictEqual(configGroup.startupConfig.url, 'mutated');
  });
});
