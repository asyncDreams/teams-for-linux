# Main App Window

Manages the primary BrowserWindow that hosts the Teams web interface.

## Components

- **[index.js](index.js)**: Entry point and window lifecycle management
- **[browserWindowManager.js](browserWindowManager.js)**: Window creation, configuration, and event handling
- **[meetingWindowManager.js](meetingWindowManager.js)**: Pop-out meeting windows (`meetupJoinPopOutWindow`) — native-Teams-style meeting joins in a dedicated window sharing the main window's session partition, with the main window staying on chat/calendar

## Responsibilities

- Window state management (minimize, maximize, close)
- Web contents configuration and security settings
- Integration with Teams web interface
- Call event handling and screen sharing coordination
- Meeting join routing: in-app navigation (default) or pop-out meeting windows (opt-in)