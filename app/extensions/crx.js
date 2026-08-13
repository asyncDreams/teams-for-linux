'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRX_MAGIC = 0x34327243; // "Cr24" in little-endian form
const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_MANIFEST_BYTES = 256 * 1024;

function readCrxZip(input) {
  const buffer = toBuffer(input);
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    throw new Error('Extension archive is too large');
  }
  const zipOffset = getZipOffset(buffer);
  return buffer.subarray(zipOffset);
}

function toBuffer(input) {
  return Buffer.isBuffer(input) ? input : fs.readFileSync(input);
}

function getZipOffset(buffer) {
  if (buffer.length < 16 || buffer.readUInt32LE(0) !== CRX_MAGIC) {
    if (buffer.readUInt32LE(0) === ZIP_LOCAL || buffer.readUInt32LE(0) === ZIP_CENTRAL) {
      return 0;
    }
    throw new Error('Not a CRX or ZIP archive');
  }

  const version = buffer.readUInt32LE(4);
  if (version === 2) {
    const publicKeyLength = buffer.readUInt32LE(8);
    const signatureLength = buffer.readUInt32LE(12);
    const offset = 16 + publicKeyLength + signatureLength;
    if (offset >= buffer.length) throw new Error('Invalid CRX2 header');
    return offset;
  }
  if (version === 3) {
    const headerSize = buffer.readUInt32LE(8);
    const offset = 12 + headerSize;
    if (offset >= buffer.length) throw new Error('Invalid CRX3 header');
    return offset;
  }
  throw new Error('Unsupported CRX version');
}

function findEndOfCentralDirectory(zip) {
  const minimum = Math.max(0, zip.length - 22 - 0xffff);
  for (let offset = zip.length - 22; offset >= minimum; offset -= 1) {
    if (zip.readUInt32LE(offset) !== ZIP_EOCD) continue;
    const commentLength = zip.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength <= zip.length) return offset;
  }
  throw new Error('ZIP central directory not found');
}

function parseZipEntries(zip) {
  const eocd = findEndOfCentralDirectory(zip);
  if (zip.readUInt16LE(eocd + 4) !== 0 || zip.readUInt16LE(eocd + 6) !== 0) {
    throw new Error('Multi-disk archives are not supported');
  }
  const entryCount = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
  }
  if (entryCount > MAX_ENTRIES || centralOffset + centralSize > zip.length) {
    throw new Error('Invalid ZIP central directory');
  }

  const entries = [];
  const names = new Set();
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== ZIP_CENTRAL) {
      throw new Error('Invalid ZIP central directory entry');
    }
    const flags = zip.readUInt16LE(offset + 8);
    const compression = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const fileNameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const madeBy = zip.readUInt16LE(offset + 4) >>> 8;
    const externalAttributes = zip.readUInt32LE(offset + 38);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    const extraEnd = nameEnd + extraLength;
    const entryEnd = extraEnd + commentLength;
    if (entryEnd > zip.length || localOffset >= zip.length) throw new Error('Invalid ZIP entry bounds');
    if ((flags & 0x1) !== 0) throw new Error('Encrypted extension archives are not supported');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('ZIP64 entries are not supported');
    }

    const rawName = zip.subarray(nameStart, nameEnd).toString((flags & 0x800) !== 0 ? 'utf8' : 'latin1');
    const name = safeArchiveName(rawName);
    if (names.has(name)) throw new Error('Duplicate path in extension archive');
    names.add(name);

    // A Unix symlink can otherwise escape the destination after extraction.
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if (madeBy === 3 && (unixMode & 0xf000) === 0xa000) {
      throw new Error('Symbolic links are not allowed in extension archives');
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error('Extension archive expands beyond the size limit');
    entries.push({
      name,
      isDirectory: rawName.endsWith('/') || (madeBy === 3 && (unixMode & 0xf000) === 0x4000),
      compression,
      compressedSize,
      uncompressedSize,
      crc: zip.readUInt32LE(offset + 16),
      localOffset,
    });
    offset = entryEnd;
  }
  return entries;
}

