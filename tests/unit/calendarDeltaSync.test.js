'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  CalendarDeltaSync,
  selectEvents,
  applyDeltaPage,
  pruneStaleEvents,
  registerCalendarPanelHandlers,
} = require('../../app/graphApi/calendarDeltaSync');

const NOW = Date.parse('2026-09-04T10:00:00Z');

function event({ id = 'evt-1', startMin, endMin, subject = 'Standup', isCancelled = false }) {
  return {
    id,
    subject,
    isCancelled,
    start: { dateTime: new Date(NOW + startMin * 60000).toISOString() },
    end: { dateTime: new Date(NOW + endMin * 60000).toISOString() },
  };
}

function makeClient(responses) {
  const calls = [];
  return {
    calls,
    makeRequest: async (endpoint) => {
      calls.push(endpoint);
      const next = responses.shift();
      if (typeof next === 'function') return next(endpoint);
      return next ?? { success: true, data: { value: [] } };
    },
  };
}

function makeSync(client, config = {}) {
  return new CalendarDeltaSync({
    client,
    config: { graphApi: { enabled: true, calendar: { enabled: true, ...config } } },
    nowMs: () => NOW,
  });
}

describe('pruneStaleEvents', () => {
  it('keeps events ending after the cutoff and drops older ones', () => {
    const fresh = event({ id: 'a', startMin: 0, endMin: 30 });
    const stale = event({ id: 'b', startMin: -48 * 60, endMin: -47 * 60 });
    const result = pruneStaleEvents([fresh, stale], NOW);
    assert.deepEqual(result.map((e) => e.id), ['a']);
  });

  it('drops events with unparseable end times', () => {
    const broken = { id: 'x', end: { dateTime: 'not-a-date' } };
    assert.deepEqual(pruneStaleEvents([broken], NOW), []);
  });
});

describe('selectEvents', () => {
  it('returns events overlapping the window, sorted by start', () => {
    const later = event({ id: 'b', startMin: 120, endMin: 150 });
    const earlier = event({ id: 'a', startMin: -15, endMin: 15 });
    const result = selectEvents([later, earlier], NOW - 60 * 60000, NOW + 240 * 60000);
    assert.deepEqual(result.map((e) => e.id), ['a', 'b']);
  });

  it('excludes cancelled and non-overlapping events', () => {
    const cancelled = event({ id: 'c', startMin: 0, endMin: 30, isCancelled: true });
    const outside = event({ id: 'o', startMin: 300, endMin: 330 });
    const inside = event({ id: 'i', startMin: 10, endMin: 40 });
    const result = selectEvents([cancelled, outside, inside], NOW, NOW + 60 * 60000);
    assert.deepEqual(result.map((e) => e.id), ['i']);
  });
});

describe('applyDeltaPage', () => {
  it('upserts events by id and applies @removed', () => {
    const acc = new Map();
    applyDeltaPage(acc, {
      value: [event({ id: 'a', startMin: 0, endMin: 10 }), event({ id: 'gone', startMin: 30, endMin: 40 })],
    });
    applyDeltaPage(acc, {
      value: [event({ id: 'a', startMin: 0, endMin: 20, subject: 'Updated' })],
      '@removed': [{ id: 'gone' }],
    });
    assert.equal(acc.size, 1);
    assert.equal(acc.get('a').subject, 'Updated');
  });

  it('tolerates malformed pages', () => {
    const acc = new Map();
    applyDeltaPage(acc, null);
    applyDeltaPage(acc, {});
    applyDeltaPage(acc, { value: 'not-an-array' });
    assert.equal(acc.size, 0);
  });
});

describe('CalendarDeltaSync', () => {
  it('performs an initial delta fetch and caches events', async () => {
    const client = makeClient([
      { success: true, data: { value: [event({ id: 'a', startMin: 5, endMin: 35 })], '@odata.deltaLink': 'https://graph/deltaLink=1' } },
    ]);
    const sync = makeSync(client);
    const size = await sync.sync();
    assert.equal(size, 1);
    assert.equal(sync.size, 1);
    assert.ok(client.calls[0].startsWith('/me/calendarView/delta?'));
    const events = sync.getEvents(NOW, NOW + 60 * 60000);
    assert.deepEqual(events.map((e) => e.id), ['a']);
  });

  it('uses the stored delta link on subsequent syncs', async () => {
    const client = makeClient([
      { success: true, data: { value: [], '@odata.deltaLink': 'https://graph/delta?token=1' } },
      { success: true, data: { value: [event({ id: 'b', startMin: 60, endMin: 90 })] } },
    ]);
    const sync = makeSync(client);
    await sync.sync();
    await sync.sync();
    assert.equal(client.calls[1], 'https://graph/delta?token=1');
    assert.equal(sync.size, 1);
  });

  it('drops the delta link on 410 so the next sync re-baselines', async () => {
    const client = makeClient([
      { success: true, data: { value: [], '@odata.deltaLink': 'https://graph/delta?token=stale' } },
      { success: false, status: 410, error: 'expired' },
      { success: true, data: { value: [event({ id: 'c', startMin: 0, endMin: 15 })] } },
    ]);
    const sync = makeSync(client);
    await sync.sync();
    await sync.sync(); // 410 — link dropped
    await sync.sync(); // full fetch again
    assert.ok(client.calls[2].startsWith('/me/calendarView/delta?'));
    assert.equal(sync.size, 1);
  });

  it('continues from @odata.nextLink on the next pass', async () => {
    const client = makeClient([
      { success: true, data: { value: [event({ id: 'p1', startMin: 0, endMin: 10 })], '@odata.nextLink': 'https://graph/delta?page=2' } },
      { success: true, data: { value: [event({ id: 'p2', startMin: 20, endMin: 30 })], '@odata.deltaLink': 'https://graph/delta?done' } },
    ]);
    const sync = makeSync(client);
    await sync.sync();
    assert.equal(sync.size, 1);
    await sync.sync();
    assert.equal(sync.size, 2);
  });

  it('is a no-op when disabled', async () => {
    const client = makeClient([]);
    const sync = new CalendarDeltaSync({
      client,
      config: { graphApi: { enabled: false } },
      nowMs: () => NOW,
    });
    assert.equal(await sync.sync(), 0);
    assert.equal(client.calls.length, 0);
    sync.start();
    sync.stop();
    assert.equal(client.calls.length, 0);
  });

  it('start/stop manage the interval without firing during tests', () => {
    const client = makeClient([]);
    const sync = makeSync(client, { syncIntervalMs: 60000 });
    sync.start();
    sync.start(); // idempotent
    sync.stop();
    assert.equal(client.calls.length, 0);
  });
});

