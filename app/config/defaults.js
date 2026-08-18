/**
 * Default configuration values and Teams host-table helpers.
 * This file is the single source of truth for Teams hosts / URL patterns.
 * It stays a plain data module (no Electron imports) so it can be required
 * by app/config/options.js and by the preload/renderer outside the main process,
 * and so unit tests can import it without initializing the full config system.
 */

// ---------------------------------------------------------------------------
// Host table — canonical host first. Add future Microsoft rings here;
// consumers derive their regexes / allow-lists from this table so a host
// change is a one-line patch rather than a 6-file literal hunt.
// ---------------------------------------------------------------------------

const TEAMS_HOSTS = [
  'teams.cloud.microsoft', // canonical — default url uses this
  'teams.microsoft.com',   // legacy
  'teams.live.com',        // personal
];

const TEAMS_CANONICAL_HOST = TEAMS_HOSTS[0];

// Microsoft Cloud App Security proxy suffix — tenants that route Teams
// through Defender for Cloud Apps store cookies at *.mcas.ms
const MCAS_SUFFIX = '.mcas.ms';

// Suffixes that denote a Teams-adjacent host even when not literally in
// TEAMS_HOSTS.  .cloud.microsoft tolerates future teams.{region}.cloud.microsoft
// without a code change; .mcas.ms is the strip-before-match wrapper above.
const TEAMS_HOST_SUFFIXES = ['.cloud.microsoft', '.mcas.ms'];

// CDN / legacy domains that are Teams-related but not navigational hosts
const TEAMS_CDN_HOSTS = ['statics.teams.cdn.office.net'];

// Auth-related domains whose cookies may need cleaning / whitelisting.
// Derived from TEAMS_HOSTS plus the well-known Microsoft identity hosts so
// a host-table change automatically propagates to session-cookie handling.
const AUTH_DOMAINS = [
  'login.microsoftonline.com',
  'login.microsoft.com',
  'microsoft.com',
  'office.com',
  'office365.com',
  'live.com',
  'microsoftonline.com',
  ...TEAMS_HOSTS,
];

const AUTH_LOGIN_DOMAINS = [
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.live.com',
];

// Legacy Teams protocol v1 — host-independent
const MS_TEAMS_PROTOCOL_V1 =
  '^msteams:/(?:meet/|l/(?:app|call|channel|chat|entity|file|meet(?:ing|up-join)|message|task|team)/)';

// ---------------------------------------------------------------------------
// Pure helpers — no side effects, no Electron, safe to unit-test in plain Node
// ---------------------------------------------------------------------------

function stripMcasSuffix(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) return hostname;
  return hostname.endsWith(MCAS_SUFFIX)
    ? hostname.slice(0, -MCAS_SUFFIX.length)
    : hostname;
}

/**
 * Returns true when hostname (optionally wrapped with .mcas.ms) denotes a
 * Teams host. Accepts:
 *  - exact TEAMS_HOSTS entries
 *  - single- or multi-label subdomains of a TEAMS_HOST (e.g. foo.teams.cloud.microsoft)
 *  - future regional form teams.*.cloud.microsoft (teams.<region>.cloud.microsoft)
 * Host comparison is case-insensitive; caller should have lower-cased if needed,
 * but we normalize here as well.
 */
function isTeamsHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const lower = hostname.toLowerCase();
  const stripped = stripMcasSuffix(lower);

  // Exact match
  if (TEAMS_HOSTS.includes(stripped)) return true;

  // Subdomain of a known host — any depth (matches prior menu/mainWindow behaviour,
  // and is intentionally more permissive than the old preload single-label check so
  // a single helper can replace both without narrowing previously-accepted URLs).
  for (const domain of TEAMS_HOSTS) {
    if (stripped.endsWith('.' + domain)) return true;
  }

  // Future regional: teams.<something>.cloud.microsoft — not yet in TEAMS_HOSTS
  // but should be treated as Teams-ish so the next Microsoft ring doesn't need
  // an emergency regex patch. Guard requires both a teams. prefix and the
  // .cloud.microsoft suffix to avoid matching arbitrary *.cloud.microsoft.
  if (
    stripped.startsWith('teams.') &&
    stripped.endsWith('.cloud.microsoft') &&
    stripped.length > 'teams.'.length + '.cloud.microsoft'.length
  ) {
    return true;
  }

  return false;
}

/**
 * Returns true when urlStr is an https: URL whose hostname is a Teams host.
 * MCAS-wrapped hostnames are unwrapped before the check.
 */
function isValidTeamsUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const { protocol, hostname } = new URL(urlStr);
    return protocol === 'https:' && isTeamsHost(hostname);
  } catch {
    return false;
  }
}

/**
 * Normalizes a Teams URL's hostname to the canonical host when the URL is
 * on a legacy Teams host (teams.microsoft.com / teams.live.com) or a
 * regional variant that should be canonicalized. Preserves pathname, search,
 * and hash. Returns the original string when no normalization applies or
 * when parsing fails. MCAS-wrapped URLs are not rewritten — stripping the
 * suffix would remove the proxy routing.
 */
function normalizeTeamsUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return urlStr;
  try {
    const parsed = new URL(urlStr);
    const originalHost = parsed.hostname;
    // Never rewrite an MCAS-wrapped hostname — the suffix is the tenant's proxy routing
    if (originalHost.toLowerCase().endsWith(MCAS_SUFFIX)) return urlStr;
    const lowerHost = originalHost.toLowerCase();
    const stripped = stripMcasSuffix(lowerHost);
    if (!isTeamsHost(lowerHost)) return urlStr;
    if (stripped === TEAMS_CANONICAL_HOST) return urlStr;
    // Only canonicalize known legacy hosts; future regional hosts stay as-is
    // until explicitly added to the legacy set to avoid surprising a new ring.
    const LEGACY_HOSTS = TEAMS_HOSTS.filter(h => h !== TEAMS_CANONICAL_HOST);
    const isLegacy =
      LEGACY_HOSTS.includes(stripped) ||
      LEGACY_HOSTS.some(d => stripped.endsWith('.' + d));
    if (!isLegacy) return urlStr;
    parsed.hostname = TEAMS_CANONICAL_HOST;
    return parsed.toString();
  } catch {
    return urlStr;
  }
}

/**
 * Builds the https: Teams meetup-join / deep-link regex source (without
 * surrounding slashes) from the host table. The caller should wrap it in
 * new RegExp(...). Extracts the "teams." suffix part for the alternation
 * rather than hard-coding literals.
 */
function buildMeetupJoinRegEx() {
  const hostPattern = TEAMS_HOSTS.map(h =>
    h.replace(/^teams\./, '').replace(/\./g, '\\.')
  ).join('|');
  return String.raw`^https://teams\.(?:${hostPattern})/(v2/\?meetingjoin=|meet/|l/(?:app|call|channel|chat|entity|file|meet(?:ing|up-join)|message|task|team)/)`;
}

/**
 * Builds the msteams:// v2 protocol regex source from the host table.
 */
function buildMsTeamsProtocolV2() {
  const hostPattern = TEAMS_HOSTS.map(h =>
    h.replace(/^teams\./, '').replace(/\./g, '\\.')
  ).join('|');
  return String.raw`^msteams://teams\.(?:${hostPattern})/(?:meet/|l/(?:app|call|channel|chat|entity|file|meet(?:ing|up-join)|message|task|team)/)`;
}

// Network error patterns that indicate transient connection issues (proxy, tunnel, DNS, etc.)
// Used by both the global error handlers (app/index.js) and ConnectionManager.
const NETWORK_ERROR_PATTERNS = [
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK_CHANGED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_NAME_NOT_RESOLVED',
];

// Pre-built regex strings — kept as plain strings for config / yargs compatibility
const meetupJoinRegEx = buildMeetupJoinRegEx();
const msTeamsProtocolV2 = buildMsTeamsProtocolV2();

const defaults = {
  TEAMS_HOSTS,
  TEAMS_CANONICAL_HOST,
  TEAMS_HOST_SUFFIXES,
  TEAMS_CDN_HOSTS,
  AUTH_DOMAINS,
  AUTH_LOGIN_DOMAINS,
  MCAS_SUFFIX,
  MS_TEAMS_PROTOCOL_V1,
  meetupJoinRegEx,
  msTeamsProtocolV2,
  NETWORK_ERROR_PATTERNS,
  // Helpers (also exported as named exports for destructuring)
  stripMcasSuffix,
  isTeamsHost,
  isValidTeamsUrl,
  normalizeTeamsUrl,
  buildMeetupJoinRegEx,
  buildMsTeamsProtocolV2,
};

module.exports = defaults;
// Named exports for destructuring convenience (same object, no duplication)
module.exports.TEAMS_HOSTS = TEAMS_HOSTS;
module.exports.TEAMS_CANONICAL_HOST = TEAMS_CANONICAL_HOST;
module.exports.TEAMS_HOST_SUFFIXES = TEAMS_HOST_SUFFIXES;
module.exports.TEAMS_CDN_HOSTS = TEAMS_CDN_HOSTS;
module.exports.AUTH_DOMAINS = AUTH_DOMAINS;
module.exports.AUTH_LOGIN_DOMAINS = AUTH_LOGIN_DOMAINS;
module.exports.MCAS_SUFFIX = MCAS_SUFFIX;
module.exports.MS_TEAMS_PROTOCOL_V1 = MS_TEAMS_PROTOCOL_V1;
module.exports.stripMcasSuffix = stripMcasSuffix;
module.exports.isTeamsHost = isTeamsHost;
module.exports.isValidTeamsUrl = isValidTeamsUrl;
module.exports.normalizeTeamsUrl = normalizeTeamsUrl;
module.exports.buildMeetupJoinRegEx = buildMeetupJoinRegEx;
module.exports.buildMsTeamsProtocolV2 = buildMsTeamsProtocolV2;
module.exports.NETWORK_ERROR_PATTERNS = NETWORK_ERROR_PATTERNS;
module.exports.meetupJoinRegEx = meetupJoinRegEx;
module.exports.msTeamsProtocolV2 = msTeamsProtocolV2;
