'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const evaluator = require('./review-eval');
const suite = evaluator.loadSuite();
const perfect = () => ({ predictions: suite.cases.map(c => ({ id: c.id, action: c.expected || 'question', rationale: 'Evidence checked.' })) });

test('positive controls defeat silence; unresolved cases do not affect accuracy', () => {
  const p = perfect(), good = evaluator.score(suite, p);
  assert.equal(good.metrics.accuracy, 1);
  assert.equal(good.metrics.unresolved, 1);
  p.predictions.find(p => p.id === 'case-10').action = 'finding';
  assert.equal(evaluator.score(suite, p).metrics.precision, 1);
  const silent = evaluator.score(suite, { predictions: p.predictions.map(p => ({ ...p, action: 'quiet' })) });
  assert.equal(silent.metrics.missedIssues, 3);
  assert.equal(silent.metrics.recall, 0);
  assert.equal(silent.metrics.precision, null);
});

test('accusations and repetitions are counted separately from question wording', () => {
  const p = perfect();
  for (const id of ['case-03', 'case-07']) p.predictions.find(p => p.id === id).action = 'finding';
  p.predictions.find(p => p.id === 'case-08').action = 'question';
  const report = evaluator.score(suite, p);
  assert.equal(report.metrics.falseAlarms, 2);
  assert.equal(report.metrics.repeatedFindings, 1);
  assert.equal(report.metrics.repeatedReports, 2);
  assert.equal(report.metrics.mismatches, 3);
});

test('missing responses are incomplete, not clean; duplicate, extra and malformed predictions fail', () => {
  const p = perfect(); p.predictions.pop();
  const report = evaluator.score(suite, p);
  assert.equal(report.complete, false);
  assert.equal(report.metrics.missing, 1);
  assert.equal(report.metrics.accuracy, null);
  assert.equal(report.metrics.precision, null);
  assert.throws(() => evaluator.score(suite, { predictions: [...p.predictions, p.predictions[0]] }), /duplicate/);
  assert.throws(() => evaluator.score(suite, { predictions: [{ id: 'extra', action: 'quiet', rationale: 'x' }] }), /unknown/);
  assert.throws(() => evaluator.score(suite, { predictions: [{ id: 'case-01', action: 'quiet' }] }), /rationale/);
  assert.throws(() => evaluator.score(suite, { ...perfect(), suiteHash: 'wrong' }), /hash/);
});

test('comparison recomputes scores and refuses different or incomplete suites', () => {
  const baseline = evaluator.score(suite, perfect());
  baseline.metrics.falseAlarms = 100;
  const p = perfect(); p.predictions[1].action = 'finding';
  const current = evaluator.score(suite, p);
  assert.equal(evaluator.compare(suite, current, baseline).delta.falseAlarms, 1);
  assert.deepEqual(evaluator.compare(suite, current, baseline).changes, [{ id: 'case-02', before: 'quiet', after: 'finding', expected: 'quiet' }]);
  assert.throws(() => evaluator.compare(suite, current, { ...baseline, suiteHash: 'old' }), /same suite/);
  assert.throws(() => evaluator.compare(suite, current, { ...baseline, predictions: [] }), /complete/);
});

test('candidate prompt hides labels, rationales and provenance; invocation disables tools and session writes', () => {
  const prompt = evaluator.promptFor(suite, 'Candidate skill');
  assert.match(prompt, /Candidate skill/);
  for (const c of suite.cases) {
    assert.ok(!prompt.includes(c.reason));
    assert.ok(!prompt.includes(c.source));
  }
  assert.ok(!prompt.includes('"expected"'));
  const call = evaluator.invocation(prompt, 'candidate-model', '/tmp/eval', { KEEP_TASK: 'live', KEEP_REVIEWER: '1', CODEX_THREAD_ID: 'live' });
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  assert.ok(call.args.includes('--safe-mode'));
  assert.ok(call.args.includes('--strict-mcp-config'));
  assert.ok(call.args.includes('--no-session-persistence'));
  assert.equal(call.options.env.KEEP_TASK, undefined);
  assert.equal(call.options.env.KEEP_REVIEWER, undefined);
  assert.equal(call.options.timeout, 300000);
});

test('CLI scores poor candidates successfully without touching registry; model subprocess smoke uses isolated fake CLI', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-eval-test-'));
  try {
    const input = path.join(dir, 'predictions.json');
    fs.writeFileSync(input, JSON.stringify({ predictions: perfect().predictions.map(p => ({ ...p, action: 'finding' })) }));
    const registry = path.join(dir, 'absent-registry');
    const env = { ...process.env, KEEP_DIR: registry };
    const cli = args => spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'review-eval', ...args], { env, encoding: 'utf8' });
    const result = cli(['--predictions', input, '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout).metrics.falseAlarms > 0);
    assert.equal(fs.existsSync(registry), false);
    const fake = path.join(dir, 'fake-claude');
    fs.writeFileSync(fake, '#!/usr/bin/env node\nprocess.stdout.write(' + JSON.stringify(JSON.stringify(perfect())) + ');\n', { mode: 0o755 });
    env.KEEP_CLAUDE = fake;
    const run = cli(['--run', '--json']);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.metrics.accuracy, 1);
    assert.equal(report.run.model, 'fable');
    assert.match(report.run.promptHash, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(registry), false);
    assert.notEqual(cli(['--run', '--predictions', input]).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
