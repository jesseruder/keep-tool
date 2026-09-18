# Browser Bridge

One Edge extension, one native messaging host, and one stdio MCP server per agent
session, so every Claude Code and Codex session on this machine can drive the same
browser at the same time — whatever account it runs on.

`docs/DESIGN.md` explains why it exists and how it is put together.
`docs/claude-in-chrome-tools.txt` is the tool contract it mirrors.

```
Edge ── extension (MV3, chrome.debugger/CDP)
          │ native messaging
     native host  host/native-host.js          broker, one per extension connection
          │ unix socket ~/Library/Application Support/BrowserBridge/bridge.sock
   ┌──────┴───────┬──────────────┐
 mcp/server.js  mcp/server.js  mcp/server.js   one per agent session
```

## Install

Everything is local; nothing is published or fetched at run time.

```sh
cd browser-bridge
npm install
node bin/install.js --dry-run     # read what it will do
node bin/install.js               # write the launcher, the manifest, register `browser`
```

The installer:

1. writes `~/Library/Application Support/BrowserBridge/native-host`, a two-line `sh`
   launcher that execs the absolute path of the node that ran the installer (Edge starts
   native hosts with an empty environment, so nothing may depend on `PATH` or nvm);
2. writes `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.keep.browser_bridge.json`
   (`--chrome-too` adds Chrome's);
3. registers the MCP server as `browser` in every Claude config directory it finds and in
   `~/.codex` / `~/.codex-secondary`, through `claude mcp add` and `codex mcp add`. If a
   CLI is missing or refuses, it prints the exact block to paste and carries on.

Then load the extension:

1. `edge://extensions` → Developer mode → **Load unpacked** → pick `browser-bridge/extension`.
2. The id must be **goijgcbiphelgdlpjmpepfkihboonjbg** — the `key` in `manifest.json`
   pins it, and the native host manifest only trusts that origin.
3. Click the extension's icon: the popup should say **connected**, and list sessions as
   they attach.

`node bin/install.js --uninstall` removes both browsers' manifests and unregisters the
MCP servers.

Re-running the installer after moving the checkout is required: the launcher and the
manifests hold absolute paths. A re-run unregisters `browser` before registering it
again, so the new path replaces the old one instead of being refused as a duplicate.

### Trying it in a throwaway Edge

Edge 153 ignores `--load-extension`, and load-unpacked cannot be scripted in a running
browser. For development, launch a second Edge on a scratch profile with the DevTools
pipe and load the extension over CDP:

```sh
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --user-data-dir=/tmp/bb-profile --remote-debugging-pipe \
  --enable-unsafe-extension-debugging --no-first-run about:blank
# on the pipe (fds 3 and 4): {"id":1,"method":"Extensions.loadUnpacked","params":{"path":".../extension"}}
```

That profile reads native messaging manifests from its own directory, so copy
`com.keep.browser_bridge.json` into `/tmp/bb-profile/NativeMessagingHosts/` before the
extension connects. The real Edge profile reads the one the installer wrote.

## Using it

Tool names and input schemas match the Claude in Chrome extension, so the habits carry
over: call `tabs_context_mcp` first, then use the tab ids it returns.

Each session gets its own Edge **tab group**, titled with the session name. Every
tab-scoped tool refuses ids outside that group (`Tab 42 is not in the same group`), which
is what keeps parallel sessions from trampling each other. The window is never focused:
your terminal keeps keyboard focus.

Tools: `tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`, `navigate`, `read_page`,
`find`, `get_page_text`, `form_input`, `javascript_tool`, `computer`,
`read_console_messages`, `read_network_requests`, `resize_window`, `file_upload`,
`upload_image`, `browser_batch`, `browser_status`, `gif_creator`.

Worth knowing:

- `read_page` renders the accessibility tree with `ref_N` ids; those refs stay valid for
  the same page and are reset when the main frame navigates. Cross-origin iframes are
  included: each one is read through its own debugger session and spliced in under its
  iframe element, and a ref inside one still works for clicks, `form_input` and uploads.
- `find` ranks lexically — tokens matched against name, role, value and description, with
  stemming, a synonym table (`basket` finds `cart`, `picker` finds a combobox) and typo
  tolerance. It is a heuristic, not a model, and an exact match always wins.
- `computer` screenshots come back as an MCP image block at viewport CSS size × `scale`,
  and the text block states both the image size and the viewport size. Coordinates are
  always CSS pixels.
- `save_to_disk` writes to `~/Library/Application Support/BrowserBridge/screenshots/` and
  reports the path.
- `file_upload` takes absolute paths on this machine: regular files, one hard link, 10 MB
  total. Nothing is base64'd around.
- `gif_creator` records the session's own tab group: `start_recording`, then every
  `computer` action and `navigate` in that group becomes an annotated frame (take a
  screenshot right after starting and right before stopping to bookend it), then `export`
  with `download: true` to save the GIF or `coordinate: [x, y]` to drop it straight onto
  a page. At most 300 frames and 60 MB per group; `export` keeps the frames, `clear`
  throws them away. The GIF is never sent back to the model, only its filename and size.
- Page content is untrusted input. The MCP instructions say so; treat it that way.

## Configuration

| Variable | Effect |
| --- | --- |
| `BROWSER_BRIDGE_SESSION_NAME` | Names the session and its tab group. Otherwise `<account or agent> #<pid>`. |
| `BROWSER_BRIDGE_NEW_WINDOW=1` | `tabs_context_mcp{createIfEmpty}` opens a new window instead of using the last focused one. |
| `BROWSER_BRIDGE_RUNTIME_DIR` | Moves the socket, log, screenshots and config (the tests use this). |

`~/Library/Application Support/BrowserBridge/config.json`:

```json
{ "blockedHosts": ["admin.example.com", "*.internal.example"] }
```

`navigate` refuses those hosts before the request reaches the browser.

## Troubleshooting

- **"Browser Bridge is not connected"** — Edge is closed, the extension is disabled, or
  the installer has not run. Open the popup and press Reconnect.
- **The popup says disconnected** — look at `~/Library/Application Support/BrowserBridge/host.log`.
  A host that cannot bind the socket says why there.
- **Edge shows "Browser Bridge started debugging this browser"** — that is the debugger
  infobar and it is expected. If you cancel it, the next command re-attaches.
- **"another Browser Bridge host is already listening"** — two extension instances (two
  Edge profiles) tried to own the socket. Only one profile can host the bridge.
- **A tool says `No tab with id: N`** — the tab is gone, or it belongs to another
  session. Call `tabs_context_mcp` again.

## Development

```sh
npm test          # node:test, no browser involved
npm run icons     # regenerate extension/icons/*.png from bin/make-icons.js
node bin/gen-key.js   # only if the extension id ever has to change
```

The extension is plain ES modules loaded straight from disk: no bundler, no build step.
Edit a file, press reload on `edge://extensions`. `extension/lib/keys.js`, `ax.js`,
`find.js`, `gifframes.js` and `url.js` hold the logic worth testing and never touch a
`chrome` API, which is why the tests can import them directly.

`extension/lib/vendor/gifenc.js` is the only third-party file in the extension: the
unmodified ESM build of [gifenc](https://github.com/mattdesl/gifenc) 1.0.3 (MIT), copied
in rather than installed because there is no bundler to resolve a dependency for a
load-unpacked extension. To update it, `npm pack gifenc`, unpack it, and copy
`dist/gifenc.esm.js` over the body of that file, keeping the license header.