describe('registerCalendarPanelHandlers', () => {
  // The panel handlers window events around the real clock, so fixtures in
  // this section are relative to Date.now() rather than the NOW constant.
  const REAL_NOW = Date.now();
  function realEvent({ id = 'evt-1', startMin, endMin, subject = 'Standup' }) {
    return {
      id,
      subject,
      start: { dateTime: new Date(REAL_NOW + startMin * 60000).toISOString() },
      end: { dateTime: new Date(REAL_NOW + endMin * 60000).toISOString() },
    };
  }
  function makeIpcMain() {
    const handlers = new Map();
    return {
      handlers,
      handle: (channel, fn) => handlers.set(channel, fn),
    };
  }
  function makeFakeGraphClient(responses) {
    const calls = [];
    return {
      calls,
      makeRequest: async (endpoint) => {
        calls.push(endpoint);
        const next = responses.shift();
        return next ?? { success: true, data: { value: [] } };
      },
      getCalendarView: async (startDateTime, endDateTime, options) => {
        const params = new URLSearchParams({ startDateTime, endDateTime });
        for (const [key, value] of Object.entries(options || {})) {
          if (value !== undefined && value !== null) params.append(key, value);
        }
        return makeFakeGraphClient._last = await (async () => {
          const endpoint = `/me/calendar/calendarView?${params.toString()}`;
          calls.push(endpoint);
          const next = responses.shift();
          return next ?? { success: true, data: { value: [] } };
        })();
      },
    };
  }

  it('serves events from the delta sync when present', async () => {
    const ipcMain = makeIpcMain();
    const client = makeClient([
      { success: true, data: { value: [event({ id: 'a', startMin: 5, endMin: 35 })], '@odata.deltaLink': 'https://graph/deltaLink=1' } },
    ]);
    const sync = makeSync(client);
    await sync.sync();
    registerCalendarPanelHandlers(ipcMain, { client, config: {}, deltaSync: sync });

    const get = ipcMain.handlers.get('calendar-panel-get-events');
    const result = await get(null, { startMs: NOW, endMs: NOW + 60 * 60000 });
    assert.equal(result.success, true);
    assert.deepEqual(result.events.map((e) => e.id), ['a']);
  });

  it('refresh triggers a sync and returns the window', async () => {
    const ipcMain = makeIpcMain();
    const client = makeClient([
      { success: true, data: { value: [event({ id: 'a', startMin: 5, endMin: 35 })], '@odata.deltaLink': 'https://graph/deltaLink=1' } },
    ]);
    const sync = makeSync(client);
    registerCalendarPanelHandlers(ipcMain, { client, config: {}, deltaSync: sync, nowMs: () => NOW });

    const refresh = ipcMain.handlers.get('calendar-panel-refresh');
    const result = await refresh();
    assert.equal(result.success, true);
    assert.equal(result.synced, true);
    assert.deepEqual(result.events.map((e) => e.id), ['a']);
  });

  it('falls back to a direct calendarView without a delta sync', async () => {
    const ipcMain = makeIpcMain();
    const client = makeFakeGraphClient([
      { success: true, data: { value: [realEvent({ id: 'a', startMin: 5, endMin: 35 })] } },
    ]);
    registerCalendarPanelHandlers(ipcMain, { client, config: {}, deltaSync: null });

    const get = ipcMain.handlers.get('calendar-panel-get-events');
    const result = await get(null, { startMs: REAL_NOW, endMs: REAL_NOW + 60 * 60000 });
    assert.equal(result.success, true);
    assert.deepEqual(result.events.map((e) => e.id), ['a']);
    assert.ok(client.calls[0].startsWith('/me/calendar/calendarView?'));
  });

  it('returns not-enabled when the client is missing', async () => {
    const ipcMain = makeIpcMain();
    registerCalendarPanelHandlers(ipcMain, { client: null, config: {}, deltaSync: null });
    const get = ipcMain.handlers.get('calendar-panel-get-events');
    const result = await get(null, {});
    assert.equal(result.success, false);
  });
});
