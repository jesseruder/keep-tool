# Session scenario tests

Run `npm run test:scenarios` for named regressions plus 50 seeded sequences per
agent. No live sessions, network, daemon, or registry are used. Fixtures and
ledger/hook files live in a disposable temporary directory. No model calls.

For a larger deterministic run:

```sh
npm run test:scenarios -- --seed 1000 --cases 200
npm run test:scenarios:browser
```

The second command runs the existing isolated browser fixture, now also feeding
it status transitions from the replay harness. It checks real terminal focus,
selection, resizing, navigation, and close behavior. It launches its own browser
profile and fixture server, never attaching to the user's browser or terminal.

## What is tested

The fake clock drives synthetic Claude/Codex transcript records through the real
transcript parsers, durable background-job ledger, hook storage/reconciliation,
conversation policy, attention builder, and frontend ordering/selection helpers.
Named scenarios carry explicit expected states and input-queue membership. These
expectations describe user behavior, not a second copy of the policy algorithm.
Generated episodes vary automated/human turns, schedules, questions, background
jobs, large outputs, cold parser reloads, hook omission/duplication, and elapsed time.
Named scenarios additionally cover late hooks, truncation, subagents, and Claude
cron lifetime. Cron support is deliberately not invented for Codex.

Every event checks closed-session exclusion, attention/state agreement,
running-before-waiting ordering, and stable identity-based selection. Explicit
`expect` events check independent outcomes. A mutation-canary test intentionally
breaks readiness to verify that detection and reduction work.

## Reproducing a failure

Failures print the observed trace (event, state, selected rule and evidence
source), followed by a reduced JSON scenario. Save that JSON and run:

```sh
npm run test:scenarios -- --replay /path/to/failure.json
```

The reducer preserves semantic events (turn starts, completions, scheduling,
process changes) and the failing assertion/expected value, and minimizes removable
perturbations such as hooks, output, clock advances and restarts. Removing a
required completion would manufacture a failure, not reproduce one. The result
is not necessarily the globally shortest explanation. Add the
reduced scenario to `bin/scenarios/cases.js` with a descriptive name before fixing
the production bug. Standard `npm test` also runs the named cases, ten generated
seeds per agent, and the reducer canary via `bin/session-scenarios.test.js`.

## Boundaries

This is not an end-to-end daemon test: registry and process observations are
fixture inputs, and parser outputs are assembled at a test adapter boundary.
`restart` reloads parser caches and reopens persisted ledger/hook state; it does
not restart an OS process. Codex lifecycle events here use normalized shared hook
records, not the native hook transport (covered by `codex-lifecycle.test.js`).
Selection helpers do not establish browser focus correctness; the separate
browser suite does. These tests cannot prove that every future agent transcript
format is supported, and generated inputs are bounded rather than exhaustive.
