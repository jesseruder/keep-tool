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
      encoding: 'utf8', env: { ...process.env, KEEP_DIR: tmp, CLAUDE_CODE_ENTRYPOINT: 'cli', KEEP_RUN: '' }, input: JSON.stringify({ cwd: tmp }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /daemon handles due delivery; inspect before duplicating/);
    assert.match(r.stdout, /read the shared keep skill/);
    assert.match(r.stdout, /--handoff needs-input/);
    assert.doesNotMatch(r.stdout, /Conventions: \/keep|run its check recipe/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test('startup context lists only this project\'s overdue checks and stays silent in headless sessions', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'keep-guidance-scope-'));
  const other = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'keep-guidance-other-'));
  try {
    fs.mkdirSync(path.join(tmp, 'tasks'));
    fs.writeFileSync(path.join(tmp, 'tasks/here.md'), `---\ntitle: Here check\nstatus: waiting\nproject: ${tmp}\ncheck_after: 2000-01-01\n---\n`);
    fs.writeFileSync(path.join(tmp, 'tasks/elsewhere.md'), `---\ntitle: Elsewhere check\nstatus: waiting\nproject: ${other}\ncheck_after: 2000-01-01\n---\n`);
    const run = (env) => spawnSync(process.execPath, [path.join(root, 'bin/keep.js'), 'hook', 'session-start'], {
      encoding: 'utf8', env: { ...process.env, KEEP_DIR: tmp, KEEP_RUN: '', CLAUDE_CODE_ENTRYPOINT: 'cli', ...env },
      input: JSON.stringify({ session_id: 'scope-session', cwd: tmp }),
    });
    const interactive = run({});
    assert.equal(interactive.status, 0, interactive.stderr);
    assert.match(interactive.stdout, /Overdue checks \(1\):\n- here: "Here check"/);
    assert.doesNotMatch(interactive.stdout, /Elsewhere check/);
    assert.match(interactive.stdout, /1 overdue check\(s\) in other projects \(keep overdue\)/);
    for (const env of [{ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }, { KEEP_RUN: '1' }]) {
      const headless = run(env);
      assert.equal(headless.status, 0, headless.stderr);
      assert.equal(headless.stdout, '', JSON.stringify(env));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});
test('agent-facing scheduling contract is present in skill, README, and CLI help', (t) => {
  const keepRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'keep-guidance-help-'));
  fs.mkdirSync(path.join(keepRoot, 'tasks'));
  t.after(() => fs.rmSync(keepRoot, { recursive: true, force: true }));
  for (const file of ['skills/keep/SKILL.md', 'README.md', 'docs/session-reliability.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(text, /--handoff needs-input/, file);
    assert.match(text, /turn-scoped/, file);
  }
  for (const args of [['help'], ['checkin', '--help']]) {
    const r = spawnSync(process.execPath, [path.join(root, 'bin/keep.js'), ...args], {
      encoding: 'utf8', env: { ...process.env, KEEP_DIR: keepRoot },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /--handoff waiting\|needs-input/);
    assert.match(r.stdout, /--check "recipe"/);
  }
  assert.equal(require('./health').CADENCES.runs.cadenceMs, 60000);
  assert.match(fs.readFileSync(path.join(root, 'skills/keep/SKILL.md'), 'utf8'), /polls due recipes every minute/);
});
