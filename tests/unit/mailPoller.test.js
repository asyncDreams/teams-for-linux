'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  MailPoller,
  selectNewMessages,
  formatMailNotification,
  MAX_TRACKED_IDS,
} = require('../../app/graphApi/mailPoller');

const NOW = Date.parse('2026-09-04T10:00:00Z');

function message({ id = 'm1', ageMinutes = 5, subject = 'Hello', from = 'Alice' }) {
  return {
    id,
    subject,
    receivedDateTime: new Date(NOW - ageMinutes * 60000).toISOString(),
    bodyPreview: 'Some preview text',
    webLink: `https://outlook.office.com/mail/inbox/${id}`,
    from: { emailAddress: { name: from, address: `${from.toLowerCase()}@example.com` } },
  };
}

function makeClient(responses) {
  const calls = [];
  return {
    calls,
    getMailMessages: async (options) => {
      calls.push(options);
      const next = responses.shift();
      if (typeof next === 'function') return next(options);
      return next ?? { success: true, data: { value: [] } };
    },
  };
}

function makePoller(client, overrides = {}) {
  const announced = [];
  const notifier = {
    showMailPreview: (payload) => announced.push(payload),
  };
  const poller = new MailPoller({
    client,
    config: { graphApi: { enabled: true, mailPreview: { enabled: true, ...overrides } } },
    notifier,
    nowMs: () => NOW,
  });
  return { poller, announced };
}

describe('selectNewMessages', () => {
  it('announces nothing on first run unless the mail is fresh', () => {
    const fresh = message({ id: 'a', ageMinutes: 1 });
    const old = message({ id: 'b', ageMinutes: 60 });
    const result = selectNewMessages([fresh, old], {
      announcedIds: new Set(),
      newestSeenMs: 0,
      isFirstRun: true,
      nowMs: NOW,
    });
    assert.deepEqual(result.map((m) => m.id), ['a']);
  });

  it('announces mail at or after the newest seen time on later runs', () => {
    const boundary = message({ id: 'edge', ageMinutes: 10 });
    const newer = message({ id: 'new', ageMinutes: 1 });
    const older = message({ id: 'old', ageMinutes: 20 });
    const result = selectNewMessages([newer, boundary, older], {
      announcedIds: new Set(),
      newestSeenMs: Date.parse(boundary.receivedDateTime),
      isFirstRun: false,
      nowMs: NOW,
    });
    assert.deepEqual(result.map((m) => m.id), ['edge', 'new']);
  });

  it('skips already-announced ids', () => {
    const msg = message({ id: 'a', ageMinutes: 1 });
    const result = selectNewMessages([msg], {
      announcedIds: new Set(['a']),
      newestSeenMs: 0,
      isFirstRun: false,
      nowMs: NOW,
    });
    assert.deepEqual(result, []);
  });

  it('drops messages with unparseable received times', () => {
    const broken = { id: 'x', receivedDateTime: 'nope' };
    const result = selectNewMessages([broken], {
      announcedIds: new Set(),
      newestSeenMs: 0,
      isFirstRun: false,
      nowMs: NOW,
    });
    assert.deepEqual(result, []);
  });
});

describe('formatMailNotification', () => {
  it('renders sender, subject, and preview', () => {
    const payload = formatMailNotification(message({ id: 'a', subject: 'Q3 plan', from: 'Sam' }));
    assert.equal(payload.title, 'Q3 plan');
    assert.equal(payload.kind, 'mail');
    assert.equal(payload.conversation, 'Inbox');
    assert.ok(payload.body.startsWith('Sam:'));
    assert.equal(payload.sender.displayName, 'Sam');
    assert.ok(payload.deepLink.includes('a'));
  });

  it('falls back for missing subject, sender, and preview', () => {
    const payload = formatMailNotification({ id: 'x', receivedDateTime: new Date(NOW).toISOString() });
    assert.equal(payload.title, '(No subject)');
    assert.equal(payload.body, 'Mail');
    assert.equal(payload.deepLink, null);
  });
});

