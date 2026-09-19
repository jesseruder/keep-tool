# Desktop interaction QA

## Request isolation

`keep serve` gives the public TCP listener to a supervised child process. That
process serves `/app`, allowlisted `/vendor` files, SSE, terminal WebSocket
upgrades, layouts, portable-transfer summaries, and every `/api/state` projection —
full, `console=1`, and the mobile `view=<name>` views — from its last completed
publication. Nothing is served at `/`; it answers 404. The daemon keeps action ordering, injection
locks, restart admission, and every authoritative mutation behind a mode-0600 Unix
socket. The frontend authenticates the real public peer and Host before forwarding
a request, strips forwarded identity headers, and uses a private per-process token
for the Unix hop. It never retries writes.

A request is authorized by loopback with a loopback `Host`, by `x-keep-token`, or
— at the frontend worker only — by a browser session. Sessions exist for shells
that can set headers on a top-level navigation only: a phone WebView cannot set
one on the page's own scripts, styles, fetches, EventSource or WebSocket.
`GET /app?token=<token>` is the one place a token becomes a session. A matching
token answers `302` to `/app` with `Set-Cookie: keep-session=<32 random bytes,
base64url>; Max-Age=400d; Path=/; HttpOnly; SameSite=Strict` and `cache-control:
no-store`, and never echoes the token into a body or a log. There is no `Secure`:
this is private-network HTTP. A wrong token falls through to the ordinary ladder,
which is a `403` for anyone who could not already reach the console.

The cookie is an opaque id, never the daemon token, because cookies are not
isolated by port: a token cookie would be handed to every other service on the
Mac, and any of them could replay it as `x-keep-token`. The worker keeps at most
32 sessions in memory as `{createdAt, lastSeenAt, host}`, evicting the oldest,
and accepts one only when the request `Host` equals the host it was issued for.
Nothing is written to disk and sessions die with the worker process; the app
notices through the `unauthorized` message below and re-runs its bootstrap.

For the same reason a session is not general authority: a page on another port of
this host is *same-site*, so `SameSite=Strict` does not stop it from sending the
cookie here. A session-authorized request must carry `x-keep: 1` for everything
except `GET` of `/app`, `/app/*`, `/vendor/*`, `/api/events`, and the pane socket
upgrade — the requests the browser itself issues. That header is the whole
cross-site barrier: a hostile page cannot add it without a CORS preflight, and
there is no `access-control-allow-origin` anywhere in this tree. It has to carry
the barrier alone, because the body readers parse JSON whatever the content type
claims. Loopback and header-token clients are unaffected by the rule. The
frontend strips `Cookie` along with the other forwarded identity headers before
the Unix hop, so the daemon authorizes that hop by its private token alone and
its own `authorized()` knows nothing about cookies.

A pane socket upgrade needs that same authorization plus an origin rule:
an `Origin` whose host equals the request's `Host` — any host, so the console
page works on loopback and on the Mac's LAN address alike — or no `Origin` at all
together with a valid `x-keep-token`, which is a native client. A browser always
sends `Origin` on a WebSocket handshake, so a cookie with no `Origin` is not a
browser and is refused. `bin/console.js` owns the predicate
(`upgradeOriginAllowed`) and both the daemon and the frontend worker use it;
`sameOrigin` still means loopback only.

State production runs on invalidation and a 30-second cadence. Refreshes coalesce
to one active build and one follow-up; a failed build leaves the last valid state in
place. Before the first real publication, cached routes return bounded `503` loading
responses. Successful writes receive a daemon-epoch mutation fence. State and
portable-transfer reads wait silently for a publication carrying that fence, which
keeps immediate post-action reloads coherent without making ordinary reads depend
on the daemon event loop. `x-keep-state-generated-at`, `x-keep-state-version`, and
`x-keep-mutation-fence` expose the publication age and boundary.

The console reloads on a delta channel rather than refetching its whole projection
(780 KB raw, 178 KB gzipped) eight times a minute. `console=1&delta=1` answers an envelope (plain `console=1` still answers the bare
projection, so a console tab running code from before the channel keeps working
across a daemon restart):
`{ instance, version, full }` when it has to send the projection, `{ instance,
version, since, deltas }` when the console named a snapshot it can chain from with
`&since=<instance>:<version>`. The worker keeps the last 30 publications' deltas in
a ring (`KEEP_STATE_DELTA_HISTORY`) and diffs each publication against the previous
one with the two-level keyed diff in `web/app/shared/state-delta.js`: a fixed table
of keyed lists (tasks, sessions, panes, notifications, accounts, handoffs, agents,
`reviewQueue.items`, `health.schedulers`, `limitResume.waiting`/`.sent`) sends the
rows that changed, everything else is a wholesale field. It falls back to the full
projection whenever it cannot name the chain — another worker's instance, or a
version the ring no longer holds. A version sequence that stops increasing, and a
state object published twice (which a publication must never be: `consoleState`
passes fields through by reference, so an in-place edit is invisible to the diff),
both rename the chain as well, so a stale console cannot be served a delta that
means something else. A chain that grew longer than the projection it replaces is
answered with the projection instead. The console drops its cached snapshot and
reloads once whenever a delta will not apply or its last full projection is over
30 minutes old, and treats a response with neither `full` nor `deltas` as a plain
projection, which is what the browser fixtures and the daemon's own
`/api/state` serve. `view=` and
the full projection are unchanged and ignore `since`; ETag, gzip, `304`, and the
post-mutation fence apply to the envelope exactly as before.

