'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relativePath) => fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');

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
      'app/presence/diagnostics.html',
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
});
