# Keep Desktop

Keep Desktop is a thin Tauri v2 macOS shell for the console served by `keep serve` at `http://localhost:7777/app`. It contains no Keep application logic.

From the repository root, run `npm run desktop:dev` for development or `npm run desktop:build` for a release bundle. The built application lands at `desktop/src-tauri/target/release/bundle/macos/Keep.app`.

`keep serve` must be running before the console can load. The local launcher page keeps polling the daemon and shows the launchd command if it cannot connect.

The web app uses the global Tauri API for `set_badge`, `send_notification`, `get_notification_click`, and `acknowledge_notification_click`. These commands have generated permissions granted only to the console's loopback origins. Bundled macOS notifications use UserNotifications and carry the attention key; clicks focus the window and select that item. A pending click survives page reloads and is acknowledged only after a successful state refresh. Older shells and unbundled development builds fall back to the notification plugin (without session navigation).

Closing the macOS window hides it so the console continues receiving updates and notifications; Quit still exits the app. Background throttling is disabled on macOS 14 and newer. On macOS 12–13, WebKit may suspend a hidden console, delaying notifications until it becomes visible. The web console subscribes before its initial load and retries failed refreshes, including after daemon restarts.

The bell at the right of the toolbar opens the alert inbox, with persistent read/unread
state, card notes, and links to sessions and the reviewer. These messages come from
`keep alert`, independently of the session waiting queue. Fresh eligible alerts use
`alert:<id>` click targets to open the inbox; the daemon persists desktop claims to
avoid replaying banners across windows and reloads. Existing sound/phone/speaker
routing remains in effect. Enable notification permission from the inbox if needed.
