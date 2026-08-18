'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  KEEP_ONLINE_MODES,
  normalizeMode,
  normalizeBusinessHours,
  isWithinBusinessHours,
  shouldKeepOnline,
  shouldInjectKeepAlive,
} = require('../../app/presence/smartPresence');

const dateInUtc = (value) => new Date(`${value}Z`);

describe('smart presence mode normalization', () => {
  it('defaults to disabled and preserves the legacy boolean', () => {
    assert.equal(normalizeMode(undefined, false), KEEP_ONLINE_MODES.DISABLED);
    assert.equal(normalizeMode(undefined, true), KEEP_ONLINE_MODES.ALWAYS);
    assert.equal(normalizeMode('always'), KEEP_ONLINE_MODES.ALWAYS);
    assert.equal(normalizeMode('business-hours'), KEEP_ONLINE_MODES.BUSINESS_HOURS);
    assert.equal(normalizeMode('invalid'), KEEP_ONLINE_MODES.DISABLED);
  });

  it('normalizes invalid schedule fields without throwing', () => {
    assert.deepEqual(normalizeBusinessHours({
      enabled: true,
      startTime: 'bad',
      endTime: '26:99',
      weekdays: [1, 1, 8, '5'],
      timezone: 'Not/AZone',
    }), {
      enabled: true,
      startTime: '09:00',
      endTime: '17:00',
      weekdays: [1, 5],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });
});

describe('business-hours schedule', () => {
  const settings = {
    enabled: true,
    startTime: '09:00',
    endTime: '17:00',
    weekdays: [1, 2, 3, 4, 5],
    timezone: 'UTC',
  };

  it('handles weekday boundaries in the configured timezone', () => {
    assert.equal(isWithinBusinessHours(dateInUtc('2026-08-10T08:59:00'), settings), false);
    assert.equal(isWithinBusinessHours(dateInUtc('2026-08-10T09:00:00'), settings), true);
    assert.equal(isWithinBusinessHours(dateInUtc('2026-08-10T16:59:00'), settings), true);
    assert.equal(isWithinBusinessHours(dateInUtc('2026-08-10T17:00:00'), settings), false);
    assert.equal(isWithinBusinessHours(dateInUtc('2026-08-09T12:00:00'), settings), false);
  });

  it('supports overnight windows without leaking into an unscheduled day', () => {
    const overnight = { ...settings, startTime: '22:00', endTime: '06:00' };
    assert.equal(isWithinBusinessHours(dateInUtc('2026-08-10T21:59:00'), overnight), false);
    assert.equal(isWithinBusinessHours(dateInUtc('2026-08-10T22:00:00'), overnight), true);
    assert.equal(isWithinBusinessHours(dateInUtc('2026-08-11T05:59:00'), overnight), true);
    assert.equal(isWithinBusinessHours(dateInUtc('2026-08-11T06:00:00'), overnight), false);
    assert.equal(isWithinBusinessHours(dateInUtc('2026-08-08T23:00:00'), overnight), false);
  });

  it('applies the configured timezone rather than the host timezone', () => {
    const eastern = { ...settings, timezone: 'America/New_York' };
    assert.equal(isWithinBusinessHours(new Date('2026-08-10T13:00:00Z'), eastern), true);
    assert.equal(isWithinBusinessHours(new Date('2026-08-10T22:00:00Z'), eastern), false);
  });

  it('requires the business-hours feature flag', () => {
    assert.equal(isWithinBusinessHours(dateInUtc('2026-08-10T10:00:00'), { ...settings, enabled: false }), false);
  });
});

describe('keep-online decisions', () => {
  const businessHours = {
    enabled: true,
    startTime: '09:00',
    endTime: '17:00',
    weekdays: [1, 2, 3, 4, 5],
    timezone: 'UTC',
  };

  it('supports disabled, always, business-hours, and legacy modes', () => {
    const now = dateInUtc('2026-08-10T10:00:00');
    assert.equal(shouldKeepOnline({ presence: { keepAlwaysOnlineMode: 'disabled' } }, now), false);
    assert.equal(shouldKeepOnline({ presence: { keepAlwaysOnlineMode: 'always' } }, now), true);
    assert.equal(shouldKeepOnline({ presence: { keepAlwaysOnlineMode: 'business-hours', businessHours } }, now), true);
    assert.equal(shouldKeepOnline({ presence: { keepAlwaysOnlineMode: 'business-hours', businessHours } }, dateInUtc('2026-08-10T19:00:00')), false);
    assert.equal(shouldKeepOnline({ presence: { keepAlwaysOnline: true } }, now), true);
  });

  it('lets normal mode nudge but smart mode yields to meeting and explicit status', () => {
    const now = dateInUtc('2026-08-10T10:00:00');
    const normal = { presence: { keepAlwaysOnlineMode: 'always', smartPresence: false } };
    const smart = { presence: { keepAlwaysOnlineMode: 'always', smartPresence: true } };
    assert.equal(shouldInjectKeepAlive(normal, { inMeeting: true }, now), true);
    assert.equal(shouldInjectKeepAlive(smart, { inMeeting: true }, now), false);
    assert.equal(shouldInjectKeepAlive(smart, { presenting: true }, now), false);
    assert.equal(shouldInjectKeepAlive(smart, { currentStatus: 2 }, now), false);
    assert.equal(shouldInjectKeepAlive(smart, { explicitStatus: 'dnd' }, now), false);
    assert.equal(shouldInjectKeepAlive(smart, {}, now), true);
  });
});
