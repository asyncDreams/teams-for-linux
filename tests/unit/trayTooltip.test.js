'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const ApplicationTray = require('../../app/menus/tray');

const { buildTrayTooltip } = ApplicationTray;

describe('buildTrayTooltip', () => {
  it('renders the app title alone with no counts or presence', () => {
    assert.equal(buildTrayTooltip('Teams for Linux', 0, 0), 'Teams for Linux');
  });

  it('appends the Teams badge count when present', () => {
    assert.equal(buildTrayTooltip('Teams for Linux', 3, 0), 'Teams for Linux (3)');
  });

  it('appends the local history unread count', () => {
    assert.equal(buildTrayTooltip('Teams for Linux', 0, 5), 'Teams for Linux · 5 unread');
  });

  it('combines badge count, history unread, and presence source', () => {
    const tip = buildTrayTooltip('Teams for Linux', 2, 4, 2, 'Meeting');
    assert.equal(tip, 'Teams for Linux (2) · 4 unread — Busy · Source: Meeting');
  });

  it('omits the presence source when unknown or empty', () => {
    assert.equal(buildTrayTooltip('Teams for Linux', 0, 0, 2), 'Teams for Linux — Busy');
  });

  it('treats non-numeric counts as zero', () => {
    assert.equal(buildTrayTooltip('Teams for Linux', null, 'nope'), 'Teams for Linux');
  });
});
