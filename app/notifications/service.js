const { Notification, nativeImage, ipcMain } = require("electron");
const crypto = require("node:crypto");
const path = require("node:path");
const teamsHosts = require("../config/defaults");
const AvatarCache = require("./avatarCache");

const USER_STATUS = {
  UNKNOWN: -1,
  AVAILABLE: 1,
};

const VALID_KINDS = new Set([
  "direct",
  "group",
  "channel",
  "mention",
  "meeting",
  "call",
  "missedCall",
  "unknown",
]);

const KIND_URGENCY = {
  call: "critical",
  missedCall: "critical",
  mention: "critical",
  meeting: "normal",
  channel: "normal",
  group: "normal",
  direct: "normal",
  unknown: null, // use defaultNotificationUrgency
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_ICON_DATA_URL = 32 * 1024;
const MAX_TITLE = 512;
const MAX_BODY = 1000;

class NotificationService {
  #soundPlayer;
  #config;
  #mainWindow;
  #getUserStatus;
  #notificationSounds;
  #avatarCache;
  #graphApiClient;

  constructor(soundPlayer, config, mainWindow, getUserStatus, graphApiClient = null) {
    this.#soundPlayer = soundPlayer;
    this.#config = config;
    this.#mainWindow = mainWindow;
    this.#getUserStatus = getUserStatus;
    this.#graphApiClient = graphApiClient;
    this.#avatarCache = new AvatarCache();

    this.#notificationSounds = [
      {
        type: "new-message",
        file: path.join(config.appPath, "assets/sounds/new_message.wav"),
      },
      {
        type: "meeting-started",
        file: path.join(config.appPath, "assets/sounds/meeting_started.wav"),
      },
    ];
  }

  setGraphApiClient(client) {
    this.#graphApiClient = client;
  }

  initialize() {
    // Play notification sound for Teams messages and calls
    ipcMain.handle("play-notification-sound", this.#handlePlayNotificationSound.bind(this));
    // Show system notification for Teams activity (legacy)
    ipcMain.handle("show-notification", this.#handleShowNotification.bind(this));
    // Show system notification with structured ParsedNotification (Phase 1)
    ipcMain.handle("show-notification-v2", this.#handleShowNotificationV2.bind(this));
  }

  async #handleShowNotification(_event, options) {
    const notificationId = options?.notificationId || crypto.randomUUID();
    return this.#showNotification({ ...options, notificationId });
  }

  async #handleShowNotificationV2(_event, parsed) {
    // Validate and sanitize parsed payload; fall back to legacy rendering if invalid
    const validated = this.#validateParsed(parsed);
    if (!validated) {
      console.warn("[NOTIFICATIONS] Invalid ParsedNotification, falling back to legacy path", {
        hasTitle: !!(parsed && parsed.title),
        kind: parsed && parsed.kind,
      });
      // Fall back: treat parsed as legacy options if it at least has title
      if (parsed && typeof parsed.title === "string") {
        return this.#showNotification({
          title: String(parsed.title).slice(0, MAX_TITLE),
          body: typeof parsed.body === "string" ? String(parsed.body).slice(0, MAX_BODY) : "",
          icon: parsed.iconDataUrl || parsed.icon,
          notificationId: parsed.notificationId || crypto.randomUUID(),
          timeoutType: parsed.timeoutType,
        });
      }
      return;
    }
    return this.#showParsedNotification(validated);
  }

  async #handlePlayNotificationSound(_event, options) {
    return this.#playNotificationSound(options || {});
  }

  #validateParsed(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (typeof parsed.title !== "string" || !parsed.title.trim()) return null;
    if (parsed.title.length > MAX_TITLE * 2) return null; // cap before slice, but allow up to 2x for safety
    if (parsed.body !== undefined && typeof parsed.body !== "string") return null;
    if (parsed.notificationId !== undefined) {
      if (typeof parsed.notificationId !== "string" || !UUID_RE.test(parsed.notificationId)) {
        // Allow fallback IDs like fallback-... for non-crypto environments, but log
        if (!String(parsed.notificationId).startsWith("fallback-")) return null;
      }
    }
    if (parsed.kind !== undefined) {
      if (typeof parsed.kind !== "string" || !VALID_KINDS.has(parsed.kind)) return null;
    }
    if (parsed.deepLink !== undefined && parsed.deepLink !== null) {
      if (typeof parsed.deepLink !== "string" || parsed.deepLink.length > 2048) return null;
      if (
        !parsed.deepLink.startsWith("https://") &&
        !parsed.deepLink.startsWith("msteams:") &&
        !parsed.deepLink.startsWith("msteams://")
      ) {
        return null;
      }
      if (parsed.deepLink.startsWith("https://")) {
        // Host must be a Teams host (or will be rejected later silently)
        try {
          const host = new URL(parsed.deepLink).hostname;
          // Only soft-validate here; main show path will re-check strictly
          if (!host) return null;
        } catch {
          return null;
        }
      }
    }
    if (parsed.iconDataUrl !== undefined && parsed.iconDataUrl !== null) {
      if (typeof parsed.iconDataUrl !== "string") return null;
      if (parsed.iconDataUrl.length > MAX_ICON_DATA_URL + 1024) return null;
      if (
        !parsed.iconDataUrl.startsWith("data:") &&
        !parsed.iconDataUrl.startsWith("blob:") &&
        !parsed.iconDataUrl.startsWith("https://")
      ) {
        return null;
      }
    }
    if (parsed.conversation !== undefined && parsed.conversation !== null) {
      if (typeof parsed.conversation !== "object" || Array.isArray(parsed.conversation)) return null;
      if (typeof parsed.conversation.key !== "string" || !parsed.conversation.key.trim()) return null;
      if (parsed.conversation.key.length > 512) return null;
    }
    if (parsed.sender !== undefined && parsed.sender !== null) {
      if (typeof parsed.sender !== "object" || Array.isArray(parsed.sender)) return null;
      if (parsed.sender.displayName !== undefined && typeof parsed.sender.displayName !== "string") return null;
      if (parsed.sender.avatarRef !== undefined && typeof parsed.sender.avatarRef !== "string") return null;
      if (parsed.sender.userId !== undefined && typeof parsed.sender.userId !== "string") return null;
    }
    return parsed;
  }

  async #showParsedNotification(parsed) {
    const startTime = Date.now();
    const kind = parsed.kind || "unknown";
    const notificationId = parsed.notificationId || crypto.randomUUID();

    // PII-safe log: never log title/body/deepLink verbatim
    console.debug("[NOTIFICATIONS] Parsed notification request", {
      kind,
      hasSender: !!(parsed.sender && parsed.sender.displayName),
      hasAvatar: !!(parsed.sender && parsed.sender.avatarRef) || !!parsed.iconDataUrl,
      hasDeepLink: !!parsed.deepLink,
      hasGroup: !!(parsed.conversation && parsed.conversation.key),
      hasTag: !!parsed.rawTag,
      notificationId,
    });

    // Resolve icon: parsed.iconDataUrl > sender avatarRef (if data:) > cache > legacy icon
    let resolvedIcon = null;
    let avatarFromCache = false;
    try {
      // Prefer inline data: URLs (already fetched in renderer)
      if (parsed.iconDataUrl && parsed.iconDataUrl.startsWith("data:")) {
        if (parsed.iconDataUrl.length <= MAX_ICON_DATA_URL) {
          resolvedIcon = parsed.iconDataUrl;
        }
      } else if (
        parsed.sender &&
        parsed.sender.avatarRef &&
        parsed.sender.avatarRef.startsWith("data:") &&
        parsed.sender.avatarRef.length <= MAX_ICON_DATA_URL
      ) {
        resolvedIcon = parsed.sender.avatarRef;
      } else if (this.#config.notifications?.avatar) {
        // Try cache when avatar feature is opted-in
        const cacheKey = (parsed.sender && (parsed.sender.userId || parsed.sender.displayName)) || null;
        if (cacheKey) {
          const cached = this.#avatarCache.get(cacheKey);
          if (cached) {
            resolvedIcon = cached;
            avatarFromCache = true;
          }
        }
        // Also cache any data: icon we just resolved for future toasts
        if (resolvedIcon && parsed.sender) {
          const key = parsed.sender.userId || parsed.sender.displayName;
          if (key && resolvedIcon.startsWith("data:")) {
            this.#avatarCache.set(key, resolvedIcon);
          }
        }
      }
      // Fallback to legacy icon field if still unresolved
      if (!resolvedIcon && parsed.iconDataUrl && parsed.iconDataUrl.startsWith("data:")) {
        resolvedIcon = parsed.iconDataUrl;
      }
      if (!resolvedIcon && parsed.icon && typeof parsed.icon === "string" && parsed.icon.startsWith("data:")) {
        if (parsed.icon.length <= MAX_ICON_DATA_URL) resolvedIcon = parsed.icon;
      }
    } catch {
      // icon resolution is best-effort
      resolvedIcon = null;
    }

    // Urgency per kind, fallback to defaultNotificationUrgency
    const perKindUrgency = KIND_URGENCY[kind] || null;
    const urgency = perKindUrgency || this.#config.defaultNotificationUrgency;

    // Grouping tag: only when notifications.grouping is true
    let tag;
    if (this.#config.notifications?.grouping) {
      const rawGroupKey =
        (parsed.conversation && parsed.conversation.key) || parsed.rawTag || null;
      if (rawGroupKey && typeof rawGroupKey === "string" && rawGroupKey.trim()) {
        tag = rawGroupKey.trim().slice(0, 256);
      }
    }

    // Actions / reply: only when notifications.actions is true
    const actionsEnabled = !!this.#config.notifications?.actions;
    let actions;
    let hasReply = false;
    let replyPlaceholder;
    let closeButtonText;
    if (actionsEnabled) {
      if (["direct", "group", "channel", "mention"].includes(kind)) {
        actions = [
          { type: "button", text: "Open" },
          { type: "button", text: "Mark as read" },
        ];
        hasReply = true;
        replyPlaceholder = "Reply…";
        closeButtonText = "Close";
      } else if (["meeting", "call", "missedCall"].includes(kind)) {
        const joinLabel = kind === "missedCall" ? "Call back" : "Join";
        actions = [
          { type: "button", text: joinLabel },
          { type: "button", text: "Open" },
        ];
      } else {
        actions = [{ type: "button", text: "Open" }];
      }
    }

    try {
      await this.#playNotificationSound({
        type: parsed.kind === "meeting" || parsed.kind === "call" ? "meeting-started" : "new-message",
        audio: "default",
      });

      const notificationConfig = {
        title: String(parsed.title).slice(0, MAX_TITLE),
        body: typeof parsed.body === "string" ? String(parsed.body).slice(0, MAX_BODY) : "",
        urgency,
        timeoutType: parsed.timeoutType === "never" ? "never" : this.#config.notifications?.timeoutType === "never" ? "never" : "default",
      };

      if (resolvedIcon) {
        try {
          const img = nativeImage.createFromDataURL(resolvedIcon);
          if (!img.isEmpty()) {
            // Resize avatars to notification-appropriate size (32-64px) to avoid huge icons
            const size = img.getSize();
            if (size.width > 128 || size.height > 128) {
              notificationConfig.icon = img.resize({ width: 64, height: 64, quality: "good" });
            } else {
              notificationConfig.icon = img;
            }
          }
        } catch {
          // invalid data URL — skip icon
        }
      }

      if (tag) notificationConfig.tag = tag;
      if (actions) notificationConfig.actions = actions;
      if (hasReply) {
        notificationConfig.hasReply = true;
        if (replyPlaceholder) notificationConfig.replyPlaceholder = replyPlaceholder;
        if (closeButtonText) notificationConfig.closeButtonText = closeButtonText;
      }

      const notification = new Notification(notificationConfig);

      const deepLink = parsed.deepLink || null;
      const isValidDeepLink = (() => {
        if (!deepLink || typeof deepLink !== "string") return false;
        if (deepLink.startsWith("msteams:")) return true;
        if (deepLink.startsWith("https://")) {
          try {
            const h = new URL(deepLink).hostname;
            return teamsHosts.isTeamsHost(h);
          } catch {
            return false;
          }
        }
        return false;
      })();

      const navigateToDeepLink = () => {
        if (!isValidDeepLink || !deepLink) return false;
        try {
          const win = this.#mainWindow.getWindow();
          if (!win || win.isDestroyed()) return false;
          // For https links, navigate inside the Teams window
          if (deepLink.startsWith("https://")) {
            win.show();
            win.focus();
            win.loadURL(deepLink, { userAgent: this.#config.chromeUserAgent }).catch(() => {
              console.debug("[NOTIFICATIONS] Deep link navigation failed");
            });
            return true;
          }
          if (deepLink.startsWith("msteams:")) {
            const httpsUrl = deepLink.replace(/^msteams:/, "https:");
            win.show();
            win.focus();
            win.loadURL(httpsUrl, { userAgent: this.#config.chromeUserAgent }).catch(() => {
              console.debug("[NOTIFICATIONS] msteams deep link navigation failed");
            });
            return true;
          }
        } catch {
          // best-effort
        }
        return false;
      };

      notification.on("click", () => {
        console.debug("[NOTIFICATIONS] Parsed notification clicked", {
          kind,
          hasDeepLink: !!deepLink,
          isValidDeepLink,
          notificationId,
        });
        // If we have a valid deepLink, navigate; otherwise use existing clickAction
        if (isValidDeepLink && navigateToDeepLink()) return;
        const clickAction = this.#config.notifications?.electron?.clickAction ?? "show";
        if (clickAction === "none") return;
        if (clickAction === "restore") {
          this.#mainWindow.restoreWindow();
        } else {
          this.#mainWindow.show();
        }
      });

      if (actions) {
        notification.on("action", (_event, index) => {
          console.debug("[NOTIFICATIONS] Notification action", { kind, index, notificationId });
          // Index semantics per kind:
          // chat kinds: 0=Open, 1=Mark as read
          // meeting/call: 0=Join/Call back, 1=Open
          // unknown: 0=Open
          if (["direct", "group", "channel", "mention"].includes(kind)) {
            if (index === 0) {
              if (!navigateToDeepLink()) this.#mainWindow.show();
            } else if (index === 1) {
              console.debug("[NOTIFICATIONS] Mark as read (local dismiss)", { kind, notificationId });
              // No server call on MVP — local dismiss only, badge will reconcile via title
            }
          } else if (["meeting", "call", "missedCall"].includes(kind)) {
            // Both Join and Open navigate to the same deepLink on MVP
            if (!navigateToDeepLink()) this.#mainWindow.show();
          } else {
            if (!navigateToDeepLink()) this.#mainWindow.show();
          }
        });

        if (hasReply) {
          notification.on("reply", (_event, replyText) => {
            console.debug("[NOTIFICATIONS] Notification reply", {
              kind,
              replyLength: typeof replyText === "string" ? replyText.length : 0,
              notificationId,
            });
            // Best-effort Graph send; if unavailable, open the chat
            if (
              this.#graphApiClient &&
              typeof this.#graphApiClient.sendChatMessageToUser === "function" &&
              parsed.sender &&
              parsed.sender.userId
            ) {
              const content = typeof replyText === "string" ? replyText.trim().slice(0, 1000) : "";
              if (content) {
                this.#graphApiClient
                  .sendChatMessageToUser({ userId: parsed.sender.userId }, content)
                  .then((res) => {
                    if (!res || !res.success) {
                      console.debug("[NOTIFICATIONS] Graph reply failed, opening chat", { kind });
                      navigateToDeepLink();
                    }
                  })
                  .catch(() => {
                    console.debug("[NOTIFICATIONS] Graph reply error, opening chat");
                    navigateToDeepLink();
                  });
                return;
              }
            }
            // Fallback: open the conversation
            if (!navigateToDeepLink()) this.#mainWindow.show();
          });
        }
      }

      notification.on("close", () => {
        console.debug("[NOTIFICATIONS] Parsed notification dismissed", { kind, notificationId });
        const win = this.#mainWindow.getWindow();
        if (!win || win.isDestroyed()) return;
        const { webContents } = win;
        if (!webContents || webContents.isDestroyed()) return;
        webContents.send("notification-closed", notificationId);
      });

      notification.show();

      const totalTime = Date.now() - startTime;
      console.debug("[NOTIFICATIONS] Parsed notification displayed", {
        kind,
        hasAvatar: !!resolvedIcon,
        avatarFromCache,
        hasTag: !!tag,
        hasActions: !!actions,
        hasReply,
        urgency,
        totalTimeMs: totalTime,
        notificationId,
      });
    } catch (error) {
      console.error("[NOTIFICATIONS] Failed to show parsed notification", {
        error: error.message,
        kind,
        elapsedMs: Date.now() - startTime,
        notificationId,
      });
    }
  }

  async #showNotification(options) {
    const startTime = Date.now();
    console.debug("[NOTIFICATIONS] Native notification request received", {
      titleLength: options.title?.length || 0,
      bodyLength: options.body?.length || 0,
      hasIcon: !!options.icon,
      type: options.type,
      urgency: this.#config.defaultNotificationUrgency,
      timestamp: new Date().toISOString(),
      suggestion: "Monitor totalTimeMs for notification display delays",
    });

    try {
      await this.#playNotificationSound({
        type: options.type,
        audio: "default",
      });

      const notificationConfig = {
        title: options.title,
        body: options.body,
        urgency: this.#config.defaultNotificationUrgency,
        timeoutType: options.timeoutType === "never" ? "never" : "default",
      };

      if (options.icon) {
        try {
          notificationConfig.icon = nativeImage.createFromDataURL(options.icon);
        } catch {
          // invalid icon — show without
        }
      }

      const notification = new Notification(notificationConfig);

      notification.on("click", () => {
        const clickAction = this.#config.notifications?.electron?.clickAction ?? "show";
        console.debug(`[NOTIFICATIONS] Notification clicked, clickAction=${clickAction}`);
        if (clickAction === "none") return;
        if (clickAction === "restore") {
          this.#mainWindow.restoreWindow();
        } else {
          this.#mainWindow.show();
        }
      });

      notification.on("close", () => {
        console.debug("[NOTIFICATIONS] Notification dismissed by system");
        const win = this.#mainWindow.getWindow();
        if (!win || win.isDestroyed()) return;
        const { webContents } = win;
        if (!webContents || webContents.isDestroyed()) return;
        webContents.send("notification-closed", options.notificationId);
      });

      notification.show();

      const totalTime = Date.now() - startTime;
      console.debug("[NOTIFICATIONS] Native notification displayed successfully", {
        totalTimeMs: totalTime,
        urgency: this.#config.defaultNotificationUrgency,
        performanceNote: totalTime > 500 ? "Slow notification display detected" : "Normal notification speed",
      });
    } catch (error) {
      console.error("[NOTIFICATIONS] Failed to show native notification", {
        error: error.message,
        elapsedMs: Date.now() - startTime,
        suggestion: "Check if notification permissions are granted or icon data is valid",
      });
    }
  }

  async #playNotificationSound(options) {
    console.debug(`[NOTIFICATIONS] Sound requested => type: ${options.type}, audio: ${options.audio}`);

    if (!this.#soundPlayer || this.#config.disableNotificationSound) {
      console.debug("Notification sounds are disabled");
      return;
    }

    const userStatus = this.#getUserStatus();

    if (
      this.#config.disableNotificationSoundIfNotAvailable &&
      userStatus !== USER_STATUS.AVAILABLE &&
      userStatus !== USER_STATUS.UNKNOWN
    ) {
      console.debug("Notification sounds are disabled when user is not active");
      return;
    }

    const sound = this.#notificationSounds.find((ns) => {
      return ns.type === options.type;
    });

    if (sound) {
      console.debug(`Playing file: ${sound.file}`);
      await this.#soundPlayer.play(sound.file);
      return;
    }

    console.debug(`[NOTIFICATIONS] No sound configured for type: ${options.type}`);
  }
}

module.exports = NotificationService;
