# Browser Module

Handles browser-side code injection and communication with the Teams web interface.

## Structure

- **[index.js](index.js)**: Entry point for browser integration
- **[notifications/](notifications/)**: Activity monitoring and unread count management
- **[tools/](tools/)**: Client-side scripts injected into Teams interface
- **[preload.js](preload.js)**: Preload script for secure IPC communication
- **[tools/moduleRegistry.js](tools/moduleRegistry.js)**: Declarative registry of browser modules and their IPC requirements

## Browser module registry

`preload.js` does not hard-code the list of browser modules it initializes. That
list — and the decision of which modules receive `ipcRenderer` during
`init(config, ipcRenderer)` — is declared once in
[tools/moduleRegistry.js](tools/moduleRegistry.js):

```js
{ name: "trayIconRenderer", path: "./trayIconRenderer", requiresIpc: true },
```

**To add a browser module:** create the tool in `tools/` exporting
`init(config)` or `init(config, ipcRenderer)`, then add one entry to
`BROWSER_MODULES`. Set `requiresIpc: true` if and only if the `init`
signature takes `ipcRenderer`.

The registry's invariants are enforced by `tests/unit/preloadModules.test.js`:

- `settings`, `theme`, `trayIconRenderer` and `mqttStatusMonitor` must keep
  `requiresIpc: true` (issue #1902 — these were accidentally dropped from the
  preload init list multiple times in git history, breaking tray icons and
  MQTT status publishing for users)
- every registered module must load and export an `init` function
- every `requiresIpc` flag must match the real module's `init` arity
- `preload.js` must initialize modules through `initBrowserModules()`

## Key Features

- Notification count tracking and tray icon updates
- Custom CSS injection
- Browser API patching for enhanced functionality
- Activity monitoring for status updates
- Microphone auto-gain control disabling
- Screen sharing stream management
- Keyboard shortcuts and zoom controls
