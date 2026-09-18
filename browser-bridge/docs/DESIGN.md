# Browser Bridge

An account-agnostic replacement for the Claude in Chrome extension. One Edge
extension, one native messaging host, and one stdio MCP server that any number of
Claude Code and Codex sessions, on any account, run at the same time.

## Why

Claude Code's `--chrome` integration writes one native-host manifest per browser that
points at a single Claude config directory (`~/.claude-secondary/chrome/chrome-native-host`
today). Sessions from the other config directories cannot use the extension, and Codex
ships a separate extension of its own. The extension is also tied to the claude.ai
login of the browser. This machine runs three Claude accounts and two Codex accounts,
so the browser has to be shared by the tool, not owned by an account.

## Shape

```
Edge (one profile)
  └─ extension (MV3, load-unpacked, fixed id via manifest "key")
       │ chrome.runtime.connectNative
       ▼
  native host  browser-bridge/host/native-host.js   (spawned by Edge, one per extension connection)
       │ unix socket  ~/Library/Application Support/BrowserBridge/bridge.sock   (0600, JSON lines)
   ┌───┴────────────┬───────────────┐
 MCP server      MCP server      MCP server       browser-bridge/mcp/server.js, one per agent session
 (claude default) (codex-secondary) (claude-tertiary)
```

- The **extension** does all browser work through `chrome.debugger` (Chrome DevTools
  Protocol): trusted mouse and keyboard input, screenshots, the accessibility tree with
  `ref_N` element ids, console and network capture, JavaScript evaluation, file inputs,
  window resizing. This is the same mechanism Claude in Chrome uses, so it works on
  canvas apps and inside same-process iframes.
- The **native host** is a broker. Edge starts it when the extension connects. It
  listens on the Unix socket, accepts any number of long-lived clients, and multiplexes
  their requests to the extension over the native messaging port, tagging each request
  with the client's session.
- The **MCP server** is one stdio process per agent session. It exposes tools whose
  names and input schemas match Claude in Chrome exactly (see
  `docs/claude-in-chrome-tools.txt`, carved from Claude Code 2.1.276), so the model's
  existing habits carry over. Each session gets its own named Edge tab group; every
  tab-scoped tool refuses tab ids outside that group, so parallel sessions cannot
  trample each other.
- The **installer** registers the native host manifest for Edge (and Chrome when asked)
  and registers the MCP server named `browser` in every Claude config directory and
  both Codex homes.

Everything is plain JavaScript on Node 22, ES modules, no bundler, no TypeScript. The
directory has its own `package.json` and is not part of keep-tool's build or test
scripts. Its only runtime dependency is `@modelcontextprotocol/sdk` (plus `zod`, which
the SDK needs for tool schemas).

## Directory layout

```
browser-bridge/
  package.json              own deps and scripts: "test": node --test test/*.test.js
  README.md                 install and use
  docs/DESIGN.md            this file
  docs/claude-in-chrome-tools.txt   the tool contract being mirrored
  extension/
    manifest.json           MV3; "key" fixes the extension id
    background.js           service worker entry: native port, dispatch, keepalive
    lib/native.js           port connect/reconnect, chunked message reassembly
    lib/sessions.js         session key -> tab group, persisted in chrome.storage.session
    lib/cdp.js              chrome.debugger attach/detach, send(), per-tab event buffers
    lib/keys.js             key name -> CDP key event table (pure, testable)
    lib/ax.js               accessibility tree -> text with refs (pure, testable)
    lib/find.js             heuristic element search over the AX tree (pure, testable)
    lib/page.js             functions serialized into the page via Runtime.callFunctionOn
    tools/*.js              one module per tool
    popup.html, popup.js    status: connected?, sessions, groups, reconnect button
  host/
    native-host.js          the broker (entry; the native host manifest points at a launcher that execs it)
    protocol.js             native framing, socket line codec, limits (pure, testable)
  mcp/
    server.js               stdio MCP server entry
    tools.js                tool definitions: names, schemas, result shaping
    client.js               socket client with reconnect and hello
  bin/
    install.js              register native host + MCP servers; --browser edge|chrome; --dry-run; --uninstall
    gen-key.js              one-time: generate manifest key and print the extension id
  test/                     node:test files; nothing here touches a real browser
```

## Protocols

### Socket (MCP server <-> host), JSON lines, UTF-8, one object per line, 4 MiB cap per line

Client to host:

