'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('hosted Codex disables decorative effects while preserving arguments and standalone settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-effects-'));
  try {
    const fake = path.join(root, 'codex');
    fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 42\n', { mode: 0o755 });
    const args = ['resume', 'session-id', 'prompt with spaces and $literal'];
    for (const hosted of [false, true]) {
      const env = { ...process.env, KEEP_DIR: root };
      delete env.KEEP_PANE;
      if (hosted) env.KEEP_PANE = 'test-pane';
      const result = spawnSync(path.join(__dirname, 'keep-codex-cli'), [fake, ...args], { env, encoding: 'utf8' });
      assert.equal(result.status, 42);
      assert.deepEqual(result.stdout.trimEnd().split('\n'), [
        ...(hosted ? ['-c', 'tui.animations=false', '-c', 'tui.whimsy=false'] : []), ...args,
      ]);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
