'use strict';

const fs = require('node:fs');
const path = require('node:path');

const METADATA_VERSION = 1;
const MAX_RECORDS = 100;

class ExtensionRegistry {
  #metadataPath;
  #settingsStore;

  constructor(metadataPath, settingsStore = null) {
    this.#metadataPath = metadataPath;
    this.#settingsStore = settingsStore;
  }

  load() {
    let records = null;
    try {
      if (fs.existsSync(this.#metadataPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.#metadataPath, 'utf8'));
        records = Array.isArray(parsed) ? parsed : parsed?.extensions;
      }
    } catch {
      records = null;
    }
    if (!Array.isArray(records)) {
      try {
        const legacy = this.#settingsStore?.get('extensions.installed', []);
        records = Array.isArray(legacy) ? legacy : [];
      } catch {
        records = [];
      }
    }
    return records.slice(0, MAX_RECORDS);
  }

  save(records) {
    const safeRecords = Array.isArray(records) ? records.slice(0, MAX_RECORDS) : [];
    fs.mkdirSync(path.dirname(this.#metadataPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#metadataPath}.tmp`;
    fs.writeFileSync(
      temporary,
      JSON.stringify({ version: METADATA_VERSION, extensions: safeRecords }, null, 2),
      { mode: 0o600 },
    );
    fs.renameSync(temporary, this.#metadataPath);
    this.#settingsStore?.set('extensions.installed', safeRecords);
  }
}

module.exports = ExtensionRegistry;
module.exports.METADATA_VERSION = METADATA_VERSION;
