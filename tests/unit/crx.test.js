'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  extractCrx,
  getZipOffset,
  safeArchiveName,
  validateManifest,
} = require('../../app/extensions/crx');

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function makeZip(files, compression = 0) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const contents = Buffer.from(value);
    const compressed = compression === 8 ? zlib.deflateRawSync(contents) : contents;
    const local = Buffer.alloc(30 + filename.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(compression, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc32(contents), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(filename.length, 26);
    filename.copy(local, 30);
    locals.push(Buffer.concat([local, compressed]));

    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(compression, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc32(contents), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    filename.copy(central, 46);
    centrals.push(central);
    offset += locals.at(-1).length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

function makeCrx(zip, version) {
  if (version === 2) {
    const header = Buffer.alloc(16);
    header.writeUInt32LE(0x34327243, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(1, 8);
    header.writeUInt32LE(1, 12);
    return Buffer.concat([header, Buffer.from([1, 2]), zip]);
  }
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x34327243, 0);
  header.writeUInt32LE(3, 4);
  header.writeUInt32LE(4, 8);
  return Buffer.concat([header, Buffer.from([0, 0, 0, 0]), zip]);
}

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tfl-crx-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('CRX headers and extraction', () => {
  const manifest = JSON.stringify({
    manifest_version: 3,
    name: 'Otter test extension',
    version: '1.2.3',
    permissions: ['storage'],
    host_permissions: ['https://teams.cloud.microsoft/*'],
  });

  it('extracts a CRX2 archive with stored files', () => {
    const file = path.join(root, 'extension.crx');
    fs.writeFileSync(file, makeCrx(makeZip({ 'manifest.json': manifest, 'service.js': 'self.foo = 1;' }), 2));
    const result = extractCrx(file, path.join(root, 'out'));
    assert.equal(result.manifest.name, 'Otter test extension');
    assert.equal(fs.readFileSync(path.join(result.extensionPath, 'service.js'), 'utf8'), 'self.foo = 1;');
    assert.equal(getZipOffset(fs.readFileSync(file)), 18);
  });

  it('extracts a CRX3 archive with deflated files', () => {
    const file = path.join(root, 'extension.crx');
    fs.writeFileSync(file, makeCrx(makeZip({ 'manifest.json': manifest, 'nested/content.js': 'content' }, 8), 3));
    const result = extractCrx(file, path.join(root, 'out'));
    assert.equal(result.manifest.manifest_version, 3);
    assert.equal(fs.readFileSync(path.join(result.extensionPath, 'nested/content.js'), 'utf8'), 'content');
    assert.equal(getZipOffset(fs.readFileSync(file)), 16);
  });
});

describe('extension archive validation', () => {
  it('rejects traversal and invalid manifests', () => {
    assert.throws(() => safeArchiveName('../escape.js'), /traversal/i);
    assert.throws(() => safeArchiveName('/absolute.js'), /absolute/i);
    assert.throws(() => validateManifest({ manifest_version: 1, name: 'bad', version: '1' }), /manifest versions/i);
    assert.throws(() => validateManifest({ manifest_version: 3, name: '', version: '1' }), /name/i);
  });
});
