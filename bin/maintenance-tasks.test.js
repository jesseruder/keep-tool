const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tasks = require('./maintenance-tasks');

test('companion-jobs answers resolved Codex and Pi lists, not promises', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-companion-jobs-'));
  try {
    const result = await tasks.run('companion-jobs', { root, fallbackCacheMs: 0, processRows: [], psOutput: '' });
    assert.equal(typeof result.codexJobs?.then, 'undefined', 'the Codex list is awaited');
    assert.equal(typeof result.piJobs?.then, 'undefined', 'the Pi list is awaited');
    // Serialized across the process boundary, each keeps its discovery state.
    const wire = JSON.parse(JSON.stringify(result));
    assert.equal(typeof wire.codexJobs.discovery, 'string');
    assert.ok(Array.isArray(wire.codexJobs.jobs));
    assert.ok(Array.isArray(wire.piJobs.jobs));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
