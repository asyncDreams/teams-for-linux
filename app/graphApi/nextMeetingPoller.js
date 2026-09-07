'use strict';

/**
 * Next-meeting tray surface (Phase 3 calendar consumer).
 *
 * Periodically polls the Graph calendar view and forwards the current or next
 * meeting to the tray tooltip via `tray.setNextMeeting(...)`. Nothing here
 * touches Electron: the client and tray are injected, and time is injectable
 * via `nowMs` for deterministic unit tests.
 *
 * The tray stays dumb (it only renders what it is given), and this module owns
 * the Graph contract — the same layering as the notification service.
 */

const logger = require('electron-log');

/** Clamp bounds shared by config defaults and runtime guards. */
const LOOKAHEAD_MIN_MINUTES = 5;
const LOOKAHEAD_MAX_MINUTES = 120;
const POLL_MIN_MS = 15000;
const POLL_MAX_MS = 10 * 60 * 1000;

/** Events with this showAs are excluded; every other value (busy, tentative,
 * workingElsewhere, oof, unknown) counts as a real commitment. */
const FREE_SHOW_AS = 'free';

/**
 * Pure: pick the meeting to surface from a calendar-view page.
 *
 * Rules, in priority order:
 *   1. An ongoing (start <= now < end), non-cancelled, busy-ish event wins —
 *      even if a later event starts sooner than this one ends.
 *   2. Otherwise the soonest future start within the lookahead window.
 *   3. Cancelled, all-day, and explicitly-Free events are never candidates.
 *
 * @param {ReadonlyArray<object>} events Raw Graph calendarView events.
 * @param {number} nowMs Comparison instant (epoch ms).
 * @param {number} lookaheadMs How far ahead a *future* start may sit.
 * @returns {{ event: object | null, state: 'none' | 'upcoming' | 'ongoing' }}
 */
function pickNextMeeting(events, nowMs, lookaheadMs) {
  let ongoing = null;
  let earliestStart = null;
  let upcoming = null;

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.isCancelled) continue;
    if (event.isAllDay) continue;
    const showAs = String(event?.showAs || '').toLowerCase();
    if (showAs === FREE_SHOW_AS) continue;

    const startMs = Date.parse(event?.start?.dateTime || '');
    const endMs = Date.parse(event?.end?.dateTime || '');
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (endMs <= startMs) continue;

    if (startMs <= nowMs && nowMs < endMs) {
      // Overlapping ongoing events resolve deterministically: the one that
      // started earliest wins (ties keep the first seen).
      if (!ongoing || startMs < Date.parse(ongoing?.start?.dateTime || '')) {
        ongoing = event;
      }
      continue;
    }

    if (startMs > nowMs && startMs - nowMs <= lookaheadMs) {
      if (!earliestStart || startMs < earliestStart) {
        earliestStart = startMs;
        upcoming = event;
      }
    }
  }

  if (ongoing) return { event: ongoing, state: 'ongoing' };
  if (upcoming) return { event: upcoming, state: 'upcoming' };
  return { event: null, state: 'none' };
}

/**
 * Pure: render the picked meeting as a compact tray segment.
 * Ongoing meetings count up their minutes remaining; upcoming ones count down
 * to start. Titles are truncated defensively — Teams titles can be long and
 * the tooltip is a single line.
 *
 * @param {object | null} event Event from pickNextMeeting (or a raw event).
 * @param {'upcoming' | 'ongoing'} state
 * @param {number} nowMs Comparison instant (epoch ms).
 * @returns {string | null} Tooltip segment without the leading separator.
 */
function formatNextMeeting(event, state, nowMs) {
  if (!event) return null;

  const title = String(event?.subject || 'Meeting').trim() || 'Meeting';
  const trimmed = title.length > 30 ? `${title.slice(0, 29)}…` : title;

  const startMs = Date.parse(event?.start?.dateTime || '');
  const endMs = Date.parse(event?.end?.dateTime || '');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  if (state === 'ongoing') {
    const minutesLeft = Math.max(0, Math.round((endMs - nowMs) / 60000));
    return `Meeting now: ${trimmed} (${minutesLeft}m left)`;
  }

  const minutesUntil = Math.round((startMs - nowMs) / 60000);
  if (minutesUntil < 1) {
    return `Meeting now: ${trimmed}`;
  }
  return `Next: ${trimmed} in ${minutesUntil}m`;
}

