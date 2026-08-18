'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const read = (relativePath) => fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');

function readPngAlpha(relativePath) {
  const data = fs.readFileSync(path.join(__dirname, '..', '..', relativePath));
  let offset = 8;
  let width;
  let height;
  let colorType;
  const compressed = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString('ascii');
    const body = data.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colorType = body[9];
    } else if (type === 'IDAT') {
      compressed.push(body);
    }
  }
  assert.equal(colorType, 6, `${relativePath} must preserve an alpha channel`);
  const rows = zlib.inflateSync(Buffer.concat(compressed));
  const stride = width * 4;
  let transparent = 0;
  for (let y = 0; y < height; y += 1) {
    assert.equal(rows[y * (stride + 1)], 0, `${relativePath} must use the generated RGBA row format`);
    for (let x = 0; x < width; x += 1) {
      if (rows[y * (stride + 1) + 1 + x * 4 + 3] === 0) transparent += 1;
    }
  }
  return { width, height, transparent };
}

describe('Fluent app-owned surfaces', () => {
  it('defines shared tokens and reduced-motion behavior', () => {
    const css = read('app/assets/css/fluent-parity.css');
    assert.match(css, /--tfl-accent/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /focus-visible/);
  });

  it('uses the shared styling on app-owned windows', () => {
    for (const page of [
      'app/extensions/manager.html',
      'app/notifications/history.html',
      'app/diagnostics/diagnostics.html',
      'app/notificationSystem/notificationToast.html',
    ]) {
      assert.match(read(page), /fluent-parity\.css/);
    }
  });

  it('keeps the collaborative mark transparent and distinct', () => {
    const svg = read('app/assets/icons/tfl-collab.svg');
    assert.match(svg, /viewBox="0 0 256 256"/);
    assert.match(svg, /<path/);
    assert.doesNotMatch(svg, /<rect[^>]+fill=/i);
    assert.match(svg, /conversation circles|collaborative/i);
  });

  it('ships transparent raster assets instead of a solid blue square', () => {
    const appIcon = readPngAlpha('app/assets/icons/icon-256x256.png');
    const buildIcon = readPngAlpha('build/icons/256x256.png');
    assert.deepEqual(buildIcon, appIcon);
    assert.equal(appIcon.width, 256);
    assert.equal(appIcon.height, 256);
    assert.ok(appIcon.transparent > appIcon.width * appIcon.height * 0.4);
  });
});