```
{"id":"c1","method":"hello","params":{"sessionKey":"<uuid>","name":"claude-tertiary #12","agent":"claude","account":"claude-tertiary"}}
{"id":"c2","method":"tabs_context_mcp","params":{"createIfEmpty":true}}
{"id":"c3","method":"computer","params":{"action":"screenshot","tabId":123}}
```

Host to client:

```
{"id":"c2","ok":true,"result":{...}}
{"id":"c3","ok":false,"error":{"message":"No tab with id: 123"}}
```

The first message on a connection must be `hello`; the host rejects anything else and
closes. `sessionKey` is generated once per MCP server process and reused on every
reconnect, so a session that reconnects after the host restarts gets its tab group back.
The host adds `sessionKey` to every request it forwards. When a client disconnects, the
host sends the extension `{"method":"session_closed","params":{"sessionKey":...}}`.

Method names on the socket are the tool names. Params are the tool's input, already
validated by the MCP server. The extension re-validates the parts that matter for
safety (tab membership, sizes).

### Native messaging (host <-> extension)

Standard framing: 4-byte native-endian length + JSON. Chrome caps a message at 1 MiB
in each direction, and a full-resolution PNG screenshot can exceed that, so any
message over 768 KiB is split: `{"id":"c3","chunk":0,"of":3,"data":"<part of the JSON text>"}`.
The receiver reassembles by id and parses once. Both directions implement chunking.

