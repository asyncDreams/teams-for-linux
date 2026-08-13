'use strict';

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const MAX_PAGE_PATH = 512;

/**
 * Resolves the path of an extension action popup, if declared.
 *
 * MV3 uses `action.default_popup`; MV2 uses `browser_action.default_popup` with
 * a `page_action.default_popup` fallback. Returns null when no popup exists.
 * @param {object} manifest
 * @returns {string|null}
 */
function getPopupPath(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  if (manifest.manifest_version === 3) {
    const action = manifest.action;
    if (action && typeof action.default_popup === 'string' && action.default_popup) return action.default_popup;
    return null;
  }
  const browserAction = manifest.browser_action;
  if (browserAction && typeof browserAction.default_popup === 'string' && browserAction.default_popup) {
    return browserAction.default_popup;
  }
  const pageAction = manifest.page_action;
  if (pageAction && typeof pageAction.default_popup === 'string' && pageAction.default_popup) {
    return pageAction.default_popup;
  }
  return null;
}

/**
 * Resolves the extension options page, if declared.
 *
 * `options_ui.page` is used by MV2/MV3; `options_page` is the legacy MV2 field.
 * @param {object} manifest
 * @returns {{ path: string, openInTab: boolean }|null}
 */
function getOptionsPage(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  const optionsUi = manifest.options_ui;
  if (optionsUi && typeof optionsUi.page === 'string' && optionsUi.page) {
    return { path: optionsUi.page, openInTab: optionsUi.open_in_tab === true };
  }
  if (typeof manifest.options_page === 'string' && manifest.options_page) {
    return { path: manifest.options_page, openInTab: false };
  }
  return null;
}

/**
 * Builds a `chrome-extension://` URL for an extension page while rejecting
 * traversal, absolute, and scheme-injection inputs.
 * @param {string} extensionId
 * @param {string} relPath
 * @returns {string|null}
 */
function extensionPageUrl(extensionId, relPath) {
  if (typeof extensionId !== 'string' || !EXTENSION_ID_PATTERN.test(extensionId)) return null;
  if (typeof relPath !== 'string' || !relPath || relPath.length > MAX_PAGE_PATH) return null;
  if (relPath.includes('\0')) return null;
  const normalized = relPath.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.includes('://')) return null;
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
  }
  return `chrome-extension://${extensionId}/${normalized}`;
}

module.exports = {
  extensionPageUrl,
  getOptionsPage,
  getPopupPath,
};
