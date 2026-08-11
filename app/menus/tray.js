const { Tray, Menu, ipcMain, nativeImage } = require("electron");
const os = require("node:os");
const isMac = os.platform() === "darwin";

class ApplicationTray {
  constructor(window, appMenu, iconPath, config) {
    this.window = window;
    this.iconPath = iconPath;
    this.appMenu = appMenu;
    this.config = config;

    this.tray = new Tray(this.getIconImage(this.iconPath));
    this.tray.setToolTip(this.config.appTitle);
    this.tray.on("click", () => this.showAndFocusWindow());
    this.tray.setContextMenu(Menu.buildFromTemplate(this.appMenu));
  }

  initialize() {
    // Update tray icon based on Teams status (notifications, badge count)
    ipcMain.on("tray-update", this.#handleTrayUpdate.bind(this));
  }

  #handleTrayUpdate(_event, data) {
    const { icon, flash, count, presence } = data || {};
    this.updateTrayImage(icon, flash, count, presence);
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

  updateTrayImage(iconUrl, flash, count, presence) {
    if (this.tray && !this.tray.isDestroyed()) {
      const effectiveIconPath = iconUrl || this.iconPath;
      const image = this.getIconImage(effectiveIconPath);
      this.tray.setImage(image);
      this.window.flashFrame(flash);
      const baseTitle = this.config.appTitle;
      const PRESENCE_LABELS = { 1: "Available", 2: "Busy", 3: "Do not disturb", 4: "Away", 5: "Be right back" };
      const parts = [baseTitle];
      if (count > 0) parts.push(`(${count})`);
      if (presence && PRESENCE_LABELS[presence]) parts.push(`— ${PRESENCE_LABELS[presence]}`);
      this.tray.setToolTip(parts.join(" "));
    }
  }

  close() {
    if (!this.tray.isDestroyed()) {
      this.tray.destroy();
    }
  }
}
exports = module.exports = ApplicationTray;
