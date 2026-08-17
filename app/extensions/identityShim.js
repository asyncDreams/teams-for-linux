'use strict';

const DEFAULT_REDIRECT_HOST = 'chromiumapp.org';
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const DENIED_PROTOCOLS = new Set(['file:', 'javascript:', 'data:', 'about:']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Extracts the extension id from a chrome-extension:// URL, or null when the
 * URL is not a valid extension page owned by a single extension.
 * @param {string} url
 * @returns {string|null}
 */
function extensionIdFromUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'chrome-extension:') return null;
  if (!EXTENSION_ID_PATTERN.test(parsed.hostname)) return null;
  return parsed.hostname;
}

/**
 * Returns true when `targetUrl` is the declared redirect target, ignoring the
 * query string and fragment (which carry the OAuth code) and tolerating case
 * differences, trailing slashes, and default ports.
 * @param {string} redirectUri
 * @param {string} targetUrl
 * @returns {boolean}
 */
function redirectMatches(redirectUri, targetUrl) {
  if (typeof redirectUri !== 'string' || typeof targetUrl !== 'string') return false;
  let expected;
  let actual;
  try {
    expected = new URL(redirectUri);
    actual = new URL(targetUrl);
  } catch {
    return false;
  }
  if (expected.protocol !== actual.protocol) return false;
  if (expected.hostname.toLowerCase() !== actual.hostname.toLowerCase()) return false;
  if (expected.port !== actual.port) return false;
  const expectedPath = expected.pathname.replace(/\/+$/, '');
  const actualPath = actual.pathname;
  return actualPath === expectedPath || actualPath.startsWith(`${expectedPath}/`);
}

/**
 * Validates the authorization URL handed to chrome.identity.launchWebAuthFlow.
 * HTTPS is always allowed; plain HTTP is permitted only for loopback hosts so
 * local development providers keep working. Everything else is rejected.
 * @param {*} url
 * @returns {boolean}
 */
function isValidAuthUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') {
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  }
  return false;
}

/**
 * Validates a chrome.identity redirect_uri. Only chrome-extension:// pages owned
 * by the calling extension and HTTPS hosts in the allow-list are accepted, so an
 * extension can never capture an OAuth code meant for a different app.
 * @param {*} redirectUrl
 * @param {string[]} allowedHosts
 * @param {string|null} extensionId
 * @returns {boolean}
 */
function isAuthorizedRedirect(redirectUrl, allowedHosts = [DEFAULT_REDIRECT_HOST], extensionId = null) {
  if (typeof redirectUrl !== 'string' || !redirectUrl) return false;
  let parsed;
  try {
    parsed = new URL(redirectUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === 'chrome-extension:') {
    return typeof extensionId === 'string' && parsed.hostname === extensionId;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  // The stock Chromium redirect host is always <extension-id>.chromiumapp.org;
  // require the subdomain to match the calling extension.
  if (host === DEFAULT_REDIRECT_HOST || host.endsWith(`.${DEFAULT_REDIRECT_HOST}`)) {
    if (typeof extensionId !== 'string') return false;
    const subdomain = host.slice(0, host.length - DEFAULT_REDIRECT_HOST.length - 1);
    return subdomain === extensionId;
  }
  return allowedHosts.some((allowed) => {
    const normalized = String(allowed || '').toLowerCase();
    if (!normalized) return false;
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

/**
 * Classifies a URL an extension asked to open (window.open / tabs.create).
 *
 * - 'auth': https (or loopback http) -> open in-app in the Teams partition so
 *   the OAuth session lands where the extension can use it.
 * - 'extension': chrome-extension:// -> open in-app.
 * - 'external': a custom scheme (otter://, msteams://, mailto:) -> hand to the
 *   OS so the native handler (e.g. the Otter desktop app) can complete the flow.
 * - 'deny': dangerous or unparseable URLs.
 * @param {*} url
 * @returns {'auth'|'extension'|'external'|'deny'}
 */
function classifyOpenUrl(url) {
  if (typeof url !== 'string' || !url) return 'deny';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'deny';
  }
  const protocol = parsed.protocol;
  if (protocol === 'chrome-extension:') return 'extension';
  if (protocol === 'https:') return 'auth';
  if (protocol === 'http:') {
    return LOOPBACK_HOSTS.has(parsed.hostname) ? 'auth' : 'deny';
  }
  if (DENIED_PROTOCOLS.has(protocol)) return 'deny';
  return 'external';
}

/**
 * Returns the main-world script that patches the extension page's chrome.*
 * surface with the identity/tabs shims. The shim delegates to
 * window.__tflExtensionBridge, which the preload exposes from the main process.
 * It is intentionally idempotent and non-destructive: existing APIs are left
 * untouched, and absence of the bridge is a silent no-op.
 *
 * Unsupported or background-driven APIs are reported back to the main process
 * (via bridge.report) so the Extensions manager can surface what an extension
 * actually attempted instead of failing silently.
 * @returns {string}
 */
function buildShimSource() {
  return `(() => {
  const bridge = window.__tflExtensionBridge;
  if (!bridge) return;
  const report = (message) => { try { bridge.report(message); } catch {} };
  const chrome = window.chrome || (window.chrome = {});
  if (!chrome.identity) chrome.identity = {};
  if (!chrome.identity.launchWebAuthFlow) {
    chrome.identity.launchWebAuthFlow = function (details, callback) {
      report('identity.launchWebAuthFlow');
      const promise = Promise.resolve().then(() => bridge.launchWebAuthFlow(details || {}));
      if (typeof callback === 'function') {
        promise.then((url) => callback(url), () => callback(undefined));
      }
      return promise;
    };
  }
  if (!chrome.identity.getAuthToken) {
    chrome.identity.getAuthToken = function (details, callback) {
      report('identity.getAuthToken');
      const cb = typeof details === 'function' ? details : callback;
      const promise = Promise.reject(new Error('getAuthToken is not supported by Teams for Linux; sign in from the extension popup instead'));
      if (typeof cb === 'function') {
        promise.catch(() => cb(undefined));
      }
      return promise;
    };
  }
  if (!chrome.tabs) chrome.tabs = {};
  if (!chrome.tabs.create) {
    chrome.tabs.create = function (details, callback) {
      report('tabs.create');
      const promise = Promise.resolve().then(() => bridge.tabsCreate(details || {}));
      if (typeof callback === 'function') {
        promise.then((tab) => callback(tab), () => callback(null));
      }
      return promise;
    };
  }
  // Instrument runtime.sendMessage so MV3 background round-trips surface in the
  // diagnostics instead of failing silently (Electron does not run MV3 service
  // workers, so messages to the background never resolve).
  if (chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function (message) {
      report('runtime.sendMessage');
      return original.apply(chrome.runtime, arguments);
    };
  }
})();`;
}

module.exports = {
  DEFAULT_REDIRECT_HOST,
  buildShimSource,
  classifyOpenUrl,
  extensionIdFromUrl,
  isAuthorizedRedirect,
  isValidAuthUrl,
  redirectMatches,
};
