# Keep mobile

An Expo SDK 57 app for your own Keep registry. It connects to your running Keep
daemon; each teammate enters their own server address and access token.

## The shell

The app is a shell around the Keep web console rather than a second interface over
the same API. Three screens, on a React Navigation native stack:

- **Setup** — server URL, token, and palette, saved in AsyncStorage. Reachable again
  from the gear in the console screen's top bar.
- **Console** — a `react-native-webview` holding the console itself. This is where
  everything happens.
- **Terminal** — the polled plain-text terminal viewer, reached only when the console
  asks for it. It is the fallback until a native terminal lands.

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
reload per ten seconds; at most three in five minutes; and two refusals in a row
stop the retrying outright. Whichever trips first shows the native banner pointing at
Setup, and only Retry or the manual reload clears them. The one exemption from the
interval is the first refusal after a mount, so a daemon restart recovers at once —
it is spent on use and nothing re-arms it.

Only `{type:'authenticated'}`, which the console posts once per page load after a
request actually comes back 200, clears the failure count. **`ready` does not**: it
says the page's scripts ran, which they do before any request and again after every
`hello`, so treating it as proof of a session let alternating ready/unauthorized
reload in a loop. `decideBootstrap` in `src/bridge.js` is the whole rule as a pure
function, and `bridge.test.js` drives the adversarial sequence through it. Nothing
else in the app stores or reads the cookie.

The native side still sends `x-keep-token` for the two things it does itself: the
setup connection check and the 15-minute background sweep.

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
node --require ./scripts/test-env.cjs --test app/src/*.test.js
```

A local Android debug build, without EAS:

```sh
cd app
npx expo prebuild --platform android --no-install
cd android && ./gradlew assembleDebug
```

`app/android/` is generated and stays out of git.
