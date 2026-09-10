'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  MeetingWindowManager,
  extractMeetingKey,
  meetingWindowTitle,
  isCallOrMeetingRouteUrl,
  MAX_MEETING_WINDOWS,
} = require('../../app/mainAppWindow/meetingWindowManager');

const JOIN_URL =
  'https://teams.cloud.microsoft/l/meetup-join/19%3Ameeting_ZTg0YzAtOGVm%40thread.v2/0?context=%7B%22Tid%22%3A%22org%22%7D';
const JOIN_URL_ALT_HOST =
  'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_ZTg0YzAtOGVm%40thread.v2/0?context=%7B%22Tid%22%3A%22org%22%7D';
const JOIN_URL_2 =
  'https://teams.cloud.microsoft/l/meetup-join/19%3Ameeting_9999%40thread.v2/0';

function fakeWindow(overrides = {}) {
  const listeners = new Map();
  const register = (name, fn) => {
    const list = listeners.get(name) || [];
    list.push(fn);
    listeners.set(name, list);
  };
  return {
    id: overrides.id ?? Math.floor(Math.random() * 1e6),
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    show: () => {},
    focus: () => {},
    restore: () => {},
    destroy: () => {},
    on: (name, fn) => {
      register(name, fn);
    },
    once: (name, fn) => {
      register(name, fn);
    },
    emit: (name, ...args) => {
      for (const fn of listeners.get(name) || []) fn(...args);
    },
    webContents: {
      loadURL: overrides.loadURL ?? (() => {}),
      setWindowOpenHandler: () => {},
    },
    ...overrides,
  };
}

function baseConfig(overrides = {}) {
  return {
    meetupJoinPopOutWindow: true,
    chromeUserAgent: 'test-agent',
    menubar: 'auto',
    partition: 'persist:teams-4-linux',
    ...overrides,
  };
}

function makeManager({ config, windowOverrides, now } = {}) {
  let nextId = 1;
  const created = [];
  const createWindow = (options) => {
    const win = fakeWindow({ id: nextId++, ...windowOverrides });
    created.push({ options, window: win });
    return win;
  };
  const manager = new MeetingWindowManager({
    config: config ?? baseConfig(),
    createWindow,
    ...(now ? { now } : {}),
  });
  return { manager, created };
}

describe('extractMeetingKey', () => {
  it('extracts the meeting id from a meetup-join thread id', () => {
    assert.equal(extractMeetingKey(JOIN_URL), '19:meeting_ZTg0YzAtOGVm');
  });

  it('is host-independent (canonical and legacy hosts give the same key)', () => {
    assert.equal(extractMeetingKey(JOIN_URL_ALT_HOST), '19:meeting_ZTg0YzAtOGVm');
  });

  it('tolerates v2-style meet paths', () => {
    const url = 'https://teams.cloud.microsoft/meet/9322879383989';
    assert.equal(extractMeetingKey(url), '9322879383989');
  });

  it('keeps ids without an @ intact', () => {
    const url = 'https://teams.cloud.microsoft/l/meetup-join/plainid/0';
    assert.equal(extractMeetingKey(url), 'plainid');
  });

  it('returns null for non-meeting URLs and bad input', () => {
    assert.equal(extractMeetingKey('https://teams.cloud.microsoft/l/chat/0/0'), null);
    assert.equal(extractMeetingKey('not a url'), null);
    assert.equal(extractMeetingKey(''), null);
    assert.equal(extractMeetingKey(null), null);
    assert.equal(extractMeetingKey(42), null);
  });

  it('returns null for non-http(s) protocols', () => {
    assert.equal(extractMeetingKey('msteams:/l/meetup-join/19:meeting_x@thread.v2/0'), null);
  });
});

describe('meetingWindowTitle', () => {
  it('never embeds meeting identifiers (PII)', () => {
    assert.equal(meetingWindowTitle(), 'Meeting — Teams for Linux');
    assert.doesNotMatch(meetingWindowTitle(), /meeting_|thread/i);
  });
});

