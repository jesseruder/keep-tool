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
  narrow the query. A token matches in one of four ways, scored in that order: exact,
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
  capped at 300 frames and 60 MB per group; at a cap recording stays on, nothing more is
  stored, and `export` says so. Frame delay is the real gap to the next frame clamped to
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
  every capture; without that the frame is stale.
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
  from a frame whose content box starts at (22, 282)). `frameQuadToMainViewport` in
  `tools/shared.js` adds the host iframe element's content-box origin — `DOM.getBoxModel`
  on the host node in its *parent* session, `content` rather than the border box, so the
  iframe's own border and padding are excluded — and repeats outwards for a frame nested
  inside another OOPIF. A same-process frame shares its parent's session and needs no
  translation, so the loop does not run for it. `DOM.scrollIntoViewIfNeeded` in the child
  session scrolls the frame's own content correctly and is left alone. The
  `getBoundingClientRect` fallback is refused for a framed ref, because it is frame
  relative with no way to correct it.
- Refs still reset on main-frame navigation. `Target.detachedFromTarget` marks that
  session's refs detached, so using one says the iframe went away and to read the page
  again, rather than "unknown ref".

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
- `test/frames.test.js`: the splice as a pure function (namespacing, nesting, a
  same-process child, an unplaceable frame), then read_page, find and the ref-based tools
  against a stubbed CDP that answers a different tree per session and per frame id: a page
  with no child frames must take exactly the path it always took, a framed ref must send
  its DOM commands to the frame and its mouse events to the page at the *translated*
  point (the arithmetic is checked against the live Edge measurements, one level and two),
  and a detached frame must invalidate its refs with a clear error.
- `test/gif.test.js`: labels, delays, caps and the quality mapping directly; the store
  against an in-memory backend (`setGifBackend`); the tool and the recorder against a
  stubbed `chrome`; and the encoder against a stubbed `OffscreenCanvas`, which records
  every drawing call and feeds the real `gifenc` synthetic pixels, so the bytes the
  download test inspects are a real GIF.
- `test/client.test.js`: reconnect and hello replay against a scripted socket server.
- `test/install.test.js`: `--dry-run` output and manifest contents against a temp
  HOME.

Live verification against Edge is done from the driving session, not by the
implementer.

## Phase 2

- Keep integration: `keep open` sets `BROWSER_BRIDGE_SESSION_NAME` to the session
  number and card so tab groups read `#12 fix-login`.

## Security notes

- The socket is 0600 inside a 0700 directory; anything running as this user can drive
  the browser, which is the same trust boundary as the Claude in Chrome native host.
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
