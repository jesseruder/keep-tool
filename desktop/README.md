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

The desktop toolbar speaker button mutes waiting sounds (saved locally across launches).
A macOS Pop plays only when Waiting on you changes from empty to nonempty,
including batched arrivals. Startup and additional arrivals while already waiting
are silent. Desktop banners are silent; the queue transition owns audio.
The loopback-only `play_attention_sound` command plays the system sound without
requiring notification permission.

Project icons use the bundled SVG catalog in `web/app/project-catalog.js`. When the
console sees a new project, it displays a folder while the daemon's background
summary queue picks a catalog icon from the repo name and the first 6 KB of its
README. The icon's catalog color is used automatically. Existing project choices
stay fixed; model output cannot add SVG markup. Valid choices are saved under
`.keep/project-icons/` and reused across browser sessions and Git worktrees of the
same repo. The initial scan also includes existing sessions and task projects.
If selection is unavailable, the folder remains and normal polling retries;
project-icon work has lower priority than session summaries. These local choices
are not synced through Git.

In the Mac app, pasting a screenshot into a focused Codex or Claude Code terminal
with Cmd+V (or Edit → Paste) forwards that agent's Ctrl+V image-attachment shortcut.
The image stays on the shared macOS clipboard until the agent reads it; Keep does
not upload it or submit the prompt. Ordinary text keeps xterm's normal bracketed
paste behavior. Shell panes and remote browser viewers do not use this shortcut.
A native format-only check handles clipboard images that WebKit does not expose;
older Keep builds can still handle exposed PNG items, or use Control+V directly.
Disconnected terminals ask for another paste after reconnecting instead of queuing
an image shortcut against clipboard contents that may have changed.
