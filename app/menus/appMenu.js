const { shell } = require("electron");
const buildProfilesMenu = require("./profilesMenu");

exports = module.exports = (Menus) => ({
  label: "Teams for Linux",
  submenu: [
    {
      label: "Open",
      accelerator: "ctrl+O",
      click: () => Menus.open(),
    },
    {
      label: "Join Meeting",
      accelerator: "ctrl+J",
      click: () => Menus.joinMeeting(),
    },
    {
      label: "Return to Teams",
      click: () => Menus.returnToTeams(),
    },
    getViewMenu(Menus),
    ...(Menus.configGroup.startupConfig.quickChat?.enabled
      ? [
          {
            label: "Quick Chat",
            accelerator: Menus.configGroup.startupConfig.quickChat?.shortcut || undefined,
            click: () => Menus.showQuickChat(),
          },
        ]
      : []),
    {
      label: "Refresh",
      accelerator: "ctrl+R",
      click: () => Menus.reload(),
    },
    ...(process.env.APPIMAGE
      ? [
          {
            label: "Check for Updates",
            click: () => Menus.checkForUpdates(),
          },
        ]
      : []),
    {
      label: "Hide",
      accelerator: "ctrl+H",
      click: () => Menus.hide(),
    },
    {
      label: "Debug",
      submenu: [
        {
          label: "Open DevTools",
          accelerator: "ctrl+D",
          click: () => Menus.debug(),
        },
        {
          label: "Open GPU Info",
          click: () => Menus.showGpuInfo(),
        },
        {
          label: "Diagnostics",
          click: () => Menus.openDiagnostics(),
        },
        {
          label: "Presence",
          submenu: getPresenceMenu(Menus),
        },
        {
          label: "Linux Desktop",
          submenu: getLinuxDesktopMenu(Menus),
        },
      ],
    },
    {
      type: "separator",
    },
    getSettingsMenu(Menus),
    getPreferencesMenu(),
    getNotificationsMenu(Menus),
    ...(Menus.configGroup.startupConfig.multiAccount?.enabled
      ? [buildProfilesMenu(Menus)].filter(Boolean)
      : []),
    {
      type: "separator",
    },
    {
      label: "About",
      click: () => Menus.about(),
    },
    getHelpMenu(Menus),
    {
      label: "Extensions",
      submenu: [
        {
          label: "Install CRX...",
          enabled: Menus.configGroup.startupConfig.extensions?.enabled === true
            && Menus.configGroup.startupConfig.extensions?.allowCrx !== false,
          click: () => Menus.installExtensionCrx(),
        },
        {
          label: "Load Unpacked...",
          enabled: Menus.configGroup.startupConfig.extensions?.enabled === true
            && Menus.configGroup.startupConfig.extensions?.allowUnpacked !== false,
          click: () => Menus.loadExtensionUnpacked(),
        },
        {
          type: "separator",
        },
        {
          label: "Manage Extensions",
          click: () => Menus.openExtensionsManager(),
        },
      ],
    },
    ...(Menus.configGroup.startupConfig.media?.video?.menuEnabled
      ? [
          {
            type: "separator",
          },
          getVideoMenu(Menus),
        ]
      : []),
    {
      type: "separator",
    },
    {
      label: "Quit (Clear Storage)",
      click: () => Menus.quit(true),
    },
    {
      label: "Quit",
      accelerator: "ctrl+Q",
      click: () => Menus.quit(),
    },
  ],
});

function getViewMenu(Menus) {
  return {
    label: "View",
    submenu: [
      {
        label: "Notification History",
        click: () => Menus.openNotificationHistory(),
      },
    ],
  };
}

function getPresenceMenu(Menus) {
  const mode = Menus.configGroup.startupConfig.presence?.keepAlwaysOnlineMode
    || (Menus.configGroup.startupConfig.presence?.keepAlwaysOnline ? "always" : "disabled");
  return [
    {
      label: "Unified presence sync",
      type: "checkbox",
      checked: Menus.configGroup.startupConfig.presence?.sync?.enabled === true,
      click: () => Menus.togglePresenceSync(),
    },
    {
      type: "separator",
    },
    {
      label: "Disabled",
      type: "radio",
      checked: mode === "disabled",
      click: () => Menus.setKeepAlwaysOnlineMode("disabled"),
    },
    {
      label: "Always",
      type: "radio",
      checked: mode === "always",
      click: () => Menus.setKeepAlwaysOnlineMode("always"),
    },
    {
      label: "Business Hours",
      type: "radio",
      checked: mode === "business-hours",
      click: () => Menus.setKeepAlwaysOnlineMode("business-hours"),
    },
  ];
}

