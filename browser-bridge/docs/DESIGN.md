# Browser Bridge

An account-agnostic replacement for the Claude in Chrome extension. One Edge
extension, one native messaging host, and one MCP daemon that any number of
Claude Code and Codex sessions, on any account, share at the same time.

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
       │       one socket client per MCP session, each with its own sessionKey
       ▼
  MCP daemon  browser-bridge/mcp/daemon.js     (one process, launchd KeepAlive)
       │ streamable HTTP on 127.0.0.1:47331/mcp, Bearer token from daemon.json (0600)
   ┌───┴────────────────┬────────────────────┐
 session             session              session       one Mcp-Session-Id each
 (claude default)   (codex-secondary)    (claude-tertiary)
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
- The **MCP daemon** is one long-lived process serving MCP over streamable HTTP on
  loopback. It exposes tools whose names and input schemas match Claude in Chrome exactly
  (see `docs/claude-in-chrome-tools.txt`, carved from Claude Code 2.1.276), so the model's
  existing habits carry over. Each MCP session gets its own socket client, its own
  `sessionKey` and its own named Edge tab group; every tab-scoped tool refuses tab ids
  outside that group, so parallel sessions cannot trample each other. A session costs the
  daemon one socket and no process at all: sessions used to spawn a stdio server each at
  startup whether or not they ever touched the browser (35 processes, 828 MB resident on
  2026-09-18), and neither client can lazy-start a stdio server.
- `mcp/server.js` is the same thing over **stdio**, one process per session — the original
  shape, kept as a fallback (`node bin/install.js --stdio`) and for the driving scripts.
  All of the behaviour is in `mcp/session.js`, which both entry points use, so the two
  cannot drift.
- The **installer** registers the native host manifest for Edge (and Chrome when asked),
  installs the daemon as a launchd agent, and points `browser` at
  `http://127.0.0.1:<port>/mcp` in every Claude config directory and both Codex homes,
  with `bin/headers.js` as the headers helper that carries the session's name and token.

