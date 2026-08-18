'use strict';

/**
 * Notification extractor — renderer-side normaliser for Teams toasts.
 *
 * Turns the lossy `new Notification(title, body, {icon})` call into a
 * structured `ParsedNotification` so the main process can show sender-
 * attributed, typed, grouped and actionable toasts.
 *
 * Design: `docs-site/docs/development/windows-parity/design-notification-extraction.md`
 *   shim (options.tag/data/icon) > hub-card DOM > title/body parse
 *   soft selectors — unmatched degrades to kind:"unknown" + passthrough
 */

const MAX_TEXT_LENGTH = 1000;
const MAX_ICON_DATA_URL_LENGTH = 32 * 1024; // 32 KiB cap for data: URLs in IPC

const KINDS = [
  'direct',
  'group',
  'channel',
  'mention',
  'meeting',
  'call',
  'missedCall',
  'unknown',
];

/** @type {Set<string>} quick lookup for validation in main */
const KIND_SET = new Set(KINDS);

/**
 * Cap a string to MAX_TEXT_LENGTH and trim. Non-strings → ''.
 */
function capText(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > MAX_TEXT_LENGTH
    ? trimmed.slice(0, MAX_TEXT_LENGTH)
    : trimmed;
}

/**
 * Best-effort sender extraction from a Teams notification title.
 * Teams often renders `"Sender Name: preview"` or `"Sender Name"` alone.
 * We only use the prefix before the first ": " when it looks like a name
 * (≤ 64 chars, no URL-like content). Never treat deepLink query as name.
 */
function parseTitleForSender(title) {
  if (typeof title !== 'string' || !title) return null;
  const idx = title.indexOf(': ');
  if (idx === -1) return null;
  const candidate = title.slice(0, idx).trim();
  if (!candidate || candidate.length > 64) return null;
  if (candidate.includes('http://') || candidate.includes('https://')) return null;
  if (candidate.includes('@') && candidate.includes('.')) return null; // email-like — don't mis-attribute
  return candidate;
}

/**
 * Classify kind from available signals.
 * Priority: mention > call/missedCall > meeting > channel > group > direct > unknown
 * All inputs are optional; missing signals degrade to unknown.
 *
 * @param {object} signals
 * @param {string} [signals.tag] - Notification.options.tag
 * @param {string} [signals.dataTid] - hub card data-tid / data-testid
 * @param {string} [signals.title]
 * @param {string} [signals.body]
 * @param {object} [signals.data] - Notification.options.data (opaque)
 * @returns {string} one of KINDS
 */
function classifyKind({ tag, dataTid, title, body, data } = {}) {
  const tagLower = typeof tag === 'string' ? tag.toLowerCase() : '';
  const tidLower = typeof dataTid === 'string' ? dataTid.toLowerCase() : '';
  const titleLower = typeof title === 'string' ? title.toLowerCase() : '';
  const bodyLower = typeof body === 'string' ? body.toLowerCase() : '';
  const haystack = `${tagLower} ${tidLower} ${titleLower} ${bodyLower}`;

  // Data object hints (Teams sometimes sets data.type / data.kind)
  const dataKind = data && typeof data === 'object'
    ? String(data.kind || data.type || data.notificationType || '').toLowerCase()
    : '';

  if (dataKind.includes('mention') || haystack.includes('mention') || haystack.includes('@mentioned')) {
    return 'mention';
  }
  if (
    haystack.includes('missed call') ||
    haystack.includes('missedcall') ||
    (tagLower.includes('call') && haystack.includes('missed')) ||
    dataKind.includes('missedcall')
  ) {
    return 'missedCall';
  }
  if (
    haystack.includes('incoming call') ||
    haystack.includes('incomingcall') ||
    (dataKind.includes('call') && !haystack.includes('missed')) ||
    tagLower.startsWith('call:')
  ) {
    // Distinguish missed already returned above
    return 'call';
  }
  if (
    haystack.includes('meeting') ||
    tagLower.includes('meeting') ||
    tidLower.includes('meeting') ||
    dataKind.includes('meeting')
  ) {
    return 'meeting';
  }
  if (
    haystack.includes('channel') ||
    tidLower.includes('channel') ||
    tagLower.includes('channel')
  ) {
    return 'channel';
  }
  if (
    haystack.includes('group') ||
    tagLower.includes('group') ||
    tidLower.includes('group')
  ) {
    return 'group';
  }
  // Tag prefix `chat:` or direct-like title without channel/meeting hints — treat as direct
  if (
    tagLower.startsWith('chat:') ||
    tagLower.includes('direct') ||
    tagLower.includes('im:')
  ) {
    return 'direct';
  }
  // If we have any tag/dataTid that looks chat-ish, prefer direct over unknown
  if (tagLower || tidLower) {
    // unknown tag shapes — stay unknown rather than guessing direct
    return 'unknown';
  }
  return 'unknown';
}