function getLinuxDesktopMenu(Menus) {
  const waylandMode = Menus.configGroup.startupConfig.linux?.waylandMode
    || Menus.configGroup.startupConfig.wayland?.mode
    || "auto";
  return [
    ...["auto", "enabled", "disabled"].map((mode) => ({
      label: `Wayland: ${mode[0].toUpperCase()}${mode.slice(1)}`,
      type: "radio",
      checked: waylandMode === mode,
      click: () => Menus.setWaylandMode(mode),
    })),
    {
      type: "separator",
    },
    {
      label: "Prefer desktop portal for screen sharing",
      type: "checkbox",
      checked: Menus.configGroup.startupConfig.linux?.portal?.enabled !== false,
      click: () => Menus.toggleLinuxPortal(),
    },
    {
      label: "Linux media controls",
      type: "checkbox",
      checked: Menus.configGroup.startupConfig.linux?.mediaControls?.enabled === true,
      click: () => Menus.toggleLinuxMediaControls(),
    },
  ];
}

function getSettingsMenu(Menus) {
  return {
    label: "Settings",
    submenu: [
      {
        label: "Save",
        click: () => Menus.saveSettings(),
      },
      {
        label: "Restore",
        click: () => Menus.restoreSettings(),
      },
    ],
  };
}

function getPreferencesMenu() {
  return {
    label: "Zoom",
    submenu: [
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { role: "togglefullscreen" },
    ],
  };
}

function getNotificationsMenu(Menus) {
  return {
    label: "Notifications",
    submenu: [
      {
        label: "Disable All Notifications",
        type: "checkbox",
        checked: Menus.configGroup.startupConfig.disableNotifications,
        click: () => Menus.toggleDisableNotifications(),
      },
      {
        label: "Disable Notifications Sound",
        type: "checkbox",
        checked: Menus.configGroup.startupConfig.disableNotificationSound,
        click: () => Menus.toggleDisableNotificationSound(),
      },
      {
        label: "Disable Sound when Not Available (e.g: busy, in a call)",
        type: "checkbox",
        checked:
          Menus.configGroup.startupConfig
            .disableNotificationSoundIfNotAvailable,
        click: () => Menus.toggleDisableNotificationSoundIfNotAvailable(),
      },
      {
        label: "Disables Window Flash on New Notifications",
        type: "checkbox",
        checked: Menus.configGroup.startupConfig.disableNotificationWindowFlash,
        click: () => Menus.toggleDisableNotificationWindowFlash(),
      },
      {
        label: "Disable Badge Count",
        type: "checkbox",
        checked: Menus.configGroup.startupConfig.disableBadgeCount,
        click: () => Menus.toggleDisableBadgeCount(),
      },
      {
        type: "separator",
      },
      {
        label: "Group by conversation",
        type: "checkbox",
        checked: !!Menus.configGroup.startupConfig.notifications?.grouping,
        click: () => Menus.toggleNotificationGrouping(),
      },
      {
        label: "Show notification actions",
        type: "checkbox",
        checked: !!Menus.configGroup.startupConfig.notifications?.actions,
        click: () => Menus.toggleNotificationActions(),
      },
      {
        label: "Show sender avatar",
        type: "checkbox",
        checked: !!Menus.configGroup.startupConfig.notifications?.avatar,
        click: () => Menus.toggleNotificationAvatar(),
      },
      {
        label: "Urgency",
        submenu: [
          {
            label: "Low",
            type: "checkbox",
            checked:
              Menus.configGroup.startupConfig.defaultNotificationUrgency ===
              "low",
            click: () => Menus.setNotificationUrgency("low"),
          },
          {
            label: "Normal",
            type: "checkbox",
            checked:
              Menus.configGroup.startupConfig.defaultNotificationUrgency ===
              "normal",
            click: () => Menus.setNotificationUrgency("normal"),
          },
          {
            label: "Critical",
            type: "checkbox",
            checked:
              Menus.configGroup.startupConfig.defaultNotificationUrgency ===
              "critical",
            click: () => Menus.setNotificationUrgency("critical"),
          },
        ],
      },
    ],
  };
}

function getHelpMenu(Menus) {
  return {
    label: "Help",
    submenu: [
      {
        label: "Teams for Linux Documentation",
        click: () => Menus.showDocumentation(),
      },
      {
        type: "separator",
      },
      {
        label: "Online Documentation",
        click: () =>
          shell.openExternal("https://support.office.com/en-us/teams"),
      },
      {
        label: "Github Project",
        click: () =>
          shell.openExternal(
            "https://github.com/IsmaelMartinez/teams-for-linux"
          ),
      },
      {
        label: "Microsoft Teams Support",
        click: () =>
          shell.openExternal(
            "https://answers.microsoft.com/en-us/msteams/forum"
          ),
      },
    ],
  };
}

function getVideoMenu(Menus) {
  return {
    label: "Video",
    submenu: [
      {
        label: "Force enable PiP mode for shared screen",
        click: () => {
          Menus.forcePip();
        },
      },
      {
        label: "Force toggle controls for all video elements",
        click: () => {
          Menus.forceVideoControls();
        },
      },
    ],
  };
}
