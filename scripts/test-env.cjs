'use strict';

// Node's test runner executes each test file in a child with this marker. Give
// every child its own empty registry before application modules can load the
// operator's Keep configuration into process.env. Fixture CLIs may still pass
// their own KEEP_DIR or KEEP_CONFIG explicitly.
if (process.env.NODE_TEST_CONTEXT) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-node-test-'));

  process.env.KEEP_DIR = root;
  delete process.env.KEEP_CONFIG;
  process.env.KEEP_NO_PUSH = '1';

  process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }));
}
