'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExtensionRegistry = require('../../app/extensions/registry');

let root;
let metadataPath;
let store;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tfl-extension-registry-'));
  metadataPath = path.join(root, 'extensions', 'metadata.json');
  const values = new Map();
  store = {
    get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    set: (key, value) => values.set(key, value),
  };
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('ExtensionRegistry persistence', () => {
  it('writes versioned metadata atomically and reloads it', () => {
    const registry = new ExtensionRegistry(metadataPath, store);
    const records = [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Otter', enabled: true }];
    registry.save(records);

    const persisted = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    assert.equal(persisted.version, 1);
    assert.deepEqual(new ExtensionRegistry(metadataPath, store).load(), records);
    assert.deepEqual(store.get('extensions.installed'), records);
    assert.equal(fs.existsSync(`${metadataPath}.tmp`), false);
  });

  it('migrates the legacy array file format', () => {
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    const legacy = [{ id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Legacy', enabled: false }];
    fs.writeFileSync(metadataPath, JSON.stringify(legacy));
    assert.deepEqual(new ExtensionRegistry(metadataPath, store).load(), legacy);
  });

  it('falls back to the settings store when the metadata file is absent', () => {
    const legacy = [{ id: 'cccccccccccccccccccccccccccccccc', name: 'Stored', enabled: true }];
    store.set('extensions.installed', legacy);
    assert.deepEqual(new ExtensionRegistry(metadataPath, store).load(), legacy);
  });

  it('caps records returned from a corrupted oversized registry', () => {
    const registry = new ExtensionRegistry(metadataPath, store);
    registry.save(Array.from({ length: 120 }, (_, index) => ({ id: String(index), enabled: true })));
    assert.equal(new ExtensionRegistry(metadataPath, store).load().length, 100);
  });
});
