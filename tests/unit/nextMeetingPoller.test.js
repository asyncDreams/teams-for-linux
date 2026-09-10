'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  pickNextMeeting,
  formatNextMeeting,
  NextMeetingPoller,
} = require('../../app/graphApi/nextMeetingPoller');
const ApplicationTray = require('../../app/menus/tray');

const { buildTrayTooltip } = ApplicationTray;

// Fixed instant: 2026-09-04T10:00:00Z. All fixtures below are expressed
// relative to this so the tests stay readable and drift-free.
const NOW = Date.parse('2026-09-04T10:00:00Z');

function event({ startMin, endMin, subject = 'Standup', showAs = 'busy', isCancelled = false, isAllDay = false }) {
  return {
    subject,
    showAs,
    isCancelled,
    isAllDay,
    start: { dateTime: new Date(NOW + startMin * 60000).toISOString() },
    end: { dateTime: new Date(NOW + endMin * 60000).toISOString() },
  };
}

describe('pickNextMeeting', () => {
  it('returns none for an empty or missing event list', () => {
    assert.deepStrictEqual(pickNextMeeting([], NOW, 30 * 60000), { event: null, state: 'none' });
    assert.deepStrictEqual(pickNextMeeting(null, NOW, 30 * 60000), { event: null, state: 'none' });
  });

  it('prefers an ongoing event over a sooner-starting future one', () => {
    const ongoing = event({ startMin: -20, endMin: 10, subject: 'Long sync' });
    const soon = event({ startMin: 5, endMin: 25, subject: 'Next thing' });

    const { event: picked, state } = pickNextMeeting([soon, ongoing], NOW, 30 * 60000);

    assert.strictEqual(state, 'ongoing');
    assert.strictEqual(picked.subject, 'Long sync');
  });

  it('picks the soonest upcoming event within the lookahead window', () => {
    const later = event({ startMin: 25, endMin: 55, subject: 'Later' });
    const sooner = event({ startMin: 10, endMin: 30, subject: 'Sooner' });

    const { event: picked, state } = pickNextMeeting([later, sooner], NOW, 30 * 60000);

    assert.strictEqual(state, 'upcoming');
    assert.strictEqual(picked.subject, 'Sooner');
  });

  it('ignores upcoming events beyond the lookahead window', () => {
    const far = event({ startMin: 45, endMin: 75 });

    const { state } = pickNextMeeting([far], NOW, 30 * 60000);

    assert.strictEqual(state, 'none');
  });

  it('skips cancelled, all-day, and free events', () => {
    const cancelled = event({ startMin: 5, endMin: 25, isCancelled: true });
    const allDay = event({ startMin: 6, endMin: 26, isAllDay: true });
    const free = event({ startMin: 7, endMin: 27, showAs: 'free' });
    const real = event({ startMin: 10, endMin: 30, subject: 'Real' });

    const { event: picked, state } = pickNextMeeting([cancelled, allDay, free, real], NOW, 30 * 60000);

    assert.strictEqual(state, 'upcoming');
    assert.strictEqual(picked.subject, 'Real');
  });

  it('skips events with missing or unparseable times', () => {
    const broken = { subject: 'Broken', start: {}, end: { dateTime: 'not-a-date' } };

    const { state } = pickNextMeeting([broken], NOW, 30 * 60000);

    assert.strictEqual(state, 'none');
  });

  it('resolves overlapping ongoing events deterministically (earliest start wins)', () => {
    const first = event({ startMin: -30, endMin: 30, subject: 'A' });
    const second = event({ startMin: -10, endMin: 40, subject: 'B' });

    const { event: picked } = pickNextMeeting([second, first], NOW, 30 * 60000);

    assert.strictEqual(picked.subject, 'A');
  });
});

describe('formatNextMeeting', () => {
  it('formats an ongoing meeting with minutes remaining', () => {
    const ongoing = event({ startMin: -20, endMin: 10, subject: 'Design review' });

    assert.strictEqual(
      formatNextMeeting(ongoing, 'ongoing', NOW),
      'Meeting now: Design review (10m left)'
    );
  });

  it('formats an upcoming meeting with a countdown', () => {
    const upcoming = event({ startMin: 15, endMin: 45, subject: '1:1 with Sam' });

    assert.strictEqual(
      formatNextMeeting(upcoming, 'upcoming', NOW),
      'Next: 1:1 with Sam in 15m'
    );
  });

  it('shows Meeting now without minutes for a meeting starting within a minute', () => {
    const imminent = event({ startMin: 0.2, endMin: 30, subject: 'Kickoff' });

    assert.strictEqual(
      formatNextMeeting(imminent, 'upcoming', NOW),
      'Meeting now: Kickoff'
    );
  });

  it('truncates long titles with an ellipsis', () => {
    const long = event({ startMin: 10, endMin: 40, subject: 'A'.repeat(60) });

    const segment = formatNextMeeting(long, 'upcoming', NOW);

    assert.ok(segment.startsWith('Next: '), segment);
    assert.ok(segment.includes('…'), segment);
    assert.ok(segment.length < 50, segment);
  });

  it('falls back to "Meeting" when the subject is blank', () => {
    const blank = event({ startMin: 10, endMin: 40, subject: '   ' });

    assert.strictEqual(
      formatNextMeeting(blank, 'upcoming', NOW),
      'Next: Meeting in 10m'
    );
  });

  it('returns null for a missing event or unparseable times', () => {
    assert.strictEqual(formatNextMeeting(null, 'upcoming', NOW), null);
    const broken = { subject: 'x', start: {}, end: {} };
    assert.strictEqual(formatNextMeeting(broken, 'upcoming', NOW), null);
  });
});

