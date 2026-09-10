'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const quality = require('./review-quality');

test('observations need references and verification; uncertain claims cannot interrupt', () => {
  assert.equal(quality.assessment({}).basis, 'needs-verification');
  assert.throws(() => quality.assessment({ basis: 'observed', evidence: 'a delta' }), /what was checked/);
  assert.throws(() => quality.assessment({ basis: 'certain' }), /basis/);
  assert.equal(quality.canInterrupt({ basis: 'inferred', evidence: 'e', checked: 'c' }), false);
  assert.equal(quality.canInterrupt({ basis: 'observed', evidence: 'e', checked: 'c' }), true);
  assert.equal(quality.canInterrupt({ basis: 'observed', evidence: 'e', checked: 'c', outcome: { status: 'incorrect' } }), false);
});

test('outcomes require explicit evidence, preserve ownership, appear in stats and bundles, and retain corrections', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-outcome-')));
  const cli = path.join(__dirname, 'keep.js');
  const env = { ...process.env, KEEP_DIR: root, KEEP_ALLOW_PUSH: '0', CODEX_THREAD_ID: 'work-owner',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' };
  delete env.KEEP_REVIEWER; delete env.KEEP_REVIEWER_NAME; delete env.CLAUDE_CODE_SESSION_ID;
  const run = (args, extra = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' });
  const ok = (args, extra) => { const r = run(args, extra); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const stateFile = path.join(root, '.keep', 'review', 'outcome-fixture.json');
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  try {
    for (const dir of ['tasks', 'archive', 'digests', 'reviews']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    spawnSync('git', ['init', '-q', root]);
    ok(['add', 'Outcome fixture', '--status', 'active', '--project', root, '-m', 'Started.']);
    const note = ['review-note', 'outcome-fixture', '--kind', 'no-tests', '--subject', 'unit test', '--severity', 'low', '-m', 'No tests in this delta.'];
    const key = ok(note).match(/finding ([a-f0-9]{16})/)[1];
    assert.equal(state().findings[key].basis, 'needs-verification');
    assert.equal(JSON.parse(ok(['review-outcome', 'outcome-fixture', '--json']))[0].outcome.status, 'unresolved');
    const invalid = run([...note, '--basis', 'observed', '--evidence', 'delta']);
    assert.notEqual(invalid.status, 0);
    const upgradedBundle = ok(['review-bundle', 'outcome-fixture', '--force']);
    const bundleId = upgradedBundle.match(/bundle: ([0-9a-f]{8})/)[1];
    const document = { notes: [{ id: 'outcome-fixture', bundle: bundleId, kind: 'no-tests', subject: 'unit test', severity: 'low', message: 'Verified no test exists.', basis: 'observed', evidence: 'repository test inventory', checked: 'Inspected parent verification and test files' }] };
    const docFile = path.join(root, 'landing.json'); fs.writeFileSync(docFile, JSON.stringify(document));
    ok(['review-land', '--file', docFile]);
    assert.equal(state().findings[key].basis, 'observed', 'a verified follow-up bypasses repeat suppression');
    assert.equal(state().findings[key].checked, document.notes[0].checked);
    const before = fs.readFileSync(stateFile, 'utf8');
    assert.notEqual(run(['review-outcome', 'outcome-fixture', key, 'fixed', '-m', 'fixed']).status, 0);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
    ok(['review-outcome', 'outcome-fixture', key, 'fixed', '-m', 'Added test coverage.', '--evidence', 'commit abc1234; passing suite'], { CODEX_THREAD_ID: 'curator' });
    assert.equal(state().findings[key].outcome.status, 'fixed');
    const card = require('./keep.js').parseTask(fs.readFileSync(path.join(root, 'tasks', 'outcome-fixture.md'), 'utf8'), 'outcome-fixture');
    assert.equal(card.fm.status, 'active');
    assert.deepEqual(card.fm.sessions.map(s => s.id), ['work-owner']);
    assert.match(card.body, /review outcome/);
    const stats = spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(path.join(__dirname, 'review.js'))}).reviewStats().outcomes))`], { env, encoding: 'utf8' });
    assert.equal(JSON.parse(stats.stdout).fixed, 1);
    ok(['review-outcome', 'outcome-fixture', key, 'incorrect', '-m', 'The parent already ran the suite.', '--evidence', 'parent check-in 2026-09-10T10:00']);
    assert.equal(state().findings[key].outcomeHistory[0].status, 'fixed');
    const unchanged = fs.readFileSync(stateFile, 'utf8');
    assert.notEqual(run(['review-outcome', 'outcome-fixture', key, 'unresolved', '-m', 'reopen', '--evidence', 'new reference'], { KEEP_REVIEWER: '1' }).status, 0);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), unchanged);
    assert.equal(run([...note, '--force']).status, 4, 'incorrect findings cannot be re-raised by force');
    const bundle = ok(['review-bundle', 'outcome-fixture', '--force']);
    assert.match(bundle, /Prior corrected findings/);
    assert.match(bundle, /The parent already ran the suite/);
    assert.match(bundle, /Evidence limits: this bundle is a delta/);
    assert.match(bundle, /incorrect/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
