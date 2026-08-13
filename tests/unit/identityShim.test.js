'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildShimSource,
  extensionIdFromUrl,
  isAuthorizedRedirect,
  isValidAuthUrl,
  redirectMatches,
} = require('../../app/extensions/identityShim');

describe('isValidAuthUrl', () => {
  it('accepts https URLs', () => {
    assert.equal(isValidAuthUrl('https://login.microsoftonline.com/oauth2/v2.0/authorize'), true);
  });

  it('accepts loopback http for local development', () => {
    assert.equal(isValidAuthUrl('http://localhost:3000/authorize'), true);
    assert.equal(isValidAuthUrl('http://127.0.0.1:3000/authorize'), true);
  });

  it('rejects non-loopback http and non-web schemes', () => {
    assert.equal(isValidAuthUrl('http://evil.example.com/authorize'), false);
    assert.equal(isValidAuthUrl('javascript:alert(1)'), false);
    assert.equal(isValidAuthUrl('file:///etc/passwd'), false);
    assert.equal(isValidAuthUrl(null), false);
    assert.equal(isValidAuthUrl(''), false);
  });
});

describe('isAuthorizedRedirect', () => {
  it('accepts the stock <id>.chromiumapp.org redirect for the calling extension', () => {
    assert.equal(isAuthorizedRedirect('https://abcd.chromiumapp.org/callback', ['chromiumapp.org'], 'abcd'), true);
  });

  it('rejects a chromiumapp.org redirect for a different extension id', () => {
    assert.equal(isAuthorizedRedirect('https://abcd.chromiumapp.org/callback', ['chromiumapp.org'], 'dcba'), false);
  });

  it('accepts the calling extension chrome-extension origin', () => {
    assert.equal(isAuthorizedRedirect('chrome-extension://abcd/callback', ['chromiumapp.org'], 'abcd'), true);
  });

  it('rejects an unknown host and a different extension origin', () => {
    assert.equal(isAuthorizedRedirect('https://evil.example.com/callback', ['chromiumapp.org'], 'abcd'), false);
    assert.equal(isAuthorizedRedirect('chrome-extension://dcba/callback', ['chromiumapp.org'], 'abcd'), false);
    assert.equal(isAuthorizedRedirect('not a url', ['chromiumapp.org'], 'abcd'), false);
  });

  it('accepts a configured allow-listed host and its subdomains', () => {
    assert.equal(isAuthorizedRedirect('https://oauth.otter.ai/cb', ['otter.ai'], null), true);
    assert.equal(isAuthorizedRedirect('https://id.otter.ai/cb', ['otter.ai'], null), true);
  });
});

describe('extensionIdFromUrl', () => {
  it('extracts a valid extension id from a chrome-extension URL', () => {
    assert.equal(extensionIdFromUrl('chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html'), 'abcdefghijklmnopabcdefghijklmnop');
  });

  it('returns null for non-extension or malformed URLs', () => {
    assert.equal(extensionIdFromUrl('https://teams.cloud.microsoft/'), null);
    assert.equal(extensionIdFromUrl('chrome-extension://not-an-id/popup.html'), null);
    assert.equal(extensionIdFromUrl('not a url'), null);
    assert.equal(extensionIdFromUrl(null), null);
  });
});

describe('redirectMatches', () => {
  const redirectUri = 'https://abcd.chromiumapp.org/oauth2';
  it('matches the exact path and tolerates query/fragment', () => {
    assert.equal(redirectMatches(redirectUri, 'https://abcd.chromiumapp.org/oauth2?code=123#frag'), true);
  });
  it('tolerates a trailing slash on the declared redirect', () => {
    assert.equal(redirectMatches(`${redirectUri}/`, 'https://abcd.chromiumapp.org/oauth2'), true);
  });
  it('ignores host case', () => {
    assert.equal(redirectMatches('https://Abcd.ChromiumApp.org/oauth2', 'https://abcd.chromiumapp.org/oauth2'), true);
  });
  it('rejects a different host or a sibling path', () => {
    assert.equal(redirectMatches(redirectUri, 'https://evil.example.com/oauth2'), false);
    assert.equal(redirectMatches(redirectUri, 'https://abcd.chromiumapp.org/other'), false);
  });
  it('matches chrome-extension redirects', () => {
    assert.equal(redirectMatches('chrome-extension://abcd/callback', 'chrome-extension://abcd/callback?code=1'), true);
  });
});

describe('buildShimSource', () => {
  it('installs launchWebAuthFlow, tabs.create, getAuthToken, and runtime instrumentation', () => {
    const source = buildShimSource();
    assert.equal(typeof source, 'string');
    assert.match(source, /launchWebAuthFlow/);
    assert.match(source, /tabsCreate/);
    assert.match(source, /getAuthToken/);
    assert.match(source, /runtime\.sendMessage/);
    assert.match(source, /chrome\.identity/);
    assert.match(source, /chrome\.tabs/);
    assert.match(source, /report/);
  });
});
