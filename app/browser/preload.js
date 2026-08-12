const { ipcRenderer } = require("electron");
// Phase 1 notification extractor — renderer-side normaliser (soft, PII-safe).
// Keep require lazy-safe: if the module is missing (e.g. stale cache) we degrade
// to the original title/body passthrough rather than breaking toasts.
let notificationExtractor = null;
try {
  notificationExtractor = require("./tools/notificationExtractor");
} catch {
  // extractor unavailable — preload stays on legacy path
}

// #2677: Electron removed the non-standard `File.path` from dropped files, so
// Teams (which uploads by native path) rejects them as "File is missing data".
// Restore it via webUtils.getPathForFile before Teams's drop handler reads it,
// scoped to Teams hosts so the SSO/auth pages this window also loads can't read
// local paths off dropped files.
//
// The same stripping hits pasted files: when a user copies an image file
// in their file manager and pastes into the compose box, Chromium surfaces it
// as a File on the paste event's clipboardData, and Teams uploads by path — so
// the paste fails the same way drag-drop used to. Restore the path on a
// capture-phase paste listener too. Raw image-bit paste (screenshots) arrives
// as a Blob with no path and is unaffected.
try {
  const { webUtils } = require("electron");
  const { isTeamsHost } = require("../config/defaults");
  // Restore the non-standard `File.path` on every File in a FileList, in place.
  // No-op for blob-backed files (screenshots) since webUtils only resolves a
  // path for files that originated from the OS file list; those are left as-is.
  const restoreFilePaths = (files) => {
    if (!files?.length) {
      return;
    }
    for (const file of files) {
      if (file.path) {
        continue;
      }
      try {
        const path = webUtils.getPathForFile(file);
        if (path) {
          Object.defineProperty(file, "path", {
            value: path,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
      } catch {
        // leave the file untouched if the path can't be resolved
      }
    }
  };
  globalThis.addEventListener(
    "drop",
    (event) => {
      if (!isTeamsHost(globalThis.location.hostname)) {
        return;
      }
      restoreFilePaths(event.dataTransfer?.files);
    },
    true,
  );
  globalThis.addEventListener(
    "paste",
    (event) => {
      if (!isTeamsHost(globalThis.location.hostname)) {
        return;
      }
      restoreFilePaths(event.clipboardData?.files);
    },
    true,
  );
} catch {
  // webUtils unavailable
}

// #2534: forward the MessagePort that main posts on 'screen-share-port' into
// the main world. Using window.postMessage with transfer is the supported way
// to hand a MessagePort across to the renderer; the port cannot be returned
// through a contextBridge-exposed function call. Posting to
// `window.location.origin` (rather than `"*"`) restricts the destination to
// this document and satisfies SonarCloud's S2819 cross-origin check.
ipcRenderer.on("screen-share-port", (event) => {
  if (event.ports?.length) {
    globalThis.postMessage("screen-share-port", globalThis.location.origin, event.ports);
  }
});

// Note: IPC validation handled by main process, no need for duplicate validation here
globalThis.electronAPI = {
  desktopCapture: {
    chooseDesktopMedia: (sources, cb) => {
      ipcRenderer
        .invoke("choose-desktop-media", sources)
        .then((streamId) => cb(streamId))
        .catch(err => {
          console.error('Desktop media choice failed:', err);
          cb(null);
        });
      return Date.now();
    },
    cancelChooseDesktopMedia: () => ipcRenderer.send("cancel-desktop-media"),
  },
  sendScreenSharingStarted: (sourceId) => {
    if (sourceId === null || (typeof sourceId === 'string' && sourceId.length < 100)) {
      globalThis.dispatchEvent(new CustomEvent('tfl-screen-sharing-started'));
      return ipcRenderer.send("screen-sharing-started", sourceId);
    }
    console.error('Invalid sourceId for screen sharing');
  },
  sendScreenSharingStopped: () => {
    globalThis.dispatchEvent(new CustomEvent('tfl-screen-sharing-stopped'));
    return ipcRenderer.send("screen-sharing-stopped");
  },
  stopSharing: () => ipcRenderer.send("stop-screen-sharing-from-thumbnail"),
  sendSelectSource: () => ipcRenderer.send("select-source"),
  onSelectSource: (callback) => ipcRenderer.once("select-source", callback),
  send: (channel, ...args) => {
    return ipcRenderer.send(channel, ...args);
  },

  getConfig: () => ipcRenderer.invoke("get-config"),
  getScreenSharingDiagnostics: () => ipcRenderer.invoke("screen-sharing-get-diagnostics"),

  showNotification: (options) => {
    if (!options || typeof options !== 'object') {
      return Promise.reject(new Error('Invalid notification options'));
    }
    return ipcRenderer.invoke("show-notification", options);
  },
  showNotificationV2: (parsed) => {
    if (!parsed || typeof parsed !== 'object') {
      return Promise.reject(new Error('Invalid parsed notification'));
    }
    return ipcRenderer.invoke("show-notification-v2", parsed);
  },
  playNotificationSound: (options) => {
    if (options && typeof options !== 'object') {
      return Promise.reject(new Error('Invalid sound options'));
    }
    return ipcRenderer.invoke("play-notification-sound", options);
  },
  sendNotificationToast: (data) => {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid notification toast data');
    }
    ipcRenderer.send("notification-show-toast", data);
  },

  setBadgeCount: (count) => {
    if (typeof count !== 'number' || count < 0 || count > 9999) {
      console.error('Invalid badge count:', count);
      return Promise.reject(new Error('Invalid badge count'));
    }
    return ipcRenderer.invoke("set-badge-count", count);
  },

  updateTray: (icon, flash) => {
    return ipcRenderer.send("tray-update", { icon, flash });
  },

  onSystemThemeChanged: (callback) => {
    if (typeof callback !== 'function') {
      console.error('Invalid callback for theme changed');
      return;
    }
    return ipcRenderer.on("system-theme-changed", callback);
  },

  setUserStatus: (data) => {
    if (!data || typeof data !== 'object') {
      return Promise.reject(new Error('Invalid user status data'));
    }
    return ipcRenderer.invoke("user-status-changed", data);
  },

  getZoomLevel: (partition) => {
    if (typeof partition !== 'string' || partition.length > 100) {
      return Promise.reject(new Error('Invalid partition'));
    }
    return ipcRenderer.invoke("get-zoom-level", partition);
  },
  saveZoomLevel: (data) => {
    if (!data || typeof data !== 'object' || typeof data.level !== 'number') {
      return Promise.reject(new Error('Invalid zoom data'));
    }
    return ipcRenderer.invoke("save-zoom-level", data);
  },

  navigateBack: () => ipcRenderer.send("navigate-back"),
  navigateForward: () => ipcRenderer.send("navigate-forward"),
  getNavigationState: () => ipcRenderer.invoke("get-navigation-state"),
  onNavigationStateChanged: (callback) => {
    if (typeof callback !== 'function') {
      console.error('Invalid callback for navigation state changed');
      return;
    }
    return ipcRenderer.on("navigation-state-changed", callback);
  },

  graphApi: {
    getUserProfile: () => ipcRenderer.invoke("graph-api-get-user-profile"),
    getCalendarEvents: (options) => ipcRenderer.invoke("graph-api-get-calendar-events", options),
    getCalendarView: (start, end, options) => ipcRenderer.invoke("graph-api-get-calendar-view", start, end, options),
    createCalendarEvent: (event) => ipcRenderer.invoke("graph-api-create-calendar-event", event),
    getMailMessages: (options) => ipcRenderer.invoke("graph-api-get-mail-messages", options),
  },

  openChatWithUser: (email) => {
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      console.error('Invalid email for chat deep link');
      return false;
    }
    // Use the current Teams base URL (could be teams.cloud.microsoft or teams.microsoft.com)
    const currentOrigin = globalThis.location.origin;
    const chatPath = `/l/chat/0/0?users=${encodeURIComponent(email)}`;
    const chatUrl = `${currentOrigin}${chatPath}`;
    console.debug('[CHAT_LINK] Navigating to chat via deep link');
    globalThis.location.href = chatUrl;
    return true;
  },

  sessionType: process.env.XDG_SESSION_TYPE || "x11",
};

// Config is fetched asynchronously; the Notification override below reads it via closure
let notificationConfig = null;

// Dedup window for notificationMethod electron/custom -> suppress double sound + hide Teams in-app toast.
// Declared at module top-level scope so both playNotificationSound and the CustomNotification
// factory (inside the IIFE below) can reach them.
let lastOsNotificationAt = 0;
const OS_NOTIFICATION_DEDUP_WINDOW_MS = 4000;
function recordOsNotification() { lastOsNotificationAt = Date.now(); }
function shouldSuppressTeamsInAppToast() {
  if (notificationConfig?.notifications?.suppressInApp === false) return false;
  const method = notificationConfig?.notificationMethod;
  if (method !== 'electron' && method !== 'custom') return false;
  return Date.now() - lastOsNotificationAt < OS_NOTIFICATION_DEDUP_WINDOW_MS;
}
function installTeamsInAppToastSuppressor() {
  if (globalThis.__tflToastSuppressorInstalled) return;
  globalThis.__tflToastSuppressorInstalled = true;
  const hideTeamsToastDom = () => {
    if (!shouldSuppressTeamsInAppToast()) return;
    try {
      const selectors = [
        '[data-tid*="notification" i][role="alert"]',
        '[data-testid*="notification" i][role="alert"]',
        '[data-tid*="toast" i]',
        '[role="alert"][aria-label*="notification" i]',
      ];
      for (const sel of selectors) {
        try {
          const nodes = document.querySelectorAll(sel);
          nodes.forEach((n) => {
            try { n.style.display = 'none'; n.setAttribute('data-tfl-suppressed', '1'); } catch {}
          });
        } catch {}
      }
    } catch {}
  };
  const obs = new MutationObserver(() => hideTeamsToastDom());
  const startObs = () => {
    try {
      if (document.body) obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class','style'] });
    } catch {}
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObs, { once: true });
  else startObs();
  // Poll fallback for shadow-dom teams renders
  setInterval(hideTeamsToastDom, 800);
}

ipcRenderer.invoke("get-config").then((config) => {
  notificationConfig = config;
  installTeamsInAppToastSuppressor();
  console.debug("Preload: Config loaded for notifications:", {
    notificationMethod: config?.notificationMethod,
    disableNotifications: config?.disableNotifications
  });
}).catch((err) => {
  console.error("Preload: Failed to load config for notifications:", err);
});

// Create a Notification-like stub so Teams can manage lifecycle without errors.
// Without addEventListener/close/dispatchEvent, Teams' internal state machine
// breaks after the first notification, causing subsequent ones to stop firing.
function createNotificationStub() {
  const stub = {
    onclick: null,
    onclose: null,
    onerror: null,
    onshow: null,
    close() { if (this.onclose) this.onclose(); },
    addEventListener(type, listener) {
      if (type === 'click') this.onclick = listener;
      else if (type === 'close') this.onclose = listener;
      else if (type === 'show') this.onshow = listener;
      else if (type === 'error') this.onerror = listener;
    },
    removeEventListener(type, listener) {
      if (type === 'click' && (!listener || this.onclick === listener)) this.onclick = null;
      else if (type === 'close' && (!listener || this.onclose === listener)) this.onclose = null;
      else if (type === 'show' && (!listener || this.onshow === listener)) this.onshow = null;
      else if (type === 'error' && (!listener || this.onerror === listener)) this.onerror = null;
    },
    dispatchEvent() { return true; },
  };
  // Fire the show event asynchronously like a real Notification
  setTimeout(() => { if (stub.onshow) stub.onshow(); }, 0);
  return stub;
}

function playNotificationSound(notifSound) {
  const method = notificationConfig?.notificationMethod || "web";
  if (method === "electron" || method === "custom") {
    // Main process already plays the notification sound for electron/custom;
    // still allow renderer sound only if OS notification not recently sent.
    if (Date.now() - lastOsNotificationAt < OS_NOTIFICATION_DEDUP_WINDOW_MS) return;
    // For electron, always delegate to main; for custom, main also plays
    if (method === "electron") return;
  }
  if (globalThis.electronAPI?.playNotificationSound) {
    try {
      console.debug("Requesting application to play sound");
      globalThis.electronAPI.playNotificationSound(notifSound);
    } catch (e) {
      console.debug("playNotificationSound failed", e);
    }
  }
}

function createWebNotification(classicNotification, title, options) {
  const notifSound = {
    type: options.type,
    audio: "default",
    title: title,
    body: options.body,
  };
  playNotificationSound(notifSound);

  // Return actual native notification object (critical for Teams to manage lifecycle)
  console.debug("Continues to default notification workflow");
  if (classicNotification) {
    try {
      return new classicNotification(title, options);
    } catch (err) {
      console.debug("Could not create native notification:", err);
      return null;
    }
  }
  return null;
}

function createElectronNotification(options, parsed, preallocatedId) {
  const notificationId = (parsed && parsed.notificationId) || preallocatedId || crypto.randomUUID();
  const stub = createNotificationStub();
  let closed = false;
  const finalizeClose = () => {
    if (closed) return;
    closed = true;
    ipcRenderer.removeListener("notification-closed", onClosed);
    if (stub.onclose) stub.onclose();
  };
  const onClosed = (_event, closedId) => {
    if (closedId !== notificationId) return;
    finalizeClose();
  };
  stub.close = finalizeClose;
  // Prefer the structured v2 path when we have a parsed payload — it carries
  // sender, kind, grouping key, deepLink and avatar without extra DOM work
  // in the main process. Falls back to the legacy channel if v2 is unavailable.
  const targetChannel = parsed ? "show-notification-v2" : "show-notification";
  const payload = parsed ? { ...parsed, notificationId } : { ...options, notificationId };
  // Ensure legacy fields are present for the main-process validator even on v2
  if (parsed) {
    payload.title = parsed.title;
    payload.body = parsed.body;
    if (parsed.iconDataUrl) payload.icon = parsed.iconDataUrl;
    else if (options.icon) payload.icon = options.icon;
  }
  if (globalThis.electronAPI) {
    ipcRenderer.on("notification-closed", onClosed);
    const invoke = parsed && globalThis.electronAPI.showNotificationV2
      ? globalThis.electronAPI.showNotificationV2(payload)
      : globalThis.electronAPI.showNotification(payload);
    // If we tried v2 and it was rejected (old main), retry once on legacy.
    Promise.resolve(invoke).catch((e) => {
      if (parsed && targetChannel === "show-notification-v2") {
        console.debug("show-notification-v2 not available, falling back to legacy", e?.message || e);
        return globalThis.electronAPI.showNotification({ ...options, notificationId }).catch((e2) => {
          console.debug("showNotification fallback failed", e2);
        });
      }
      console.debug("showNotification failed", e);
      ipcRenderer.removeListener("notification-closed", onClosed);
    });
  }
  return stub;
}

/**
 * Build a ParsedNotification for the current toast when the extractor is
 * available. Soft — any exception degrades to null and the caller falls
 * back to the legacy title/body path. No PII is logged.
 */
function tryBuildParsed(title, options, preallocatedId) {
  if (!notificationExtractor) return { parsed: null, notificationId: preallocatedId || null };
  try {
    const hubProbe = notificationExtractor.probeHubCard();
    const notificationId = preallocatedId || crypto.randomUUID();
    const parsed = notificationExtractor.buildParsedNotification({
      title,
      options,
      notificationId,
      hubProbe,
    });
    console.debug("[NOTIFICATIONS] Parsed notification", {
      kind: parsed.kind,
      hasSender: !!parsed.sender,
      hasAvatar: !!(parsed.sender && parsed.sender.avatarRef),
      hasDeepLink: !!parsed.deepLink,
      hasGroup: !!(parsed.conversation && parsed.conversation.key),
      notificationId,
    });
    return { parsed, notificationId };
  } catch (e) {
    console.debug("notificationExtractor build failed", e?.message || e);
    return { parsed: null, notificationId: preallocatedId || null };
  }
}

function createCustomNotification(title, options) {
  const notificationData = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    title: title,
    body: options.body || '',
    icon: options.icon,
  };

  const notifSound = {
    type: options.type,
    audio: "default",
    title: title,
    body: options.body,
  };
  playNotificationSound(notifSound);

  try {
    if (globalThis.electronAPI?.sendNotificationToast) {
      globalThis.electronAPI.sendNotificationToast(notificationData);
    } else {
      console.warn("sendNotificationToast API not available");
    }
  } catch (e) {
    console.error("Failed to send custom notification:", e);
  }

  return createNotificationStub();
}

