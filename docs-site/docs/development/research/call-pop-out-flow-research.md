# Call Pop-Out Flow (in-chat calls in a dedicated window)

:::note
Research and design proposal. No behavior changes yet. Builds on the
meeting pop-out shipped in `app/mainAppWindow/meetingWindowManager.js`
(`meetupJoinPopOutWindow`) and the window-open interception in
`app/mainAppWindow/index.js`.
:::

## Problem

In the native Teams desktop app, clicking the call (audio/video) button in a
1:1 or group chat opens the call in its **own window** while the chat stays
put. In Teams for Linux the call takes over the main window: the chat is
replaced by the calling experience, and leaving the call navigates back. The
user asked for native-style behaviour — and, failing that, the inverse
(flow: call in main window, chat popped out).

## What already works (state of the art)

- **Meeting joins** (`/meetup-join/…`, `/meet/…`): the pop-out window manager
  hosts each meeting in a dedicated `BrowserWindow` sharing the main window's
  session partition (SSO/cookies carry over), keyed per meeting, with a
  4-window leak guard. Gated by `meetupJoinPopOutWindow`.
- **Call deep links** (`https://teams…/l/call/0/0/0?…`): the default
  `meetupJoinRegEx` already matches `l/call/`, so calls started from
  **notifications, CLI arguments, history entries, and `msteams:` protocol
  links** already route through the same pop-out path via
  `shouldPopOutJoinUrl()` (mainAppWindow lines ~850, ~936, ~958, ~983, ~1393).

## The actual gap

Clicking the **in-chat call button** is not a `window.open` — Teams performs
an SPA navigation (`did-navigate-in-page` / history push) inside the main
window to the calling route, so none of the existing interception points
(`setWindowOpenHandler`, `shouldPopOutJoinUrl`, `openMeetingWindow`) fire.
The calling surface lives in the main window with the chat view torn down.

Teams does not expose the chat id through any wrapper-visible API at click
time, so "call in pop-out, chat stays" needs an interception point that
sees the URL **before** the SPA state changes.

## Design options considered

1. **Intercept the SPA navigation in the main window**
   (`webContents.on('will-navigate')` + `did-start-navigation` with
   `isMainFrame`): detect `l/call/…` main-frame navigations and, when
   pop-out is enabled, hand the URL to `meetingWindowManager.openMeeting()`
   and `event.preventDefault()` / restore the previous route. The meeting
   manager already keys windows per call (`extractMeetingKey` handles the
   `l/call/0/0/0` id segment), so repeat clicks focus the existing call
   window. **Chosen.** Risk: distinguishing genuine call navigations from
   Teams' internal route churn; mitigated by matching only `l/call/` paths,
   only for main-frame navigations, and only when the pop-out flag is on.
2. **The inverse flow (call in main window, chat popped out)**: a second
   long-lived window hosting `https://teams…/chat/`/the main app shell.
   Technically possible (the meeting window already proves session sharing),
   but it duplicates notification/activity wiring, presence, badge counts
   and the `config-changed` merge for a second full Teams instance — a
   much larger surface for a worse default UX (the call surface is the
   thing users want out of the way, not the chat).
3. **Inject a DOM listener** on the call button: brittle against Teams DOM
   churn (the repo's own guidance: browser scripts must be defensive;
   meetings have no button either).

## Chosen design (option 1), in phases

- **Phase A — call routes pop out**: in `mainAppWindow`, when
  `meetupJoinPopOutWindow` is on, intercept main-frame navigation to
  `l/call/…` and delegate to `meetingWindowManager.openMeeting()`. The
  main window's URL/route must be restored to the chat (history back) so
  the chat stays visible. No new config option: the feature rides the
  existing `meetupJoinPopOutWindow` flag, consistent with "calls are
  meeting joins".
- **Phase B — stay-in-window fallback**: when the call window fails to
  open (limit reached, disabled mid-session), fall back to in-main-window
  behaviour exactly as today.
- **Phase C (optional, later)** — "reverse" mode as an opt-in
  `media.callPopOutMode: 'off' | 'popout' | 'reverse'` only if users ask
  for the chat-in-window variant; see option 2 for why it is parked.
- **Test surface**: unit tests for a pure `isCallRouteUrl()` helper
  (path-shape matching only, no PII); e2e stays on the meeting pop-out
  suites since the call path shares the manager.

## Deliberately out of scope

- Multi-call UX beyond the existing 4-window guard.
- Making the call window resizable-independent from the main window's zoom
  level (inherits Teams' zoom handling like meeting windows today).
- The reverse flow (option 2) without a user request.