describe('MailPoller', () => {
  it('announces fresh mail on the first poll and tracks ids', async () => {
    const client = makeClient([
      { success: true, data: { value: [message({ id: 'a', ageMinutes: 1 })] } },
    ]);
    const { poller, announced } = makePoller(client);
    const count = await poller.poll();
    assert.equal(count, 1);
    assert.equal(announced.length, 1);
    assert.equal(poller.trackedCount, 1);
  });

  it('does not re-announce the same messages', async () => {
    const client = makeClient([
      { success: true, data: { value: [message({ id: 'a', ageMinutes: 1 })] } },
      { success: true, data: { value: [message({ id: 'a', ageMinutes: 1 })] } },
    ]);
    const { poller, announced } = makePoller(client);
    await poller.poll();
    const second = await poller.poll();
    assert.equal(second, 0);
    assert.equal(announced.length, 1);
  });

  it('announces newer mail that arrives on later polls', async () => {
    const client = makeClient([
      { success: true, data: { value: [message({ id: 'a', ageMinutes: 3 })] } },
      { success: true, data: { value: [message({ id: 'a', ageMinutes: 3 }), message({ id: 'b', ageMinutes: 1 })] } },
    ]);
    const { poller, announced } = makePoller(client);
    await poller.poll();
    const second = await poller.poll();
    assert.equal(second, 1);
    assert.equal(announced.length, 2);
    assert.equal(announced[1].title, 'Hello');
  });

  it('announces the oldest-first when several arrive', async () => {
    const client = makeClient([
      {
        success: true,
        data: {
          value: [message({ id: 'c', ageMinutes: 1 }), message({ id: 'a', ageMinutes: 3 }), message({ id: 'b', ageMinutes: 2 })],
        },
      },
    ]);
    const { poller, announced } = makePoller(client);
    await poller.poll();
    assert.equal(announced.length, 3);
    assert.ok(announced[0].deepLink.includes('a'));
    assert.ok(announced[2].deepLink.includes('c'));
  });

  it('bounds the dedup set at MAX_TRACKED_IDS', async () => {
    const ids = Array.from({ length: MAX_TRACKED_IDS + 10 }, (_, i) => `m${i}`);
    const client = makeClient([
      {
        success: true,
        data: {
          value: ids.map((id, i) => message({ id, ageMinutes: 1 + (ids.length - i) })),
        },
      },
    ]);
    const { poller } = makePoller(client);
    await poller.poll();
    assert.equal(poller.trackedCount, MAX_TRACKED_IDS);
  });

  it('does nothing when disabled', async () => {
    const client = makeClient([]);
    const poller = new MailPoller({
      client,
      config: { graphApi: { enabled: true } },
      notifier: { showMailPreview: () => {} },
      nowMs: () => NOW,
    });
    assert.equal(await poller.poll(), 0);
    assert.equal(client.calls.length, 0);
    poller.start();
    poller.stop();
    assert.equal(client.calls.length, 0);
  });

  it('keeps going when a notifier throws', async () => {
    const client = makeClient([
      { success: true, data: { value: [message({ id: 'a', ageMinutes: 1 })] } },
    ]);
    const poller = new MailPoller({
      client,
      config: { graphApi: { enabled: true, mailPreview: { enabled: true } } },
      notifier: { showMailPreview: () => { throw new Error('boom'); } },
      nowMs: () => NOW,
    });
    const count = await poller.poll();
    assert.equal(count, 1); // announced attempt made; failure swallowed
  });

  it('clamps the poll interval', () => {
    assert.equal(MailPoller.clampPollIntervalMs(5000), 60000);
    assert.equal(MailPoller.clampPollIntervalMs(60 * 60 * 1000), 30 * 60 * 1000);
    assert.equal(MailPoller.clampPollIntervalMs('nonsense'), 5 * 60 * 1000);
    assert.equal(MailPoller.clampPollIntervalMs(7 * 60 * 1000), 7 * 60 * 1000);
  });
});
