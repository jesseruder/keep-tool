# Daemon synchronous-work policy

`keep serve` handles HTTP requests and periodic jobs on one Node event loop. A
synchronous filesystem call, synchronous subprocess, or `Atomics.wait` stops all
of them until it returns. `bin/daemon-sync-guard.test.js` prevents that class of
work from growing while the remaining legacy sites are moved to workers or async
APIs.

The guard parses CommonJS with Acorn. It starts at `bin/serve.js`'s `start()`,
maps the `ctx` object into the route and scheduler factories, and follows local
function calls, static `require` imports, destructured imports, aliases, object
properties, and reexports. Functions created inside a reached factory are treated
as reachable callbacks. Only an actual `Worker`/process launch is an execution
boundary. A file named `*-worker.js` that is directly required and called is still
followed as main-thread code, so a worker-looking filename cannot bypass the guard.

The debt file is deliberately explicit. Each direct sink records its lexical
function, operation, exact count, and a reason that classifies it as subprocess,
lock/backoff, state mutation, metadata, or read/scan debt. Every call edge leading
to blocking code is also recorded with an exact count. Consequently all of these
fail the test:

- adding a direct sync operation, including through an alias;
- making a route or scheduler call a blocking helper that already existed;
- adding another invocation of an already-reached blocking helper; and
- leaving a removed sink, edge, or unresolved computed call in the debt file.

The manifest is a ratchet, not evidence that the daemon is nonblocking. The graph
is branch-insensitive: a function can remain syntactically reachable even when the
production daemon injects a worker implementation and only a test or CLI takes its
synchronous fallback. Therefore a listed path is conservative static evidence,
not proof that production selects that branch. Each entry is still code capable
of holding the event loop if later wiring selects it. A manifest diff that adds
debt needs the same scrutiny as the code that caused it; regenerating the file is
not a fix.

`wt land` enforces the ratchet for `keep-tool` after rebasing onto the current
`origin/main` and immediately before it pushes. This closes the interval where an
upstream commit could add blocking work after a session ran its tests. The gate
runs only the standalone checker, not the test suite, and never regenerates the
manifest:

```sh
node scripts/daemon-sync-policy.cjs --check
```

A failed check refuses the push and leaves the rebased worktree available for a
fix. Other repositories do not run this Keep-specific policy. `wt land --no-push`
also skips the gate because it cannot update the remote; a later pushing
`wt land` checks the then-current rebased tree.

This is static analysis, with deliberate conservative choices. A callback defined
inside a reached factory is counted even when a runtime option may disable it.
The analyzer cannot prove targets selected through runtime mutation, injected
objects other than the daemon's `ctx`, dynamic `require`, or arbitrary computed
properties. A newly reached computed call fails closed. The few existing computed
dispatches are exact-count debt with reasons in the manifest. Code should use a
static import/property or a worker boundary instead of expanding those exceptions.

To inspect the current high-risk paths without changing the debt file:

```sh
node - <<'NODE'
const policy = require('./scripts/daemon-sync-policy.cjs');
const result = policy.createAnalyzer(process.cwd()).run();
for (const sink of result.sinkPaths) {
  console.log(`${sink.operation} x${sink.count}\n  ${sink.path.join('\n  -> ')}`);
}
NODE
```

When an intentional migration removes debt, regenerate the mechanical manifest,
review its deletion-only diff, and run the guard. Additions require a specific
design review and a real reason; do not describe a new sync call as legacy debt.

```sh
node - <<'NODE'
const fs = require('node:fs');
const policy = require('./scripts/daemon-sync-policy.cjs');
const analysis = policy.createAnalyzer(process.cwd()).run();
fs.writeFileSync('bin/daemon-sync-debt.json',
  `${JSON.stringify(policy.manifestFrom(analysis), null, 2)}\n`);
console.log({ sinks: analysis.sinks.length, edges: analysis.edges.length,
  unresolved: analysis.unresolved.length, reachable: analysis.reachable.length });
NODE
KEEP_TEST_CONCURRENCY=1 node scripts/test-runner.cjs bin/daemon-sync-guard.test.js
```
