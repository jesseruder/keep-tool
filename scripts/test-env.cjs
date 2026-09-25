'use strict';

// Node's test runner executes each test file in a child with this marker. Give
// every child its own empty registry before application modules can load the
// operator's Keep configuration into process.env. Fixture CLIs may still pass
// their own KEEP_DIR or KEEP_CONFIG explicitly; tests that care about an account or
// pane set it in their own env object.
if (process.env.NODE_TEST_CONTEXT) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-node-test-'));

  // An agent pane inherits the operator's whole Keep environment: its config's env
  // block, features, scopes, placement, the pane and account it runs as, and on a
  // non-daemon node that node's identity, daemon address and live host socket. Any of
  // it changes what a fixture CLI does (a registry write sent to the real daemon, a
  // feature switched off), so the suite starts from none of it. KEEP_TEST_* knobs and
  // the browser-suite controls below are the caller's to pass through. A child forked by a test runs this preload again
  // (fork keeps execArgv) with the KEEP_* env its test gave it, so the sweep runs
  // once, in the test file's own process.
  const callerControls = new Set(['KEEP_BROWSER_TEST', 'KEEP_CHROME', 'KEEP_SHOT_DIR']);
  if (!process.env.KEEP_TEST_ENV_SCRUBBED) {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('KEEP_') && !name.startsWith('KEEP_TEST_') && !callerControls.has(name)) delete process.env[name];
    }
    process.env.KEEP_TEST_ENV_SCRUBBED = '1';
  }
  process.env.KEEP_DIR = root;
  process.env.KEEP_NO_PUSH = '1';
  // Timeout diagnostics sample swap out of band with sysctl. A suite of a few hundred
  // test processes has no use for that reading and every reason not to spawn for it.
  process.env.KEEP_PRESSURE_SWAP = '0';
  // A daemon under test must never switch the operator's desktop reminders.
  process.env.KEEP_REMINDERS_CONFIG = path.join(root, 'reminders.config.json');
  process.env.KEEP_REMINDERS_STATE = path.join(root, 'reminders-state.json');
  process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }));
}