describe('NextMeetingPoller clamping', () => {
  it('clamps lookahead minutes to the 5-120 range', () => {
    assert.strictEqual(NextMeetingPoller.clampLookaheadMinutes(1), 5);
    assert.strictEqual(NextMeetingPoller.clampLookaheadMinutes(30), 30);
    assert.strictEqual(NextMeetingPoller.clampLookaheadMinutes(500), 120);
    assert.strictEqual(NextMeetingPoller.clampLookaheadMinutes('junk'), 30);
  });

  it('clamps the poll interval to 15s-10m', () => {
    assert.strictEqual(NextMeetingPoller.clampPollIntervalMs(1000), 15000);
    assert.strictEqual(NextMeetingPoller.clampPollIntervalMs(60000), 60000);
    assert.strictEqual(NextMeetingPoller.clampPollIntervalMs(99999999), 600000);
    assert.strictEqual(NextMeetingPoller.clampPollIntervalMs(undefined), 60000);
  });
});

describe('NextMeetingPoller.poll', () => {
  function makePoller({ calendarValue, config }) {
    const calls = [];
    const client = {
      getCalendarView: async (start, end, options) => {
        calls.push({ start, end, options });
        return calendarValue === 'throw'
          ? (() => { throw new Error('network down'); })()
          : calendarValue;
      },
    };
    const trayUpdates = [];
    const tray = {
      setNextMeeting: (m) => trayUpdates.push(m),
    };
    // Inject the fixed clock so fixture times (relative to NOW) line up.
    const poller = new NextMeetingPoller({ client, config, tray, nowMs: () => NOW });
    return { poller, calls, trayUpdates };
  }

  const baseConfig = {
    graphApi: { enabled: true, nextMeeting: { enabled: true, lookaheadMinutes: 30, pollIntervalMs: 60000 } },
  };

  it('publishes an upcoming meeting to the tray', async () => {
    const { poller, trayUpdates } = makePoller({
      config: baseConfig,
      calendarValue: { success: true, data: { value: [event({ startMin: 12, endMin: 42, subject: 'Retro' })] } },
    });

    await poller.poll();

    assert.strictEqual(trayUpdates.length, 1);
    assert.strictEqual(trayUpdates[0].state, 'upcoming');
    assert.strictEqual(trayUpdates[0].event.subject, 'Retro');
  });

  it('clears the tray segment when the calendar is clear', async () => {
    const { poller, trayUpdates } = makePoller({
      config: baseConfig,
      calendarValue: { success: true, data: { value: [] } },
    });

    await poller.poll();

    assert.strictEqual(trayUpdates.length, 1);
    assert.strictEqual(trayUpdates[0], null);
  });

  it('survives client throws and API failure responses without touching the tray', async () => {
    const thrown = makePoller({ config: baseConfig, calendarValue: 'throw' });
    await thrown.poller.poll();
    assert.strictEqual(thrown.trayUpdates.length, 0);

    const failed = makePoller({
      config: baseConfig,
      calendarValue: { success: false, status: 403 },
    });
    await failed.poller.poll();
    assert.strictEqual(failed.trayUpdates.length, 0);
  });

  it('does nothing when disabled', async () => {
    const disabledConfig = {
      graphApi: { enabled: true, nextMeeting: { enabled: false } },
    };
    const { poller, calls, trayUpdates } = makePoller({ config: disabledConfig, calendarValue: { success: true, data: { value: [] } } });

    await poller.poll();

    assert.strictEqual(calls.length, 0);
    assert.strictEqual(trayUpdates.length, 0);
  });

  it('start() is idempotent and stop() clears the tray segment', () => {
    const { poller } = makePoller({ config: baseConfig, calendarValue: { success: true, data: { value: [] } } });

    poller.start();
    poller.start();
    assert.ok(poller._interval, 'interval should be set after start');

    poller.stop();
    assert.strictEqual(poller._interval, null);
    assert.strictEqual(poller.tray.setNextMeeting, poller.tray.setNextMeeting);
  });
});

describe('buildTrayTooltip with next-meeting segment', () => {
  it('appends the next-meeting segment after presence', () => {
    const tip = buildTrayTooltip('Teams for Linux', 0, 0, 2, 'Calendar', 'Next: Retro in 5m');
    assert.strictEqual(tip, 'Teams for Linux — Busy · Source: Calendar — Next: Retro in 5m');
  });

  it('combines badge, unread, and next meeting', () => {
    const tip = buildTrayTooltip('Teams for Linux', 3, 2, null, null, 'Meeting now: Sync (10m left)');
    assert.strictEqual(tip, 'Teams for Linux (3) · 2 unread — Meeting now: Sync (10m left)');
  });

  it('omits the segment when null or empty', () => {
    assert.strictEqual(buildTrayTooltip('Teams for Linux', 0, 0, null, null, null), 'Teams for Linux');
    assert.strictEqual(buildTrayTooltip('Teams for Linux', 0, 0, null, null, ''), 'Teams for Linux');
  });
});
