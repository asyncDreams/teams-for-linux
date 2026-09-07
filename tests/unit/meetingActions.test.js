'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  RESPONSE_VALUES,
  parseRespondPayload,
  buildRespondRequest,
  applyResponseStatus,
  isEventRespondable,
} = require('../../app/graphApi/meetingActions');
const { registerCalendarPanelHandlers, RESPONSE_STATUS } = require('../../app/graphApi/calendarDeltaSync');

const NOW = Date.parse('2026-09-07T10:00:00Z');

function event(overrides = {}) {
  return {
    id: 'evt-1',
    subject: 'Standup',
    isCancelled: false,
    start: { dateTime: new Date(NOW - 5 * 60000).toISOString() },
    end: { dateTime: new Date(NOW + 25 * 60000).toISOString() },
    isOrganizer: false,
    responseStatus: 'notResponded',
    ...overrides,
  };
}

function makeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: (channel, fn) => handlers.set(channel, fn),
  };
}

describe('parseRespondPayload', () => {
  it('accepts a valid payload and defaults sendResponse to true', () => {
    assert.deepEqual(parseRespondPayload({ eventId: 'abc', response: 'Accepted' }), {
      ok: true,
      eventId: 'abc',
      response: 'accepted',
      sendResponse: true,
    });
  });

  it('honors sendResponse: false', () => {
    const parsed = parseRespondPayload({ eventId: 'abc', response: 'declined', sendResponse: false });
    assert.equal(parsed.sendResponse, false);
  });

  it('rejects missing or empty event ids', () => {
    assert.equal(parseRespondPayload({ response: 'accepted' }).ok, false);
    assert.equal(parseRespondPayload({ eventId: '   ', response: 'accepted' }).ok, false);
    assert.equal(parseRespondPayload(null).ok, false);
  });

  it('rejects unknown response values', () => {
    assert.equal(parseRespondPayload({ eventId: 'a', response: 'maybe' }).ok, false);
    assert.equal(parseRespondPayload({ eventId: 'a', response: 42 }).ok, false);
  });

  it('exposes the valid response values', () => {
    assert.deepEqual([...RESPONSE_VALUES], ['accepted', 'tentative', 'declined']);
  });
});

describe('buildRespondRequest', () => {
  it('maps each response to the correct Graph endpoint', () => {
    assert.equal(buildRespondRequest('e1', 'accepted', true).endpoint, '/me/events/e1/accept');
    assert.equal(buildRespondRequest('e1', 'tentative', true).endpoint, '/me/events/e1/tentativelyAccept');
    assert.equal(buildRespondRequest('e1', 'declined', false).endpoint, '/me/events/e1/decline');
  });

  it('url-encodes the event id and carries sendResponse in the body', () => {
    const { endpoint, options } = buildRespondRequest('id/with spaces', 'tentative', false);
    assert.ok(endpoint.includes(encodeURIComponent('id/with spaces')));
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.body, { sendResponse: false });
  });

  it('exposes the responseStatus mapping', () => {
    assert.equal(RESPONSE_STATUS.accepted, 'accepted');
    assert.equal(RESPONSE_STATUS.tentative, 'tentativelyAccepted');
    assert.equal(RESPONSE_STATUS.declined, 'declined');
  });
});

describe('applyResponseStatus', () => {
  it('returns a shallow clone with the new status, not mutating the input', () => {
    const original = event();
    const patched = applyResponseStatus(original, 'tentative');
    assert.equal(patched.responseStatus, 'tentativelyAccepted');
    assert.equal(original.responseStatus, 'notResponded');
    assert.notEqual(patched, original);
  });

  it('returns null for a missing event', () => {
    assert.equal(applyResponseStatus(null, 'accepted'), null);
  });
});

describe('isEventRespondable', () => {
  it('accepts a future invitation', () => {
    assert.equal(isEventRespondable(event(), NOW), true);
  });

  it('rejects past, cancelled, and organizer events', () => {
    const past = event({ end: { dateTime: new Date(NOW - 60000).toISOString() } });
    const cancelled = event({ isCancelled: true });
    const organizer = event({ isOrganizer: true });
    assert.equal(isEventRespondable(past, NOW), false);
    assert.equal(isEventRespondable(cancelled, NOW), false);
    assert.equal(isEventRespondable(organizer, NOW), false);
  });

  it('rejects organizer-flagged events that only carry the legacy responseStatus', () => {
    const legacy = event({ isOrganizer: undefined, responseStatus: 'organizer' });
    assert.equal(isEventRespondable(legacy, NOW), false);
  });

  it('rejects missing events and unparseable end times', () => {
    assert.equal(isEventRespondable(null, NOW), false);
    assert.equal(isEventRespondable(event({ end: { dateTime: 'nope' } }), NOW), false);
  });
});

