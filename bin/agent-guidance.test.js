'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
test('startup context points both agents at the shared skill without duplicating scheduled work', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'keep-guidance-'));
  try {
    fs.mkdirSync(path.join(tmp, 'tasks'));
    fs.writeFileSync(path.join(tmp, 'tasks/probe.md'), `---\ntitle: Probe\nstatus: waiting\nproject: ${tmp}\ncheck_after: 2000-01-01\ncheck: Read-only fixture\n---\n`);
    const r = spawnSync(process.execPath, [path.join(root, 'bin/keep.js'), 'hook', 'session-start'], {
      encoding: 'utf8', env: { ...process.env, KEEP_DIR: tmp }, input: JSON.stringify({ cwd: tmp }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /daemon handles due delivery; inspect before duplicating/);
    assert.match(r.stdout, /read the shared keep skill/);
    assert.match(r.stdout, /--handoff needs-input/);
    assert.doesNotMatch(r.stdout, /Conventions: \/keep|run its check recipe/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test('agent-facing scheduling contract is present in skill, README, and CLI help', () => {
  for (const file of ['skills/keep/SKILL.md', 'README.md', 'docs/session-reliability.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(text, /--handoff needs-input/, file);
    assert.match(text, /turn-scoped/, file);
  }
  for (const args of [['help'], ['checkin', '--help']]) {
    const r = spawnSync(process.execPath, [path.join(root, 'bin/keep.js'), ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /--handoff waiting\|needs-input/);
    assert.match(r.stdout, /--check "recipe"/);
  }
  assert.equal(require('./health').CADENCES.runs.cadenceMs, 60000);
  assert.match(fs.readFileSync(path.join(root, 'skills/keep/SKILL.md'), 'utf8'), /polls due recipes every minute/);
});
