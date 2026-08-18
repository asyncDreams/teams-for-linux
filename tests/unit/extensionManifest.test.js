'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  extensionPageUrl,
  getOptionsPage,
  getPopupPath,
} = require('../../app/extensions/manifest');
const {
  deriveExtensionId,
  getCrxPublicKey,
} = require('../../app/extensions/crx');

const EXTENSION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('extension manifest page extraction', () => {
  it('reads an MV3 action popup and options_ui page', () => {
    const manifest = {
      manifest_version: 3,
      action: { default_popup: 'popup.html', default_title: 'Otter' },
      options_ui: { page: 'options.html', open_in_tab: true },
    };
    assert.equal(getPopupPath(manifest), 'popup.html');
    assert.deepEqual(getOptionsPage(manifest), { path: 'options.html', openInTab: true });
  });

  it('reads an MV2 browser_action popup and legacy options_page', () => {
    const manifest = {
      manifest_version: 2,
      browser_action: { default_popup: 'popup.html' },
      options_page: 'options.html',
    };
    assert.equal(getPopupPath(manifest), 'popup.html');
    assert.deepEqual(getOptionsPage(manifest), { path: 'options.html', openInTab: false });
  });

  it('returns null when no popup or options page is declared', () => {
    assert.equal(getPopupPath({ manifest_version: 3, name: 'x' }), null);
    assert.equal(getOptionsPage({ manifest_version: 3 }), null);
    assert.equal(getPopupPath(null), null);
  });
});

describe('extension page URL safety', () => {
  it('builds chrome-extension URLs for safe relative paths', () => {
    assert.equal(extensionPageUrl(EXTENSION_ID, 'popup.html'), `chrome-extension://${EXTENSION_ID}/popup.html`);
    assert.equal(extensionPageUrl(EXTENSION_ID, 'nested/options.html'), `chrome-extension://${EXTENSION_ID}/nested/options.html`);
  });

  it('rejects traversal, absolute, and scheme-injection inputs', () => {
    assert.equal(extensionPageUrl(EXTENSION_ID, '../secret.html'), null);
    assert.equal(extensionPageUrl(EXTENSION_ID, '..\\secret.html'), null);
    assert.equal(extensionPageUrl(EXTENSION_ID, '/absolute.html'), null);
    assert.equal(extensionPageUrl(EXTENSION_ID, 'https://evil.example'), null);
    assert.equal(extensionPageUrl(EXTENSION_ID, 'popup.html//x'), null);
    assert.equal(extensionPageUrl(EXTENSION_ID, ''), null);
    assert.equal(extensionPageUrl('not-an-id', 'popup.html'), null);
  });
});

describe('CRX public key and extension id derivation', () => {
  function buildCrx3(publicKey) {
    const proof = Buffer.concat([Buffer.from([0x0a, publicKey.length]), publicKey]);
    const header = Buffer.concat([Buffer.from([0x12, proof.length]), proof]);
    const prefix = Buffer.alloc(12);
    prefix.writeUInt32LE(0x34327243, 0);
    prefix.writeUInt32LE(3, 4);
    prefix.writeUInt32LE(header.length, 8);
    return Buffer.concat([prefix, header, Buffer.from([0x50, 0x4b, 0x03, 0x04])]);
  }

  it('derives a stable 32-character id from a DER public key', () => {
    const key = Buffer.from('synthetic-der-public-key-bytes');
    const id = deriveExtensionId(key);
    assert.match(id, /^[a-p]{32}$/);
    assert.equal(id, deriveExtensionId(key));
    assert.notEqual(id, deriveExtensionId(Buffer.from('another-key')));
  });

  it('extracts the public key from a CRX3 protobuf header', () => {
    const key = Buffer.from('der-public-key');
    const publicKey = getCrxPublicKey(buildCrx3(key));
    assert.ok(publicKey);
    assert.equal(publicKey.toString(), key.toString());
    assert.match(deriveExtensionId(publicKey), /^[a-p]{32}$/);
  });

  it('returns null for a bare ZIP without a CRX header', () => {
    assert.equal(getCrxPublicKey(Buffer.from([0x50, 0x4b, 0x03, 0x04])), null);
  });
});

describe('extension manager UI', () => {
  it('wires popup and options actions', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../app/extensions/manager.html'), 'utf8');
    assert.match(html, /openPopup/);
    assert.match(html, /openOptions/);
    assert.match(html, /item\.popupPath/);
    assert.match(html, /item\.optionsPath/);
  });
});
