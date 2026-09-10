'use strict';

/**
 * Delta-query calendar sync (Phase 2 remaining-gap item) and the calendar
 * panel backend (Phase 3 "richer calendar surface").
 *
 * Two independent pieces:
 *
 * 1. CalendarDeltaSync — an in-memory cache of the user's calendar, kept
 *    fresh with Graph delta queries (`/me/calendarView/delta`). A full
 *    calendarView fetch happens only once per process; every later sync is
 *    an incremental delta. Polling on a timer when started, and always
 *    available on-demand for the calendar panel. Consumers read via
 *    `getEvents(startMs, endMs)`.
 *
 * 2. Calendar panel IPC handlers — request/response channels the calendar
 *    panel window uses to read the synced calendar. A delta sync instance
 *    runs on-demand here: the panel triggers `calendar-panel-refresh`,
 *    which performs a delta sync and returns the day's events.
 *
 * The window is thin (window/preload/html), mirroring
 * app/notifications/history*; this module owns the Graph contract.
 */

const logger = require('electron-log');
const { parseRespondPayload, buildRespondRequest, applyResponseStatus, isEventRespondable, RESPONSE_STATUS } = require('./meetingActions');

/** Fallback window when a consumer does not pass one. */
const DEFAULT_WINDOW_DAYS = 3;
/** Hard ceiling so a runaway caller cannot fetch years of calendar. */
const MAX_WINDOW_DAYS = 14;
/** Delta-link safety: re-baseline after this many days on one delta link. */
const DELTA_LINK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Cache pruning cadence. */
const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

/** Fields requested from Graph for cached events. */
const EVENT_SELECT = 'subject,bodyPreview,start,end,showAs,isAllDay,isCancelled,onlineMeetingUrl,location,attendees,organizer,responseStatus,isOrganizer';

/**
 * Pure: drop events that cannot matter to any consumer anymore.
 * @param {ReadonlyArray<object>} events
 * @param {number} nowMs
 * @returns {Array<object>} Events ending at/after the cutoff.
 */
function pruneStaleEvents(events, nowMs) {
  return (Array.isArray(events) ? events : []).filter((event) => {
    const endMs = Date.parse(event?.end?.dateTime || '');
    return Number.isFinite(endMs) && endMs > nowMs - 24 * 60 * 60 * 1000;
  });
}

/**
 * Pure: narrow cached events to [startMs, endMs), sorted by start time.
 * Cancelled events are dropped here rather than at cache-write time so the
 * delta engine can still recognize them as *changes* to known events.
 * @param {ReadonlyArray<object>} events
 * @param {number} startMs
 * @param {number} endMs
 * @returns {Array<object>}
 */
function selectEvents(events, startMs, endMs) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => {
      if (!event || event.isCancelled) return false;
      const start = Date.parse(event?.start?.dateTime || '');
      const end = Date.parse(event?.end?.dateTime || '');
      if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
      return start < endMs && end > startMs;
    })
    .sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime));
}

/**
 * Pure: reduce one delta response page into a Map keyed by event id.
 * Graph signals removal with `@removed`; updated and new events arrive as
 * normal entries that overwrite by id.
 * @param {Map<string, object>} acc Mutable accumulator.
 * @param {object} page Delta response page ({ value, '@removed' }).
 * @returns {Map<string, object>} The same accumulator.
 */
function applyDeltaPage(acc, page) {
  const removed = page?.['@removed'];
  if (Array.isArray(removed)) {
    for (const item of removed) {
      if (item?.id) acc.delete(item.id);
    }
  }
  const value = Array.isArray(page?.value) ? page.value : [];
  for (const event of value) {
    if (event?.id) acc.set(event.id, event);
  }
  return acc;
}

/**
 * Poll the Graph calendar with delta queries and keep an in-memory cache.
 * Client and clock are injectable so unit tests run without Electron.
 */
class CalendarDeltaSync {
  /**
   * @param {object} params
   * @param {object} params.client GraphApiClient.
   * @param {object} params.config Resolved startup config.
   * @param {() => number} [params.nowMs] Injectable clock.
   */
  constructor({ client, config, nowMs = () => Date.now() }) {
    this.client = client;
    this.config = config;
    this._nowMs = nowMs;
    this._cache = new Map();
    this._deltaLink = null;
    this._deltaLinkAge = 0;
    this._interval = null;
    this._syncing = false;
  }

  isEnabled() {
    return Boolean(
      this.config?.graphApi?.enabled &&
        this.config?.graphApi?.calendar?.enabled !== false &&
        this.client
    );
  }

  static clampSyncIntervalMs(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 5 * 60 * 1000;
    return Math.max(30 * 1000, Math.min(Math.round(n), 60 * 60 * 1000));
  }

