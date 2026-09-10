'use strict';

/**
 * Meeting quick actions (Phase 3 remaining-gap item).
 *
 * Pure helpers that back the calendar panel's Accept / Tentative / Decline
 * buttons: they build the Graph respond endpoint and payload, validate the
 * user's response, and derive optimistic UI updates for the cached event.
 * The actual IPC wiring lives in calendarDeltaSync.js; the panel calls it
 * through `calendar-panel-respond`.
 *
 * Endpoint contract (Graph v1.0):
 *   POST /me/events/{id}/accept    { sendResponse?: boolean, proposedNewTime?: never }
 *   POST /me/events/{id}/tentativelyAccept { sendResponse?: boolean }
 *   POST /me/events/{id}/decline   { sendResponse?: boolean }
 *
 * Requires Calendars.ReadWrite consent; 403s surface as a normal failure
 * result so the panel can show a clear error without crashing.
 */

/** Valid response values for the respond IPC payload. */
const RESPONSE_VALUES = Object.freeze(['accepted', 'tentative', 'declined']);

/** Map from the public response value to the Graph action segment. */
const RESPONSE_ENDPOINTS = Object.freeze({
  accepted: 'accept',
  tentative: 'tentativelyAccept',
  declined: 'decline',
});

/** Map from the public response value to the Graph `responseStatus`. */
const RESPONSE_STATUS = Object.freeze({
  accepted: 'accepted',
  tentative: 'tentativelyAccepted',
  declined: 'declined',
});

/**
 * Pure: validate a respond payload.
 * @param {unknown} payload IPC payload.
 * @returns {{ ok: true, eventId: string, response: string, sendResponse: boolean }
 *   | { ok: false, error: string }}
 */
function parseRespondPayload(payload) {
  const eventId = typeof payload?.eventId === 'string' ? payload.eventId.trim() : '';
  if (!eventId) return { ok: false, error: 'Missing or invalid eventId' };
  const response = typeof payload?.response === 'string' ? payload.response.trim().toLowerCase() : '';
  if (!RESPONSE_VALUES.includes(response)) {
    return { ok: false, error: `Invalid response; expected one of ${RESPONSE_VALUES.join(', ')}` };
  }
  const sendResponse = payload?.sendResponse !== false;
  return { ok: true, eventId, response, sendResponse };
}

/**
 * Pure: build the Graph request for a response action.
 * @param {string} eventId Graph event id.
 * @param {'accepted'|'tentative'|'declined'} response
 * @param {boolean} sendResponse Whether to email attendees.
 * @returns {{ endpoint: string, options: object }}
 */
function buildRespondRequest(eventId, response, sendResponse) {
  return {
    endpoint: `/me/events/${encodeURIComponent(eventId)}/${RESPONSE_ENDPOINTS[response]}`,
    options: {
      method: 'POST',
      body: { sendResponse: Boolean(sendResponse) },
    },
  };
}

/**
 * Pure: optimistic cache patch for a responded event. Returns a shallow
 * clone with the new `responseStatus` so the panel can render the change
 * immediately; returns null when the event is unknown.
 * @param {object|null} event Cached Graph event.
 * @param {'accepted'|'tentative'|'declined'} response
 * @returns {object|null}
 */
function applyResponseStatus(event, response) {
  if (!event) return null;
  return { ...event, responseStatus: RESPONSE_STATUS[response] };
}

/**
 * Pure: decide whether a response action applies to an event. Meetings the
 * user organized, past events, and cancelled events are not actionable.
 * @param {object|null} event Cached Graph event.
 * @param {number} nowMs Injectable clock value.
 * @returns {boolean}
 */
function isEventRespondable(event, nowMs) {
  if (!event || event.isCancelled) return false;
  const endMs = Date.parse(event?.end?.dateTime || '');
  if (!Number.isFinite(endMs) || endMs <= nowMs) return false;
  // Graph marks organizer events with isOrganizer=true; older caches may
  // only carry responseStatus:'organizer'. Respond endpoints are for
  // invitations, so organizer events are excluded either way.
  if (event.isOrganizer === true) return false;
  if (event.isOrganizer === undefined && event.responseStatus === 'organizer') return false;
  return true;
}

module.exports = {
  RESPONSE_VALUES,
  RESPONSE_ENDPOINTS,
  RESPONSE_STATUS,
  parseRespondPayload,
  buildRespondRequest,
  applyResponseStatus,
  isEventRespondable,
};
