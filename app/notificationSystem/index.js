const { ipcMain } = require('electron');
const NotificationToast = require('./NotificationToast');

class CustomNotificationManager {
  #mainWindow;
  #toastDuration;
  #activeToasts;

  constructor(config, mainWindow) {
    this.#mainWindow = mainWindow;
    this.#toastDuration = config?.customNotification?.toastDuration || 5000;
    this.#activeToasts = new Set();
  }

  initialize() {
    // Display custom in-app toast notification in bottom-right corner
    ipcMain.on('notification-show-toast', this.#handleShowToast.bind(this));
    // Handle toast clicks - close the window and focus main window
    ipcMain.on('notification-toast-click', this.#handleToastClick.bind(this));
    ipcMain.on('notification-toast-action', this.#handleToastAction.bind(this));

    console.info('[CustomNotificationManager] Initialized and listening on "notification-show-toast" channel');
  }

  #normalizeToastData(data) {
    const title = String(data?.title || 'Teams').slice(0, 200);
    const body = String(data?.body || '').slice(0, 400);
    const kind = typeof data?.kind === 'string' ? data.kind : undefined;
    // Avatar: allow data: url up to 32k, otherwise initials fallback
    let avatarDataUrl = null;
    let senderInitial = null;
    if (typeof data?.icon === 'string' && data.icon.startsWith('data:') && data.icon.length < 35000) avatarDataUrl = data.icon;
    else if (typeof data?.avatarDataUrl === 'string' && data.avatarDataUrl.startsWith('data:') && data.avatarDataUrl.length < 35000) avatarDataUrl = data.avatarDataUrl;
    if (!avatarDataUrl && title) senderInitial = title.trim().charAt(0).toUpperCase() || 'T';
    const actions = Array.isArray(data?.actions) ? data.actions.slice(0, 2).map(a => typeof a === 'string' ? { text: a } : a) : undefined;
    return { title, body, kind, avatarDataUrl, senderInitial, actions };
  }

  #handleShowToast(event, data) {
    if (!data?.title) {
      console.warn('[CustomNotificationManager] Invalid notification data, missing title');
      return;
    }
    try {
      const normalized = this.#normalizeToastData(data);
      const toast = new NotificationToast(normalized, this.#toastDuration);
      this.#activeToasts.add(toast);
      const originalClose = toast.close.bind(toast);
      toast.close = function() {
        originalClose();
        this.#activeToasts.delete(toast);
      }.bind(this);
      toast.show();
      console.debug('[CustomNotificationManager] Toast displayed');
    } catch (error) {
      console.error('[CustomNotificationManager] Error displaying toast:', error);
    }
  }

  #handleToastClick(event) {
    try {
      for (const toast of this.#activeToasts) {
        if (toast.getWebContents() === event.sender) { toast.close(); break; }
      }
      if (this.#mainWindow && !this.#mainWindow.isDestroyed()) { this.#mainWindow.show(); this.#mainWindow.focus(); }
    } catch (error) {
      console.error('[CustomNotificationManager] Error handling toast click:', error);
    }
  }

  #handleToastAction(event, action) {
    try {
      for (const toast of this.#activeToasts) {
        if (toast.getWebContents() === event.sender) { toast.close(); break; }
      }
      if (this.#mainWindow && !this.#mainWindow.isDestroyed()) { this.#mainWindow.show(); this.#mainWindow.focus(); }
      console.debug('[CustomNotificationManager] Toast action', { action: String(action || '').slice(0, 30) });
    } catch (error) {
      console.error('[CustomNotificationManager] Error handling toast action:', error);
    }
  }
}

module.exports = CustomNotificationManager;
