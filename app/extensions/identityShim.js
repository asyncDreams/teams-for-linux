'use strict';

const DEFAULT_REDIRECT_HOST = 'chromiumapp.org';

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
  return allowedHosts.some((allowed) => {
    const normalized = String(allowed || '').toLowerCase();
    if (!normalized) return false;
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

/**
 * Returns the main-world script that patches the extension page's chrome.*
 * surface with the identity/tabs shims. The shim delegates to
 * window.__tflExtensionBridge, which the preload exposes from the main process.
 * It is intentionally idempotent and non-destructive: existing APIs are left
 * untouched, and absence of the bridge is a silent no-op.
 * @returns {string}
 */
function buildShimSource() {
  return `(() => {
  const bridge = window.__tflExtensionBridge;
  if (!bridge) return;
  const chrome = window.chrome || (window.chrome = {});
  if (!chrome.identity) {
    chrome.identity = {
      launchWebAuthFlow(details, callback) {
        const promise = Promise.resolve().then(() => bridge.launchWebAuthFlow(details || {}));
        if (typeof callback === 'function') {
          promise.then((url) => callback(url), () => callback(undefined));
        }
        return promise;
      },
    };
  }
  if (!chrome.tabs) {
    chrome.tabs = {
      create(details, callback) {
        const promise = Promise.resolve().then(() => bridge.tabsCreate(details || {}));
        if (typeof callback === 'function') {
          promise.then((tab) => callback(tab), () => callback(null));
        }
        return promise;
      },
    };
  }
})();`;
}

module.exports = {
  DEFAULT_REDIRECT_HOST,
  buildShimSource,
  isAuthorizedRedirect,
  isValidAuthUrl,
};
