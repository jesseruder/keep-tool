# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# This app is a shell

It is a WebView around the Keep web console, not a second interface over the daemon's
API. Three screens — Setup, Console, Terminal — and a message bridge. Features belong
in the console (`web/app/`) unless they need the phone: notifications, the badge, the
terminal fallback. See `README.md` for the bootstrap and the bridge message table.