// Override window.Notification immediately before Teams loads
// Using factory function pattern instead of class to avoid "return in constructor" anti-pattern
(function() {
  const ICON_BASE64 =
    "data:image/png;base64,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";

  const classicNotification = globalThis.Notification;

  // Factory function that creates notification objects (avoids "return in constructor" issue)
  function CustomNotification(title, options) {
    if (notificationConfig?.disableNotifications) {
      return { onclick: null, onclose: null, onerror: null };
    }

    options = options || {};
    options.icon = options.icon || ICON_BASE64;
    options.title = options.title || title;
    options.type = options.type || "new-message";
    options.timeoutType =
      notificationConfig?.notifications?.timeoutType === "never"
        ? "never"
        : "default";
    options.requireInteraction = options.timeoutType === "never";

    const method = notificationConfig?.notificationMethod || "web";

    // Build the structured payload once — enriches all three methods but is
    // only forwarded over IPC for the Electron path. Web/custom benefit from
    // the "<Sender>: <Preview>" title rewrite and avatar pointer when present.
    const preId = crypto.randomUUID();
    const { parsed } = tryBuildParsed(title, options, preId);

    if (method === "custom") {
      if (parsed) {
        const customOpts = {
          ...options,
          body: parsed.body || options.body,
          icon: parsed.iconDataUrl || options.icon,
          title: parsed.title,
        };
          recordOsNotification();
        return createCustomNotification(parsed.title, customOpts);
      }
      recordOsNotification();
      return createCustomNotification(title, options);
    }

    if (method === "web") {
      if (parsed) {
        const webOpts = {
          ...options,
          body: parsed.body || options.body,
          icon: parsed.iconDataUrl || options.icon,
          title: parsed.title,
        };
        const notification = createWebNotification(classicNotification, parsed.title, webOpts);
        return notification || { onclick: null, onclose: null, onerror: null };
      }
      const notification = createWebNotification(classicNotification, title, options);
      return notification || { onclick: null, onclose: null, onerror: null };
    }

    recordOsNotification();
    return createElectronNotification(options, parsed, preId);
  }

  CustomNotification.requestPermission = async function() {
    return "granted";
  };

  Object.defineProperty(CustomNotification, 'permission', {
    get: function() {
      return "granted";
    }
  });

  globalThis.Notification = CustomNotification;
  console.debug("Preload: CustomNotification factory initialized");
})();

