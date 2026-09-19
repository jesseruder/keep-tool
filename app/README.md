# Keep mobile

An Expo SDK 57 app for your own Keep registry. It connects to your running Keep
daemon; each teammate enters their own server address and access token.

## The shell

The app is a shell around the Keep web console rather than a second interface over
the same API. Three screens, on a React Navigation native stack:

- **Setup** — server URL, token, and palette, saved in AsyncStorage, plus the push
  registration state with a Retry and **Forget this server**. Reachable again from
  the gear in the console screen's top bar.
- **Console** — a `react-native-webview` holding the console itself. This is where
  everything happens.
- **Terminal** — the native terminal, reached only when the console asks for it. The
  old polled plain-text viewer is still there behind a **Text view** toggle, which is
  remembered; it goes away once the native one has a week of use.

### Bootstrap

The WebView always loads `<server>/app?token=<token>`. The daemon answers with a 302
to `/app` after setting an opaque `keep-session` cookie, so the token is not left in
the address the page keeps. That session lives only in the frontend worker's memory:
**every daemon restart forgets it**, which makes re-bootstrapping ordinary rather
than exceptional. The app reloads the `?token=` URL when

- the Console screen mounts,
- the app returns to the foreground after five minutes or more away,
- the top frame gets an HTTP 403, or the console posts `{type:'unauthorized'}`.

Three independent brakes hold it, because each one alone has a hole: at most one
reload per ten seconds; at most three in five minutes; and two *attempted* reloads
with no `authenticated` between them stop the retrying outright. Whichever trips
first shows the native banner pointing at Setup, and only Retry or the manual reload
clears them. The one exemption from the interval is the first refusal after a mount,
so a daemon restart recovers at once — it is spent on use and nothing re-arms it.

A refusal the interval postpones is not a failure and is not dropped: the rule
returns a `retryAt`, the Console screen holds a timer for it, and the reload happens
once the interval is up. Counting postponed refusals stranded a phone with a
perfectly good token behind the error panel whenever two daemon restarts landed
within ten seconds of each other.

Only `{type:'authenticated'}`, which the console posts once per page load after a
request actually comes back 200, clears the failure count. **`ready` does not**: it
says the page's scripts ran, which they do before any request and again after every
`hello`, so treating it as proof of a session let alternating ready/unauthorized
reload in a loop. `decideBootstrap` in `src/bridge.js` is the whole rule as a pure
function, and `bridge.test.js` drives the adversarial sequence through it. Nothing
else in the app stores or reads the cookie.

The native side still sends `x-keep-token` for the three things it does itself: the
setup connection check, push registration, and the background sweep.

### Terminal

The phone runs xterm's parser itself. `@xterm/headless` parses the pane's bytes in the
app (`src/terminal/emulator.js`) and the rows are drawn as native `<Text>`, one per
line with a nested `<Text>` per styling run — there is no canvas in React Native to
hand xterm's renderer, and a screenshot stream would cost far more than the bytes.

The phone is an **observer**. `src/terminal/socket.js` attaches with `viewer=mobile-…`
and `primary=0`, and never sends `resize` or `primary`, so opening a session on the
phone cannot reflow the window somebody is typing into on the Mac. The geometry is
adopted, not chosen: from the `attached` frame, and again from every later pane frame,
so resizing the window on the Mac reflows the phone with it. The host does accept an
observer's keystrokes, so a question can still be answered from the phone; the status
bar says so.

| module | what it owns |
| --- | --- |
| `terminal/emulator.js` | the parser, the viewport rows, the scrollback, the cursor and the modes |
| `terminal/socket.js` | the relay: attach, replay, live bytes, visibility, reconnect, `history=full` |
| `terminal/stream.js` | writes and resizes in one order: a resize drains what was written before it |
| `terminal/scrollback.js` | the rows above the screen, mirrored out of the buffer |
| `terminal/render-queue.js` | the ~30 fps clock and the coalescing of dirty rows |
| `terminal/row.js` | a row cut into styling runs, with the cursor cell split out |
| `terminal/style.js` | a run turned into a React Native style, including the 256-colour palette |
| `terminal/keys.js` | key and text to bytes: modes, sticky modifiers, paste, the hidden field's delta |
| `terminal/zoom.js` | the pinch arithmetic |