/**
 * Derive a stable grouping key from available signals.
 * Prefers explicit tag, then data.conversationId / threadId, then sender+title hash.
 * Returns null when no stable key is available — caller should fall back to notificationId.
 */
function deriveGroupingKey({ tag, data, title }) {
  if (typeof tag === 'string' && tag.trim()) return tag.trim().slice(0, 256);
  if (data && typeof data === 'object') {
    const candidate =
      data.conversationId ||
      data.conversationKey ||
      data.threadId ||
      data.chatId ||
      data.channelId ||
      data.teamChannelKey;
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().slice(0, 256);
    }
  }
  // Do not hash title — that would create PII in the key. Return null so main
  // uses notificationId as group fallback (no coalescing, but no PII leak).
  if (typeof title === 'string' && title.trim()) {
    // Use a short prefix of the title's structure without content? No — return null.
  }
  return null;
}

/**
 * Extract a deepLink from hub-card anchor if present. Soft — returns null on miss.
 * Only accepts https:// or msteams:// links and only when the host is a Teams host
 * (validated more strictly in main). Length-capped.
 */
function extractDeepLinkHref(href) {
  if (typeof href !== 'string' || !href) return null;
  const trimmed = href.trim().slice(0, 2048);
  if (!trimmed) return null;
  if (
    trimmed.startsWith('https://') ||
    trimmed.startsWith('msteams:') ||
    trimmed.startsWith('msteams://')
  ) {
    return trimmed;
  }
  return null;
}

/**
 * Probe the Teams notification hub DOM for the card nearest in time.
 * Soft selectors — any miss returns null fields, never throws.
 * Must be called synchronously from the Notification constructor context.
 *
 * @returns {{ senderName: string|null, avatarUrl: string|null, deepLink: string|null, dataTid: string|null }}
 */
