# Browser Bridge

One Edge extension, one native messaging host, and one shared MCP daemon, so every Claude
Code and Codex session on this machine can drive the same browser at the same time —
whatever account it runs on, and without a process per session.

`docs/DESIGN.md` explains why it exists and how it is put together.
`docs/claude-in-chrome-tools.txt` is the tool contract it mirrors.

```
Edge ── extension (MV3, chrome.debugger/CDP)
          │ native messaging
     native host  host/native-host.js          broker, one per extension connection
          │ unix socket ~/Library/Application Support/BrowserBridge/bridge.sock
     mcp/daemon.js                             one process, launchd KeepAlive
          │ streamable HTTP on 127.0.0.1:47331/mcp (Bearer token, loopback only)
   ┌──────┴───────┬──────────────┐
 session        session        session         one MCP session per agent session
```

## Install

Everything is local; nothing is published or fetched at run time.

```sh
cd browser-bridge
npm install
node bin/install.js --dry-run     # read what it will do
node bin/install.js               # launcher, manifest, daemon, register `browser`
```

The installer:

1. writes `~/Library/Application Support/BrowserBridge/native-host`, a two-line `sh`
   launcher that execs the absolute path of the node that ran the installer (Edge starts
   native hosts with an empty environment, so nothing may depend on `PATH` or nvm);
