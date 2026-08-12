'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const NotificationHistoryService = require('../../app/notifications/history');

let userDataPath;

beforeEach(() => {
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tfl-notification-history-'));
});

afterEach(() => {
  fs.rmSync(userDataPath, { recursive: true, force: true });
});

describe('NotificationHistoryService persistence', () => {
  it('records and reloads a notification from disk', () => {
    const service = new NotificationHistoryService(userDataPath, { enabled: true, retentionDays: 0 });
    const id = service.record({
      id: 'history-1',
      timestamp: Date.now(),
      sender: { displayName: 'Ada', avatar: 'data:image/png;base64,abc' },
      conversationTitle: 'Project chat',
      preview: 'Build is ready',
      type: 'direct',
      urgency: 'normal',
      metadata: { conversation: 'chat-1' },
      actions: [{ type: 'open' }],
    });

    assert.equal(id, 'history-1');
    const reloaded = new NotificationHistoryService(userDataPath, { enabled: true, retentionDays: 0 });
    const entries = reloaded.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].sender.displayName, 'Ada');
    assert.equal(entries[0].category, 'chats');
    assert.equal(reloaded.unreadCount(), 1);
  });

  it('migrates the legacy array-on-disk format', () => {
    fs.writeFileSync(path.join(userDataPath, 'notification-history.json'), JSON.stringify([
      { id: 'legacy-1', timestamp: Date.now(), type: 'channel', preview: 'Legacy entry' },
    ]));
    const service = new NotificationHistoryService(userDataPath, { enabled: true, retentionDays: 0 });
    const [entry] = service.list();
    assert.equal(entry.id, 'legacy-1');
    assert.equal(entry.category, 'channels');
    assert.equal(entry.unread, true);
  });

  it('does not write while disabled', () => {
    const service = new NotificationHistoryService(userDataPath, { enabled: false, retentionDays: 0 });
    assert.equal(service.record({ id: 'disabled', type: 'direct' }), null);
    assert.equal(fs.existsSync(path.join(userDataPath, 'notification-history.json')), false);
  });
});

describe('NotificationHistoryService retention and queries', () => {
  it('removes entries outside the configured retention window', () => {
    const service = new NotificationHistoryService(userDataPath, { enabled: true, retentionDays: 7 });
    service.record({ id: 'old', timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000, type: 'direct' });
    service.record({ id: 'recent', timestamp: Date.now() - 2 * 24 * 60 * 60 * 1000, type: 'meeting' });
    assert.deepEqual(service.list().map((entry) => entry.id), ['recent']);
  });

  it('filters by category and case-insensitive text', () => {
    const service = new NotificationHistoryService(userDataPath, { enabled: true, retentionDays: 0 });
    service.record({ id: 'chat', sender: { displayName: 'Ada' }, preview: 'Please review', type: 'direct' });
    service.record({ id: 'mention', sender: { displayName: 'Lin' }, preview: 'You were mentioned', type: 'mention' });
    assert.deepEqual(service.list({ category: 'mentions' }).map((entry) => entry.id), ['mention']);
    assert.deepEqual(service.list({ query: 'ADA' }).map((entry) => entry.id), ['chat']);
  });

  it('supports oldest sorting, read state, and clearing', () => {
    const service = new NotificationHistoryService(userDataPath, { enabled: true, retentionDays: 0 });
    service.record({ id: 'new', timestamp: 2000, type: 'call' });
    service.record({ id: 'old', timestamp: 1000, type: 'group' });
    assert.deepEqual(service.list({ sort: 'oldest' }).map((entry) => entry.id), ['old', 'new']);
    assert.equal(service.markRead('old'), true);
    assert.deepEqual(service.list({ unreadOnly: true }).map((entry) => entry.id), ['new']);
    assert.equal(service.clear('old'), true);
    assert.equal(service.clearAll(), true);
    assert.equal(service.list().length, 0);
  });

  it('exports versioned JSON without exposing mutable internal entries', () => {
    const service = new NotificationHistoryService(userDataPath, { enabled: true, retentionDays: 0 });
    service.record({ id: 'export-1', type: 'missedCall', preview: 'Call' });
    const exported = JSON.parse(service.exportJson());
    assert.equal(exported.version, 1);
    assert.equal(exported.entries[0].id, 'export-1');
    const listed = service.list();
    listed[0].preview = 'mutated';
    assert.equal(service.list()[0].preview, 'Call');
  });
});
