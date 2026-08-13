'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildShimSource,
  isAuthorizedRedirect,
  isValidAuthUrl,
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
  it('accepts the default chromiumapp.org host and subdomains', () => {
    assert.equal(isAuthorizedRedirect('https://abcd.chromiumapp.org/callback', ['chromiumapp.org'], 'abcd'), true);
  });

  it('accepts the calling extension chrome-extension origin', () => {
    assert.equal(isAuthorizedRedirect('chrome-extension://abcd/callback', ['chromiumapp.org'], 'abcd'), true);
  });

  it('rejects an unknown host and a different extension origin', () => {
    assert.equal(isAuthorizedRedirect('https://evil.example.com/callback', ['chromiumapp.org'], 'abcd'), false);
    assert.equal(isAuthorizedRedirect('chrome-extension://dcba/callback', ['chromiumapp.org'], 'abcd'), false);
    assert.equal(isAuthorizedRedirect('not a url', ['chromiumapp.org'], 'abcd'), false);
  });
});

describe('buildShimSource', () => {
  it('installs both launchWebAuthFlow and tabs.create', () => {
    const source = buildShimSource();
    assert.equal(typeof source, 'string');
    assert.match(source, /launchWebAuthFlow/);
    assert.match(source, /tabsCreate/);
    assert.match(source, /chrome\.identity/);
    assert.match(source, /chrome\.tabs/);
  });
});