Each of those has a `node --test` file beside it; everything awkward about the screen
lives in one of them rather than in the component.

**Painting.** Bytes arrive at whatever rate the pane produces them, so the screen is
repainted on a clock: the first change after a quiet moment paints at once, and
anything within the next 33 ms is coalesced into one frame. Only the rows xterm
reports as dirty are re-read, and each row is a memoized component, so a spinner
repaints one line. A resize, an alternate-screen switch or the end of a replay
invalidates the whole screen instead.

**Scrolling and zoom.** The pane is desktop-width, so the screen scrolls sideways;
pinching scales the font between 6 and 20 px and the size is remembered. Lines that
scroll off the top are kept as they go past and mounted above the live screen, so
scrolling up reads them; the view follows the output whenever it is at the bottom.
How many went past is *measured* (the normal buffer's `baseY`, which a scroll region
or the alternate screen does not touch) rather than counted from xterm's scroll
events, which fire for both. Collecting them is only sound while they stay put, and
two things move them: a full buffer, which drops its oldest line for every new one,
and a resize, which re-wraps lines and shuffles them between the screen and the
scrollback. Either way the mounted window is read from the buffer again instead of
being added to — for a full buffer, only while the reader is actually looking at it.

A resize is also why writes and resizes share one queue. xterm parses asynchronously
but resizes immediately, so a pane frame reporting the Mac's new window size could
otherwise lay bytes that are still in the parser's queue out at a geometry they were
never written for. `terminal/stream.js` drains what was written before the resize,
applies it, rebuilds the scrollback, and only then lets the next frame through.
**Load earlier output** first mounts more of what the app already holds and then
reattaches with `history=full`, which is how the console's own history button works:
the pane's whole scrollback arrives in the attach snapshot, rather than being stitched
on from a second source.

**Typing.** A hidden `TextInput` (no autocorrect, no suggestions, `visible-password` on
Android) is held at a sentinel string, and every change is read as a difference against
it — which is the only way a soft keyboard can report a backspace on an empty field.
The key bar sends: Esc `ESC`, Tab `TAB`, sticky Ctrl and Alt, the arrows and Home/End
in either CSI or SS3 form depending on the pane's cursor-keys mode, PgUp/PgDn, ⇧⏎ as
`ESC CR` (what `web/app/terminal.js` sends, so Claude Code and Codex insert a newline
instead of submitting), Backspace `DEL`, ^C, and Paste. Paste is bracketed when the
program asked for it. Copy and paste use React Native's own clipboard, which is
deprecated but still present in 0.86; without it those two buttons say so rather than
failing silently.

### Bridge

`window.keepShell` is defined before the console's own scripts run:

```js
window.keepShell = { platform, version, post(message) { … } };
```

That injection is not guaranteed to win the race against the page's own scripts on
Android, so once the page has loaded the app injects it again if it is missing and
then sends `{type:'hello'}`. The console answers a `hello` by switching to mobile
mode and re-posting `ready` and its last badge, so **`ready` can arrive more than
once** and the shell treats it as idempotent — and as carrying no authority over the
session, per the bootstrap rules above.

Console → shell, via `window.keepShell.post(message)`:

| message | effect |
| --- | --- |
| `{type:'ready'}` | hides the native loading overlay; nothing else, and repeatable |
| `{type:'authenticated'}` | a request came back 200; clears the refusal count |
| `{type:'unauthorized'}` | re-bootstraps, under the rules above |
| `{type:'badge', count}` | sets the launcher badge |
| `{type:'notify', title, body, key}` | schedules an immediate local notification carrying `key` |
| `{type:'openTerminal', pane, session, title}` | opens the Terminal screen on that target |
| `{type:'openExternal', url}` | hands an `http(s)` URL to the phone's browser |

Anything else — bad JSON, an unknown type, a `javascript:` URL — is dropped.

Shell → console, if the page defines `window.keepShellReceive(message)`:

