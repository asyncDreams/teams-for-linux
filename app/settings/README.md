# Configuration Settings

In-app configuration UI (Settings → Configuration…), implementing Phase 3b of
the config-UX research
([documentation-and-config-ux-research.md](../../../docs-site/docs/development/research/documentation-and-config-ux-research.md)).

## Files

| File | Purpose |
| --- | --- |
| `configSettingsService.js` | Main-process service: derives the settings schema from `app/config/options.js`, validates writes against it, persists override deltas through the existing config store (`legacyConfigStore`), and registers the `settings-config-*` IPC handlers |
| `settingsWindow.js` | Sandboxed `BrowserWindow` (contextIsolation + sandbox), mirroring the DiagnosticsWindow pattern |
| `settingsPreload.js` | Thin `contextBridge` exposing only the five `settings-config-*` channels |
| `settings.html` / `settings.js` | Schema-driven renderer: grouped sidebar, search, per-option editors, reset and restart actions |

## How it works

- **Single source of truth**: the schema (types, defaults, choices,
  `applyMode`, nested fields) is derived from `app/config/options.js` at
  runtime, so the UI can never offer an option that does not exist and new
  options appear automatically.
- **Persistence**: a change is validated, applied to the running
  `startupConfig`, and the override delta (values differing from the schema
  default) is recomputed and written via `legacyConfigStore` — the same store
  the menu toggles use, so values survive restart through the existing boot
  merge with no new persistence format.
- **Apply modes**: `applyMode: "live"` options additionally notify the host,
  which broadcasts `config-changed` to the Teams renderer (identical to the
  menu toggles); everything else is marked "needs restart" and the window
  offers a restart action (`app.relaunch()` + `app.exit(0)`).
- **Secrets stay file-only**: `clientCertPassword` is hidden from the UI; a
  handful of expert options (`chromeUserAgent`, `electronCLIFlags`,
  `customCACertsFingerprints`, `meetupJoinRegEx`) are exposed only through a
  JSON editor.
- **Security**: writes are validated against the schema (type, choices, size
  bounds), object writes reject `__proto__` / `constructor` / `prototype`
  paths, every channel is allowlisted in `app/security/ipcValidator.js`, and
  the renderer builds DOM with `createElement`/`textContent` only.

## IPC channels

| Channel | Type | Purpose |
| --- | --- | --- |
| `settings-config-schema` | handle | Schema snapshot for the renderer |
| `settings-config-values` | handle | Current effective values + persisted overrides |
| `settings-config-set` | handle | Validate and apply one change |
| `settings-config-reset` | handle | Restore defaults (one option or all) |
| `settings-config-restart` | event | Restart request |

## Tests

`tests/unit/configSettingsService.test.js` covers schema derivation, value
validation, path helpers, override diffing/merging, live-change hooks, and the
store behaviour with a fake config group.
