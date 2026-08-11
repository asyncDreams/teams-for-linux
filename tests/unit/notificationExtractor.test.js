/**
 * Unit tests for notification extractor (app/browser/tools/notificationExtractor.js)
 * Run with: node --test tests/unit/notificationExtractor.test.js
 * No Electron required — pure helpers + mocked DOM probe.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const ex = require('../../app/browser/tools/notificationExtractor');

describe('notificationExtractor — capText', () => {
	it('trims and caps to MAX_TEXT_LENGTH', () => {
		assert.strictEqual(ex.capText('  hello  '), 'hello');
		const long = 'a'.repeat(2000);
		assert.strictEqual(ex.capText(long).length, ex.MAX_TEXT_LENGTH);
	});

	it('returns empty for non-string', () => {
		assert.strictEqual(ex.capText(null), '');
		assert.strictEqual(ex.capText(undefined), '');
		assert.strictEqual(ex.capText(123), '');
		assert.strictEqual(ex.capText({}), '');
	});

	it('empty string stays empty', () => {
		assert.strictEqual(ex.capText(''), '');
		assert.strictEqual(ex.capText('   '), '');
	});
});

describe('notificationExtractor — parseTitleForSender', () => {
	it('extracts sender before ": "', () => {
		assert.strictEqual(ex.parseTitleForSender('Alice: hello world'), 'Alice');
		assert.strictEqual(ex.parseTitleForSender('Bob Smith: preview'), 'Bob Smith');
	});

	it('returns null when no ": " separator', () => {
		assert.strictEqual(ex.parseTitleForSender('NoSeparator'), null);
		assert.strictEqual(ex.parseTitleForSender(''), null);
		assert.strictEqual(ex.parseTitleForSender(null), null);
	});

	it('rejects too-long candidate', () => {
		const longName = 'a'.repeat(65) + ': preview';
		assert.strictEqual(ex.parseTitleForSender(longName), null);
	});

	it('rejects URL-like candidate', () => {
		assert.strictEqual(ex.parseTitleForSender('https://example.com: preview'), null);
		assert.strictEqual(ex.parseTitleForSender('http://x: body'), null);
	});

	it('rejects email-like candidate', () => {
		assert.strictEqual(ex.parseTitleForSender('alice@example.com: hi'), null);
	});

	it('trims candidate', () => {
		assert.strictEqual(ex.parseTitleForSender('  Alice  : hello'), 'Alice');
	});
});

describe('notificationExtractor — classifyKind', () => {
	it('mention outranks others', () => {
		assert.strictEqual(ex.classifyKind({ title: 'mention', body: '' }), 'mention');
		assert.strictEqual(ex.classifyKind({ data: { kind: 'mention' } }), 'mention');
		assert.strictEqual(ex.classifyKind({ body: '@mentioned you' }), 'mention');
	});

	it('missedCall detection', () => {
		assert.strictEqual(ex.classifyKind({ title: 'Missed call from Alice' }), 'missedCall');
		assert.strictEqual(ex.classifyKind({ tag: 'call:123', body: 'missed' }), 'missedCall');
		assert.strictEqual(ex.classifyKind({ data: { kind: 'missedCall' } }), 'missedCall');
	});

	it('call detection', () => {
		assert.strictEqual(ex.classifyKind({ title: 'Incoming call' }), 'call');
		assert.strictEqual(ex.classifyKind({ tag: 'call:abc' }), 'call');
		assert.strictEqual(ex.classifyKind({ data: { kind: 'call' } }), 'call');
	});

	it('meeting detection', () => {
		assert.strictEqual(ex.classifyKind({ title: 'Meeting started' }), 'meeting');
		assert.strictEqual(ex.classifyKind({ tag: 'meeting:123' }), 'meeting');
		assert.strictEqual(ex.classifyKind({ dataTid: 'meeting-card' }), 'meeting');
		assert.strictEqual(ex.classifyKind({ data: { type: 'meeting' } }), 'meeting');
	});

	it('channel detection', () => {
		assert.strictEqual(ex.classifyKind({ dataTid: 'channel-notification' }), 'channel');
		assert.strictEqual(ex.classifyKind({ tag: 'channel:general' }), 'channel');
		assert.strictEqual(ex.classifyKind({ title: 'Channel message' }), 'channel');
	});

	it('group detection', () => {
		assert.strictEqual(ex.classifyKind({ tag: 'group:abc' }), 'group');
		assert.strictEqual(ex.classifyKind({ body: 'group chat' }), 'group');
	});

	it('direct detection via chat: tag', () => {
		assert.strictEqual(ex.classifyKind({ tag: 'chat:19:abc@thread.v2' }), 'direct');
		assert.strictEqual(ex.classifyKind({ tag: 'direct:123' }), 'direct');
	});

	it('unknown for empty or unrecognized tag', () => {
		assert.strictEqual(ex.classifyKind({}), 'unknown');
		assert.strictEqual(ex.classifyKind({ title: 'Hello' }), 'unknown');
		assert.strictEqual(ex.classifyKind({ tag: 'random-tag-xyz' }), 'unknown');
	});

	it('is case-insensitive', () => {
		assert.strictEqual(ex.classifyKind({ title: 'MEETING started' }), 'meeting');
		assert.strictEqual(ex.classifyKind({ tag: 'CALL:123' }), 'call');
	});
});

describe('notificationExtractor — deriveGroupingKey', () => {
	it('prefers tag', () => {
		assert.strictEqual(ex.deriveGroupingKey({ tag: 'chat:123' }), 'chat:123');
	});

	it('falls back to data conversation identifiers', () => {
		assert.strictEqual(ex.deriveGroupingKey({ data: { conversationId: 'conv-1' } }), 'conv-1');
		assert.strictEqual(ex.deriveGroupingKey({ data: { threadId: 't-1' } }), 't-1');
		assert.strictEqual(ex.deriveGroupingKey({ data: { chatId: 'c-1' } }), 'c-1');
		assert.strictEqual(ex.deriveGroupingKey({ data: { channelId: 'ch-1' } }), 'ch-1');
	});

	it('caps at 256 and trims', () => {
		const long = '  ' + 'a'.repeat(500) + '  ';
		assert.strictEqual(ex.deriveGroupingKey({ tag: long }).length, 256);
	});

	it('returns null when no stable key — does not hash title (PII guard)', () => {
		assert.strictEqual(ex.deriveGroupingKey({ title: 'Alice: hello' }), null);
		assert.strictEqual(ex.deriveGroupingKey({}), null);
		assert.strictEqual(ex.deriveGroupingKey({ data: {} }), null);
	});
});

describe('notificationExtractor — extractDeepLinkHref', () => {
	it('accepts https and msteams', () => {
		assert.strictEqual(
			ex.extractDeepLinkHref('https://teams.cloud.microsoft/l/meetup-join/abc'),
			'https://teams.cloud.microsoft/l/meetup-join/abc'
		);
		assert.strictEqual(ex.extractDeepLinkHref('msteams://teams.cloud.microsoft/l/chat/0/0'), 'msteams://teams.cloud.microsoft/l/chat/0/0');
		assert.strictEqual(ex.extractDeepLinkHref('msteams:/l/meetup-join/abc'), 'msteams:/l/meetup-join/abc');
	});

	it('rejects non-allowed schemes', () => {
		assert.strictEqual(ex.extractDeepLinkHref('http://teams.cloud.microsoft/'), null);
		assert.strictEqual(ex.extractDeepLinkHref('file:///etc/passwd'), null);
		assert.strictEqual(ex.extractDeepLinkHref(''), null);
		assert.strictEqual(ex.extractDeepLinkHref(null), null);
	});

	it('trims and caps at 2048', () => {
		const long = 'https://' + 'a'.repeat(3000);
		const out = ex.extractDeepLinkHref('  ' + long + '  ');
		assert.ok(out.length <= 2048);
		assert.ok(out.startsWith('https://'));
	});
});

describe('notificationExtractor — buildParsedNotification', () => {
	it('caps title/body and sets defaults', () => {
		const p = ex.buildParsedNotification({ title: '  Hello  ', options: { body: '  world  ' }, notificationId: 'id-1' });
		assert.strictEqual(p.title, 'Hello');
		assert.strictEqual(p.body, 'world');
		assert.strictEqual(p.notificationId, 'id-1');
		assert.strictEqual(p.kind, 'unknown');
	});

	it('uses hub sender over title parse', () => {
		const p = ex.buildParsedNotification({
			title: 'Bob: hi',
			options: { body: 'preview', tag: 'chat:1' },
			notificationId: 'id-2',
			hubProbe: { senderName: 'Alice', avatarUrl: null, deepLink: null, dataTid: null },
		});
		assert.strictEqual(p.sender.displayName, 'Alice');
	});

	it('falls back to title parse when hub missing', () => {
		const p = ex.buildParsedNotification({
			title: 'Carol: hello there',
			options: { body: 'hi', tag: 'chat:1' },
			notificationId: 'id-3',
			hubProbe: { senderName: null, avatarUrl: null, deepLink: null, dataTid: null },
		});
		assert.strictEqual(p.sender.displayName, 'Carol');
	});

	it('picks up sender from data.senderName', () => {
		const p = ex.buildParsedNotification({
			title: 'Hello',
			options: { body: 'hi', data: { senderName: 'Dave' }, tag: 'chat:1' },
			notificationId: 'id-4',
		});
		assert.strictEqual(p.sender.displayName, 'Dave');
	});

	it('avatarRef prefers hub over icon data URL', () => {
		const p = ex.buildParsedNotification({
			title: 'Hi',
			options: { body: 'x', icon: 'data:image/png;base64,abc', tag: 'chat:1' },
			notificationId: 'id-5',
			hubProbe: { senderName: 'Eve', avatarUrl: 'https://example.com/avatar.jpg', deepLink: null, dataTid: null },
		});
		assert.strictEqual(p.sender.avatarRef, 'https://example.com/avatar.jpg');
	});

	it('uses icon data URL as avatarRef when hub has none', () => {
		const dataUrl = 'data:image/png;base64,abc123';
		const p = ex.buildParsedNotification({
			title: 'Hi',
			options: { body: 'x', icon: dataUrl, tag: 'chat:1' },
			notificationId: 'id-6',
			hubProbe: { senderName: null, avatarUrl: null, deepLink: null, dataTid: null },
		});
		assert.strictEqual(p.sender.avatarRef, dataUrl);
		assert.strictEqual(p.iconDataUrl, dataUrl);
	});

	it('rejects non-data/https icon', () => {
		const p = ex.buildParsedNotification({
			title: 'Hi',
			options: { body: 'x', icon: 'file:///etc/passwd', tag: 'chat:1' },
			notificationId: 'id-7',
		});
		assert.strictEqual(p.iconDataUrl, undefined);
	});

	it('deepLink prefers hub, then data deepLink/url', () => {
		const p1 = ex.buildParsedNotification({
			title: 'Hi',
			options: { body: 'x', data: { deepLink: 'https://teams.cloud.microsoft/l/chat/0/0' } },
			notificationId: 'id-8',
			hubProbe: { senderName: null, avatarUrl: null, deepLink: 'https://teams.cloud.microsoft/l/meetup-join/abc', dataTid: null },
		});
		assert.strictEqual(p1.deepLink, 'https://teams.cloud.microsoft/l/meetup-join/abc');

		const p2 = ex.buildParsedNotification({
			title: 'Hi',
			options: { body: 'x', data: { url: 'msteams://teams.cloud.microsoft/l/chat/0/0' } },
			notificationId: 'id-9',
		});
		assert.strictEqual(p2.deepLink, 'msteams://teams.cloud.microsoft/l/chat/0/0');
	});

	it('kind classification flows through build', () => {
		const p = ex.buildParsedNotification({
			title: 'Meeting started',
			options: { body: 'join now', tag: 'meeting:123' },
			notificationId: 'id-10',
		});
		assert.strictEqual(p.kind, 'meeting');
	});

	it('grouping key derived correctly', () => {
		const p = ex.buildParsedNotification({
			title: 'Hi',
			options: { body: 'x', tag: 'conv-123', data: { conversationId: 'ignored' } },
			notificationId: 'id-11',
		});
		assert.strictEqual(p.conversation.key, 'conv-123');
	});

	it('conversation.title from data', () => {
		const p = ex.buildParsedNotification({
			title: 'Hi',
			options: { body: 'x', tag: 't-1', data: { conversationTitle: 'Team Alpha' } },
			notificationId: 'id-12',
		});
		assert.strictEqual(p.conversation.title, 'Team Alpha');
	});

	it('displayTitle prefixes sender for chat-like kinds', () => {
		const p = ex.buildParsedNotification({
			title: 'hello world',
			options: { body: 'preview text', tag: 'chat:123', data: { senderName: 'Alice' } },
			notificationId: 'id-13',
		});
		// kind direct => prefix applies
		assert.ok(p.title.startsWith('Alice:'), `title was ${p.title}`);
		assert.strictEqual(p.kind, 'direct');
	});

	it('does not prefix sender for meeting/call kinds', () => {
		const pMeeting = ex.buildParsedNotification({
			title: 'Meeting started',
			options: { body: 'join', tag: 'meeting:1', data: { senderName: 'Alice' } },
			notificationId: 'id-14',
		});
		assert.strictEqual(pMeeting.title, 'Meeting started');

		const pCall = ex.buildParsedNotification({
			title: 'Incoming call',
			options: { body: 'answer', tag: 'call:1', data: { senderName: 'Bob' } },
			notificationId: 'id-15',
		});
		assert.strictEqual(pCall.title, 'Incoming call');
	});

	it('does not double-prefix when title already starts with sender', () => {
		const p = ex.buildParsedNotification({
			title: 'Alice: hello',
			options: { body: 'preview', tag: 'chat:1', data: { senderName: 'Alice' } },
			notificationId: 'id-16',
		});
		assert.strictEqual(p.title, 'Alice: hello');
	});

	it('sender.userId from data', () => {
		const p = ex.buildParsedNotification({
			title: 'Hi',
			options: { body: 'x', data: { userId: 'uid-123', senderName: 'Alice' }, tag: 'chat:1' },
			notificationId: 'id-17',
		});
		assert.strictEqual(p.sender.userId, 'uid-123');

		const p2 = ex.buildParsedNotification({
			title: 'Hi',
			options: { body: 'x', data: { senderId: 'sid-456', senderName: 'Bob' }, tag: 'chat:1' },
			notificationId: 'id-18',
		});
		assert.strictEqual(p2.sender.userId, 'sid-456');
	});

	it('generates fallback notificationId when not provided', () => {
		const p = ex.buildParsedNotification({ title: 'Hi', options: {} });
		assert.ok(typeof p.notificationId === 'string' && p.notificationId.length > 0);
	});

	it('preserves rawTag', () => {
		const p = ex.buildParsedNotification({ title: 'Hi', options: { tag: 'my-tag' }, notificationId: 'id-19' });
		assert.strictEqual(p.rawTag, 'my-tag');
	});

	it('handles missing options gracefully', () => {
		const p = ex.buildParsedNotification({ title: 'Hello', notificationId: 'id-20' });
		assert.strictEqual(p.title, 'Hello');
		assert.strictEqual(p.body, '');
	});

	it('caps long title/body at MAX_TEXT_LENGTH', () => {
		const long = 'x'.repeat(5000);
		const p = ex.buildParsedNotification({ title: long, options: { body: long }, notificationId: 'id-21' });
		assert.ok(p.title.length <= ex.MAX_TEXT_LENGTH);
		assert.ok(p.body.length <= ex.MAX_TEXT_LENGTH);
	});
});

describe('notificationExtractor — probeHubCard (no DOM / empty DOM)', () => {
	let originalDocument;

	beforeEach(() => {
		originalDocument = global.document;
	});

	afterEach(() => {
		if (originalDocument === undefined) delete global.document;
		else global.document = originalDocument;
	});

	it('returns nulls when document is undefined', () => {
		delete global.document;
		const res = ex.probeHubCard();
		assert.deepStrictEqual(res, { senderName: null, avatarUrl: null, deepLink: null, dataTid: null });
	});

	it('returns nulls when no cards found', () => {
		global.document = {
			querySelector: () => null,
			querySelectorAll: () => [],
		};
		const res = ex.probeHubCard();
		assert.deepStrictEqual(res, { senderName: null, avatarUrl: null, deepLink: null, dataTid: null });
	});

	it('handles querySelector throwing', () => {
		global.document = {
			querySelector: () => { throw new Error('bad selector'); },
			querySelectorAll: () => { throw new Error('bad'); },
		};
		const res = ex.probeHubCard();
		assert.deepStrictEqual(res, { senderName: null, avatarUrl: null, deepLink: null, dataTid: null });
	});
});
