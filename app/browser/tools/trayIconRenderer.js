const { nativeImage } = require("electron");
const TrayIconChooser = require("./trayIconChooser");
const PRESENCE_COLORS = {
  0: null,         // offline/unknown — no dot
  1: "#107c41",    // Available — green
  2: "#d83b01",    // Busy — red
  3: "#a80000",    // DND — dark red (renderer draws stripe)
  4: "#ffb900",    // Away — yellow
  5: "#ffb900",    // Be Right Back — yellow
};
const PRESENCE_LABELS = {
  0: "Offline",
  1: "Available",
  2: "Busy",
  3: "Do not disturb",
  4: "Away",
  5: "Be right back",
};

class TrayIconRenderer {
  #lastRequestedCount;
  #updateSequence = 0;
  #lastPresence = 0;
  #lastUnreadCount = 0;

  init(config, ipcRenderer) {
    this.ipcRenderer = ipcRenderer;
    this.config = config;
    const iconChooser = new TrayIconChooser(config);
    this.baseIcon = nativeImage.createFromPath(iconChooser.getFile());
    this.iconSize = this.baseIcon.getSize();
    globalThis.addEventListener(
      "unread-count",
      this.updateActivityCount.bind(this),
    );
    // Presence dot (Linux/Windows, opt-in). Listen even when the flag is off
    // at boot so a config reload could pick it up without a restart.
    globalThis.addEventListener(
      "user-status-changed-local",
      this.#onPresenceChanged.bind(this),
    );
  }

  #onPresenceChanged(event) {
    const status = Number(event.detail?.status) || 0;
    if (status === this.#lastPresence) return;
    this.#lastPresence = status;
    if (!this.config.media?.showStatusOnTrayIcon) return;
    if (this.config.trayIconEnabled === false) return;
    // Re-render at current unread count with the new presence colour.
    this.#renderAndSend(this.#lastUnreadCount, status).catch(() => {});
  }

  async #renderAndSend(count, presenceStatus) {
    const sequence = ++this.#updateSequence;
    this.#lastRequestedCount = count;
    let icon = null;
    if (count > 0 || (presenceStatus && PRESENCE_COLORS[presenceStatus])) {
      try {
        icon = await this.render(count, presenceStatus);
      } catch (error) {
        console.error("[TRAY_DIAG] Icon render failed", { error: error.message });
        this.#lastRequestedCount = undefined;
        return;
      }
    }
    if (sequence !== this.#updateSequence) return;
    this.ipcRenderer.send("tray-update", {
      icon,
      flash: count > 0 && !this.config.disableNotificationWindowFlash,
      count,
      presence: presenceStatus || 0,
    });
  }

  async updateActivityCount(event) {
    const count = event.detail.number;
    this.#lastUnreadCount = count;
    const presence = this.config.media?.showStatusOnTrayIcon ? this.#lastPresence : 0;
    // Deduplicate on the tuple (count, presence) — a presence-only change
    // must still render even when count is unchanged.
    if (count === this.#lastRequestedCount && presence === (this._lastRenderedPresence || 0)) {
      console.debug("[TRAY_DIAG] Activity count unchanged, skipping update");
      return;
    }
    const sequence = ++this.#updateSequence;
    const startTime = Date.now();
    console.debug("[TRAY_DIAG] Activity count update initiated", {
      newCount: count,
      presence,
      willFlash: count > 0 && !this.config.disableNotificationWindowFlash
    });
    let icon = null;
    const needsRender = count > 0 || (presence && PRESENCE_COLORS[presence]);
    if (needsRender) {
      try {
        icon = await this.render(count, presence);
      } catch (error) {
        console.error("[TRAY_DIAG] Icon render failed", { error: error.message, count, elapsedMs: Date.now() - startTime });
        this.#lastRequestedCount = undefined;
        return;
      }
    }
    if (sequence !== this.#updateSequence) {
      console.debug("[TRAY_DIAG] Update superseded while rendering, discarding", { staleCount: count });
      return;
    }
    this.#lastRequestedCount = count;
    this._lastRenderedPresence = presence;
    this.ipcRenderer.send("tray-update", {
      icon,
      flash: count > 0 && !this.config.disableNotificationWindowFlash,
      count,
      presence,
    });
    console.debug("[TRAY_DIAG] Tray update IPC sent", { count, presence, totalTimeMs: Date.now() - startTime });
    if (!this.config.disableBadgeCount) {
      await this.ipcRenderer.invoke("set-badge-count", count).catch(err =>
        console.error("[TRAY_DIAG] Failed to set badge count:", err.message)
      );
    }
  }

