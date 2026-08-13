'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HISTORY_VERSION = 1;
const MAX_ENTRIES = 5000;
const MAX_TEXT_LENGTH = 2000;
const MAX_AVATAR_LENGTH = 32 * 1024;
const RETENTION_DAYS = new Set([7, 30, 90, 0]);
const CHAT_TYPES = new Set(['direct', 'group']);
const CALL_TYPES = new Set(['call', 'missedCall']);

function clampText(value, max = MAX_TEXT_LENGTH) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function normaliseRetentionDays(value) {
  const numeric = Number(value);
  return RETENTION_DAYS.has(numeric) ? numeric : 30;
}

function categoryForType(type) {
  if (CHAT_TYPES.has(type)) return 'chats';
  if (type === 'channel') return 'channels';
  if (type === 'mention') return 'mentions';
  if (type === 'meeting') return 'meetings';
  if (CALL_TYPES.has(type)) return 'calls';
  return 'other';
}

function safeClone(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return value;
  if (typeof value !== 'object') return typeof value === 'string' ? clampText(value) : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => safeClone(entry, depth + 1));
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, 40)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    result[key] = safeClone(entry, depth + 1);
  }
  return result;
}

class NotificationHistoryService {
  #filePath;
  #enabled;
  #retentionDays;
  #entries = [];
  #initialized = false;
  #changeListener = null;

  constructor(userDataPath, options = {}) {
    this.#filePath = path.join(userDataPath, 'notification-history.json');
    this.#enabled = options?.enabled === true;
    this.#retentionDays = normaliseRetentionDays(options?.retentionDays);
    this.#changeListener = typeof options?.onChange === 'function' ? options.onChange : null;
    this.#load();
  }

  /**
   * Registers a listener invoked with the unread count after every mutation.
   * Used to keep the tray tooltip badge in sync without coupling this module
   * to the windowing layer.
   * @param {Function} fn
   */
  setChangeListener(fn) {
    this.#changeListener = typeof fn === 'function' ? fn : null;
  }

  setOptions(options = {}) {
    this.#enabled = options?.enabled === true;
    this.#retentionDays = normaliseRetentionDays(options?.retentionDays);
    this.#cleanupRetention();
    this.#write();
  }

  isEnabled() {
    return this.#enabled;
  }

  record(notification = {}) {
    if (!this.#enabled) return null;
    const timestamp = Number.isFinite(notification.timestamp)
      ? notification.timestamp
      : Date.now();
    const entry = {
      id: typeof notification.id === 'string' && notification.id.length > 0
        ? notification.id.slice(0, 128)
        : crypto.randomUUID(),
      timestamp,
      sender: {
        displayName: clampText(notification.sender?.displayName, 256),
        avatar: typeof notification.sender?.avatar === 'string'
          ? notification.sender.avatar.slice(0, MAX_AVATAR_LENGTH)
          : null,
      },
      conversationTitle: clampText(notification.conversationTitle, 512),
      preview: clampText(notification.preview, MAX_TEXT_LENGTH),
      type: typeof notification.type === 'string' ? notification.type.slice(0, 64) : 'unknown',
      category: categoryForType(notification.type),
      urgency: typeof notification.urgency === 'string' ? notification.urgency.slice(0, 32) : 'normal',
      metadata: safeClone(notification.metadata || {}),
      actions: safeClone(notification.actions || []),
      deepLink: typeof notification.deepLink === 'string' ? notification.deepLink.slice(0, 2048) : null,
      unread: notification.unread !== false,
    };

    this.#entries = [entry, ...this.#entries.filter((item) => item.id !== entry.id)].slice(0, MAX_ENTRIES);
    this.#cleanupRetention();
    this.#write();
    return entry.id;
  }

  list(filters = {}) {
    this.#cleanupRetention();
    const query = typeof filters.query === 'string' ? filters.query.trim().toLocaleLowerCase() : '';
    const category = typeof filters.category === 'string' ? filters.category : 'all';
    const unreadOnly = filters.unreadOnly === true;
    const sort = filters.sort === 'oldest' ? 'oldest' : 'newest';

    let entries = this.#entries.filter((entry) => {
      if (category !== 'all' && entry.category !== category) return false;
      if (unreadOnly && !entry.unread) return false;
      if (!query) return true;
      return [entry.sender?.displayName, entry.conversationTitle, entry.preview, entry.type]
        .some((value) => String(value || '').toLocaleLowerCase().includes(query));
    });

    entries = entries.sort((left, right) => {
      const difference = left.timestamp - right.timestamp;
      return sort === 'oldest' ? difference : -difference;
    });