function safeArchiveName(rawName) {
  if (!rawName || rawName.includes('\0')) throw new Error('Invalid path in extension archive');
  const normalized = rawName.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error('Absolute paths are not allowed in extension archives');
  }
  const safe = path.posix.normalize(normalized);
  if (safe === '..' || safe.startsWith('../')) throw new Error('Path traversal in extension archive');
  return safe;
}

function extractZip(zip, destination) {
  const entries = parseZipEntries(zip);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const target = path.resolve(destination, ...entry.name.split('/'));
    const root = path.resolve(destination) + path.sep;
    if (target !== path.resolve(destination) && !target.startsWith(root)) {
      throw new Error('Archive entry escapes extraction directory');
    }
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      continue;
    }

    const local = entry.localOffset;
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== ZIP_LOCAL) {
      throw new Error('Invalid ZIP local entry');
    }
    const localNameLength = zip.readUInt16LE(local + 26);
    const localExtraLength = zip.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > zip.length) throw new Error('ZIP entry data exceeds archive');
    const compressed = zip.subarray(dataStart, dataEnd);
    let contents;
    if (entry.compression === 0) {
      contents = Buffer.from(compressed);
    } else if (entry.compression === 8) {
      try {
        contents = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
      } catch {
        throw new Error('Unable to decompress extension archive');
      }
    } else {
      throw new Error(`Unsupported ZIP compression method: ${entry.compression}`);
    }
    if (contents.length !== entry.uncompressedSize || crc32(contents) !== entry.crc) {
      throw new Error('Extension archive checksum validation failed');
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, contents, { mode: 0o600 });
  }
  return entries;
}

function findExtensionRoot(extractedPath) {
  const manifestPath = path.join(extractedPath, 'manifest.json');
  if (fs.existsSync(manifestPath)) return extractedPath;
  const children = fs.readdirSync(extractedPath, { withFileTypes: true })
    .filter((child) => child.isDirectory());
  if (children.length === 1 && fs.existsSync(path.join(extractedPath, children[0].name, 'manifest.json'))) {
    return path.join(extractedPath, children[0].name);
  }
  throw new Error('Extension manifest.json must be at the archive root');
}

function readManifest(extensionPath) {
  const manifestPath = path.join(extensionPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('manifest.json missing');
  const stat = fs.statSync(manifestPath);
  if (stat.size > MAX_MANIFEST_BYTES) throw new Error('manifest.json is too large');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error('Invalid manifest.json');
  }
  validateManifest(manifest);
  return manifest;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid extension manifest');
  if (manifest.manifest_version !== 2 && manifest.manifest_version !== 3) {
    throw new Error('Only manifest versions 2 and 3 are supported');
  }
  if (typeof manifest.name !== 'string' || manifest.name.trim() === '') throw new Error('Extension name is missing');
  if (typeof manifest.version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(manifest.version)) {
    throw new Error('Extension version is invalid');
  }
  for (const field of ['permissions', 'host_permissions', 'optional_permissions']) {
    if (manifest[field] !== undefined && (!Array.isArray(manifest[field]) || manifest[field].some((permission) => typeof permission !== 'string'))) {
      throw new Error(`Extension ${field} is invalid`);
    }
  }
  if (manifest.content_scripts !== undefined && (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.some((script) => !script || typeof script !== 'object'))) {
    throw new Error('Extension content_scripts is invalid');
  }
  return manifest;
}