  render(newActivityCount, presenceStatus = 0) {
    const IMAGE_PNG = "image/png";
    return new Promise((resolve) => {
      const canvas = document.createElement("canvas");
      canvas.height = 140;
      canvas.width = 140;
      const image = new Image();
      const baseIconData = this.baseIcon.toDataURL(IMAGE_PNG);
      image.onerror = () => {
        console.error("Failed to load base icon for tray rendering");
        resolve(baseIconData);
      };
      image.onload = () => {
        try {
          this._addRedCircleNotification(canvas, image, newActivityCount, resolve, presenceStatus);
        } catch (error) {
          console.error("[TRAY_DIAG] Canvas drawing failed, using base icon:", error);
          resolve(baseIconData);
        }
      };
      if (!baseIconData || baseIconData === "data:,") {
        console.error("Base icon toDataURL returned invalid data");
        resolve(baseIconData);
        return;
      }
      image.src = baseIconData;
    });
  }

  _addRedCircleNotification(canvas, image, newActivityCount, resolve, presenceStatus = 0) {
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, 140, 140);
    if (newActivityCount > 0 && !this.config.disableBadgeCount) {
      ctx.fillStyle = "red";
      ctx.beginPath();
      ctx.ellipse(100, 90, 40, 40, 40, 0, 2 * Math.PI);
      ctx.fill();
      ctx.textAlign = "center";
      ctx.fillStyle = "white";
      ctx.font = 'bold 70px "Segoe UI","Helvetica Neue",Helvetica,Arial,sans-serif';
      if (newActivityCount > 9) {
        ctx.fillText("+", 100, 110);
      } else {
        ctx.fillText(newActivityCount.toString(), 100, 110);
      }
    }
    // Presence dot (small, bottom-right) when opted in and we have a known status.
    const presenceColor = PRESENCE_COLORS[presenceStatus];
    if (presenceColor && this.config.media?.showStatusOnTrayIcon) {
      // White border then coloured dot; for DND add a horizontal bar.
      ctx.fillStyle = "white";
      ctx.beginPath();
      ctx.arc(112, 120, 22, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillStyle = presenceColor;
      ctx.beginPath();
      ctx.arc(112, 120, 16, 0, 2 * Math.PI);
      ctx.fill();
      if (presenceStatus === 3) {
        ctx.fillStyle = "white";
        ctx.fillRect(102, 117, 20, 6);
      }
    }
    const resizedCanvas = this._getResizeCanvasWithOriginalIconSize(canvas);
    resolve(resizedCanvas.toDataURL());
  }

  _getResizeCanvasWithOriginalIconSize(canvas) {
    const resizedCanvas = document.createElement("canvas");
    const rctx = resizedCanvas.getContext("2d");

    resizedCanvas.width = this.iconSize.width;
    resizedCanvas.height = this.iconSize.height;

    const scaleFactorX = this.iconSize.width / canvas.width;
    const scaleFactorY = this.iconSize.height / canvas.height;
    rctx.scale(scaleFactorX, scaleFactorY);
    rctx.drawImage(canvas, 0, 0);

    return resizedCanvas;
  }
}

module.exports = new TrayIconRenderer();
