'use strict';

/**
 * Meeting pop-out window manager — native-Teams-style "pop out meeting".
 *
 * When `meetupJoinPopOutWindow` is enabled, a meeting join opens in a
 * dedicated BrowserWindow sharing the main window's session partition
 * (cookies/SSO carry over) and the same preload script. The main window
 * stays on chat/calendar instead of navigating away.
 *
 * Lifecycle: one window per meeting (keyed by the meeting's organizer id /
 * thread id, extracted from the join URL), closed by its own close button
 * or by `closeAll()` on app quit. Re-joining the same meeting focuses the
 * existing window rather than stacking duplicates.
 */

const { BrowserWindow } = require('electron');
const path = require('node:path');

/** Maximum simultaneously open meeting windows (leak guard). */
const MAX_MEETING_WINDOWS = 4;

/**
 * Extracts a stable key identifying the meeting a join URL points to.
 *
 * Teams join URLs embed the meeting's thread id, whose final segment is
 * unique per meeting (organizer org id + meeting id), e.g.
 *   .../meetup-join/19:meeting_ZTg...@thread.v2/...?...
 * Also tolerates v2-style `meet` paths. Returns null when no meeting id
 * can be found — the caller then falls back to the whole URL as the key.
 *
 * Pure function: no Electron, no module state.
 *
 * @param {string} url
 * @returns {string|null} meeting key or null
 */
function extractMeetingKey(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    // Path shapes: /meetup-join/<threadId>/<...> or /meet/<id>
    const segments = parsed.pathname.split('/').filter(Boolean);
    const meetupIdx = segments.findIndex(
      (s) => s === 'meetup-join' || s === 'meet'
    );
    if (meetupIdx === -1 || meetupIdx + 1 >= segments.length) return null;
    const id = decodeURIComponent(segments[meetupIdx + 1]);
    if (!id) return null;
    // Keep only the meeting-identifying portion of the thread id
    // ("19:meeting_...@thread.v2" → "19:meeting_...").
    const atIdx = id.indexOf('@');
    return atIdx > 0 ? id.slice(0, atIdx) : id;
  } catch {
    return null;
  }
}

/**
 * Returns the window title for a meeting window. Teams sets the document
 * title itself once loaded ("Meeting in ..."), so this is only the
 * pre-load placeholder. Kept meeting-agnostic on purpose: meeting ids are
 * user-identifying data and must not be surfaced in window titles.
 * Pure function.
 *
 * @returns {string}
 */
function meetingWindowTitle() {
  return `Meeting — Teams for Linux`;
}

/**
 * Manages the set of open meeting pop-out windows.
 *
 * Injectable for tests: `deps.createWindow(options)` defaults to
 * `new BrowserWindow(...)`, `deps.now` to Date.now.
 */
class MeetingWindowManager {
  // windows: Map<meetingKey, { window, windowId, url, createdAt }>
  #windows = new Map();
  #config;
  #iconImage;
  #createWindow;
  #now;
  #backgroundColor;

  constructor({ config, iconImage, backgroundColor, createWindow, now } = {}) {
    this.#config = config;
    this.#iconImage = iconImage ?? undefined;
    this.#backgroundColor = backgroundColor;
    this.#createWindow = createWindow;
    this.#now = now ?? Date.now;
  }

  get size() {
    return this.#windows.size;
  }

  /**
   * Whether the pop-out feature is enabled and actionable.
   */
  isEnabled() {
    return Boolean(this.#config?.meetupJoinPopOutWindow);
  }

  /**
   * Opens (or focuses) the meeting window for a join URL.
   *
   * @param {string} url - normalized https join URL
   * @returns {Electron.BrowserWindow|null} the meeting window, or null when
   *   the feature is disabled or the window limit is reached
   */
  openMeeting(url) {
    if (!this.isEnabled()) return null;
    if (!url || typeof url !== 'string') return null;

    const key = extractMeetingKey(url) ?? url;
    const existing = this.#windows.get(key);
    if (existing && existing.window && !existing.window.isDestroyed()) {
      this.#reveal(existing.window);
      existing.window.webContents.loadURL(url, {
        userAgent: this.#config.chromeUserAgent,
      });
      return existing.window;
    }

    if (this.#windows.size >= MAX_MEETING_WINDOWS) {
      // Close the oldest window to make room rather than silently failing.
      const oldest = [...this.#windows.values()].sort(
        (a, b) => a.createdAt - b.createdAt
      )[0];
      if (oldest?.window && !oldest.window.isDestroyed()) {
        oldest.window.destroy();
      }
      if (oldest) this.#windows.delete(oldest.key);
    }

    const window = this.#createWindow({
      title: meetingWindowTitle(),
      width: 1280,
      height: 800,
      minWidth: 640,
      minHeight: 480,
      show: false,
      autoHideMenuBar: this.#config.menubar === 'auto',
      icon: this.#iconImage,
      backgroundColor: this.#backgroundColor,
      parent: undefined, // independent window — it must survive main-window focus changes
      webPreferences: {
        partition: this.#config.partition,
        preload: path.join(__dirname, '..', 'browser', 'preload.js'),
        plugins: true,
        spellcheck: true,
        webviewTag: true,
        // SECURITY: same posture as the main window (Teams DOM access
        // required, compensated by IPC validation in preload).
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    const entry = { window, windowId: window.id, url, key, createdAt: this.#now() };
    this.#windows.set(key, entry);

    window.on('closed', () => {
      if (this.#windows.get(key)?.windowId === window.id) {
        this.#windows.delete(key);
      }
    });

    window.webContents.setWindowOpenHandler((details) => {
      // Meeting sub-popups (pre-join device settings, reactions help, etc.):
      // allow as modal children, mirroring secureOpenLink's in-app mode.
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          modal: true,
          useContentSize: true,
          parent: window,
        },
      };
    });

    window.webContents.loadURL(url, {
      userAgent: this.#config.chromeUserAgent,
    });
    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) {
        window.show();
        window.focus();
      }
    });

    return window;
  }

  /**
   * Closes the window for a specific meeting key, if open.
   *
   * @param {string} meetingKey
   * @returns {boolean} true when a window was closed
   */
  closeMeeting(meetingKey) {
    const entry = this.#windows.get(meetingKey);
    if (!entry) return false;
    if (entry.window && !entry.window.isDestroyed()) {
      entry.window.destroy();
    }
    this.#windows.delete(meetingKey);
    return true;
  }

  /**
   * Returns the open window for a meeting key, if any.
   */
  getMeetingWindow(meetingKey) {
    const entry = this.#windows.get(meetingKey);
    if (!entry) return null;
    if (entry.window && !entry.window.isDestroyed()) return entry.window;
    this.#windows.delete(meetingKey);
    return null;
  }

  /**
   * All open meeting windows (destroyed ones pruned).
   */
  getAllWindows() {
    for (const [key, entry] of this.#windows) {
      if (!entry.window || entry.window.isDestroyed()) {
        this.#windows.delete(key);
      }
    }
    return [...this.#windows.values()].map((e) => e.window);
  }

  /**
   * Closes every open meeting window. Called on app quit.
   */
  closeAll() {
    for (const [, entry] of this.#windows) {
      if (entry.window && !entry.window.isDestroyed()) {
        entry.window.destroy();
      }
    }
    this.#windows.clear();
  }

  #reveal(window) {
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
  }
}

module.exports = {
  MeetingWindowManager,
  extractMeetingKey,
  meetingWindowTitle,
  MAX_MEETING_WINDOWS,
};
