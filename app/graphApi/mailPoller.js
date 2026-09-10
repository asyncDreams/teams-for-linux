'use strict';

/**
 * Mail preview notifications (Phase 3 remaining-gap item).
 *
 * Periodically polls Graph /me/messages for new mail in the inbox and shows a
 * system notification per unseen message, routed through the shared
 * NotificationService so history, sounds, and click actions behave exactly
 * like Teams notifications.
 *
 * Deduplication: Graph does not expose a read cursor suitable for polling, so
 * the poller tracks the ids of messages it has already announced (bounded
 * set) plus the newest seen `receivedDateTime`. Anything newer that is not
 * in the announced set is new.
 *
 * Client and clock are injectable so unit tests run without Electron.
 */

const logger = require('electron-log');

/** Bounded dedup set so memory stays flat over long sessions. */
const MAX_TRACKED_IDS = 500;
/** Clamp bounds shared by config defaults and runtime guards. */
const POLL_MIN_MS = 60 * 1000;
const POLL_MAX_MS = 30 * 60 * 1000;
/** Do not announce mail older than this on first run (avoid a history replay burst). */
const FIRST_RUN_MAX_AGE_MS = 5 * 60 * 1000;
const MAIL_FIELDS = 'subject,bodyPreview,from,receivedDateTime,webLink';

/**
 * Pure: decide which messages are "new" for notification purposes.
 * A message is new when it is not already announced, its received time is
 * at or after the newest previously-seen time, and (on a first run) it is
 * recent enough that announcing it is not a history replay.
 * @param {ReadonlyArray<object>} messages Graph messages (any order).
 * @param {{ announcedIds: ReadonlySet<string>, newestSeenMs: number, isFirstRun: boolean, nowMs: number }} state
 * @returns {Array<object>} New messages sorted oldest-first.
 */
function selectNewMessages(messages, { announcedIds, newestSeenMs, isFirstRun, nowMs }) {
  const seen = announcedIds instanceof Set ? announcedIds : new Set();
  const cutoffMs = isFirstRun ? nowMs - FIRST_RUN_MAX_AGE_MS : newestSeenMs;
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => {
      if (!message?.id || seen.has(message.id)) return false;
      const receivedMs = Date.parse(message?.receivedDateTime || '');
      if (!Number.isFinite(receivedMs)) return false;
      return receivedMs >= cutoffMs;
    })
    .sort((a, b) => Date.parse(a.receivedDateTime) - Date.parse(b.receivedDateTime));
}

/**
 * Pure: render one mail message as a NotificationService payload.
 * @param {object} message Graph message.
 * @returns {{ title: string, body: string, kind: string, conversation: string, deepLink: string|null, sender: object }}
 */
function formatMailNotification(message) {
  const senderName = String(message?.from?.emailAddress?.name || message?.from?.emailAddress?.address || 'Mail');
  const subject = String(message?.subject || '').trim() || '(No subject)';
  const preview = String(message?.bodyPreview || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  return {
    title: subject,
    body: preview ? `${senderName}: ${preview}` : senderName,
    kind: 'mail',
    conversation: 'Inbox',
    deepLink: typeof message?.webLink === 'string' ? message.webLink : null,
    sender: { displayName: senderName },
  };
}

/**
 * Poll the inbox and announce new mail through NotificationService.
 */
class MailPoller {
  /**
   * @param {object} params
   * @param {object} params.client GraphApiClient.
   * @param {object} params.config Resolved startup config.
   * @param {{ showMailPreview?: (payload: object) => void }} [params.notifier]
   *   NotificationService; injected for tests.
   * @param {() => number} [params.nowMs] Injectable clock.
   */
  constructor({ client, config, notifier = null, nowMs = () => Date.now() }) {
    this.client = client;
    this.config = config;
    this.notifier = notifier;
    this._nowMs = nowMs;
    this._announcedIds = new Set();
    this._newestSeenMs = 0;
    this._firstRun = true;
    this._interval = null;
  }

  isEnabled() {
    return Boolean(
      this.config?.graphApi?.enabled &&
        this.config?.graphApi?.mailPreview?.enabled &&
        this.client &&
        this.notifier
    );
  }

  static clampPollIntervalMs(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 5 * 60 * 1000;
    return Math.max(POLL_MIN_MS, Math.min(Math.round(n), POLL_MAX_MS));
  }

  start() {
    if (!this.isEnabled() || this._interval) return;
    const interval = MailPoller.clampPollIntervalMs(
      this.config.graphApi.mailPreview.pollIntervalMs
    );
    this._interval = setInterval(() => {
      this.poll().catch((error) => {
        logger.warn('[GRAPH_API] Mail poll failed', { message: error?.message });
      });
    }, interval);
    logger.info('[GRAPH_API] MailPoller started', { intervalMs: interval });
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
      logger.debug('[GRAPH_API] MailPoller stopped');
    }
  }

  /**
   * One inbox fetch + announcement pass. Never throws.
   * @returns {Promise<number>} Number of messages announced.
   */
  async poll() {
    if (!this.isEnabled()) return 0;
    const now = this._nowMs();
    const isFirstRun = this._firstRun;
    this._firstRun = false;

    let result;
    try {
      result = await this.client.getMailMessages({
        top: 10,
        select: MAIL_FIELDS,
        orderby: 'receivedDateTime desc',
      });
    } catch (error) {
      logger.warn('[GRAPH_API] Mail poll request failed', { message: error?.message });
      return 0;
    }

    if (!result?.success) {
      // Expected on tenants without Mail.Read consent; keep it quiet.
      logger.debug('[GRAPH_API] Mail poll unavailable', { status: result?.status });
      return 0;
    }

    const messages = Array.isArray(result.data?.value) ? result.data.value : [];
    const fresh = selectNewMessages(messages, {
      announcedIds: this._announcedIds,
      newestSeenMs: this._newestSeenMs,
      isFirstRun,
      nowMs: now,
    });

    // Advance the cursor and dedup set even if nothing is announced.
    for (const message of messages) {
      const receivedMs = Date.parse(message?.receivedDateTime || '');
      if (Number.isFinite(receivedMs) && receivedMs > this._newestSeenMs) {
        this._newestSeenMs = receivedMs;
      }
      if (message?.id) {
        this._announcedIds.add(message.id);
        if (this._announcedIds.size > MAX_TRACKED_IDS) {
          // Drop the oldest ids (Set preserves insertion order).
          const excess = this._announcedIds.size - MAX_TRACKED_IDS;
          let dropped = 0;
          for (const id of this._announcedIds) {
            if (dropped++ >= excess) break;
            this._announcedIds.delete(id);
          }
        }
      }
    }

    for (const message of fresh) {
      try {
        this.notifier.showMailPreview(formatMailNotification(message));
      } catch (error) {
        logger.warn('[GRAPH_API] Mail notification failed', { message: error?.message });
      }
    }
    if (fresh.length > 0) {
      logger.info('[GRAPH_API] Mail preview announced', { count: fresh.length });
    }
    return fresh.length;
  }

  /** Test hook: number of tracked message ids. */
  get trackedCount() {
    return this._announcedIds.size;
  }
}

module.exports = {
  MailPoller,
  selectNewMessages,
  formatMailNotification,
  MAIL_FIELDS,
  POLL_MIN_MS,
  POLL_MAX_MS,
  MAX_TRACKED_IDS,
  FIRST_RUN_MAX_AGE_MS,
};