  /** Start background delta polling (opt-in via graphApi.calendar.syncIntervalMs). */
  start() {
    if (!this.isEnabled() || this._interval) return;
    const interval = CalendarDeltaSync.clampSyncIntervalMs(
      this.config.graphApi.calendar.syncIntervalMs
    );
    this._interval = setInterval(() => {
      this.sync().catch((error) => {
        logger.warn('[GRAPH_API] Calendar delta sync failed', { message: error?.message });
      });
    }, interval);
    logger.info('[GRAPH_API] CalendarDeltaSync started', { intervalMs: interval });
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
      logger.debug('[GRAPH_API] CalendarDeltaSync stopped');
    }
  }

  /**
   * Run one sync pass (delta if we hold a link, full calendarView otherwise).
   * Never throws; returns the number of cached events afterwards.
   * @returns {Promise<number>}
   */
  async sync() {
    if (!this.isEnabled() || this._syncing) return this._cache.size;
    this._syncing = true;
    try {
      const now = this._nowMs();
      // Re-baseline when the delta link is older than the safety window —
      // Graph may expire links server-side without notice.
      if (this._deltaLink && now - this._deltaLinkAge > DELTA_LINK_MAX_AGE_MS) {
        this._deltaLink = null;
      }

      const endpoint = this._deltaLink || this.#buildInitialEndpoint(now);
      const result = await this.client.makeRequest(endpoint);

      if (!result?.success) {
        // 410 Gone means the delta link expired; drop it and let the next
        // call re-baseline with a full fetch.
        if (result?.status === 410) {
          logger.warn('[GRAPH_API] Delta link expired (410); will re-baseline');
          this._deltaLink = null;
        }
        return this._cache.size;
      }

      applyDeltaPage(this._cache, result.data);

      // Persist the next delta link when Graph provided one.
      const nextLink = result.data?.['@odata.nextLink'];
      const deltaLink = result.data?.['@odata.deltaLink'];
      if (typeof nextLink === 'string' && nextLink) {
        // More pages follow; sync() does not paginate eagerly. The next
        // scheduled run continues from the nextLink.
        this._deltaLink = nextLink;
      } else if (typeof deltaLink === 'string' && deltaLink) {
        this._deltaLink = deltaLink;
        this._deltaLinkAge = now;
      }

      this._prune();
      return this._cache.size;
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Initial full fetch: a bounded calendarView around now, requesting a
   * delta so subsequent passes can be incremental.
   * @param {number} nowMs
   */
  #buildInitialEndpoint(nowMs) {
    const daysBack = 1;
    const daysForward = DEFAULT_WINDOW_DAYS;
    const params = new URLSearchParams({
      startDateTime: new Date(nowMs - daysBack * 24 * 60 * 60 * 1000).toISOString(),
      endDateTime: new Date(nowMs + daysForward * 24 * 60 * 60 * 1000).toISOString(),
      $select: EVENT_SELECT,
    });
    return `/me/calendarView/delta?${params.toString()}`;
  }

  _prune() {
    for (const [id, event] of this._cache) {
      const endMs = Date.parse(event?.end?.dateTime || '');
      if (!Number.isFinite(endMs) || endMs < this._nowMs() - 24 * 60 * 60 * 1000) {
        this._cache.delete(id);
      }
    }
  }

  /**
   * Cached events overlapping [startMs, endMs), sorted by start. Pure read.
   * @param {number} startMs
   * @param {number} endMs
   */
  getEvents(startMs, endMs) {
    return selectEvents([...this._cache.values()], startMs, endMs);
  }

  /**
   * One cached event by id, or null. Pure read.
   * @param {string} eventId
   */
  getEventById(eventId) {
    return this._cache.get(eventId) || null;
  }

  /**
   * Optimistically patch one cached event (used by quick actions so the UI
   * reflects a successful respond immediately; the next delta sync confirms).
   * @param {string} eventId
   * @param {object} patch Shallow-merged into the cached event.
   * @returns {object|null} The patched event, or null when unknown.
   */
  patchEvent(eventId, patch) {
    const existing = this._cache.get(eventId);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    this._cache.set(eventId, updated);
    return updated;
  }

  /** Number of cached events (diagnostics/tests). */
  get size() {
    return this._cache.size;
  }
}

/**
 * Register the calendar-panel IPC handlers. The panel is the richer Phase 3
 * calendar surface; delta sync gives it an efficient refresh path.
 * @param {object} ipcMain Electron ipcMain
 * @param {object} params.client GraphApiClient
 * @param {object} params.config Resolved startup config
 * @param {CalendarDeltaSync|null} [params.deltaSync] Optional shared engine
 * @param {function(string): boolean} [params.joinMeeting] Opens a join URL in
 *   a pop-out meeting window; returns false when unavailable. The panel's
 *   Join button prefers it and falls back to the main window's deep-link
 *   navigation.
 * @param {function(string): boolean} [params.navigateToTeamsUrl] Navigates
 *   the main window to a Teams URL; defaults to the mainAppWindow export.
 */