describe('MeetingWindowManager', () => {
  it('is disabled unless meetupJoinPopOutWindow is set', () => {
    const { manager, created } = makeManager({
      config: baseConfig({ meetupJoinPopOutWindow: false }),
    });
    assert.equal(manager.isEnabled(), false);
    assert.equal(manager.openMeeting(JOIN_URL), null);
    assert.equal(manager.size, 0);
    assert.equal(created.length, 0);
  });

  it('creates a window with the main window’s session posture and loads the URL', () => {
    const { manager, created } = makeManager({});
    const win = manager.openMeeting(JOIN_URL);
    assert.ok(win);
    assert.equal(manager.size, 1);
    assert.equal(created.length, 1);
    const prefs = created[0].options.webPreferences;
    assert.equal(prefs.partition, 'persist:teams-4-linux');
    assert.equal(prefs.contextIsolation, false);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(created[0].options.autoHideMenuBar, true);
  });

  it('passes the configured user agent to loadURL', () => {
    const loadCalls = [];
    const { manager } = makeManager({
      windowOverrides: { loadURL: (url, opts) => loadCalls.push({ url, opts }) },
    });
    manager.openMeeting(JOIN_URL);
    assert.equal(loadCalls.length, 1);
    assert.equal(loadCalls[0].opts.userAgent, 'test-agent');
  });

  it('re-joining the same meeting focuses the existing window, not a new one', () => {
    const { manager, created } = makeManager({});
    const first = manager.openMeeting(JOIN_URL);
    const second = manager.openMeeting(JOIN_URL_ALT_HOST);
    assert.equal(manager.size, 1);
    assert.equal(created.length, 1);
    assert.equal(second, first);
  });

  it('opens separate windows for different meetings', () => {
    const { manager } = makeManager({});
    manager.openMeeting(JOIN_URL);
    manager.openMeeting(JOIN_URL_2);
    assert.equal(manager.size, 2);
    assert.equal(manager.getAllWindows().length, 2);
  });

  it('evicts the oldest window when the limit is reached', () => {
    let tick = 0;
    const { manager, created } = makeManager({ now: () => tick++ });
    for (let i = 0; i < MAX_MEETING_WINDOWS; i++) {
      manager.openMeeting(JOIN_URL.replace('ZTg0YzAtOGVm', `meeting_${i}`));
    }
    assert.equal(manager.size, MAX_MEETING_WINDOWS);

    let destroyed = 0;
    const oldest = created[0].window;
    const realDestroy = oldest.destroy.bind(oldest);
    oldest.destroy = () => {
      destroyed++;
      realDestroy();
    };

    manager.openMeeting(JOIN_URL_2);
    assert.equal(manager.size, MAX_MEETING_WINDOWS);
    assert.equal(created.length, MAX_MEETING_WINDOWS + 1);
    assert.equal(destroyed, 1);
  });

  it('closeMeeting destroys and removes the window', () => {
    const { manager } = makeManager({});
    manager.openMeeting(JOIN_URL);
    assert.equal(manager.closeMeeting('19:meeting_ZTg0YzAtOGVm'), true);
    assert.equal(manager.size, 0);
    assert.equal(manager.closeMeeting('missing'), false);
  });

  it('cleans up when the window closes itself', () => {
    const { manager } = makeManager({});
    manager.openMeeting(JOIN_URL);
    assert.equal(manager.size, 1);
    manager.getAllWindows()[0].emit('closed');
    assert.equal(manager.size, 0);
  });

  it('closeAll destroys every window', () => {
    const { manager } = makeManager({});
    manager.openMeeting(JOIN_URL);
    manager.openMeeting(JOIN_URL_2);
    manager.closeAll();
    assert.equal(manager.size, 0);
    assert.equal(manager.getAllWindows().length, 0);
  });

  it('getMeetingWindow prunes destroyed windows', () => {
    const { manager } = makeManager({});
    const win = manager.openMeeting(JOIN_URL);
    win.isDestroyed = () => true;
    assert.equal(manager.getMeetingWindow('19:meeting_ZTg0YzAtOGVm'), null);
    assert.equal(manager.size, 0);
  });

  it('ignores empty URLs', () => {
    const { manager } = makeManager({});
    assert.equal(manager.openMeeting(''), null);
    assert.equal(manager.openMeeting(null), null);
    assert.equal(manager.size, 0);
  });

  it('constructs without an injected createWindow (production path)', () => {
    // Production builds the manager without deps; the BrowserWindow default
    // is only invoked on openMeeting, so constructing must not throw.
    const manager = new MeetingWindowManager({ config: baseConfig() });
    assert.equal(manager.isEnabled(), true);
    assert.equal(manager.size, 0);
  });
});

describe('isCallOrMeetingRouteUrl', () => {
  it('matches meeting and call route shapes', () => {
    assert.equal(
      isCallOrMeetingRouteUrl('https://teams.cloud.microsoft/l/meetup-join/19%3Ameeting_x%40thread.v2/0?context={}'),
      true,
      'meetup-join route'
    );
    assert.equal(
      isCallOrMeetingRouteUrl('https://teams.cloud.microsoft/l/call/0/0/0?transcriptId=x'),
      true,
      'in-chat call route'
    );
    assert.equal(isCallOrMeetingRouteUrl('https://teams.cloud.microsoft/meet/abc123'), true, 'short meet route');
    assert.equal(
      isCallOrMeetingRouteUrl('https://teams.cloud.microsoft/v2/call/abc'),
      true,
      'v2 call route'
    );
    assert.equal(
      isCallOrMeetingRouteUrl('https://teams.cloud.microsoft/v2/?meetingjoin=abc'),
      true,
      'classic calling container'
    );
  });

  it('does not match ordinary Teams surfaces', () => {
    assert.equal(isCallOrMeetingRouteUrl('https://teams.cloud.microsoft/l/chats/19:x@thread.v2'), false, 'chats route');
    assert.equal(isCallOrMeetingRouteUrl('https://teams.cloud.microsoft/l/channel/19:x/General'), false, 'channel route');
    assert.equal(isCallOrMeetingRouteUrl('https://teams.cloud.microsoft/calendar'), false, 'calendar route');
    assert.equal(isCallOrMeetingRouteUrl('https://teams.cloud.microsoft/l/app/abc'), false, 'app route');
    assert.equal(isCallOrMeetingRouteUrl('https://teams.cloud.microsoft/v2/'), false, 'v2 without meetingjoin');
  });

  it('rejects non-Teams hosts, non-http protocols and garbage', () => {
    assert.equal(isCallOrMeetingRouteUrl('https://evil.example.com/l/call/0/0/0'), false, 'foreign host');
    assert.equal(isCallOrMeetingRouteUrl('msteams://teams.cloud.microsoft/l/call/0/0/0'), false, 'non-http protocol');
    assert.equal(isCallOrMeetingRouteUrl(''), false, 'empty');
    assert.equal(isCallOrMeetingRouteUrl(null), false, 'null');
    assert.equal(isCallOrMeetingRouteUrl('not a url'), false, 'unparseable');
  });
});
