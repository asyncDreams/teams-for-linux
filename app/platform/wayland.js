"use strict";

const fs = require("node:fs");

const WAYLAND_MODES = ["auto", "enabled", "disabled"];

function normalizeWaylandMode(mode) {
  return WAYLAND_MODES.includes(mode) ? mode : "auto";
}

function getDesktopName(env = process.env) {
  return String(env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || "")
    .split(":")[0]
    .trim()
    .toLowerCase();
}

function isWaylandSession(env = process.env) {
  const sessionType = String(env.XDG_SESSION_TYPE || "").toLowerCase();
  return sessionType === "wayland" || Boolean(env.WAYLAND_DISPLAY);
}

function isX11Session(env = process.env) {
  const sessionType = String(env.XDG_SESSION_TYPE || "").toLowerCase();
  return sessionType === "x11" || Boolean(env.DISPLAY) && !isWaylandSession(env);
}

function detectPortalBackend(desktop) {
  if (["gnome", "ubuntu", "unity"].includes(desktop)) return "gnome";
  if (["kde", "plasma"].includes(desktop)) return "kde";
  if (["sway", "hyprland", "river", "wayfire"].includes(desktop)) return desktop;
  return desktop || "unknown";
}

function hasPortalExecutable(existsSync = fs.existsSync) {
  return [
    "/usr/bin/xdg-desktop-portal",
    "/usr/libexec/xdg-desktop-portal",
    "/usr/lib/xdg-desktop-portal",
  ].some((candidate) => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  });
}

/**
 * Describe the current Linux display/session environment without logging any
 * environment values. The returned booleans are safe for diagnostics and can
 * be used by the screen-sharing fallback without importing Electron.
 */
function detectDisplaySession(env = process.env, platform = process.platform) {
  const wayland = platform === "linux" && isWaylandSession(env);
  const x11 = platform === "linux" && isX11Session(env);
  const desktop = getDesktopName(env);
  return {
    platform,
    sessionType: String(env.XDG_SESSION_TYPE || (wayland ? "wayland" : x11 ? "x11" : "unknown")).toLowerCase(),
    isWayland: wayland,
    isX11: x11,
    desktop,
    compositor: detectPortalBackend(desktop),
    hasWaylandDisplay: Boolean(env.WAYLAND_DISPLAY),
    hasDisplay: Boolean(env.DISPLAY),
    hasSessionBus: Boolean(env.DBUS_SESSION_BUS_ADDRESS),
  };
}

/**
 * Resolve the explicit/automatic mode. `linux.waylandMode` is the public
 * setting; `wayland.mode` is accepted as a compatible alias for early builds.
 */
function resolveWaylandMode(config = {}, env = process.env, platform = process.platform) {
  const requested = config.linux?.waylandMode ?? config.wayland?.mode ?? "auto";
  const mode = normalizeWaylandMode(requested);
  const session = detectDisplaySession(env, platform);
  const enabled = platform === "linux" && (mode === "enabled" || mode === "auto" && session.isWayland);
  return { mode, enabled, session };
}

function detectScreenSharingPortal(config = {}, env = process.env, options = {}) {
  const session = resolveWaylandMode(config, env, options.platform || process.platform);
  const existsSync = options.existsSync || fs.existsSync;
  const portalConfigured = config.linux?.portal?.enabled ?? config.wayland?.portal?.enabled ?? true;
  const ozonePlatform = options.ozonePlatform || "auto";

  // WebRTCPipeWireCapturer — the Chromium feature that lets getDisplayMedia
  // talk to xdg-desktop-portal directly and bypass setDisplayMediaRequestHandler —
  // only activates under native Wayland ozone. The packaged app ships with
  // --ozone-platform=x11 (XWayland), so a Wayland *session* alone must not
  // select the portal path: on XWayland the X11 capturer is used and the
  // Electron display-media handler is required. Only treat the portal as
  // available when Chromium is actually running native Wayland.
  const nativeWayland = session.enabled && ozonePlatform !== "x11";

  const available = nativeWayland
    && portalConfigured
    && session.session.hasSessionBus
    && hasPortalExecutable(existsSync);
  const backend = session.session.compositor;
  const strategy = available ? "portal" : nativeWayland ? "legacy-fallback" : "electron-picker";

  return {
    mode: session.mode,
    enabled: session.enabled,
    nativeWayland,
    ozonePlatform,
    portalConfigured,
    available,
    backend,
    pipeWire: nativeWayland,
    strategy,
    fallback: strategy !== "portal",
    lastError: null,
    session: session.session,
  };
}

function shouldPreferScreenSharingPortal(config = {}, env = process.env, options = {}) {
  return detectScreenSharingPortal(config, env, options).strategy === "portal";
}

module.exports = {
  WAYLAND_MODES,
  normalizeWaylandMode,
  getDesktopName,
  isWaylandSession,
  isX11Session,
  detectDisplaySession,
  resolveWaylandMode,
  detectScreenSharingPortal,
  shouldPreferScreenSharingPortal,
  hasPortalExecutable,
};
