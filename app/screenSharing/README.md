# Screen Sharing Module

Provides native screen/window selection and preview window management for Teams screen sharing.

## Components

- **service.js** - ScreenSharingService class for IPC handlers and state management
- **index.js** - StreamSelector for source selection UI
- **browser.js** - Renderer process UI logic
- **preload.js** - Context bridge for IPC
- **injectedScreenSharing.js** - Client-side Teams DOM integration
- **diagnosticsWindow.js / diagnosticsPreload.js / diagnostics.html** - Read-only portal and fallback diagnostics

## ScreenSharingService Class

Manages screen sharing IPC handlers and state.

**Dependencies:**
- `mainWindow` - Main application window module

**IPC Channels:**
- `desktop-capturer-get-sources` - Get available screens/windows (returns `display_id` for screen sources)
- `get-screen-sharing-displays` - Get connected displays (`id`, `label`, `internal`, `bounds`, `scaleFactor`, `displayFrequency`) for picker enrichment
- `choose-desktop-media` - Show picker dialog
- `cancel-desktop-media` - Cancel selection
- `screen-sharing-started` - Session started event
- `screen-sharing-stopped` - Session stopped event
- `get-screen-sharing-status` - Check if sharing active
- `screen-sharing-get-diagnostics` - Report Wayland mode, portal availability/backend, active strategy, and the last safe error code
- `get-screen-share-stream` - Get active source ID
- `get-screen-share-screen` - Get screen dimensions
- `resize-preview-window` - Resize preview
- `stop-screen-sharing-from-thumbnail` - Stop from preview

**Usage:**
```javascript
const screenSharingService = new ScreenSharingService(config);
screenSharingService.initialize();
```

## StreamSelector Class

Shows the in-app picker UI for screen/window selection. The picker is a
full-window `WebContentsView` overlay mounted as a child of the main Teams
window. The picker UI itself lives in `index.html` / `index.css` /
`browser.js`.

```javascript
const streamSelector = new StreamSelector(parentWindow);
streamSelector.show((selectedSource) => {
  if (selectedSource) {
    console.log('Selected:', selectedSource.name);
  }
});
```

## Picker UI design

The picker is a modal overlay over the main Teams window. Issue #2524.

- **Layout:** segmented Screens / Windows tabs with live counts, a `1fr 300px` split on the Screens pane (grid on the left, live detail panel on the right), and a Windows pane with a responsive grid filtered via the search input. Footer surfaces a Quality chip with a popover menu and the Cancel / Share buttons. Keyboard shortcuts: Esc cancels, Enter shares, Tab switches focus, arrow keys move spatially between screens.
- **Screen ordering:** internal display first, then by `bounds.y`, then `bounds.x`. Puts the user's primary display in the top-left where "main" is expected.
- **Display enrichment:** the picker joins each screen source's `display_id` with `screen.getAllDisplays()` so tiles show the platform-provided display label, the resolution, the scale factor, and a `MAIN` badge for internal displays. Hovering or focusing a tile updates the detail panel with the live thumbnail and a spec list (resolution, refresh rate, scale, position, display number). When `display_id` is empty (some Wayland portal setups), the picker falls back to the source's own `name` and skips the enrichment, so the picker still works.
- **Selection feedback:** selected tile gains an accent border, glow, and check badge in the top-left; the share button label flips to "Share window" when a window is selected.
- **Thumbnails:** requested at 640x360 (vs the legacy 320x180) so tiles and the detail preview are readable without further upscaling. Tile thumbnails render with `object-fit: contain` so ultrawide screens stay fully visible.
- **Colour scheme:** the picker follows `prefers-color-scheme` (light is the base palette in `:root`, dark overrides land under `@media (prefers-color-scheme: dark)`), matching the convention used by `joinMeetingDialog` and the profile dialogs. Tile overlays (number badge, name gradient, preview stamp) keep light text because they sit on top of a dark scrim over the thumbnail in both schemes.

## Platform Notes

**Wayland:** `linux.waylandMode` supports `auto`, `enabled`, and `disabled`. When `linux.portal.enabled` is on and xdg-desktop-portal plus a session bus are available, Chromium's PipeWire portal path is preferred and the in-app Electron picker is retained as the fallback. The **Debug → Linux Desktop → Screen Sharing Diagnostics** window reports the selected strategy without exposing environment values. Legacy `wayland.mode` and `wayland.portal.enabled` aliases remain supported. MediaStream UUIDs are not used as desktopCapturer source IDs.

See [ADR 001](../../docs-site/docs/development/adr/001-use-desktopcapturer-source-id-format.md) for technical details.