function registerCalendarPanelHandlers(ipcMain, { client, config, deltaSync = null, joinMeeting = null, navigateToTeamsUrl = null, nowMs = Date.now }) {
  // Read cached calendar events for the panel window (day window by default).
  ipcMain.handle('calendar-panel-get-events', async (_event, payload) => {
    if (!client) return { success: false, error: 'Graph API not enabled' };
    try {
      const startMs = Number.isFinite(payload?.startMs) ? payload.startMs : nowMs();
      const endMs = Number.isFinite(payload?.endMs)
        ? payload.endMs
        : startMs + DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      const dayMs = 24 * 60 * 60 * 1000;
      const maxMs = MAX_WINDOW_DAYS * dayMs;
      const clampedEnd = Math.min(endMs, startMs + maxMs);
      if (deltaSync) {
        return { success: true, events: deltaSync.getEvents(startMs, clampedEnd) };
      }
      // No shared engine (delta sync disabled): fall back to a direct view.
      const result = await client.getCalendarView(
        new Date(startMs).toISOString(),
        new Date(clampedEnd).toISOString(),
        { select: EVENT_SELECT }
      );
      if (!result?.success) return result;
      return { success: true, events: selectEvents(result.data?.value || [], startMs, clampedEnd) };
    } catch (error) {
      logger.error('[GRAPH_API] calendar-panel-get-events failed:', { message: error.message });
      return { success: false, error: error.message };
    }
  });

  // Trigger a delta sync and return the refreshed event list for the panel.
  ipcMain.handle('calendar-panel-refresh', async () => {
    if (!client) return { success: false, error: 'Graph API not enabled' };
    try {
      if (deltaSync) {
        await deltaSync.sync();
        const now = nowMs();
        return { success: true, events: deltaSync.getEvents(now, now + MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000), synced: true };
      }
      // No engine: a full view refresh, capped to the panel window.
      const now = nowMs();
      const result = await client.getCalendarView(
        new Date(now).toISOString(),
        new Date(now + MAX_WINDOW_DAYS * 24 * 60 * 1000).toISOString(),
        { select: EVENT_SELECT }
      );
      if (!result?.success) return result;
      return { success: true, events: selectEvents(result.data?.value || [], now, now + MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000), synced: false };
    } catch (error) {
      logger.error('[GRAPH_API] calendar-panel-refresh failed:', { message: error.message });
      return { success: false, error: error.message };
    }
  });

  // Respond to a meeting invitation (accept/tentative/decline) and apply an
  // optimistic cache patch; the next delta sync confirms with the server.
  ipcMain.handle('calendar-panel-respond', async (_event, payload) => {
    if (!client) return { success: false, error: 'Graph API not enabled' };
    const parsed = parseRespondPayload(payload);
    if (!parsed.ok) return { success: false, error: parsed.error };
    try {
      const cached = deltaSync ? deltaSync.getEventById(parsed.eventId) : null;
      if (deltaSync && !cached) {
        return { success: false, error: 'Meeting not found in the local calendar cache' };
      }
      if (cached && !isEventRespondable(cached, nowMs())) {
        return { success: false, error: 'This meeting cannot be responded to (past, cancelled, or organized by you)' };
      }
      const { endpoint, options } = buildRespondRequest(parsed.eventId, parsed.response, parsed.sendResponse);
      const result = await client.makeRequest(endpoint, options);
      if (!result?.success) return result;
      let event = null;
      if (deltaSync && cached) {
        event = deltaSync.patchEvent(parsed.eventId, applyResponseStatus(cached, parsed.response));
        // Confirm in the background; the response above already succeeded.
        deltaSync.sync().catch(() => {});
      }
      return { success: true, response: parsed.response, event };
    } catch (error) {
      logger.error('[GRAPH_API] calendar-panel-respond failed:', { message: error.message });
      return { success: false, error: error.message };
    }
  });

  // Join a meeting from the panel: prefers the pop-out meeting window when
  // meetupJoinPopOutWindow is enabled, otherwise the main window's deep-link
  // path (in-app navigation) so the URL never lands in an external browser.
  ipcMain.handle('calendar-panel-join', async (_event, payload) => {
    const url = typeof payload?.url === 'string' ? payload.url.trim() : '';
    if (!url) return { success: false, error: 'No join URL provided' };
    try {
      if (typeof joinMeeting === 'function' && joinMeeting(url)) {
        return { success: true, via: 'popout' };
      }
      const navigate = navigateToTeamsUrl ?? require('../mainAppWindow').navigateToTeamsUrl;
      if (navigate(url)) return { success: true, via: 'main-window' };
      return { success: false, error: 'Could not open the meeting URL' };
    } catch (error) {
      logger.error('[GRAPH_API] calendar-panel-join failed:', { message: error.message });
      return { success: false, error: error.message };
    }
  });

  logger.debug('[GRAPH_API] Calendar panel IPC handlers registered');
}

module.exports = {
  CalendarDeltaSync,
  registerCalendarPanelHandlers,
  pruneStaleEvents,
  selectEvents,
  applyDeltaPage,
  EVENT_SELECT,
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  RESPONSE_STATUS,
};