/**
 * Poll the calendar and publish the current/next meeting to the tray.
 */
class NextMeetingPoller {
  /**
   * @param {object} params
   * @param {object} params.client GraphApiClient (uses getCalendarView).
   * @param {object} params.config Resolved startup config.
   * @param {{ setNextMeeting: (m: object | null) => void }} params.tray
   *   ApplicationTray; may arrive later via setTray().
   * @param {() => number} [params.nowMs] Injectable clock.
   */
  constructor({ client, config, tray = null, nowMs = () => Date.now() }) {
    this.client = client;
    this.config = config;
    this.tray = tray;
    this._nowMs = nowMs;
    this._interval = null;
    this._startTimeout = null;
  }

  isEnabled() {
    return Boolean(
      this.config?.graphApi?.enabled &&
        this.config?.graphApi?.nextMeeting?.enabled &&
        this.client
    );
  }

  /** Attach the tray when it is created after the poller starts. */
  setTray(tray) {
    this.tray = tray;
    // If we already know a meeting, publish it immediately so the tooltip is
    // correct from the first render rather than waiting a full poll cycle.
    if (tray && this.lastMeeting) {
      tray.setNextMeeting(this.lastMeeting);
    }
  }

  /** Clamp helper — exported bounds, applied to user config values. */
  static clampLookaheadMinutes(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 30;
    return Math.max(LOOKAHEAD_MIN_MINUTES, Math.min(Math.round(n), LOOKAHEAD_MAX_MINUTES));
  }

  static clampPollIntervalMs(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 60000;
    return Math.max(POLL_MIN_MS, Math.min(Math.round(n), POLL_MAX_MS));
  }

  start() {
    if (!this.isEnabled()) {
      logger.debug('[GRAPH_API] NextMeetingPoller not enabled; skipping start');
      return;
    }
    if (this._interval || this._startTimeout) return; // idempotent
    this._interval = setInterval(() => this.poll(), NextMeetingPoller.clampPollIntervalMs(
      this.config.graphApi.nextMeeting.pollIntervalMs
    ));
    // First poll shortly after startup so the tooltip populates quickly but
    // does not contend with window creation.
    this._startTimeout = setTimeout(() => {
      this._startTimeout = null;
      this.poll();
    }, 5000);
    logger.info('[GRAPH_API] NextMeetingPoller started');
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    if (this._startTimeout) {
      clearTimeout(this._startTimeout);
      this._startTimeout = null;
    }
    logger.debug('[GRAPH_API] NextMeetingPoller stopped');
    // Safe even if the tray is gone — setNextMeeting guards a destroyed tray.
    this.tray?.setNextMeeting(null);
  }

  /** One calendar fetch + tray publish. Never throws. */
  async poll() {
    if (!this.isEnabled()) return;
    const now = this._nowMs();
    const lookaheadMinutes = NextMeetingPoller.clampLookaheadMinutes(
      this.config.graphApi.nextMeeting.lookaheadMinutes
    );
    const start = new Date(now).toISOString();
    const end = new Date(now + lookaheadMinutes * 60000).toISOString();

    let result;
    try {
      result = await this.client.getCalendarView(start, end, {
        top: 10,
        select: 'subject,start,end,isCancelled,isAllDay,showAs',
      });
    } catch (error) {
      logger.warn('[GRAPH_API] Next-meeting poll request failed', { message: error?.message });
      return;
    }

    if (!result?.success) {
      // Expected on tenants without Calendar.Read consent; warn quietly.
      logger.debug('[GRAPH_API] Next-meeting poll unavailable', { status: result?.status });
      return;
    }

    const events = Array.isArray(result.data?.value) ? result.data.value : [];
    const { event, state } = pickNextMeeting(events, now, lookaheadMinutes * 60000);

    // A {event, state} pair, or null when the calendar is clear. The tray
    // formats it for display; this module owns the Graph contract only.
    const meeting = event ? { event, state } : null;
    this.lastMeeting = meeting;

    if (this.tray) {
      this.tray.setNextMeeting(meeting);
    }
  }
}

module.exports = {
  NextMeetingPoller,
  pickNextMeeting,
  formatNextMeeting,
  LOOKAHEAD_MIN_MINUTES,
  LOOKAHEAD_MAX_MINUTES,
  POLL_MIN_MS,
  POLL_MAX_MS,
};