Everything is plain JavaScript on Node 22, ES modules, no bundler, no TypeScript. The
directory has its own `package.json` and is not part of keep-tool's build or test
scripts. Its only runtime dependency is `@modelcontextprotocol/sdk` (plus `zod`, which
the SDK needs for tool schemas). The extension has no dependencies at all: the one piece
of third-party code it uses, the `gifenc` GIF encoder, is vendored as a single file under
`extension/lib/vendor/` because a load-unpacked extension has no build step to resolve
imports for it.

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
    lib/frames.js           splice out-of-process iframe AX trees into the page's (pure)
    lib/page.js             functions serialized into the page via Runtime.callFunctionOn
    lib/gifframes.js        gif_creator's labels, delays, caps, quality mapping (pure)
    lib/gifstore.js         gif_creator's frames in IndexedDB, keyed by tab group
    lib/gifencode.js        OffscreenCanvas overlays + gifenc encoding, in the worker
    lib/vendor/gifenc.js    vendored MIT GIF encoder (mattdesl/gifenc), not an npm dep
    tools/*.js              one module per tool
    tools/axtree.js         one AX tree per tab, iframe sessions and all
    popup.html, popup.js    status: connected?, sessions, groups, reconnect button
  host/
    native-host.js          the broker (entry; the native host manifest points at a launcher that execs it)
    protocol.js             native framing, socket line codec, limits (pure, testable)
  mcp/
    daemon.js               the shared streamable-HTTP MCP daemon (entry)
    server.js               stdio MCP server entry (one process per session; the fallback)
    session.js              one session's tool handlers, shared by both entries
    tools.js                tool definitions: names, schemas, result shaping
    client.js               socket client with reconnect and hello
  bin/
    install.js              native host + launchd daemon + registrations; --browser edge|chrome; --stdio; --rotate-token; --dry-run; --uninstall
    headers.js              prints the daemon headers for one session (the agents' headers helper)
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
- The daemon is a launchd agent (`com.keep.browser_bridge.daemon`, RunAtLoad, KeepAlive,
  ThrottleInterval 5). It runs *this checkout's* `mcp/daemon.js`, so a landing does not
  reach sessions until the job has been reloaded, which `node bin/install.js` does. A
  daemon restart invalidates every `Mcp-Session-Id`; the next request with a stale one
  gets the SDK's 404 (`-32001 Session not found`) and the client initializes again, which
  makes a new socket client with a new `sessionKey` — so the tab group is a new one, the
  old group staying behind for the user exactly as an ended session's does.
- One MCP session closes when its client sends `DELETE /mcp`, when it has made no request
  for 24 hours (swept once a minute), or when the daemon gets SIGTERM. All three close the
  session's `BridgeClient`, which is a `bye` to the host, which is `session_closed` to the
  extension: the same path a stdio server's exit took.
- The MCP server tells the host `bye` on stdin close or SIGTERM. The extension then
  closes the session's tab group only if every tab in it is a blank new-tab page;
  otherwise the tabs stay for the user, matching what Claude Code does on exit, and the
  mapping stays with them under an `ended` flag so the same session key gets its group
  back instead of opening a second one beside it.
- Creating, reviving and tearing down a session all run under one promise chain per
  session key, and so does each request's own session lookup: a request that arrives
  while a `session_closed` is still in flight (a host restart is exactly that) waits for
  that teardown to finish or abort rather than racing it, and then sees a settled world —
  either the group is still there or the session starts fresh. Teardown also re-reads an
  activity counter after every await and aborts before any tab is closed or any mapping
  forgotten, which is what turns a host restart into a no-op.
- Session state (`sessionKey -> {groupId, windowId, name}`) lives in
  `chrome.storage.session` so it survives worker restarts, and every write to it goes
  through a single queue: two tools arriving together would otherwise read the same
  snapshot and lose one another's changes. A group the user closed by hand is detected
  by `chrome.tabGroups.get` failing, and the next `tabs_context_mcp{createIfEmpty:true}`
  starts fresh.
- A tab's debugger state (console and network buffers, the ref table) belongs to the
  session that claimed it. If the tab changes group — dragged loose, or handed to
  another session — the debugger is detached and the state dropped rather than inherited
  by its new owner.
- A reply the host could never reassemble is never sent: a result over the 16 MiB
  assembled limit comes back as `result too large (N bytes, limit M)` instead of frames
  that would be dropped, leaving the caller to wait out its timeout. The host answers
  the same way if reassembly fails for any other reason, or if a half-received reply is
  dropped because it went stale or because too many were in flight at once — an
  abandoned partial always becomes an error for whoever was waiting on it.

## Tools

Names and input schemas are copied from `docs/claude-in-chrome-tools.txt`. Dropped:
`shortcuts_list`, `shortcuts_execute`, `switch_browser`, `list_connected_browsers`,
`select_browser` (Anthropic cloud features with no local meaning). Added:
`browser_status` (host reachable, extension version, this session's group and tabs,
every session the extension knows).

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
  `max_chars` truncates at a line boundary with a note giving the full size.
  Iframes are included: a cross-origin frame's tree comes from its own auto-attached
  session, a same-origin frame's from a second `getFullAXTree` for its frame id, and both
  are spliced under the iframe element that hosts them (see "Cross-origin iframes" below),
  with a trailing note saying how many of each were folded in, and another for any that
  could not be read or placed.
- `find`: heuristic over the same tree. Tokenize the query, score each node on name,
  role, value and description matches (exact phrase > all tokens > some tokens; role
  words in the query such as "button", "link", "input", "search" match the role), return
  up to 20 as `[ref] role "name"` lines, best first. State in the description that
  the ranking is lexical, not a model. More than 20 hits: return the top 20 and say to
  narrow the query. Results are ordered by *band* first and only by the additive score
  inside a band: name-is-the-query, name-contains-the-query, then every token matched
  exactly, by stem, by synonym, by typo, then a partial match. The additive score alone let
  a pile of weak matches out-total one exact one (a searchbox named "find input field box"
  beat a node named exactly "search input field box"). Query tokens are deduplicated for
  the same reason: repeating a word multiplied its contribution.
  A token matches in one of four ways, scored in that order: exact,
  stemmed (crude suffix stripping with the "e" put back, so "saved" meets "Save"),
  synonym (a table of the words models actually use: search/find, login/sign in,
  cart/basket, delete/remove, settings/preferences, ...) and fuzzy (a prefix, or a
  Damerau-Levenshtein distance of 1 for tokens of 5 characters and 2 for 8). The role
  table is reached through the same four, so "picker" and "buton" still name a role.
  Two-word forms ("sign in", "e-mail") are folded into one token on both sides, since
  the "in" would otherwise be dropped as a stopword. A node matched *only* by fuzzy
  tokens needs at least half the query's tokens to hit, so "chart" in a longer query
  does not drag in "cart".
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
- `gif_creator`: `start_recording`, `stop_recording`, `export`, `clear`, scoped to the
  tab's group (which is the session's group, with the same foreign-tab refusal as every
  other tab tool). While a group records, `computer` captures a frame after every action
  on any tab in that group — including `screenshot`, so the spec's "screenshot right
  after start / right before stop" gives the first and last frames — and `navigate`
  captures one after the load. A frame is the same `Page.captureScreenshot` the
  `screenshot` action takes (reused directly when the action *was* a screenshot),
  downscaled to at most 800 px wide, plus the action's kind, coordinates and a label
  (`Click (312, 400)`, `Type "hello"`, `Press cmd+a`, `Scroll down`,
  `Navigate example.com`, `Screenshot`) and a timestamp. Frames are blobs in IndexedDB
  keyed by the group, so a worker restart between two actions does not lose the take,
  capped at 300 frames and 60 MB per group — the incoming frame's own size counts towards
  the cap before it is written, so the total cannot overshoot, and there is no exemption
  for the first frame: one frame bigger than the whole budget is refused like any other and
  `export` then says the cap refused every frame rather than that the recording is empty.
  At a cap recording stays on, nothing more is stored, and `export` says so. `clear` empties the frames and resets the
  counters in one transaction, so a worker killed mid-clear cannot leave an empty recording
  that still believes it is full. Ownership is re-checked immediately before the capture,
  again before the frame is stored, and — inside `dropFileAtCoordinate` itself — after the
  debugger attach and the document lookup, immediately before the `callFunctionOn` that
  hands the page the file: the tab object an action captured is a snapshot, those steps are
  awaits of their own, and a tab dragged into another session's group must not be recorded
  into this session's GIF or receive its file. `upload_image`'s coordinate mode shares that
  helper and therefore that guard. The handle is released with a raw send that never
  attaches: cleaning up after a refusal must not re-attach the debugger to a tab that has
  just become somebody else's. A filename is normalised before anything is encoded
  (path separators, `<>:"|?*`, control characters, and the DOS device names judged by the
  component before the *first* dot, so `CON.backup` is caught while `console.gif` is not),
  so a name the download API would refuse never costs a wasted encode. Frame delay is the real gap to the next frame clamped to
  300-3000 ms, 1500 ms on the last. `export` renders each frame with `OffscreenCanvas`
  and encodes with the vendored `gifenc` (`quantize` + `applyPalette` + `writeFrame`);
  overlays are orange click circles, red drag arrows, a black rounded label, an orange
  progress bar and a "Browser Bridge" watermark in place of the Claude logo, each
  switchable, with `quality` 1-30 mapping to palette size, histogram format and
  prequantize rounding (documented in `lib/gifframes.js`). `download: true` hands
  `chrome.downloads.download` a `data:` URL (a worker has no `URL.createObjectURL`);
  `coordinate: [x, y]`, a property the contract's description promises but its schema
  never declared, drops the GIF on the element at that point through the same code as
  `upload_image`'s coordinate mode. Neither is an error naming both. The result is text
  only — filename, frame count, duration, encoded size, any cap note — never the bytes.
  `export` keeps the frames, `clear` discards them, `stop_recording` keeps them, and a
  closed group or an ended session drops them.
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
  are also viewport CSS pixels (verified on Edge 153 with a ref click 2200 px down a
  page).
- `Page.captureScreenshot` `clip` is in document CSS pixels, so a viewport shot passes
  `x: scrollX, y: scrollY`, and `clip.scale` is multiplied by the device pixel ratio
  (verified: `scale / dpr` gives a CSS-sized image on a DPR 2 display). A wheel scroll
  animates, so the tool waits 250 ms after scrolling and two animation frames before
  every capture; without that the frame is stale. That animation-frame wait is bounded
  three ways — two frames, 300 ms inside the page, 1 s measured in the worker — because
  CDP's `timeout` does not cover an awaited promise and a page is free to stub out both
  `setTimeout` and `requestAnimationFrame`.
- A timed-out `Runtime.evaluate` comes back on Edge 153 as `{"code":-32603,"message":"Internal error"}`
  after the full budget, not as a named timeout, so the tool uses the clock to decide.
- macOS editing chords (`cmd+a`, `cmd+z`, `alt+ArrowLeft`, ...) are performed by the
  browser, not the page: `Input.dispatchKeyEvent` needs the matching `commands` list or
  the page sees the keydown and nothing happens. `lib/keys.js` carries the table.
- `DOM.setFileInputFiles` with absolute paths works from an extension's debugger
  session; `Accessibility.getFullAXTree` includes `InlineTextBox` rows that the renderer
  drops as noise.
- Screenshots work on a tab that is active in an unfocused window, so the bridge never
  focuses a window. An occluded window (Edge behind the terminal) is the common case
  and it starves the renderer of frames: input acks take 5 s each, wheel events never
  return, animation frames never fire. `Emulation.setFocusEmulationEnabled` on every
  attached tab fixes all of that (verified on Edge 153), so `lib/cdp.js` enables it
  right after the domains. The in-page animation-frame wait before a capture is also
  bounded to 300 ms because CDP's evaluate `timeout` does not cover an awaited promise.
- The extension must also handle `chrome.tabs.onRemoved` (drop tab state) and
  `chrome.tabGroups.onRemoved` (drop the session's group id).

## Cross-origin iframes

`Accessibility.getFullAXTree` answers for exactly one document, so every iframe needs a
call of its own — a cross-origin one because it is a separate renderer the tab's session
cannot see into, a same-origin one because it is still a separate document (verified on
Edge 153: a same-origin iframe rendered as an `Iframe` node with no children until it was
fetched by frame id).

- `lib/cdp.js` sends `Target.setAutoAttach {autoAttach:true, waitForDebuggerOnStart:false,
  flatten:true}` right after attaching a tab. Every OOPIF, existing and future, then
  reports itself as `Target.attachedToTarget` on the same port with a child `sessionId`.
  Commands are addressed to it by passing `{tabId, sessionId}` to
  `chrome.debugger.sendCommand`, and its events arrive with `source.sessionId`, which is
  how the console and network handlers know to ignore them: those buffers stay the main
  session's, as they always were.
- Auto-attach is **not** recursive (verified on Edge 153: a cross-origin frame inside a
  cross-origin frame never attached). Every child session arms `Target.setAutoAttach` for
  itself as soon as it attaches, alongside its domains, so its own out-of-process children
  attach in turn; their events arrive with the tab's `source.tabId` and the *parent
  session's* `source.sessionId`, which is recorded so a detach can drop the whole subtree.
  `tools/axtree.js` therefore collects frame sessions in rounds: arming a frame is what
  makes its children appear, so the list grows while it is being walked. The walk is bounded
  three ways — at most 8 rounds, a 5 s clock checked before *every* read rather than only
  between rounds, and a race between each individual read and what is left of that clock, so
  neither a hundred slow frames nor one stalled CDP call can hold the tree hostage. The
  page's own tree is under the same clock; a main renderer that never answers is an error
  naming the timeout, since there is nothing to fall back on. When a *frame* read stops the
  walk early it keeps what it collected and the result carries a note that the page was
  still changing. A frame
  the asking session cannot read is left for the session that owns it rather than being
  written off, so a frame named in the page's frame tree but living in another process is
  still read through its own session.
- Only `type: "iframe"` targets are kept (workers auto-attach too and have no tree). For
  an iframe target the `targetId` *is* the frame id, which is the hook for splicing.
- Same-process frames are found through `Page.getFrameTree` — on the main session and on
  each OOPIF session, so a same-origin frame nested inside a cross-origin one is found
  too. Every frame in those trees that is not an attached OOPIF target is fetched with
  `Accessibility.getFullAXTree {frameId}` on that same session. The main session's frame
  tree also names frames that live in another process; asking for one there fails and is
  skipped rather than reported, because its own session already answered for it.
- `tools/axtree.js` collects all of that and asks `DOM.describeNode` for the frame id
  behind each iframe AX node (cached per document, cleared on main-frame navigation), then
  hands `lib/frames.js` the pieces. That module is pure: it namespaces each child tree's
  node ids by frame (`frameId::nodeId` — every tree numbers from 1, including two
  documents in the same session), stamps each node with the session that answers for it,
  and hangs the child roots off the hosting iframe node, in passes so an iframe inside an
  iframe lands under its own parent. A frame whose host element cannot be found is
  reported rather than dropped, and `read_page` says how many cross-origin and how many
  same-origin frames were folded in.
- Refs therefore map to `{sessionId, backendNodeId}`: a backend node id is only unique
  within one renderer. `computer` ref clicks, hover, `scroll_to`, `form_input`,
  `file_upload` and `upload_image` all send their DOM commands to the ref's session, while
  mouse and key input keep going through the main session.
- Geometry needs translating, which is the one thing the first cut got wrong.
  `DOM.getContentQuads` from a child session reports the node's position in *that frame's*
  viewport (measured on Edge 153: a button really at (452, 372) came back as (430, 90)
  from a frame whose content box starts at (22, 282)). `frameViewportOffset` in
  `tools/shared.js` adds the host iframe element's content-box origin — `DOM.getBoxModel`
  on the host node in its *parent* session, `content` rather than the border box, so the
  iframe's own border and padding are excluded — and repeats outwards for a frame nested
  inside another OOPIF. A same-process frame shares its parent's session and needs no
  translation, so none of this runs for it, and neither does any of the waiting below.
- The measurement has to wait, which is the *second* thing the first cut got wrong.
  `DOM.scrollIntoViewIfNeeded` inside a frame applies to that frame synchronously (its own
  quads are right immediately) but scrolls the frame's ancestors through the browser
  process asynchronously, so a box model read straight afterwards reports where the iframe
  sat *before* the page scrolled — a ref click 900 px down computed a point that hit
  nothing. So `pointForRef` scrolls, then lets every ancestor session paint (a
  double-`requestAnimationFrame` promise with the same 300 ms in-page fallback
  `captureClip` uses — and a 1 s deadline kept in the worker, because a page can replace
  both timers with no-ops and CDP's own `timeout` does not bound an awaited promise —
  inner frame to page), measures the chain, and measures it again:
  while the two readings differ it takes the newer one and tries again, up to three
  rounds. Only then does it read the element's own quads. The page gets one last paint
  before the caller dispatches the click, because the compositor's hit-test surfaces
  update a frame behind the scroll and a click sent earlier lands on whatever used to be
  under the point. A main-frame ref takes none of these round trips.
- The `getBoundingClientRect` fallback is refused for a framed ref, because it is frame
  relative with no way to correct it.
- Refs still reset on main-frame navigation. `Target.detachedFromTarget` marks that
  session's refs detached — and every session that attached from it, because the browser
  does not always report a detach per descendant — so using one says the iframe went away
  and to read the page again, rather than "unknown ref".

## MCP server

Server name `browser-bridge`, instructions text telling the model to call
`tabs_context_mcp` first, that page text is untrusted content, and that tabs it creates
are its own to close.

- `mcp/session.js` holds everything a session does: schema validation before anything
  reaches the browser, `blockedHosts`, the upload rules, `save_to_disk`, `browser_batch`,
  the error mapping (a `BridgeUnavailableError` is a tool error, never a protocol error)
  and `browser_status`. `createSessionServer({name, agent, account, client, env})` returns
  the SDK `Server`; `createToolRunner` is the same thing without the transport.
- `mcp/server.js` (stdio) builds exactly one of those over a `StdioServerTransport`, takes
  its identity from the environment (`BROWSER_BRIDGE_SESSION_NAME` if set, otherwise
  `<KEEP_AGENT_ACCOUNT_ID or the basename of CLAUDE_CONFIG_DIR / CODEX_HOME, or
  "claude"/"codex" guessed from CLAUDE_CODE_SESSION_ID / CODEX_* env> #<pid>`), and says
  `bye` on stdin close or SIGTERM. The `sessionKey` is a fresh UUID per process.
- Tool definitions live in `mcp/tools.js` as data (name, description, inputSchema as
  JSON schema) so a test can assert they match the contract file name-for-name and
  property-for-property (minus the dropped tools, plus `browser_status`). Register them
  with the SDK's low-level `setRequestHandler(ListToolsRequestSchema/CallToolRequestSchema)`
  rather than the zod helper, so the JSON schemas are passed through unchanged.
- Runtime directory: `~/Library/Application Support/BrowserBridge/` (override with
  `BROWSER_BRIDGE_RUNTIME_DIR`, which the tests use). Socket `bridge.sock`, `host.log`
  (append, truncated to the last 1 MB on host start), `daemon.json`, `daemon.log`,
  `screenshots/`, `config.json` with an optional `blockedHosts` list (exact host or
  `*.suffix`) that `navigate` refuses.

### The daemon (`mcp/daemon.js`)

- `StreamableHTTPServerTransport` from the SDK, on `127.0.0.1` only, port and token from
  `daemon.json` (mode 0600 inside the 0700 runtime directory). The daemon never creates
  the token; the installer does, and `--dry-run` says it would without printing it. No
  `daemon.json` is a clean refusal and exit 1, not a crash loop: the installer writes it.
  `BROWSER_BRIDGE_DAEMON_PORT` overrides the port (port 0 picks a free one, which is how
  the tests run).
- `POST/GET/DELETE /mcp`. One transport and one `createSessionServer` per MCP session,
  keyed by `Mcp-Session-Id` the way the SDK's multi-session example does, each with its own
  `BridgeClient` on the host socket carrying a fresh `sessionKey` UUID and the session's
  name. One socket client = one session = one tab group, exactly as a stdio process was,
  so neither the host nor the extension needed changing.
- An MCP session costs a Map entry, a transport and a `Server` — a few kilobytes. The
  `BridgeClient` connects lazily on the first tool call, as it always did, so a session that
  never touches the browser never opens the socket and never says `hello`: the host and the
  extension only learn about the sessions that are actually using the browser, which is less
  than they saw before, not more.
- `GET /healthz` answers `{ok, pid, port, sessions, host:{socket, connected, hostPid,
  extensionConnected, extensionVersion}}` with no auth — it is loopback-only and says
  nothing a caller could not learn by trying. It never opens a socket of its own: a probe
  that said `hello` would appear in the extension as a session with a tab group. The
  numbers come from whatever the sessions' own `hello` replies last reported.
- Session identity comes from the request, because the daemon has no environment of its
  own: `X-Browser-Bridge-Session` (trimmed, control characters stripped, 80 chars), and
  optionally `X-Browser-Bridge-Agent` and `X-Browser-Bridge-Account` the same way. With no
  session header the name is `<clientInfo.name from initialize> #<n>` on a daemon-wide
  counter — Claude Code and Codex send different `clientInfo` names and whatever they send
  is kept, sanitized the same way.
- `bin/headers.js` is what supplies those headers. It prints one JSON object
  (`Authorization: Bearer <token>`, plus the session name from
  `BROWSER_BRIDGE_SESSION_NAME`, the account from `KEEP_AGENT_ACCOUNT_ID` or the basename
  of `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, and the agent guessed as `sessionIdentity` does)
  and exits 0. With no `daemon.json` it prints `{}` and still exits 0: a bridge that is not
  installed must not break a session's startup.
- One stderr line per session start and end (name, agent, account, how many are open),
  which launchd writes to `daemon.log`. Tool arguments are never logged.

#### Security notes for the daemon

The trust boundary is unchanged: **only a process that can read the user's token file can
drive the browser**, which is the same statement as "only a process that can open the 0600
socket can drive the browser". `daemon.json` is 0600 in a 0700 directory, and the token is
32 random bytes as hex.

- Every `/mcp` request must carry `Authorization: Bearer <token>`; anything else is 401
  before the body is looked at. The comparison is length-checked and then
  `timingSafeEqual`.
- Any request carrying an `Origin` header at all is 403, including a loopback one. CLI
  clients never send one and browsers always do, so this is the cheap, complete version of
  "not reachable from a web page". No CORS header is ever sent, so a page cannot read a
  reply even if it got one.
- `enableDnsRebindingProtection: true` with `allowedHosts` of `127.0.0.1:<port>` and
  `localhost:<port>`: a name that resolves to loopback cannot be used to reach it.
- Request bodies are capped at 16 MiB and read by the daemon itself, so an oversized body
  is a 413 and the socket is dropped rather than buffered. `file_upload` sends paths, not
  bytes, so nothing legitimate comes near the cap.
- A session id the daemon does not know is a 404 and nothing else: no session is created
  and nothing is leaked about which ids exist.

## Installer

```
node bin/install.js [--browser edge|chrome] [--chrome-too] [--stdio]
                    [--rotate-token] [--dry-run] [--uninstall]
```

1. Write `~/Library/Application Support/BrowserBridge/native-host` (mode 0700), a
   two-line `#!/bin/sh` launcher that `exec`s the absolute path of the node that ran
   the installer with `host/native-host.js "$@"`. Edge launches native hosts with a
   minimal environment, so never rely on PATH or nvm.
2. Write `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.keep.browser_bridge.json`
   (`allowed_origins` = the fixed extension origin), and the Chrome equivalent when
   asked.
3. Write `daemon.json` (mode 0600) with the port and a fresh 32-byte hex token **if it is
   not already there**. An existing token is never rotated: it is in every registration
   already, and rotating it under a running session would take that session's browser away
   for no reason. `--rotate-token` is the way to do it deliberately.
4. Write `~/Library/LaunchAgents/com.keep.browser_bridge.daemon.plist` (the same node the
   native-host launcher uses, `mcp/daemon.js`, RunAtLoad, KeepAlive, ThrottleInterval 5,
   WorkingDirectory the bridge directory, both output paths `BrowserBridge/daemon.log`),
   then `launchctl bootout gui/<uid>/<label>` (failure ignored — the normal case is that
   launchd has never heard of it) and `launchctl bootstrap gui/<uid> <plist>`.
5. Register `browser` as an HTTP MCP server pointing at `http://127.0.0.1:<port>/mcp` with
   `bin/headers.js` as the headers helper, in every Claude config directory found
   (`~/.claude`, `~/.claude-secondary`, `~/.claude-tertiary`, and any `~/.claude-*` that
   has a `.claude.json`) and in `~/.codex` and `~/.codex-secondary`:

   ```json
   "browser": { "type": "http", "url": "http://127.0.0.1:47331/mcp",
                "headersHelper": "<node> <bridge>/bin/headers.js" }
   ```

   ```toml
   [mcp_servers.browser]
   url = "http://127.0.0.1:47331/mcp"
   http_headers_helper = "<node> <bridge>/bin/headers.js"
   startup_timeout_sec = 20.0
   tool_timeout_sec = 120.0
   ```

   What each client does with that helper, read out of the installed binaries rather than
   guessed (Claude Code 2.1.277, codex-cli 0.154.0):

   - Both run it **through a shell** (Codex `sh -c`, Claude Code `shell: true`) with the
     session's **whole ambient environment**, which is what lets
     `BROWSER_BRIDGE_SESSION_NAME` reach a daemon that has none. Claude Code adds
     `CLAUDE_CODE_MCP_SERVER_NAME` and `CLAUDE_CODE_MCP_SERVER_URL`.
   - Both allow it 10 s and require one JSON object of string values on stdout. Codex caps
     the output at 64 KiB and Claude Code at 1 MB; Codex refuses reserved header names
     (`accept`, `content-type`, `origin`, ... — `authorization` is not one of them).
   - Claude Code re-runs the helper and retries once when a tool call comes back 401 or 403,
     which is what makes `--rotate-token` survivable: a live session picks up the new token
     on its next call instead of needing a restart.
   - Claude Code's entry must be **`--scope user`**. At `local` or `project` scope it treats
     the config as repo-resident and refuses to run the helper at all without persisted
     workspace trust ("headersHelper not run: this workspace has no persisted trust"), and
     at `project` scope it also scrubs credential-looking variables out of the environment.
   - Codex accepts `http_headers_helper` only on a `url` server: `command` in the table
     forces stdio and the helper is then rejected, which is why the table is replaced whole
     rather than added to. Its two timeouts are set because the host's own per-request
     budget is 90 s and the socket client's is 100 s; the agent must not give up before the
     browser does.

   Neither `claude mcp add` nor `codex mcp add` has a flag for a headers helper
   (Claude Code's are `--transport` and `--header`; Codex's are `--url` and
   `--bearer-token-env-var`). Claude Code has `claude mcp add-json <name> <json>`, which
   takes the whole entry, so the Claude side still goes through the CLI —
   `CLAUDE_CONFIG_DIR=<dir> claude mcp remove --scope user browser` (failure ignored) and
   then `... claude mcp add-json --scope user browser '<entry>'`. That matters: live
   sessions rewrite `.claude.json`, and editing it from here would race them. Codex has no
   equivalent, so `[mcp_servers.browser]` is written into `config.toml` directly.

   The direct JSON edit is kept as the **fallback** for when `claude` is not on PATH or
   refuses: better to register the bridge correctly than to print a block for someone to
   paste. Both edits are surgical — every other key and table is left as it was, byte for
   byte in the TOML — and both keep a `.bak`. An edit that would change nothing is skipped
   entirely, so a re-run does not churn a file a live session is holding. A file that is not
   valid JSON is reported with the block to paste and left exactly as it was.
6. Wait up to 10 s for `GET /healthz` to answer and report the port, the pid and the
   session count, or say the daemon never came up and where its log is (and exit 1).
7. Print the extension directory to load via `edge://extensions` (Developer mode, Load
   unpacked) and the extension id the manifest key fixes.

`--stdio` is the old shape exactly: no `daemon.json`, no launchd job, and `browser`
registered through `claude mcp add` / `codex mcp add` as one stdio process per session.

`--uninstall` removes the launcher, both browsers' manifests and the plist, boots the job
out, and takes `browser` out of every config. `daemon.json` stays: sessions that are still
running hold that token in their registration, and a reinstall must not lock them out.

**The daemon runs this checkout's files.** After every landing the job has to be reloaded,
and `node bin/install.js` is what reloads it. Nothing else does — not a `git pull`, not a
session restart.

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
- `test/frames.test.js`: the splice as a pure function (namespacing, nesting, a
  same-process child, an unplaceable frame), then read_page, find and the ref-based tools
  against a stubbed CDP that answers a different tree per session and per frame id: a page
  with no child frames must take exactly the path it always took, a framed ref must send
  its DOM commands to the frame and its mouse events to the page at the *translated*
  point (the arithmetic is checked against the live Edge measurements, one level and two),
  a host iframe whose box model only reports its settled position on the second read must
  still be clicked in the right place, and a detached frame must invalidate the refs of
  everything under it with a clear error.
  The stub only attaches a frame's own children when that frame arms auto-attach, which is
  how the two-level attach is covered.
- `test/gif.test.js`: labels, delays, caps and the quality mapping directly; the store
  against an in-memory backend (`setGifBackend`); the tool and the recorder against a
  stubbed `chrome`; and the encoder against a stubbed `OffscreenCanvas`, which records
  every drawing call and feeds the real `gifenc` synthetic pixels, so the bytes the
  download test inspects are a real GIF.
- `test/client.test.js`: reconnect and hello replay against a scripted socket server.
- `test/daemon.test.js`: a daemon on port 0 against a fake host socket, driven by the SDK's
  own HTTP client so the handshake and the SSE framing are real: the session header becomes
  the name in `hello`, `tools/list` is the whole contract, a call is forwarded and answered,
  a second initialize is a second session with a second socket client, a missing or wrong
  token is 401, any `Origin` is 403, a foreign `Host` is refused, an unknown session id is
  the SDK's 404, DELETE closes the socket client, idle expiry runs on a fake clock, and a
  child daemon killed with SIGTERM says `bye` before it exits.
- `test/headers.test.js`: the helper with and without `daemon.json` and with and without
  each environment variable, plus the process itself — one JSON line, nothing on stderr,
  exit 0 either way.
- `test/install.test.js`: `--dry-run` output, the manifest, the plist, `daemon.json`
  creation without rotation, both config edits as pure functions, and a real run against a
  temp HOME with a fake command runner and a fake health probe (nothing reaches launchd,
  the real CLIs or the network).

Live verification against Edge is done from the driving session, not by the
implementer.

## Keep integration

`keep open` sets `BROWSER_BRIDGE_SESSION_NAME` in the pane environment to `#<num> <card>`
(either half alone when only one exists), so a session's tab group reads `#12 fix-login`.
An explicit value in the launch environment wins. Nothing there changed for the daemon:
the agent runs `bin/headers.js` in the session's own environment, so that variable reaches
the daemon as `X-Browser-Bridge-Session` instead of being read by a child process.

## Known gaps

- Console and network events from out-of-process iframes are dropped; only the page's own
  frames reach `read_console_messages` and `read_network_requests`.
- `get_page_text` and `javascript_tool` see the main frame only.
- `gif_creator`'s `coordinate` export and `upload_image`'s coordinate mode hit-test the
  main frame, so a drop zone inside a cross-origin iframe cannot be targeted.
- A window resized mid-recording makes later frames a different size; they are scaled into
  the first frame's canvas rather than letterboxed.
- An agent that exits without sending `DELETE /mcp` leaves its session open in the daemon
  until the 24-hour idle sweep, so the popup and `browser_status` can list sessions whose
  agent is gone. A stdio server could not do that: the pipe closing *was* the signal. There
  is no equivalent signal over HTTP, and a shorter idle timeout would evict a session that
  is simply not using the browser at the moment. The cost is a stale row and an idle socket;
  when that agent comes back it initializes again and gets a new `sessionKey`, so it gets a
  new tab group rather than the one it left.

## Security notes

- The socket is 0600 inside a 0700 directory; anything running as this user can drive
  the browser, which is the same trust boundary as the Claude in Chrome native host. The
  daemon does not widen it: its token lives in a 0600 file in the same directory, so a
  process that can read the token could have opened the socket instead. See the daemon's
  own security notes above for what keeps the loopback port from being a *second*,
  weaker way in — the Bearer token, the flat refusal of any `Origin`, DNS-rebinding
  protection and no CORS headers ever.
- The host only serves the extension origin it was launched for; the extension only
  accepts commands from its native port. Page content (text, console, network bodies,
  accessibility names) is untrusted input and the MCP instructions say so.
- `file_upload` reads paths on this machine; it is limited to regular files under
  10 MB with a single hard link, matching Claude Code's rules. Those checks and the
  browser's own read of the file are not atomic, so a path swapped in between them would
  be uploaded unchecked; on a single-user machine anything that could win that race can
  already read the file directly, so the TOCTOU gap is accepted rather than closed.
- Screenshot ids are scoped to the session that took them: sessions share one service
  worker, and one session's screenshot is not another's to upload into a page.
- A socket client may only name a tool method. `session_hello`, `session_closed` and
  `ping` are the host's to send, so a client cannot rename or evict another session's
  tab group.
- No site permission prompts: this is a single-user machine and every session is the
  user's own agent. `blockedHosts` in `config.json` is the one guard rail.