The focused isolation test deliberately blocks the daemon fixture for 10.5 seconds:

```sh
node --require ./scripts/test-env.cjs --test bin/ui-request-worker.test.js
```

It requires cached state, app/vendor assets, layouts, portable transfers, and
an SSE heartbeat to respond in under one second. The same test covers one-shot
action proxying and frontend-worker replacement with retained-state republish.

Keep Desktop loads the web console in a Tauri WebKit window. Test the production
frontend against the isolated backend in `tests/ui/fixture.cjs`: it creates a
disposable temporary project, 12 fake sessions, and WebSocket terminals that echo
and record dummy input. It never launches an agent, connects to `keep serve`, or
reads the work registry. Unsupported API actions fail visibly.

## Repeatable tests

```sh
npm ci
npx playwright install chromium webkit
npm run test:ui
```

Each test gets a fresh server on an OS-assigned loopback port and a fresh browser
context. Requests outside the fixture origin are blocked. There are no model calls.
The older browser/lifecycle suite remains available as
`npm run test:reliability:browser`; the close-state unit tests also run in `npm test`.

Tests use real browser pointer input, including explicit mouse-down, a backend
update, and mouse-up at the original coordinates. They check the resulting session
and terminal IDs, and the actual destination of typed bytes. This avoids both DOM
`.click()` shortcuts and locator retries hiding a row-movement race. Normal clicks
are still used for navigation outside the deliberate race.

Coverage includes moving session rows, changing attention sections, project/group
controls, rapid switching with output churn, drag cancellation, seeded timing
sequences, and Close from Triage, Watch and Fleet. Close tests require disappearance
within a 100 ms assertion window while the backend remains alive for 1.8 seconds,
then verify stale-update suppression and failure rollback. This is a regression
budget, not a hardware-independent latency guarantee. Unpin failure is reported
separately from process-close failure.

Failures retain a Playwright trace, screenshot and fixture event log under
`test-results/ui/`. Open the printed trace path with:

```sh
npx playwright show-trace test-results/ui/<failed-test>/trace.zip
npm run test:ui -- --project=webkit --grep 'seed 17'
```

The seeded tests are deterministic and their names carry the replay seed. Add a
focused case for every new confirmed interaction bug, including its backend timing,
before fixing it. A trace records pointer positions, DOM and requests; the fixture
log supplies input destination and state transitions.

## Exploratory clicking

```sh
npm run ui:sandbox
```

Use the printed `/app` URL in a fresh browser tab. `/__fixture` has Start/Stop
updates controls. `/__fixture/events` returns the bounded event log. The fixture
controls API can configure failure scenarios:

```sh
curl -H 'Content-Type: application/json' -d '{"closeDelay":1200,"closeFails":true}' \
  http://127.0.0.1:<printed-port>/__fixture/control
```

`churn`, `closeDelay`, `closeFails`, `layoutFails`, and `id`/`patch` are supported.
The data is synthetic; type only dummy input because the fixture records it.
Stopping the process deletes the temporary project and closes the fake terminals.

Delegate exploratory clicking to the cheaper agent (Luna was used for this change).
Give it only the sandbox URL, the task sequence and an output path; do not send it
to the production console. Ask it to select and type into different sessions while
updates run, scroll/collapse groups, change views, and close sessions with both
success and failure configured. Require exact actions, expected/observed identity,
and fixture input evidence for any finding. Screenshots sampled seconds apart
cannot establish subsecond Close latency; use the regression test for that.
Exploration reports belong in ignored `test-results/`, with confirmed failures
promoted into committed tests. No unattended paid agent loop is installed.

## Native shell

```sh
npm --prefix desktop ci
npm run ui:sandbox:desktop
```

This builds/runs the existing Tauri shell with a separate app identifier and a
window pointing directly at the fake backend. It bypasses the production launcher
and its port 7777. The random fixture origin also isolates browser storage. The
native notification/clipboard capabilities remain restricted to the production
origin; the sandbox does not exercise those integrations. Quit the sandbox to stop
its fixture. Rust and the macOS build toolchain are required.

The implementation run verified native startup and fake terminal attachment via
fixture events. Automated pointer tests ran in Chromium and Playwright WebKit,
which is not the exact system WKWebView. Native pointer automation was unavailable
in the agent environment; use the native sandbox for window-focus, trackpad and
other shell-specific interaction checks.

## Production diagnostics

The existing bounded `/api/ui-debug` log now includes pointer-down/up/cancel and
click events, row identity and pointer coordinates, alongside selection and terminal
identity. It omits typed text, key values, titles and DOM contents, keeps at most
1,000 events, and expires them after an hour. This distinguishes a lost click from
selection/focus being redirected after a valid click.