| message | when |
| --- | --- |
| `{type:'hello'}` | the page has loaded; asks the console to re-announce itself |
| `{type:'notificationClick', key}` | a notification is tapped, including from a cold start |
| `{type:'reload'}` | the ⟳ button in the top bar; long-press re-bootstraps instead |

The background sweep's own notifications have no console-issued key, so their `key` is
the sweep's `kind:sessionId:since` and the session id travels with it.

`src/bridge.js` holds all of this as pure functions — URL, injected scripts, parser,
dispatch table — and `src/bridge.test.js` covers them with plain `node --test`.

A message for a console that has not said `ready` yet has nowhere to go —
`window.keepShellReceive` does not exist, and the injection is swallowed — so `send`
refuses it and the shell keeps it. A message leaves the queue only when a send
actually succeeds, never merely because the console registered itself, and the
Console screen re-registers on every `ready`, which is what brings the drain back
around. The queue holds five, in order. That is the ordinary case for a notification
tapped from a cold start: `queueShellMessage`/`drainShellQueue` in `src/bridge.js`.

### Push

The phone registers itself with the daemon and is pushed to through Expo.
`src/push.js` is the whole rule as pure functions — the Expo calls (permission, the
token) and the HTTP client are injected by `App.js` — and `src/push.test.js` drives
it with a fake api and a fake AsyncStorage.

**Registration.** On every launch with a saved config, and again when Setup saves
one: ask for notification permission, get an Expo push token for the EAS project id
in `extra.eas.projectId`, and `POST /api/devices`:

```json
{ "expoPushToken": "ExponentPushToken[…]", "platform": "android",
  "name": "android phone", "appVersion": "1.0.0" }
```

`name` would be the device's model if `expo-device` were a dependency; it is not, so
it is the platform. The daemon keys devices by the token, so re-registering the same
one refreshes it rather than adding a row.

`{token, registeredAt, server}` is kept in AsyncStorage under
`@keep/pushRegistration`, and `shouldRegister` re-registers when the token has
rotated, when the server address is a different one, or when the record is a day
old — otherwise an ordinary launch costs no request at all. Setup's **Retry** forces
it. A refused permission clears the record and unregisters the phone from the daemon;
a phone that cannot show a notification should not be collecting pushes. Nothing here logs the token, and only its last six characters are
ever displayed.

**Moving on.** Connecting to a different server, or **Forget this server**, sends
`DELETE /api/devices` to the daemon being left, best effort, with the config that is
being replaced — it is the only thing that can still authenticate the removal. Both
bump a generation counter first, and every step of a registration checks it —
including the step *after* the record has been written, which is the narrow window
where Forget looks for a saved token, finds none because the write had not landed
yet, and sends no `DELETE` of its own. A superseded pass keeps nothing: the record it
wrote is removed again (only if it is still its own) and the token it registered is
taken back with a `DELETE`. Without all of that, forgetting a server while a
registration was in flight registered the phone all over again a moment later.

**The tap.** A push carries `data: {key, sessionId}`, where `key` is the console's
own attention key or `alert:<id>`. Foreground, background and cold start all end at
the same place: `{type:'notificationClick', key}` through the bridge, queued if the
console is not up yet, and the console selects that row or opens that message.

**One notification, not two.** The console raises its own notification for a row that
starts waiting, and `bin/attention-push.js` pushes the same rows from the daemon. So
once registration has succeeded the shell stops turning the console's `notify` into a
local notification — for attention rows. An `alert:<id>` is not dropped, because it
only reaches the phone if the operator put `expo` in `KEEP_ALERT_CHANNELS`; those are
deduped by key instead, and so is a push that arrives while the app is open. The
keys match exactly: `attention-push.js` mirrors the console's own spelling.

**The sweep.** The 15-minute background sweep (`expo-background-task`, raising local
notifications from `/api/state?view=notifications`) is the fallback for a phone push
cannot reach. It is unregistered as soon as registration succeeds, and registered
again when permission is denied or no token can be had — a pass the OS had already
scheduled checks the same flag before it notifies. A *failed* registration is not at
once the same as no registration: a launch with no network, or a daily refresh the
daemon missed, keeps the phone registered and the sweep off, because the device is
still on the daemon's list and running both is what buzzes twice.

