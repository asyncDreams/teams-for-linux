"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  detectDisplaySession,
  detectScreenSharingPortal,
  normalizeWaylandMode,
  resolveWaylandMode,
} = require("../../app/platform/wayland");

const waylandEnv = {
  XDG_SESSION_TYPE: "wayland",
  WAYLAND_DISPLAY: "wayland-0",
  XDG_CURRENT_DESKTOP: "GNOME",
  DBUS_SESSION_BUS_ADDRESS: "present-but-not-inspected",
};

const exists = (path) => path === "/usr/bin/xdg-desktop-portal";

test("normalizes unknown display modes to auto", () => {
  assert.equal(normalizeWaylandMode("enabled"), "enabled");
  assert.equal(normalizeWaylandMode("disabled"), "disabled");
  assert.equal(normalizeWaylandMode("something-else"), "auto");
});

test("detects a Wayland GNOME session without exposing environment values", () => {
  const session = detectDisplaySession(waylandEnv, "linux");
  assert.deepEqual(session, {
    platform: "linux",
    sessionType: "wayland",
    isWayland: true,
    isX11: false,
    desktop: "gnome",
    compositor: "gnome",
    hasWaylandDisplay: true,
    hasDisplay: false,
    hasSessionBus: true,
  });
});

test("auto mode follows the detected Wayland session", () => {
  assert.equal(resolveWaylandMode({}, waylandEnv, "linux").enabled, true);
  assert.equal(resolveWaylandMode({ linux: { waylandMode: "disabled" } }, waylandEnv, "linux").enabled, false);
  assert.equal(resolveWaylandMode({ linux: { waylandMode: "enabled" } }, {}, "linux").enabled, true);
  assert.equal(resolveWaylandMode({}, waylandEnv, "win32").enabled, false);
});

test("prefers the portal when the configured portal executable is available", () => {
  const diagnostics = detectScreenSharingPortal(
    { linux: { waylandMode: "auto", portal: { enabled: true } } },
    waylandEnv,
    { platform: "linux", existsSync: exists },
  );
  assert.equal(diagnostics.strategy, "portal");
  assert.equal(diagnostics.available, true);
  assert.equal(diagnostics.backend, "gnome");
  assert.equal(diagnostics.fallback, false);
});

test("uses the Electron picker fallback when the portal is unavailable", () => {
  const diagnostics = detectScreenSharingPortal(
    { linux: { waylandMode: "auto", portal: { enabled: true } } },
    waylandEnv,
    { platform: "linux", existsSync: () => false },
  );
  assert.equal(diagnostics.strategy, "legacy-fallback");
  assert.equal(diagnostics.available, false);
  assert.equal(diagnostics.fallback, true);
});

test("does not prefer a portal on X11 or when explicitly disabled", () => {
  const x11 = { XDG_SESSION_TYPE: "x11", DISPLAY: ":0", XDG_CURRENT_DESKTOP: "KDE" };
  assert.equal(
    detectScreenSharingPortal({}, x11, { platform: "linux", existsSync: exists }).strategy,
    "electron-picker",
  );
  assert.equal(
    detectScreenSharingPortal(
      { linux: { waylandMode: "disabled" } },
      waylandEnv,
      { platform: "linux", existsSync: exists },
    ).strategy,
    "electron-picker",
  );
});