function extractCrx(input, destination) {
  const buffer = toBuffer(input);
  const zip = readCrxZip(buffer);
  const publicKey = getCrxPublicKey(buffer);
  extractZip(zip, destination);
  const extensionPath = findExtensionRoot(destination);
  let manifest = readManifest(extensionPath);
  if (publicKey && !manifest.key) {
    // Persist the signing key so Electron derives the same extension id that
    // Chrome does; this is required for OAuth redirect URIs to match.
    manifest = { ...manifest, key: publicKey.toString('base64') };
    fs.writeFileSync(path.join(extensionPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  }
  return { extensionPath, manifest };
}

/**
 * Returns the DER-encoded public key embedded in a CRX header, or null when
 * the archive is a bare ZIP without one. CRX2 stores it inline; CRX3 wraps it
 * in a protobuf `CrxFileHeader`.
 * @param {Buffer} buffer
 * @returns {Buffer|null}
 */
function getCrxPublicKey(buffer) {
  if (buffer.length < 12 || buffer.readUInt32LE(0) !== CRX_MAGIC) return null;
  const version = buffer.readUInt32LE(4);
  if (version === 2) {
    const publicKeyLength = buffer.readUInt32LE(8);
    const offset = 16;
    if (offset + publicKeyLength > buffer.length) return null;
    return buffer.subarray(offset, offset + publicKeyLength);
  }
  if (version === 3) {
    const headerSize = buffer.readUInt32LE(8);
    const headerOffset = 12;
    const headerEnd = headerOffset + headerSize;
    if (headerEnd > buffer.length) return null;
    return parseCrx3PublicKey(buffer.subarray(headerOffset, headerEnd));
  }
  return null;
}

function parseCrx3PublicKey(header) {
  let offset = 0;
  while (offset < header.length) {
    const tag = readVarint(header, offset);
    offset = tag.offset;
    const fieldNumber = tag.value >>> 3;
    const wireType = tag.value & 0x7;
    if (wireType === 2) {
      const length = readVarint(header, offset);
      offset = length.offset;
      const end = offset + length.value;
      if (end > header.length) break;
      if (fieldNumber === 2) {
        // sha256_with_rsa proof message.
        return parseProofPublicKey(header.subarray(offset, end));
      }
      offset = end;
    } else if (wireType === 0) {
      offset = readVarint(header, offset).offset;
    } else if (wireType === 5) {
      offset += 4;
    } else if (wireType === 1) {
      offset += 8;
    } else {
      break;
    }
  }
  return null;
}

function parseProofPublicKey(proof) {
  let offset = 0;
  while (offset < proof.length) {
    const tag = readVarint(proof, offset);
    offset = tag.offset;
    const fieldNumber = tag.value >>> 3;
    const wireType = tag.value & 0x7;
    if (wireType === 2) {
      const length = readVarint(proof, offset);
      offset = length.offset;
      const end = offset + length.value;
      if (end > proof.length) break;
      if (fieldNumber === 1) return proof.subarray(offset, end);
      offset = end;
    } else if (wireType === 0) {
      offset = readVarint(proof, offset).offset;
    } else {
      break;
    }
  }
  return null;
}

function readVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  let index = offset;
  while (index < buffer.length) {
    const byte = buffer[index];
    index += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, offset: index };
}

/**
 * Derives the canonical Chromium extension id from a DER public key:
 * SHA-256 the key and map the first 16 bytes' nibbles to 'a'..'p'.
 * @param {Buffer} publicKey
 * @returns {string}
 */
function deriveExtensionId(publicKey) {
  const digest = crypto.createHash('sha256').update(publicKey).digest();
  let id = '';
  for (let i = 0; i < 16; i += 1) {
    id += String.fromCharCode(0x61 + (digest[i] >>> 4));
    id += String.fromCharCode(0x61 + (digest[i] & 0x0f));
  }
  return id;
}

// Small table-based CRC-32 implementation keeps archive verification dependency-free.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  MAX_UNCOMPRESSED_BYTES,
  deriveExtensionId,
  extractCrx,
  getCrxPublicKey,
  getZipOffset,
  parseZipEntries,
  readCrxZip,
  readManifest,
  safeArchiveName,
  validateManifest,
};
