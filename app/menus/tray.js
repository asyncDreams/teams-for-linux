const { Tray, Menu, ipcMain, nativeImage } = require("electron");
const os = require("node:os");
const isMac = os.platform() === "darwin";

const PRESENCE_LABELS = {
  1: "Available",
  2: "Busy",
  3: "Do not disturb",
  4: "Away",
  5: "Be right back",
};

/**
 * Composes the tray tooltip from the last Teams badge/presence update plus the
 * local notification-history unread count. Kept pure so it is unit-testable.
 * @param {string} baseTitle
 * @param {number} count Teams unread badge count
 * @param {number} historyUnread local notification-history unread count
 * @param {number} [presence]
 * @param {string} [presenceSource]
 * @returns {string}
 */
function buildTrayTooltip(baseTitle, count, historyUnread, presence, presenceSource) {
  const parts = [String(baseTitle || "")];
  if (Number(count) > 0) parts.push(`(${Number(count)})`);
  if (Number(historyUnread) > 0) parts.push(`· ${Number(historyUnread)} unread`);
  if (presence && PRESENCE_LABELS[presence]) {
    const source = typeof presenceSource === "string" && presenceSource ? ` · Source: ${presenceSource}` : "";
    parts.push(`— ${PRESENCE_LABELS[presence]}${source}`);
  }
  return parts.filter(Boolean).join(" ");
}

class ApplicationTray {
  constructor(window, appMenu, iconPath, config) {
    this.window = window;
    this.iconPath = iconPath;
    this.appMenu = appMenu;
    this.config = config;
    this.historyUnread = 0;
    this.lastUpdate = { icon: null, flash: false, count: 0, presence: null, presenceSource: null };

    this.tray = new Tray(this.getIconImage(this.iconPath));
    this.tray.setToolTip(buildTrayTooltip(this.config.appTitle, 0, 0));
    this.tray.on("click", () => this.showAndFocusWindow());
    this.tray.setContextMenu(Menu.buildFromTemplate(this.appMenu));
  }

  initialize() {
    // Update tray icon based on Teams status (notifications, badge count)
    ipcMain.on("tray-update", this.#handleTrayUpdate.bind(this));
  }

  #handleTrayUpdate(_event, data) {
    const { icon, flash, count, presence, presenceSource } = data || {};
    this.updateTrayImage(icon, flash, count, presence, presenceSource);
  }

  getIconImage(iconPath) {
    let image;
    if (iconPath.startsWith("data:")) {
      image = nativeImage.createFromDataURL(iconPath);
    } else {
      image = nativeImage.createFromPath(iconPath);
    }
    if (isMac) {
      image = image.resize({ width: 16, height: 16 });
    }
    return image;
  }

  setContextMenu(appMenu) {
    this.tray.setContextMenu(Menu.buildFromTemplate(appMenu));
  }

  showAndFocusWindow() {
    if (this.window.isFocused()) {
      this.window.hide();
    } else {
      if (this.window.isMinimized()) {
        this.window.restore();
      } else if (!this.window.isVisible()) {
        this.window.show();
      }
      this.window.focus();
    }
  }

  updateTrayImage(iconUrl, flash, count, presence, presenceSource) {
    if (this.tray && !this.tray.isDestroyed()) {
      const effectiveIconPath = iconUrl || this.iconPath;
      // Teams sends the same icon data URL on every status/badge update;
      // skip the nativeImage decode + setImage round-trip when it is unchanged.
      if (effectiveIconPath !== this.lastUpdate.icon) {
        this.tray.setImage(this.getIconImage(effectiveIconPath));
      }
      this.window.flashFrame(flash);
      this.lastUpdate = {
        icon: effectiveIconPath,
        flash: flash === true,
        count: Number(count) || 0,
        presence: presence || null,
        presenceSource: presenceSource || null,
      };
      this.#renderTooltip();
    }
  }

  setHistoryUnread(count) {
    this.historyUnread = Math.max(0, Number(count) || 0);
    this.#renderTooltip();
  }

  #renderTooltip() {
    if (!this.tray || this.tray.isDestroyed()) return;
    this.tray.setToolTip(buildTrayTooltip(
      this.config.appTitle,
      this.lastUpdate.count,
      this.historyUnread,
      this.lastUpdate.presence,
      this.lastUpdate.presenceSource
    ));
  }

  close() {
    if (!this.tray.isDestroyed()) {
      this.tray.destroy();
    }
  }
}

exports = module.exports = ApplicationTray;
exports.buildTrayTooltip = buildTrayTooltip;
exports.PRESENCE_LABELS = PRESENCE_LABELS;