describe('calendar-panel-respond IPC handler', () => {
  function makeClient(responses) {
    const calls = [];
    return {
      calls,
      makeRequest: async (endpoint, options) => {
        calls.push({ endpoint, options });
        const next = responses.shift();
        if (typeof next === 'function') return next(endpoint, options);
        return next ?? { success: true, data: { value: [] } };
      },
    };
  }

  function makeSync() {
    const sync = {
      getEventById: (id) => (id === 'evt-1' ? event() : null),
      patchEvent: (id, patch) => ({ ...event(), ...patch }),
      sync: async () => 1,
    };
    return sync;
  }

  it('responds and returns the optimistically patched event', async () => {
    const ipcMain = makeIpcMain();
    const client = makeClient([{ success: true }]);
    const deltaSync = makeSync();
    registerCalendarPanelHandlers(ipcMain, { client, config: {}, deltaSync, nowMs: () => NOW });

    const respond = ipcMain.handlers.get('calendar-panel-respond');
    const result = await respond(null, { eventId: 'evt-1', response: 'tentative' });

    assert.equal(result.success, true);
    assert.equal(result.response, 'tentative');
    assert.equal(result.event.responseStatus, 'tentativelyAccepted');
    assert.equal(client.calls.length, 1);
    assert.ok(client.calls[0].endpoint.startsWith('/me/events/evt-1/tentativelyAccept'));
    assert.deepEqual(client.calls[0].options.body, { sendResponse: true });
  });

  it('rejects unknown events without calling Graph', async () => {
    const ipcMain = makeIpcMain();
    const client = makeClient();
    registerCalendarPanelHandlers(ipcMain, { client, config: {}, deltaSync: makeSync(), nowMs: () => NOW });

    const respond = ipcMain.handlers.get('calendar-panel-respond');
    const result = await respond(null, { eventId: 'unknown', response: 'accepted' });

    assert.equal(result.success, false);
    assert.match(result.error, /not found/i);
    assert.equal(client.calls.length, 0);
  });

  it('rejects non-respondable events without calling Graph', async () => {
    const ipcMain = makeIpcMain();
    const client = makeClient();
    const deltaSync = makeSync();
    deltaSync.getEventById = () => event({ isOrganizer: true });
    registerCalendarPanelHandlers(ipcMain, { client, config: {}, deltaSync, nowMs: () => NOW });

    const respond = ipcMain.handlers.get('calendar-panel-respond');
    const result = await respond(null, { eventId: 'evt-1', response: 'declined' });

    assert.equal(result.success, false);
    assert.match(result.error, /cannot be responded/i);
    assert.equal(client.calls.length, 0);
  });

  it('validates the payload before touching the client', async () => {
    const ipcMain = makeIpcMain();
    const client = makeClient();
    registerCalendarPanelHandlers(ipcMain, { client, config: {}, deltaSync: makeSync(), nowMs: () => NOW });

    const respond = ipcMain.handlers.get('calendar-panel-respond');
    const bad = await respond(null, { eventId: 'evt-1', response: 'maybe' });
    assert.equal(bad.success, false);
    const missing = await respond(null, { response: 'accepted' });
    assert.equal(missing.success, false);
    assert.equal(client.calls.length, 0);
  });

  it('propagates Graph failures (e.g. consent 403) without patching', async () => {
    const ipcMain = makeIpcMain();
    const client = makeClient([{ success: false, status: 403 }]);
    let patched = null;
    const deltaSync = makeSync();
    deltaSync.patchEvent = (id, patch) => { patched = patch; return event(patch); };
    registerCalendarPanelHandlers(ipcMain, { client, config: {}, deltaSync, nowMs: () => NOW });

    const respond = ipcMain.handlers.get('calendar-panel-respond');
    const result = await respond(null, { eventId: 'evt-1', response: 'accepted' });

    assert.equal(result.success, false);
    assert.equal(result.status, 403);
    assert.equal(patched, null);
  });

  it('works without a delta sync by calling Graph directly', async () => {
    const ipcMain = makeIpcMain();
    const client = makeClient([{ success: true }]);
    registerCalendarPanelHandlers(ipcMain, { client, config: {}, deltaSync: null, nowMs: () => NOW });

    const respond = ipcMain.handlers.get('calendar-panel-respond');
    const result = await respond(null, { eventId: 'evt-9', response: 'declined' });

    assert.equal(result.success, true);
    assert.equal(client.calls[0].endpoint, '/me/events/evt-9/decline');
  });
});