function probeHubCard() {
  try {
    if (typeof document === 'undefined' || !document.querySelectorAll) {
      return { senderName: null, avatarUrl: null, deepLink: null, dataTid: null };
    }
    // Teams' toast container selectors — ordered by likelihood, all soft.
    const containerSelectors = [
      '[data-tid*=\"notification\" i]',
      '[data-testid*=\"notification\" i]',
      '[role=\"region\"][aria-label*=\"notification\" i]',
      '[data-tid*=\"toast\" i]',
    ];
    let container = null;
    for (const sel of containerSelectors) {
      try {
        const found = document.querySelector(sel);
        if (found) { container = found; break; }
      } catch { /* invalid selector on this DOM — try next */ }
    }
    // Fall back to whole document if no container found — but scope tightly
    const scope = container || document;

    // Find the most recent card: last element with an avatar + name-like text
    const cardSelectors = [
      '[data-tid*=\"notification-card\" i]',
      '[data-testid*=\"notification\" i]',
      '[role=\"alert\"]',
      '[class*=\"notification\" i]',
    ];
    let cards = [];
    for (const sel of cardSelectors) {
      try {
        const list = scope.querySelectorAll(sel);
        if (list && list.length) { cards = Array.from(list); break; }
      } catch { /* try next */ }
    }
    if (!cards.length) return { senderName: null, avatarUrl: null, deepLink: null, dataTid: null };

    const card = cards[cards.length - 1]; // most recent

    let senderName = null;
    let avatarUrl = null;
    let deepLink = null;
    let dataTid = null;

    try { dataTid = card.getAttribute('data-tid') || card.getAttribute('data-testid') || null; } catch { /* ignore */ }

    // Avatar: <img> or background-image
    try {
      const img = card.querySelector('img[src]');
      if (img) {
        const src = img.getAttribute('src') || img.src || '';
        if (src && (src.startsWith('data:') || src.startsWith('https://') || src.startsWith('blob:'))) {
          avatarUrl = src.slice(0, 4096);
        }
      } else {
        // background-image fallback — cap length
        const styleEl = card.querySelector('[style*=\"background-image\" i]');
        if (styleEl) {
          const bg = styleEl.style?.backgroundImage || '';
          const match = bg.match(/url\(["']?(.*?)["']?\)/i);
          if (match && match[1]) avatarUrl = match[1].slice(0, 4096);
        }
      }
    } catch { /* ignore */ }

    // Sender name: look for name node adjacent to avatar
    try {
      const nameSelectors = [
        '[data-tid*=\"sender\" i]',
        '[data-tid*=\"author\" i]',
        '[data-testid*=\"sender\" i]',
        '[class*=\"sender\" i]',
        '[class*=\"author\" i]',
        'strong',
        'b',
      ];
      for (const sel of nameSelectors) {
        const el = card.querySelector(sel);
        if (el && el.textContent) {
          const text = el.textContent.trim().slice(0, 128);
          if (text && text.length <= 64 && !text.includes('http')) {
            senderName = text;
            break;
          }
        }
      }
      // Fallback: first text node of card
      if (!senderName && card.textContent) {
        const firstLine = card.textContent.trim().split('\n')[0]?.trim().slice(0, 64);
        if (firstLine && firstLine.length <= 64) senderName = firstLine;
      }
    } catch { /* ignore */ }

    // Deep link: CTA anchor href
    try {
      const anchor = card.querySelector('a[href^=\"https://\"], a[href^=\"msteams:\"]');
      if (anchor) {
        deepLink = extractDeepLinkHref(anchor.getAttribute('href') || anchor.href || '');
      }
    } catch { /* ignore */ }

    return { senderName, avatarUrl, deepLink, dataTid };
  } catch {
    return { senderName: null, avatarUrl: null, deepLink: null, dataTid: null };
  }
}

/**
 * Build a ParsedNotification from the raw Notification constructor args
 * plus an optional hub probe result.
 *
 * @param {object} params
 * @param {string} params.title - Notification title
 * @param {object} [params.options] - Notification options (body, icon, tag, data, etc.)
 * @param {string} [params.notificationId] - crypto.randomUUID() for this toast
 * @param {object} [params.hubProbe] - result of probeHubCard() or null
 * @returns {object} ParsedNotification (see design doc §4)
 */
function buildParsedNotification({ title, options = {}, notificationId, hubProbe = null }) {
  const opts = options && typeof options === 'object' ? options : {};
  const rawTitle = capText(title);
  const rawBody = capText(opts.body);
  const rawTag = typeof opts.tag === 'string' ? opts.tag.slice(0, 512) : undefined;
  const rawData = opts.data && typeof opts.data === 'object' ? opts.data : undefined;

  // Icon: only accept data: or blob: or https: (capped). Never forward file: or bearer-bearing URLs verbatim.
  let iconDataUrl;
  if (typeof opts.icon === 'string' && opts.icon) {
    const icon = opts.icon.trim().slice(0, MAX_ICON_DATA_URL_LENGTH);
    if (icon.startsWith('data:') || icon.startsWith('blob:') || icon.startsWith('https://')) {
      iconDataUrl = icon;
    }
  }

  const hub = hubProbe || { senderName: null, avatarUrl: null, deepLink: null, dataTid: null };

  // Sender: hub card outranks title parse
  let senderDisplayName = null;
  if (hub.senderName) senderDisplayName = hub.senderName.slice(0, 128);
  else {
    const parsed = parseTitleForSender(rawTitle);
    if (parsed) senderDisplayName = parsed;
  }
  // Also check data for author
  if (!senderDisplayName && rawData && typeof rawData.senderName === 'string') {
    senderDisplayName = rawData.senderName.trim().slice(0, 128) || null;
  }

  // Avatar ref: hub avatar outranks icon data-URL; Graph photo is main-process fallback
  let avatarRef = null;
  if (hub.avatarUrl) avatarRef = hub.avatarUrl;
  else if (iconDataUrl && iconDataUrl.startsWith('data:')) avatarRef = iconDataUrl.slice(0, 4096);

  // Deep link
  let deepLink = null;
  if (hub.deepLink) deepLink = hub.deepLink;
  else if (rawData && typeof rawData.deepLink === 'string') deepLink = extractDeepLinkHref(rawData.deepLink);
  else if (rawData && typeof rawData.url === 'string') deepLink = extractDeepLinkHref(rawData.url);

  // Kind
  const kind = classifyKind({
    tag: rawTag,
    dataTid: hub.dataTid || (rawData && (rawData.tid || rawData.dataTid)) || null,
    title: rawTitle,
    body: rawBody,
    data: rawData,
  });

  const groupingKey = deriveGroupingKey({ tag: rawTag, data: rawData, title: rawTitle });

  // Display title: "<Sender>: <Preview>" when sender is reliable and kind warrants it
  let displayTitle = rawTitle;
  let displayBody = rawBody;
  if (senderDisplayName && kind !== 'unknown' && kind !== 'meeting' && kind !== 'call' && kind !== 'missedCall') {
    // Only prefix when title doesn't already start with sender
    if (!rawTitle.toLowerCase().startsWith(senderDisplayName.toLowerCase())) {
      // Use body as preview; if body empty, keep title as preview and prefix sender
      if (rawBody) {
        displayTitle = `${senderDisplayName}: ${rawTitle}`.slice(0, MAX_TEXT_LENGTH);
        displayBody = rawBody;
      } else {
        displayTitle = `${senderDisplayName}: ${rawTitle}`.slice(0, MAX_TEXT_LENGTH);
      }
    }
  }

  const parsed = {
    kind,
    title: displayTitle,
    body: displayBody,
    notificationId: notificationId || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `fallback-${Date.now()}`),
    rawTag,
  };

  if (senderDisplayName || avatarRef) {
    parsed.sender = {};
    if (senderDisplayName) parsed.sender.displayName = senderDisplayName;
    if (avatarRef) parsed.sender.avatarRef = avatarRef.slice(0, 4096);
    // userId if present in data
    if (rawData && typeof rawData.userId === 'string' && rawData.userId.trim()) {
      parsed.sender.userId = rawData.userId.trim().slice(0, 256);
    } else if (rawData && typeof rawData.senderId === 'string' && rawData.senderId.trim()) {
      parsed.sender.userId = rawData.senderId.trim().slice(0, 256);
    }
  }

  if (groupingKey) {
    parsed.conversation = { key: groupingKey };
    // Title for grouping display (team/channel context) — not PII-logged
    if (rawData && typeof rawData.conversationTitle === 'string' && rawData.conversationTitle.trim()) {
      parsed.conversation.title = rawData.conversationTitle.trim().slice(0, 256);
    }
  }

  if (deepLink) parsed.deepLink = deepLink;
  if (iconDataUrl) parsed.iconDataUrl = iconDataUrl;

  // Preserve original icon for main-process nativeImage fallback
  return parsed;
}

module.exports = {
  MAX_TEXT_LENGTH,
  MAX_ICON_DATA_URL_LENGTH,
  KINDS,
  KIND_SET,
  capText,
  parseTitleForSender,
  classifyKind,
  deriveGroupingKey,
  extractDeepLinkHref,
  probeHubCard,
  buildParsedNotification,
};
