'use strict';

const KEEP_ONLINE_MODES = Object.freeze({
  DISABLED: 'disabled',
  ALWAYS: 'always',
  BUSINESS_HOURS: 'business-hours',
});

const DEFAULT_BUSINESS_HOURS = Object.freeze({
  enabled: false,
  startTime: '09:00',
  endTime: '17:00',
  weekdays: Object.freeze([1, 2, 3, 4, 5]),
  timezone: '',
});

const WEEKDAY_BY_SHORT_NAME = Object.freeze({
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
});

function parseTime(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const match = /^(?:[01]?\d|2[0-3]):[0-5]\d$/.exec(value.trim());
  if (!match) return fallback;
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function formatTime(value, fallback) {
  const minutes = parseTime(value, parseTime(fallback, 0));
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function normalizeWeekdays(value) {
  if (!Array.isArray(value)) return [...DEFAULT_BUSINESS_HOURS.weekdays];
  const weekdays = [...new Set(value
    .map(Number)
    .filter((weekday) => Number.isInteger(weekday) && weekday >= 1 && weekday <= 7))]
    .sort((left, right) => left - right);
  return weekdays.length > 0 ? weekdays : [...DEFAULT_BUSINESS_HOURS.weekdays];
}

function isValidTimeZone(timeZone) {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

function resolveTimeZone(timeZone) {
  if (typeof timeZone === 'string' && isValidTimeZone(timeZone.trim())) {
    return timeZone.trim();
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function normalizeBusinessHours(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    enabled: source.enabled === true,
    startTime: formatTime(source.startTime, DEFAULT_BUSINESS_HOURS.startTime),
    endTime: formatTime(source.endTime, DEFAULT_BUSINESS_HOURS.endTime),
    weekdays: normalizeWeekdays(source.weekdays),
    timezone: resolveTimeZone(source.timezone),
  };
}

function normalizeMode(value, legacyKeepAlwaysOnline = false) {
  if (Object.values(KEEP_ONLINE_MODES).includes(value)) return value;
  return legacyKeepAlwaysOnline === true
    ? KEEP_ONLINE_MODES.ALWAYS
    : KEEP_ONLINE_MODES.DISABLED;
}

function normalizePresenceConfig(config = {}) {
  const presence = config?.presence && typeof config.presence === 'object'
    ? config.presence
    : config;
  return {
    mode: normalizeMode(presence?.keepAlwaysOnlineMode, presence?.keepAlwaysOnline),
    businessHours: normalizeBusinessHours(presence?.businessHours),
    smartPresence: presence?.smartPresence === true,
  };
}

function getLocalDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date)
    .filter(({ type }) => type !== 'literal')
    .map(({ type, value }) => [type, value]));
  return {
    weekday: WEEKDAY_BY_SHORT_NAME[parts.weekday],
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/**
 * Return whether a date falls inside the configured local business-hours
 * window. Overnight windows (for example 22:00-06:00) are supported and the
 * early-morning portion belongs to the previous configured weekday.
 */
function isWithinBusinessHours(date = new Date(), settings = {}) {
  const businessHours = normalizeBusinessHours(settings);
  if (!businessHours.enabled) return false;

  const { weekday, minutes } = getLocalDateParts(date, businessHours.timezone);
  const start = parseTime(businessHours.startTime, 9 * 60);
  const end = parseTime(businessHours.endTime, 17 * 60);
  const weekdays = businessHours.weekdays;

  if (start === end) return weekdays.includes(weekday);
  if (start < end) {
    return weekdays.includes(weekday) && minutes >= start && minutes < end;
  }

  const previousWeekday = weekday === 1 ? 7 : weekday - 1;
  return (weekdays.includes(weekday) && minutes >= start)
    || (weekdays.includes(previousWeekday) && minutes < end);
}

function shouldKeepOnline(config, date = new Date()) {
  const normalized = normalizePresenceConfig(config);
  if (normalized.mode === KEEP_ONLINE_MODES.ALWAYS) return true;
  if (normalized.mode !== KEEP_ONLINE_MODES.BUSINESS_HOURS) return false;
  return isWithinBusinessHours(date, normalized.businessHours);
}

function isBusyStatus(status) {
  if (status === 2 || status === 3) return true;
  if (typeof status !== 'string') return false;
  return ['busy', 'dnd', 'do-not-disturb', 'donotdisturb', 'presenting'].includes(
    status.toLowerCase().replaceAll(/\s+/g, '-'),
  );
}

/**
 * Decide if the activity nudge may run. Smart presence is deliberately an
 * additional guard: normal keep-online modes retain their existing behavior,
 * while smart mode yields to meetings, presenting, DND and explicit Busy.
 */
function shouldInjectKeepAlive(config, context = {}, date = new Date()) {
  const normalized = normalizePresenceConfig(config);
  if (!shouldKeepOnline(config, date)) return false;
  if (!normalized.smartPresence) return true;

  return !(
    context.inMeeting === true
    || context.callActive === true
    || context.presenting === true
    || context.screenSharing === true
    || context.dnd === true
    || context.explicitBusy === true
    || isBusyStatus(context.explicitStatus)
    || isBusyStatus(context.currentStatus)
  );
}

module.exports = {
  KEEP_ONLINE_MODES,
  DEFAULT_BUSINESS_HOURS,
  normalizeMode,
  normalizeBusinessHours,
  normalizePresenceConfig,
  isWithinBusinessHours,
  shouldKeepOnline,
  shouldInjectKeepAlive,
  parseTime,
};