document.addEventListener('DOMContentLoaded', async () => {
  console.debug("Preload: DOMContentLoaded, initializing browser modules...");
  try {
    const config = await ipcRenderer.invoke("get-config");
    console.debug("Preload: Got config:", {
      trayIconEnabled: config?.trayIconEnabled,
      useMutationTitleLogic: config?.useMutationTitleLogic
    });
    
    if (config.useMutationTitleLogic) {
      const mutationTitle = require("./tools/mutationTitle");
      mutationTitle.init(config);
    }
    
    // NOTE: the unread-count event is handled by trayIconRenderer.js; a second
    // listener here previously caused duplicate IPC traffic and rendering.

    const modules = [
      { name: "zoom", path: "./tools/zoom" },
      { name: "shortcuts", path: "./tools/shortcuts" },
      { name: "settings", path: "./tools/settings" },
      { name: "theme", path: "./tools/theme" },
      { name: "emulatePlatform", path: "./tools/emulatePlatform" },
      { name: "webauthnOverride", path: "./tools/webauthnOverride" },
      { name: "timestampCopyOverride", path: "./tools/timestampCopyOverride" },
      { name: "trayIconRenderer", path: "./tools/trayIconRenderer" },
      { name: "mqttStatusMonitor", path: "./tools/mqttStatusMonitor" },
      { name: "meetingStartDetector", path: "./tools/meetingStartDetector" },
      { name: "overrideMicConstraints", path: "./tools/overrideMicConstraints" },
      { name: "disableAutogain", path: "./tools/disableAutogain" },
      { name: "ignoreSystemMute", path: "./tools/ignoreSystemMute" },
      { name: "speakingIndicator", path: "./tools/speakingIndicator" },
      { name: "cameraResolution", path: "./tools/cameraResolution" },
      { name: "cameraAspectRatio", path: "./tools/cameraAspectRatio" },
      { name: "navigationButtons", path: "./tools/navigationButtons" },
      { name: "framelessTweaks", path: "./tools/frameless" },
      { name: "customStickers", path: "./tools/customStickers" },
      { name: "dockIconRenderer", path: "./tools/dockIconRenderer" },
      { name: "preventDeviceSwitching", path: "./tools/preventDeviceSwitching" }
    ];

    // CRITICAL: These modules need ipcRenderer for IPC communication (see CLAUDE.md)
    const modulesRequiringIpc = new Set(["settings", "theme", "trayIconRenderer", "mqttStatusMonitor", "meetingStartDetector", "webauthnOverride", "speakingIndicator", "customStickers", "dockIconRenderer"]);

    let successCount = 0;
    for (const module of modules) {
      try {
        const moduleInstance = require(module.path);
        if (modulesRequiringIpc.has(module.name)) {
          moduleInstance.init(config, ipcRenderer);
        } else {
          moduleInstance.init(config);
        }
        successCount++;
      } catch (err) {
        console.error(`Preload: Failed to load ${module.name}:`, err.message);
      }
    }
    
    console.info(`Preload: ${successCount}/${modules.length} browser modules initialized successfully`);

    try {
      const ActivityManager = require("./notifications/activityManager");
      new ActivityManager(ipcRenderer, config).start();
    } catch (err) {
      console.error("Preload: ActivityManager failed to initialize:", err.message);
    }

    // Keep-always-online: nudge Teams idle tracker to stay Available when enabled
    try {
      const ah = require("./tools/activityHub");
      if (config?.presence && typeof ah.initKeepAlwaysOnline === 'function') ah.initKeepAlwaysOnline(config);
    } catch {}
    // Listen for config changes from the main process (e.g., when menu toggles are clicked)
    ipcRenderer.on("config-changed", (_event, configChanges) => {
      for (const [key, value] of Object.entries(configChanges)) {
        config[key] = value;
        if (notificationConfig) notificationConfig[key] = value;
      }
      if (Object.hasOwn(configChanges, 'presence')) {
        try {
          require("./tools/activityHub").updateKeepOnlineConfig(config);
          require("./tools/mqttStatusMonitor").updateConfig(config);
        } catch {
          // Presence enhancements are optional; a stale Teams reload must not break preload.
        }
      }
    });

  } catch (error) {
    console.error("Preload: Failed to initialize browser modules:", error);
  }
});

