"use strict";

const { app, ipcMain } = require("electron");

const SERVICE_NAME = "org.mpris.MediaPlayer2.teams_for_linux";
const OBJECT_PATH = "/org/mpris/MediaPlayer2";
const PLAYER_INTERFACE = "org.mpris.MediaPlayer2.Player";

const ACTIONS = new Set([
  "play",
  "pause",
  "play-pause",
  "stop",
  "toggle-microphone",
  "toggle-camera",
  "answer-call",
  "decline-call",
  "leave-meeting",
]);

/**
 * Build the small action surface used by the optional MPRIS bridge. Keeping
 * this separate makes the action contract testable without a session bus.
 */
function buildMprisInterface(dispatch) {
  const method = (action) => (...args) => {
    const callback = typeof args.at(-1) === "function" ? args.at(-1) : null;
    dispatch(action);
    if (callback) callback(null);
  };

  return {
    name: PLAYER_INTERFACE,
    methods: {
      Play: ["", method("play")],
      Pause: ["", method("pause")],
      PlayPause: ["", method("play-pause")],
      Stop: ["", method("stop")],
      ToggleMicrophone: ["", method("toggle-microphone")],
      ToggleCamera: ["", method("toggle-camera")],
      AnswerCall: ["", method("answer-call")],
      DeclineCall: ["", method("decline-call")],
      LeaveMeeting: ["", method("leave-meeting")],
    },
  };
}

function buildMprisRootInterface(dispatch) {
  const method = (action) => (...args) => {
    const callback = typeof args.at(-1) === "function" ? args.at(-1) : null;
    dispatch(action);
    if (callback) callback(null);
  };
  return {
    name: "org.mpris.MediaPlayer2",
    methods: {
      Raise: ["", method("play")],
      Quit: ["", method("stop")],
    },
  };
}

class LinuxMediaControls {
  #config;
  #getWindow;
  #bus = null;
  #available = false;
  #initialized = false;
  #lastError = null;
  #state = {
    callActive: false,
    incomingCall: false,
    microphone: "unknown",
    camera: false,
    screenSharing: false,
  };

  constructor(config, getWindow) {
    this.#config = config || {};
    this.#getWindow = getWindow;
  }

  initialize() {
    if (this.#initialized || process.platform !== "linux") return;
    this.#initialized = true;
    if (this.#config.linux?.mediaControls?.enabled !== true) return;

    // Receive camera state updates for the optional Linux media-control surface.
    ipcMain.on("camera-state-changed", (_event, enabled) => {
      this.#state.camera = enabled === true;
      this.#publishState();
    });
    // Receive microphone state updates for the optional Linux media-control surface.
    ipcMain.on("microphone-state-changed", (_event, state) => {
      this.#state.microphone = typeof state === "string" ? state : "unknown";
      this.#publishState();
    });
    // Track screen-sharing start for the optional Linux media-control surface.
    ipcMain.on("screen-sharing-started", () => {
      this.#state.screenSharing = true;
      this.#publishState();
    });
    // Track screen-sharing stop for the optional Linux media-control surface.
    ipcMain.on("screen-sharing-stopped", () => {
      this.#state.screenSharing = false;
      this.#publishState();
    });
    app.on("teams-call-connected", () => {
      this.#state.callActive = true;
      this.#publishState();
    });
    app.on("teams-call-disconnected", () => {
      this.#state.callActive = false;
      this.#publishState();
    });
    app.on("teams-incoming-call-started", () => {
      this.#state.incomingCall = true;
      this.#publishState();
    });
    app.on("teams-incoming-call-ended", () => {
      this.#state.incomingCall = false;
      this.#publishState();
    });

    this.#connect();
  }

  getDiagnostics() {
    return {
      enabled: this.#config.linux?.mediaControls?.enabled === true,
      available: this.#available,
      lastError: this.#lastError,
      state: { ...this.#state },
    };
  }

  #connect() {
    try {
      // The dependency is already used by the Linux download integrations.
      // Keep this optional: desktops without a session bus must not prevent
      // Teams from starting.
      const dbus = require("@homebridge/dbus-native");
      const bus = dbus.sessionBus();
      if (typeof bus.requestName !== "function" || typeof bus.exportInterface !== "function") {
        this.#rememberError("dbus-server-api-unavailable");
        return;
      }
      bus.requestName(SERVICE_NAME, 4, (error) => {
        if (error) {
          this.#rememberError("mpris-name-request-failed");
          return;
        }
        try {
          const dispatch = (action) => this.#dispatch(action);
          bus.exportInterface(buildMprisRootInterface(dispatch), OBJECT_PATH);
          bus.exportInterface(buildMprisInterface(dispatch), OBJECT_PATH);
          this.#bus = bus;
          this.#available = true;
          this.#publishState();
        } catch {
          this.#rememberError("mpris-export-failed");
        }
      });
    } catch {
      this.#rememberError("session-bus-unavailable");
    }
  }

  #dispatch(action) {
    if (!ACTIONS.has(action)) return;
    const window = this.#getWindow?.();
    if (!window || window.isDestroyed()) return;
    // The renderer owns Teams' current call controls. The action name is a
    // fixed allowlist value, never user-controlled text.
    window.webContents.send("linux-media-control", action);
  }

  #publishState() {
    if (!this.#available || !this.#bus?.sendSignal) return;
    // MPRIS consumers can still observe a compact state change even on
    // implementations that do not understand the optional action methods.
    try {
      this.#bus.sendSignal(
        OBJECT_PATH,
        "org.freedesktop.DBus.Properties",
        "PropertiesChanged",
        "sa{sv}as",
        [
          PLAYER_INTERFACE,
          [["PlaybackStatus", ["s", this.#state.callActive ? "Playing" : "Stopped"]]],
          [],
        ],
      );
    } catch {
      // A disappearing session bus is non-fatal; diagnostics remains useful.
    }
  }

  #rememberError(code) {
    this.#lastError = { code, at: new Date().toISOString() };
  }
}

module.exports = { LinuxMediaControls, ACTIONS, buildMprisInterface, buildMprisRootInterface };