Host to extension: `{"id","sessionKey","method","params"}` for forwarded requests,
`{"method":"ping"}` every 20 seconds (a message on the port resets the service
worker's idle timer), `{"method":"session_closed",...}`.

Extension to host: `{"id","ok","result"}` or `{"id","ok":false,"error":{"message"}}`,
`{"event":"ready","version":"..."}` on connect, `{"event":"pong"}`.

Per-request timeout in the host: 90 s (JavaScript evaluation and navigation can be
slow). The host answers the client with an error on timeout and drops the late reply.

### Lifecycle

- Edge starts the host when the extension's service worker calls `connectNative`. The
  host validates its origin argument against the extension origin, binds the socket
  (refusing an unsafe path, replacing only a dead socket, the same checks as
  `castle-mcp`'s `secure_bind`), and removes it on exit.
- If the service worker is terminated, Edge closes the port and the host exits. The
  worker reconnects on its next wake (`chrome.alarms` every minute plus `onStartup`
  and `onInstalled`), which spawns a fresh host. MCP clients reconnect to the socket
  path with backoff (100 ms, 500 ms, 1 s, then every 2 s up to 30 s), re-send `hello`,
  and retry the in-flight request once.
- The MCP server tells the host `bye` on stdin close or SIGTERM. The extension then
  closes the session's tab group only if every tab in it is a blank new-tab page;
  otherwise the tabs stay for the user, matching what Claude Code does on exit.
- Session state (`sessionKey -> {groupId, windowId, name}`) lives in
  `chrome.storage.session` so it survives worker restarts. A group the user closed by
  hand is detected by `chrome.tabGroups.get` failing, and the next
  `tabs_context_mcp{createIfEmpty:true}` starts fresh.

## Tools

Names and input schemas are copied from `docs/claude-in-chrome-tools.txt`. Dropped:
`shortcuts_list`, `shortcuts_execute`, `switch_browser`, `list_connected_browsers`,
`select_browser` (Anthropic cloud features with no local meaning). Added:
`browser_status` (host reachable, extension version, this session's group and tabs,
every session the extension knows). `gif_creator` is phase 2: register it, return a
clear "not implemented yet" error.

Result shapes:

- `tabs_context_mcp`: text with JSON `{"groupId":n,"windowId":n,"tabs":[{"id","url","title","active"}]}`.
  With `createIfEmpty` and no live group: create the group in the last focused normal
  window (`chrome.windows.getLastFocused({windowTypes:["normal"]})`, creating a window
  only when none exists), titled with the session name, colored round-robin. Never
  focus the window: stealing focus from the terminal is the one thing users hate.
  `BROWSER_BRIDGE_NEW_WINDOW=1` on the MCP server makes it open a new window instead.
- `tabs_create_mcp`: new tab in the group, `about:blank`, returns `{"tabId"}`.
- `tabs_close_mcp`: group check, then `chrome.tabs.remove`.
- `navigate`: normalize (`https://` when no scheme; `localhost:3000` also gets
  `http://`), `back`/`forward` via `chrome.tabs.goBack/goForward`, then wait for
  `tabs.onUpdated` status `complete` on that tab or 30 s. Returns
  `{"url","title"}`. Without `tabId`, call the session's `tabs_context_mcp{createIfEmpty:true}`
  and use the first tab, appending that context to the result, as the spec describes.
- `read_page`: `Accessibility.getFullAXTree`, build the tree, assign `ref_N` to every
  node with a `backendDOMNodeId` (the map is per tab and reset on main-frame
  navigation, so refs stay valid between calls on the same page), render one line per
  node with indentation: `[ref_12] button "Sign in" focusable focused`. Ignored nodes
  are skipped but their children kept. `filter:"interactive"` keeps buttons, links,
  text inputs, checkboxes, radios, comboboxes, options, menu items, tabs, switches,
  sliders, spin buttons, and anything focusable. `depth` and `ref_id` narrow the tree;
  `max_chars` truncates at a line boundary with a note giving the full size. Cross-origin
  iframes are out of scope for phase 1; say so in a trailing note when the page has
  any.
- `find`: heuristic over the same tree. Tokenize the query, score each node on name,
  role, value and description matches (exact phrase > all tokens > some tokens; role
  words in the query such as "button", "link", "input", "search" match the role), return
  up to 20 as `[ref] role "name"` lines, best first. State in the description that
  the ranking is lexical, not a model. More than 20 hits: return the top 20 and say to
  narrow the query.
- `form_input`: `DOM.resolveNode{backendNodeId}` then `Runtime.callFunctionOn` with a
  function that sets checkboxes and radios by `checked`, selects by option value or
  text, inputs and textareas through the prototype value setter (so React and Vue see
  the change), contenteditable by `textContent`, then dispatches `input` and `change`.
- `get_page_text`: prefer `article`, then `main`/`[role=main]`, then `body`;
  `innerText`, collapse runs of blank lines, cap at 60 000 chars with a note.
- `javascript_tool`: `Runtime.evaluate{expression,replMode:true,awaitPromise:true,returnByValue:true,timeout:30000}`.
  Errors are `JavaScript execution error: <message>`; a timeout is
  `JavaScript execution error: Execution timeout: Code exceeded 30-second limit`.
  Result is `JSON.stringify` of the value, or the description for unserializable
  values.
- `computer`: activate the tab in its window first (`chrome.tabs.update{active:true}`,
  again without focusing the window), then:
  - `screenshot`: `Page.captureScreenshot` PNG of the viewport. The returned image
    must be viewport-CSS-size × `scale` pixels, so on a DPR 2 display the clip scale
    is `scale / devicePixelRatio`. The text part says
    `Screenshot of tab 123 (https://...): image 1440x900 px, viewport 1440x900 CSS px; coordinates are CSS pixels`.
    Keep the image under an id (`ss_<n>`) for `upload_image`, expiring after 5 minutes.
    `save_to_disk` is done by the MCP server: it writes
    `~/Library/Application Support/BrowserBridge/screenshots/<iso-ts>-<tab>.png` and
    reports the path.
  - `zoom`: same with the clip set to `region`, scaled so the longer side is at most
    the viewport's longer side.
  - `left_click`, `right_click`, `double_click`, `triple_click`: `Input.dispatchMouseEvent`
    mouseMoved, mousePressed, mouseReleased with `clickCount` 1, 2 or 3, `button`
    left or right, `modifiers` bitmask (alt 1, ctrl 2, meta 4, shift 8). With `ref`
    instead of `coordinate`: `DOM.scrollIntoViewIfNeeded` then `DOM.getContentQuads`
    center, corrected by `Page.getLayoutMetrics` so the point is viewport-relative.
  - `hover`: mouseMoved only. `left_click_drag`: pressed at `start_coordinate`,
    moved in 10 steps, released at `coordinate`.
  - `scroll`: `Input.dispatchMouseEvent{type:"mouseWheel"}` at the coordinate,
    100 px per tick, `scroll_amount` default 3. `scroll_to`: `DOM.scrollIntoViewIfNeeded`.
  - `type`: per character `keyDown`/`keyUp` with `text` for keys in the table, and
    `Input.insertText` for anything else (non-Latin, emoji). `\n` becomes Enter.
  - `key`: space-separated chords, `repeat` times. `cmd`/`meta`, `ctrl`, `alt`/`option`,
    `shift` modifiers; key names as in `lib/keys.js` (Return, Enter, Tab, Escape,
    Backspace, Delete, ArrowUp/Up, Home, End, PageUp, PageDown, Space, F1-F12,
    letters, digits, punctuation). Page zoom chords (`cmd+=`, `cmd+-`, `cmd+0`,
    `ctrl+` variants) return the error the spec promises.
  - `wait`: sleep `duration` (max 10 s) then take a screenshot, as Claude in Chrome does.
  Every click, type and key action returns a short text confirmation; the model is
  expected to take a screenshot when it needs to see the result.
- `read_console_messages`: buffer per tab from `Runtime.consoleAPICalled`,
  `Runtime.exceptionThrown`, `Log.entryAdded` (cap 2000, oldest dropped), captured
  from the moment the tab joined the group, cleared when the main frame navigates to
  a different origin. Filter by `pattern` (regex), `onlyErrors`, `limit`, `clear`.
  Each line: `[level] <text> (<url>:<line>)`.
- `read_network_requests`: buffer per tab from `Network.requestWillBeSent`,
  `responseReceived`, `loadingFinished`/`loadingFailed`: method, url, status,
  mimeType, resource type, encoded size, timing. Same clearing rules; `urlPattern` is
  a substring filter.
- `resize_window`: `chrome.windows.update(windowId,{width,height})`, returns the
  resulting bounds.
- `file_upload`: the MCP server resolves each path, refuses a missing or non-regular
  file, a file with more than one hard link, or a total over 10 MB, then sends the
  absolute paths; the extension calls `DOM.setFileInputFiles{files,backendNodeId}`.
  (Everything is on one machine, so no base64 round trip is needed. Keep the `files`
  field accepted for schema fidelity but ignore it.)
- `upload_image`: with `ref`, build a `File` from the stored screenshot inside the
  page (`Runtime.callFunctionOn` with the base64), put it in a `DataTransfer`, assign
  `input.files`, dispatch `input` and `change`. With `coordinate`,
  `document.elementFromPoint` and dispatch `dragenter`, `dragover`, `drop` carrying
  that `DataTransfer`.
- `browser_batch`: run in the MCP server, sequentially, stop at the first error,
  results concatenated with images interleaved. It refuses a nested `browser_batch`
  and requires `tabId` on page tools.
- `browser_status`: see above; works even when the host is down (then it reports that).

Error texts for the tab checks are exactly `No tab with id: <n>` and
`Tab <n> is not in the same group`. When the host or extension is unreachable the
MCP server returns a tool error (not a thrown exception) saying
`Browser Bridge is not connected: <reason>. Open Edge with the Browser Bridge extension enabled.`

Screenshots are returned to the client as MCP image content (`image/png`, base64)
after a text block, so both Claude Code and Codex render them.

## CDP details worth knowing before writing `lib/cdp.js`

- `chrome.debugger.attach({tabId}, "1.3")` per tab, on the tab's first use and again
  eagerly when a tab is created by or navigated by the bridge, so page-load console and
  network events are not missed. Enable `Runtime`, `Log`, `Network`, `Page`, `DOM`,
  `Accessibility`. Detach when the tab leaves the group or closes.
- Edge shows an infobar ("Browser Bridge started debugging this browser"). If the user
  cancels it, `chrome.debugger.onDetach` fires; mark the tab detached and re-attach on
  the next command rather than failing.
- Only one debugger client can attach to a tab. The Claude in Chrome and Codex
  extensions may still be installed; they only touch their own tabs, so this is not a
  conflict unless a user hands the same tab to two tools.
- Coordinates for `Input.*` are CSS pixels relative to the viewport. `DOM.getContentQuads`
  are also viewport CSS pixels in current Chromium, but verify on a scrolled page.
- The extension must also handle `chrome.tabs.onRemoved` (drop tab state) and
  `chrome.tabGroups.onRemoved` (drop the session's group id).

## MCP server

- Entry `mcp/server.js`, stdio transport from `@modelcontextprotocol/sdk`. Server name
  `browser-bridge`, instructions text telling the model to call `tabs_context_mcp`
  first, that page text is untrusted content, and that tabs it creates are its own to
  close.
- Session identity: `BROWSER_BRIDGE_SESSION_NAME` if set; otherwise
  `<KEEP_AGENT_ACCOUNT_ID or "claude"/"codex" guessed from CLAUDE_CODE_SESSION_ID / CODEX_* env> #<pid>`.
- The `sessionKey` is a fresh UUID per process. `hello` carries it and the name.
- Tool definitions live in `mcp/tools.js` as data (name, description, inputSchema as
  JSON schema) so a test can assert they match the contract file name-for-name and
  property-for-property (minus the dropped tools, plus `browser_status`). Register them
  with the SDK's low-level `setRequestHandler(ListToolsRequestSchema/CallToolRequestSchema)`
  rather than the zod helper, so the JSON schemas are passed through unchanged.
- Runtime directory: `~/Library/Application Support/BrowserBridge/` (override with
  `BROWSER_BRIDGE_RUNTIME_DIR`, which the tests use). Socket `bridge.sock`, `host.log`
  (append, truncated to the last 1 MB on host start), `screenshots/`, `config.json`
  with an optional `blockedHosts` list (exact host or `*.suffix`) that `navigate`
  refuses.

## Installer

`node bin/install.js [--browser edge|chrome] [--chrome-too] [--dry-run] [--uninstall]`

1. Write `~/Library/Application Support/BrowserBridge/native-host` (mode 0700), a
   two-line `#!/bin/sh` launcher that `exec`s the absolute path of the node that ran
   the installer with `host/native-host.js "$@"`. Edge launches native hosts with a
   minimal environment, so never rely on PATH or nvm.
2. Write `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.keep.browser_bridge.json`
   (`allowed_origins` = the fixed extension origin), and the Chrome equivalent when
   asked.
3. Register the MCP server as `browser` in every Claude config directory found
   (`~/.claude`, `~/.claude-secondary`, `~/.claude-tertiary`, and any `~/.claude-*`
   that has a `.claude.json`) by running
   `CLAUDE_CONFIG_DIR=<dir> claude mcp add --scope user browser -- <node> <abs path>/mcp/server.js`
   (the default dir's global config is `~/.claude.json`; `claude mcp add` handles that
   when `CLAUDE_CONFIG_DIR` is unset). Do not edit `.claude.json` files directly: live
   sessions rewrite them. For Codex, run `CODEX_HOME=<home> codex mcp add browser -- <node> <path>`
   for `~/.codex` and `~/.codex-secondary`. If either CLI is missing or refuses, print
   the exact config block to add by hand and continue.
4. Print the extension directory to load via `edge://extensions` (Developer mode, Load
   unpacked) and the extension id the manifest key fixes.

`--uninstall` removes the manifests and runs the matching `mcp remove` commands.

## Fixed extension id

`bin/gen-key.js` generates a 2048-bit RSA key pair, prints the base64 DER public key for
`manifest.json`'s `key` field and the id (`a`-`p` mapping of the first 32 hex chars of
the SHA-256 of the DER public key). Only the public key is committed; load-unpacked
needs no private key. The id is a constant in `host/protocol.js` and the installer.

## Tests (node:test, no browser)

- `test/protocol.test.js`: native framing round trip, chunk split and reassembly
  across the 1 MiB limit, socket line codec limits, invalid input.
- `test/host.test.js`: run `host/native-host.js` as a child with a fake extension on
  its stdin/stdout; connect two socket clients with different session keys; assert
  requests are forwarded with the right `sessionKey`, replies route to the right
  client, a timeout produces an error, a client disconnect sends `session_closed`, a
  request before `hello` is rejected, and the socket file is removed on exit.
- `test/tools.test.js`: the tool list matches `docs/claude-in-chrome-tools.txt`
  (parse the `name:"..."` entries and each `required` list) minus the dropped set plus
  `browser_status`; every input schema is valid JSON schema with the same properties.
- `test/keys.test.js`, `test/ax.test.js`, `test/find.test.js`: the pure modules, with a
  fixture AX tree captured from a real page (a small hand-written one is fine).
- `test/client.test.js`: reconnect and hello replay against a scripted socket server.
- `test/install.test.js`: `--dry-run` output and manifest contents against a temp
  HOME.

Live verification against Edge is done from the driving session, not by the
implementer.

## Phase 2

- `gif_creator`: capture a frame after every `computer` action while recording,
  encode with a vendored single-file GIF encoder (`gifenc`), export through
  `chrome.downloads.download` with a data URL, overlays as listed in the spec.
- `find` ranking quality: add synonyms and fuzzy matching once real use shows the gaps.
- Cross-origin iframe support in `read_page` via `Target.setAutoAttach` sessions.
- Keep integration: `keep open` sets `BROWSER_BRIDGE_SESSION_NAME` to the session
  number and card so tab groups read `#12 fix-login`.

## Security notes

- The socket is 0600 inside a 0700 directory; anything running as this user can drive
  the browser, which is the same trust boundary as the Claude in Chrome native host.
- The host only serves the extension origin it was launched for; the extension only
  accepts commands from its native port. Page content (text, console, network bodies,
  accessibility names) is untrusted input and the MCP instructions say so.
- `file_upload` reads paths on this machine; it is limited to regular files under
  10 MB with a single hard link, matching Claude Code's rules.
- No site permission prompts: this is a single-user machine and every session is the
  user's own agent. `blockedHosts` in `config.json` is the one guard rail.