// Forward unhandled promise rejections and window errors to main for diagnostics.
// Plain objects without a `.message` (and `undefined` rejections) previously stringified to
// the literals "[object Object]" / "undefined", which discarded all diagnostic content.
function serializeRejectionReason(reason) {
  // The whole body is wrapped in try/catch so a throwing `reason.message`
  // getter (or any other unexpected exception) degrades to a sentinel
  // string instead of propagating to the outer handler and dropping the
  // whole rejection payload.
  try {
    if (reason === undefined) return "<undefined>";
    if (reason === null) return "<null>";
    if (typeof reason === "string") return reason;
    if (typeof reason !== "object") return String(reason);
    if (typeof reason.message === "string" && reason.message.length > 0) return reason.message;
    const seen = new WeakSet();
    return JSON.stringify(reason, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    }) ?? "[unserializable rejection]";
  } catch {
    return "[unserializable rejection]";
  }
}

try {
  globalThis.addEventListener("unhandledrejection", (event) => {
    try {
      const reason = event?.reason;
      const errorData = {
        message: serializeRejectionReason(reason).substring(0, 1000),
        stack: reason?.stack ? String(reason.stack).substring(0, 5000) : null,
        timestamp: Date.now(),
      };

      ipcRenderer.send("unhandled-rejection", errorData);
    } catch (err) {
      console.debug("Unhandled rejection forwarding failed:", err);
      // Best-effort forwarding, never throw from preload
    }
  });

  globalThis.addEventListener("error", (event) => {
    try {
      const errorData = {
        message: event?.message ? String(event.message).substring(0, 1000) : '',
        filename: event?.filename ? String(event.filename).substring(0, 200) : '',
        lineno: typeof event?.lineno === 'number' ? event.lineno : 0,
        colno: typeof event?.colno === 'number' ? event.colno : 0,
        timestamp: Date.now(),
        errorStack: event?.error?.stack ? String(event.error.stack).substring(0, 5000) : null,
      };
      
      ipcRenderer.send("window-error", errorData);
    } catch (err) {
      console.debug("Window error forwarding failed:", err);
    }
  });
} catch (err) {
  console.debug("Error handler setup failed:", err);
}
