'use strict';

/**
 * AvatarCache — tiny in-memory LRU for sender avatars.
 *
 * The extractor may provide a data: avatarRef inline; when it doesn't,
 * the main process can ask this cache for a Graph/people photo. The cache
 * is intentionally tiny and TTL-bound so it never becomes a PII store on
 * disk — entries live only for the lifetime of the app process.
 *
 * For now this is a stub that resolves to null and lets the existing icon
 * path stay untouched. T1B wires the Graph fetch; T1A–T1 ships without
 * requiring Graph scopes to be present.
 */

const MAX_ENTRIES = 64;
const TTL_MS = 48 * 60 * 60 * 1000; // 48 h

class AvatarCache {
  constructor() {
    /** @type {Map<string, { dataUrl: string, at: number }>} */
    this._map = new Map();
  }

  _prune() {
    const now = Date.now();
    for (const [key, entry] of this._map) {
      if (now - entry.at > TTL_MS) this._map.delete(key);
    }
    // Enforce size bound by evicting oldest
    while (this._map.size > MAX_ENTRIES) {
      const first = this._map.keys().next().value;
      this._map.delete(first);
    }
  }

  /**
   * Get a cached data: URL for a sender key (userId or displayName).
   * Returns null on miss or expiry.
   * @param {string} key
   * @returns {string|null}
   */
  get(key) {
    if (!key || typeof key !== 'string') return null;
    const entry = this._map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > TTL_MS) {
      this._map.delete(key);
      return null;
    }
    return entry.dataUrl || null;
  }

  /**
   * Store a data: URL for a sender key. No-op for non-data: values.
   * @param {string} key
   * @param {string} dataUrl - must start with data:
   */
  set(key, dataUrl) {
    if (!key || typeof key !== 'string') return;
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return;
    // Cap stored value to avoid unbounded memory from large data URLs
    const capped = dataUrl.length > 32 * 1024 ? dataUrl.slice(0, 32 * 1024) : dataUrl;
    this._map.set(key, { dataUrl: capped, at: Date.now() });
    this._prune();
  }

  /** For tests */
  _size() { return this._map.size; }
  clear() { this._map.clear(); }
}

module.exports = AvatarCache;
