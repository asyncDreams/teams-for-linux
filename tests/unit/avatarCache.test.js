/**
 * Unit tests for avatarCache (app/notifications/avatarCache.js)
 * Run with: node --test tests/unit/avatarCache.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const AvatarCache = require('../../app/notifications/avatarCache');

describe('AvatarCache', () => {
	it('stores and retrieves a data: URL', () => {
		const c = new AvatarCache();
		c.set('alice', 'data:image/png;base64,abc');
		assert.strictEqual(c.get('alice'), 'data:image/png;base64,abc');
		assert.strictEqual(c._size(), 1);
	});

	it('returns null on miss', () => {
		const c = new AvatarCache();
		assert.strictEqual(c.get('missing'), null);
	});

	it('rejects non-data: URLs', () => {
		const c = new AvatarCache();
		c.set('bob', 'https://example.com/avatar.jpg');
		assert.strictEqual(c.get('bob'), null);
		assert.strictEqual(c._size(), 0);

		c.set('bob', 'file:///etc/passwd');
		assert.strictEqual(c.get('bob'), null);
	});

	it('rejects empty or non-string keys', () => {
		const c = new AvatarCache();
		c.set('', 'data:image/png;base64,abc');
		c.set(null, 'data:image/png;base64,abc');
		c.set(123, 'data:image/png;base64,abc');
		assert.strictEqual(c._size(), 0);
	});

	it('returns null for non-string or empty get key', () => {
		const c = new AvatarCache();
		c.set('alice', 'data:image/png;base64,abc');
		assert.strictEqual(c.get(''), null);
		assert.strictEqual(c.get(null), null);
		assert.strictEqual(c.get(123), null);
	});

	it('caps stored value at 32 KiB', () => {
		const c = new AvatarCache();
		const long = 'data:image/png;base64,' + 'a'.repeat(100 * 1024);
		c.set('alice', long);
		const stored = c.get('alice');
		assert.ok(stored.length <= 32 * 1024);
		assert.ok(stored.startsWith('data:'));
	});

	it('evicts oldest when over MAX_ENTRIES (64)', () => {
		const c = new AvatarCache();
		for (let i = 0; i < 70; i++) {
			c.set(`user-${i}`, `data:image/png;base64,${i}`);
		}
		assert.ok(c._size() <= 64, `size was ${c._size()}`);
		// First entries should have been evicted
		assert.strictEqual(c.get('user-0'), null);
		assert.ok(c.get('user-69') !== null);
	});

	it('evicts expired entries on next write (TTL 48h)', () => {
		const c = new AvatarCache();
		c.set('alice', 'data:image/png;base64,abc');
		// Backdate entry past TTL
		const entry = c._map.get('alice');
		entry.at = Date.now() - 49 * 60 * 60 * 1000;
		c.set('bob', 'data:image/png;base64,def');
		// alice should have been pruned
		assert.strictEqual(c.get('alice'), null);
		assert.strictEqual(c.get('bob'), 'data:image/png;base64,def');
	});

	it('get returns null for expired entry and deletes it', () => {
		const c = new AvatarCache();
		c.set('alice', 'data:image/png;base64,abc');
		c._map.get('alice').at = Date.now() - 49 * 60 * 60 * 1000;
		assert.strictEqual(c.get('alice'), null);
		assert.strictEqual(c._map.has('alice'), false);
	});

	it('clear removes all entries', () => {
		const c = new AvatarCache();
		c.set('alice', 'data:image/png;base64,abc');
		c.set('bob', 'data:image/png;base64,def');
		c.clear();
		assert.strictEqual(c._size(), 0);
		assert.strictEqual(c.get('alice'), null);
	});

	it('set overwrites existing key', () => {
		const c = new AvatarCache();
		c.set('alice', 'data:image/png;base64,aaa');
		c.set('alice', 'data:image/png;base64,bbb');
		assert.strictEqual(c.get('alice'), 'data:image/png;base64,bbb');
		assert.strictEqual(c._size(), 1);
	});
});