That belief has a clock on it. Refresh is daily; **48 hours** without one reaching
the daemon and the record stops counting as live, whatever it says — eviction by the
16-device cap, a `.keep/devices.json` that was lost, and a token Expo has stopped
delivering all look exactly like an offline phone from here, and a fallback that a
stale record can switch off forever is not a fallback. Past that the sweep comes back
and the console keeps announcing its own rows until a refresh succeeds. A token that
has rotated away from what the daemon holds turns the sweep back on immediately,
since the old record cannot cover it.

The quicker half of the same question is simply to ask: coming back to the app, at
most once every ten minutes, the shell reads `GET /api/devices` and compares token
tails. A daemon that no longer lists this phone invalidates the record on the spot,
and the next pass registers again. The once-per-launch
baseline pass runs either way, recording what is already waiting without
announcing it, so if the sweep ever does take over it does not fire for the backlog.

**The badge.** The push carries `badge` and the system applies it while the app is
away. In the app the console's `{type:'badge'}` is the source of truth; returning to
the foreground forgets what was last applied, so the console's next badge message
wins whatever the launcher was left showing.

From the repository root:

```sh
npm ci --prefix app
npm run mobile:theme
cd app
npx expo start
```

Use Node 22.13 or newer. See the [versioned Expo documentation](https://docs.expo.dev/versions/v57.0.0/)
for device and development-build setup. The included `preview` EAS build profile
produces an Android APK. Native notifications/background tasks require a compatible
native build; background execution is controlled by the phone's operating system.

Keep listens on loopback by default. For phone access, use a private network or VPN,
configure `KEEP_HOST` to an appropriate interface, and restart the daemon. Enter that
computer's reachable URL and its `.keep/token` value in the app's setup screen.
Keep the token private. Local HTTP is supported for private-network use; do not
expose the daemon directly to the public Internet. Existing saved connections remain
on the phone; no server address or access token is bundled with the source.

Build identity is local. Create `~/.config/keep/mobile.json` (outside this repo):

```json
{
  "owner": "your-expo-account",
  "projectId": "your-eas-project-uuid",
  "androidPackage": "com.example.keep",
  "iosBundleIdentifier": "com.example.keep"
}
```

`KEEP_MOBILE_CONFIG` selects another file. `KEEP_EXPO_OWNER`, `KEEP_EXPO_PROJECT_ID`,
`KEEP_ANDROID_PACKAGE`, and `KEEP_IOS_BUNDLE_IDENTIFIER` override individual values.
Without overrides the Android identifier is `dev.keeptool.mobile`, with no linked
Expo account or EAS project. Configure your own EAS project before cloud builds. EAS runs native prebuild remotely,
where your local config file is unavailable. Add the same identity values as EAS
project environment variables in the `preview` environment (the included profile
selects it): `KEEP_EXPO_OWNER`, `KEEP_EXPO_PROJECT_ID`, `KEEP_ANDROID_PACKAGE`, and,
for iOS, `KEEP_IOS_BUNDLE_IDENTIFIER`. Set them through the EAS dashboard or
`eas env:create`; see [EAS environment variables](https://docs.expo.dev/eas/environment-variables/).
Remote builds refuse to proceed without the platform's explicit native identifier,
so they cannot silently produce an app with the generic default identity.
Signing keys, Expo state, generated native projects, and dependencies are excluded
from the public source. The app takes scope rules from your daemon.

`npm run mobile:theme` regenerates theme tokens and the shared scope resolver.
`node --test bin/mobile-theme.test.js bin/mobile-config.test.js` checks these assets
and build-identity configuration from the repository root.

The app's own unit tests run from the repository root:

```sh
node --require ./scripts/test-env.cjs --test app/src/*.test.js app/src/terminal/*.test.js
```

A local Android debug build, without EAS:

```sh
cd app
npx expo prebuild --platform android --no-install
cd android && ./gradlew assembleDebug
```

`app/android/` is generated and stays out of git.