2. writes `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.keep.browser_bridge.json`
   (`--chrome-too` adds Chrome's);
3. writes `BrowserBridge/daemon.json` (mode 0600) with the loopback port, a random 32-byte
   `token` (what every agent sends) and a random 32-byte `secret` (what session keys are
   derived from, and which never leaves this machine), keeping either if it is already there;
   `--rotate-token` replaces both, which moves every live session to a new tab group and drops
   the session names the daemon had remembered (it recognises a `sessions.json` written under
   the old secret and discards it);
4. makes sure `BrowserBridge/daemon.log` exists at mode 0600 (launchd would create it 0644),
   writes `~/Library/LaunchAgents/com.keep.browser_bridge.daemon.plist` and reloads the
   launchd job — `kickstart -k` when the plist has not changed, otherwise `bootout`, a poll
   until launchd has really let go, and `bootstrap` with retries — then waits for `/healthz`
   and **exits non-zero if the daemon is not answering**, rather than claiming success;
5. points `browser` at `http://127.0.0.1:<port>/mcp` in every Claude config directory it
   finds and in `~/.codex` / `~/.codex-secondary`, with `bin/headers.js` as the headers
   helper that supplies the token and the session name. Neither CLI has a *flag* for a
   headers helper, so the Claude side goes through `claude mcp add-json` (which takes the
   whole entry, and leaves the file to the tool that owns it) and Codex's is a surgical edit
   of `[mcp_servers.browser]` in `config.toml`, with a `.bak` kept and everything else left
   alone. If `claude` is not on PATH the installer edits `mcpServers.browser` itself.

Sessions that were already running keep the registration they started with; restart them.

`node bin/install.js --stdio` goes back to the old shape — one `mcp/server.js` process per
session — and takes the launchd job and its plist out, so no daemon is left listening with
nothing registered against it. `daemon.json` stays, so switching back is another plain run.

**After a landing, re-run `node bin/install.js`.** The launchd job runs this checkout's
`mcp/daemon.js`, so nothing else picks up a code change: not a pull, not a session restart.
The same command is the way to restart the daemon by hand.

Then load the extension:

1. `edge://extensions` → Developer mode → **Load unpacked** → pick `browser-bridge/extension`.
2. The id must be **goijgcbiphelgdlpjmpepfkihboonjbg** — the `key` in `manifest.json`
   pins it, and the native host manifest only trusts that origin.
3. Click the extension's icon: the popup should say **connected**, and list sessions as
   they attach.

`node bin/install.js --uninstall` removes both browsers' manifests, boots the launchd job
out and unregisters `browser` everywhere. `daemon.json` stays, so sessions that are still
running are not locked out by a reinstall.

Re-running the installer after moving the checkout is required: the launcher, the plist and
the headers helper all hold absolute paths. A re-run replaces each registration in place,
so the new path takes over instead of being refused as a duplicate.

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

### Linux: a headless Edge on a machine with no display

On Linux the same `node bin/install.js` plans for systemd instead of launchd, and runs
Edge itself, since there is nobody at a screen to click **Load unpacked**:

- The runtime directory is `$XDG_STATE_HOME/browser-bridge`, or
  `~/.local/state/browser-bridge` (`BROWSER_BRIDGE_RUNTIME_DIR` still wins). It holds the
  launcher, `daemon.json`, `bridge.sock`, `host.log`, `daemon.log`, `edge.log` and the Edge
  profile, `edge-profile/`.
- The native messaging manifest goes to `~/.config/microsoft-edge/NativeMessagingHosts/`,
  and a second copy to `<profile>/NativeMessagingHosts/`, which is where a profile started
  with `--user-data-dir` looks. `--user-data-dir <dir>` picks another profile.
- Two systemd user units in `~/.config/systemd/user/`:
  `browser-bridge-daemon.service` runs `mcp/daemon.js`, and `browser-bridge-edge.service`
  (after the daemon) runs `bin/headless-edge.js`. The installer runs
  `systemctl --user daemon-reload`, then `enable --now` for a new unit or `restart` for an
  existing one. The units only outlive a logout with lingering on
  (`loginctl enable-linger $USER`).
- `bin/headless-edge.js` starts `microsoft-edge --headless=new` on the profile with
  `--remote-debugging-pipe --enable-unsafe-extension-debugging`, holds the pipe (fds 3
  and 4, NUL-terminated JSON), sends `Extensions.loadUnpacked` for this checkout's
  `extension/` on every start and logs the id it got back to `edge.log`: it must be
  `goijgcbiphelgdlpjmpepfkihboonjbg`. If Edge exits, the wrapper starts it again with a
  growing backoff; so it does if the load fails or goes 30 s unanswered, since an Edge
  without the extension is no use. SIGTERM takes Edge down with it and stops. The profile
  directory is set to mode 0700 on every start.
- Registration is the same `claude mcp add-json` into every `~/.claude*` config, with this
  machine's node, so any Claude session started afterwards has the `browser` tools.

On a machine with a GPU, `node bin/install.js --gpu` starts that Edge with the flags that
put WebGL on it (ANGLE over EGL; measured with the proprietary NVIDIA driver) instead of
`--disable-gpu`; a later plain re-install keeps that, and `--no-gpu` turns it off. Headless Edge falls back to SwiftShader without complaint when the GPU
path does not come up, so check the result rather than the flags:
`node bin/webgl-probe.js` starts a scratch Edge with the same flags, prints the WebGL
renderer it got and exits 1 if that is SwiftShader, llvmpipe or no WebGL at all
(`--without-gpu-flags` shows what Edge picks on its own). From a session, the same answer
comes from `javascript_tool` reading `WEBGL_debug_renderer_info` on the page under test.

To check it: `systemctl --user status browser-bridge-daemon browser-bridge-edge`,
`curl -s http://127.0.0.1:47331/healthz`, `edge.log` for the extension id, and
`host.log` for `extension ready`. `claude mcp list` should show `browser` connected.

**After a landing, re-run `node bin/install.js` from the checkout the units should run.**
The launcher and both units hold absolute paths (node, the checkout), so an install from a
worktree keeps running the worktree until the installer is run again from the main
checkout.

The profile starts logged out of everything. If a session needs a site login that it
cannot do itself through `form_input`, log the profile in by hand once, over the DevTools
screencast:

```sh
systemctl --user stop browser-bridge-edge
microsoft-edge --headless=new --user-data-dir="$HOME/.local/state/browser-bridge/edge-profile" \
  --remote-debugging-port=9222 https://example.com/login
# from the laptop: ssh -L 9222:127.0.0.1:9222 <node>, then edge://inspect → Configure →
# localhost:9222, and Inspect the tab: the screencast takes clicks and typing.
# When logged in, stop that Edge and:
systemctl --user start browser-bridge-edge
```

Cookies live in the profile, so they survive restarts of the unit. Anything a session can
reach through that profile, every session on the machine can reach.

`--uninstall` disables and removes the units, the launcher and the manifests, but leaves
`edge-profile/` (with its cookies) and the logs (`daemon.log`, `edge.log`, `host.log`) in
the runtime directory; delete them by hand to be rid of them. Nothing rotates `edge.log`:
the wrapper and Edge append to it for as long as the unit runs, so truncate it now and then
on a long-lived node.

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
  the same page and are reset when the main frame navigates. Iframe content is included —
  cross-origin frames through their own debugger session, same-origin ones by frame id —
  spliced in under the iframe element that holds them, and a ref inside one still works
  for clicks, `form_input` and uploads.
- `find` ranks lexically — tokens matched against name, role, value and description, with
  stemming, a synonym table (`basket` finds `cart`, `picker` finds a combobox) and typo
  tolerance. It is a heuristic, not a model, and an exact match always wins.
- `computer` screenshots come back as an MCP image block at viewport CSS size × `scale`,
  and the text block states both the image size and the viewport size. Coordinates are
  always CSS pixels.
- `save_to_disk` writes to `~/Library/Application Support/BrowserBridge/screenshots/` and
  reports the path.
- `file_upload` takes absolute paths on this machine: regular files, one hard link, 10 MB
  total, and a relative path is refused rather than guessed at — the daemon's working
  directory is this checkout, not yours. Nothing is base64'd around.
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
| `BROWSER_BRIDGE_SESSION_NAME` | Names the session and its tab group. Read in the **session's** environment — by `bin/headers.js` for Claude Code, and by Codex itself through `env_http_headers` (Codex does not give the helper an environment). Either way it arrives as `X-Browser-Bridge-Session`. Without it, the daemon names the session after the client that connected (`claude-code #3`). |
| `KEEP_AGENT_ACCOUNT_ID` | The account label the popup and `browser_status` show, on both clients. For Codex it is the *only* source: `env_http_headers` names one variable per header, so there is no fallback there. |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME` | Read by `bin/headers.js` to guess the agent, and the account when `KEEP_AGENT_ACCOUNT_ID` is unset. |
| `BROWSER_BRIDGE_NEW_WINDOW` | Overrides `newWindow` in `config.json` (`1` on, `0` off). Read by the **daemon**, so it applies to every session — which is why the setting itself belongs in `config.json` and not here. |
| `BROWSER_BRIDGE_RUNTIME_DIR` | Moves the socket, logs, `daemon.json`, screenshots and config (the tests use this). |
| `BROWSER_BRIDGE_DAEMON_PORT` | Overrides the port in `daemon.json` (0 picks a free one). |

`~/Library/Application Support/BrowserBridge/config.json`:

```json
{ "blockedHosts": ["admin.example.com", "*.internal.example"], "newWindow": false }
```

`navigate` refuses those hosts before the request reaches the browser. `newWindow` makes
`tabs_context_mcp{createIfEmpty}` open a new window instead of using the last focused one;
it lives here rather than in the environment because one shared daemon has one environment.

The runtime directory also holds `daemon.json` (the port, the token and the key-derivation
secret), `daemon.log`, `sessions.json` (each session's title and when it was last used — no
session ids and no keys, both of which are derived rather than stored), `host.log` and
`screenshots/`. All of it is 0600 in a 0700 directory.

## Troubleshooting

- **The `browser` tools are missing from a session entirely** — the daemon is down or the
  registration is stale. `curl -s http://127.0.0.1:47331/healthz` says whether the daemon
  is up and how many sessions and event streams it holds; `node bin/install.js` fixes both.
- **A tab group is titled after the client (`claude-code #3`) instead of the session** — the
  session name never reached the daemon. Claude Code gets it from
  `BROWSER_BRIDGE_SESSION_NAME` in the session's environment via `bin/headers.js`; Codex
  reads that variable itself through `env_http_headers`, so a Codex home installed before
  that was added needs `node bin/install.js` re-run.
- **The popup lists a session whose agent has exited** — Codex sends `DELETE` on exit; for
  Claude Code the daemon waits until its event stream is gone *and* nothing has been asked for
  ten minutes, so give it that long. (Thirty seconds was the first attempt, and it closed
  sessions whose laptop had merely gone to sleep.) `daemon.log` shows what the daemon thinks
  each session is doing.
- **A session's tools stop working after a restart, or its tabs move to a new group** — they
  should not. An unknown session id is adopted rather than refused, and its tab group is keyed
  by a value derived from the id, so a restart hands back the same group with nothing to look
  up. `daemon.log` says `session adopted` when that happens. The one thing that does move every
  group is `--rotate-token`, because the derivation secret changes with it.
- **The daemon will not stay up** — `~/Library/Application Support/BrowserBridge/daemon.log`
  has one line per session plus the reason it exited. Sessions appear there by name and by an
  eight-character tag, never by their session id: an id plus the secret next to it would derive
  that session's key, so the log does not hold one. `launchctl print gui/$UID/com.keep.browser_bridge.daemon`
  shows what launchd thinks. A port already in use is an exit 1 with the reason.
- **`node bin/install.js` printed `THE DAEMON IS DOWN`** — it tried and could not get the
  job up, and it prints the commands to run by hand. `Bootstrap failed: 5: Input/output
  error` means launchd had not finished removing the old job; the installer polls for that
  now, so if it still happens, wait a few seconds and run it again.
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
