# Desktop interaction QA

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