    const offset = Number.isInteger(filters.offset) && filters.offset > 0 ? filters.offset : 0;
    const limit = Number.isInteger(filters.limit) && filters.limit > 0 ? Math.min(filters.limit, 500) : 500;
    return entries.slice(offset, offset + limit).map((entry) => ({ ...entry }));
  }

  markRead(id) {
    if (typeof id !== 'string') return false;
    const entry = this.#entries.find((item) => item.id === id);
    if (!entry) return false;
    entry.unread = false;
    this.#write();
    return true;
  }

  getById(id) {
    if (typeof id !== 'string') return null;
    const entry = this.#entries.find((item) => item.id === id);
    return entry ? { ...entry } : null;
  }

  markAllRead() {
    let changed = false;
    for (const entry of this.#entries) {
      if (entry.unread) {
        entry.unread = false;
        changed = true;
      }
    }
    if (changed) this.#write();
    return changed;
  }

  clear(id) {
    if (typeof id !== 'string') return false;
    const previousLength = this.#entries.length;
    this.#entries = this.#entries.filter((entry) => entry.id !== id);
    if (this.#entries.length === previousLength) return false;
    this.#write();
    return true;
  }

  clearAll() {
    const hadEntries = this.#entries.length > 0;
    this.#entries = [];
    if (hadEntries) this.#write();
    return hadEntries;
  }

  unreadCount() {
    return this.#entries.reduce((count, entry) => count + (entry.unread ? 1 : 0), 0);
  }

  exportJson() {
    this.#cleanupRetention();
    return JSON.stringify({ version: HISTORY_VERSION, exportedAt: new Date().toISOString(), entries: this.#entries }, null, 2);
  }

  initialize() {
    if (this.#initialized) return;
    this.#initialized = true;
    const { ipcMain } = require('electron');

    // Read notification history entries for the history window.
    ipcMain.handle('notification-history-list', (_event, filters) => this.list(filters));
    // Mark one notification as read.
    ipcMain.handle('notification-history-mark-read', (_event, id) => this.markRead(id));
    // Mark all retained history entries as read.
    ipcMain.handle('notification-history-mark-all-read', () => this.markAllRead());
    // Remove one notification from local history.
    ipcMain.handle('notification-history-clear', (_event, id) => this.clear(id));
    // Remove all locally retained notification history.
    ipcMain.handle('notification-history-clear-all', () => this.clearAll());
    // Return a JSON export for the history window to save locally.
    ipcMain.handle('notification-history-export', () => this.exportJson());
    // Return the unread history count for the menu/badge.
    ipcMain.handle('notification-history-unread-count', () => this.unreadCount());
  }

  #load() {
    try {
      if (!fs.existsSync(this.#filePath)) return;
      const raw = fs.readFileSync(this.#filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
      if (!Array.isArray(entries)) return;
      this.#entries = entries
        .filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string')
        .slice(0, MAX_ENTRIES)
        .map((entry) => ({
          ...entry,
          timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now(),
          sender: {
            displayName: clampText(entry.sender?.displayName, 256),
            avatar: typeof entry.sender?.avatar === 'string' ? entry.sender.avatar.slice(0, MAX_AVATAR_LENGTH) : null,
          },
          conversationTitle: clampText(entry.conversationTitle, 512),
          preview: clampText(entry.preview),
          category: entry.category || categoryForType(entry.type),
          unread: entry.unread !== false,
        }));
      this.#cleanupRetention();
    } catch {
      // Corrupt history must never prevent Teams from starting.
      this.#entries = [];
    }
  }

  #cleanupRetention() {
    if (this.#retentionDays === 0) return;
    const cutoff = Date.now() - this.#retentionDays * 24 * 60 * 60 * 1000;
    this.#entries = this.#entries.filter((entry) => entry.timestamp >= cutoff);
  }

  #write() {
    try {
      fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
      const temporaryPath = `${this.#filePath}.tmp-${process.pid}`;
      fs.writeFileSync(temporaryPath, JSON.stringify({ version: HISTORY_VERSION, entries: this.#entries }), { mode: 0o600 });
      fs.renameSync(temporaryPath, this.#filePath);
    } catch {
      // History is an enhancement; a read-only profile must not break notifications.
    }
    this.#notifyChange();
  }

  #notifyChange() {
    if (this.#changeListener) {
      try {
        this.#changeListener(this.unreadCount());
      } catch {
        // A consumer failure must never break notification history writes.
      }
    }
  }
}

module.exports = NotificationHistoryService;
module.exports.categoryForType = categoryForType;
module.exports.normaliseRetentionDays = normaliseRetentionDays;
