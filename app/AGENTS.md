# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# This app is a shell

It is a WebView around the Keep web console, not a second interface over the daemon's
API. Three screens — Setup, Console, Terminal — and a message bridge. Features belong
in the console (`web/app/`) unless they need the phone: notifications, the badge, the
terminal.

The Terminal screen is the exception that is native on purpose. `NativeTerminal.js`
runs xterm's parser in the app over the pane socket and draws the rows itself, with
the old polled viewer (`Screen.js`) still behind a **Text view** toggle. Everything
testable about it lives in `src/terminal/*.js` with a `node --test` file beside it;
put new logic there, not in the component. See `README.md` for the terminal, the
bootstrap and the bridge message table.
