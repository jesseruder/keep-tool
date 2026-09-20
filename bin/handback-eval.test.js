'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const evaluator = require('./handback-eval');
const suite = evaluator.loadSuite();

test('nothing in the watcher requires this module', () => {
  // The whole guarantee of an offline evaluation is that it cannot act. If a
  // runtime path ever pulls it in, this is the test that says so.
  for (const file of ['turn-watcher.js', 'watcher-live.js', 'serve.js']) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.equal(/require\(['"]\.\/handback-eval/.test(source), false, `${file} requires the evaluation module`);
  }
});

test('an ask for an executable step the session could have run is a handback', () => {
  const cases = [
    'The fix is on origin/master. From the original directory, run `git -C ~/keep-tool pull --ff-only` and then `keep restart-daemon`.',
    'The worktree is still at ~/wt/keep-tool/thing; you can `wt rm thing` whenever you like.',
    'Please run the full suite before we land.',
    'I committed the change. You will need to push it yourself with `git push`.',
  ];
  for (const text of cases) assert.equal(evaluator.detect(text).handback, true, text);
});

test('a session naming its own next step is never a handback', () => {
  // The single most common healthy shape in the index. A rule that reads these
  // as hand-offs would fire on the turns that are working correctly.
  const cases = [
    'Everything is committed. Next, I will run the browser suite and report back.',
    'Next: run `npm test` once the fixture lands — I am doing that now.',
    'I will restart the daemon after the land finishes.',
    'Remaining: rerun `keep doctor` — I have it queued.',
  ];
  for (const text of cases) assert.equal(evaluator.detect(text).handback, false, text);
});

test('justified asks are carved out by class', () => {
  const carved = [
    ['credential', 'I cannot continue without a fresh token. Please run `heroku login` in a real terminal and paste the result.'],
    ['physical', 'The Pixel is asleep. Please unlock the phone and run `adb devices` on your side to confirm.'],
    ['confirm-gated', 'The branch diverged. Please run `git push --force-with-lease` if you agree.'],
    ['offer', 'I can run the migration now, or you can run `npm run migrate` yourself — say the word.'],
    ['informational', 'For reference, you can run `keep restart-daemon` any time; I already ran it after landing.'],
  ];
  for (const [carve, text] of carved) {
    const result = evaluator.detect(text);
    assert.equal(result.handback, false, text);
    assert.match(result.reason, new RegExp(carve));
  }
});

test('the session\'s own account of being blocked does not excuse the hand-off', () => {
  // Every corroborated hand-off in the sampled week came with one of these
  // sentences, and Owner rejected three of them in writing. Only the subject
  // matter carves a case out — a credential, a device, a gated action — never
  // the turn's own claim about its permissions.
  const excused = [
    'My permission guard will not let me pull the main checkout, so please run `git -C ~/keep-tool pull --ff-only`.',
    'That is yours to run, since I cannot touch the checkout from here: `git -C ~/keep-tool pull --ff-only && keep restart-daemon`',
  ];
  for (const text of excused) assert.equal(evaluator.detect(text).handback, true, text);
  // …while the subject matter still carves out the ones that are really blocked.
  const blocked = 'I cannot continue without a one-time code. Please run `npm run publish-packages` once you have it.';
  assert.equal(evaluator.detect(blocked).handback, false);
});

test('only the closing text decides, and relayed lines are not this turn\'s ask', () => {
  const buried = `${'Please run `npm test` on your side.'}${'x'.repeat(evaluator.TAIL_CHARS + 50)}`;
  assert.equal(evaluator.detect(buried).handback, false);
  const quoted = '> please run `npm test` when you can\n\nThat was the other session talking; I have already run it.';
  assert.equal(evaluator.detect(quoted).handback, false);
});

test('an ask with no executable referent is not a handback', () => {
  // "have a look when you get a chance" is a request, but not one that names
  // work the session could have done instead.
  assert.equal(evaluator.detect('Have a look at the design when you get a chance and tell me what you think.').handback, false);
  assert.equal(evaluator.detect('Which transport would you prefer, delta or full refetch?').handback, false);
});

test('the suite is labeled, redacted, and scores itself', () => {
  assert.ok(suite.cases.length >= 30, 'suite should be large enough to measure a rate');
  for (const item of suite.cases) {
    assert.ok(!/\/Users\/[a-z]/i.test(item.text), `${item.id} carries a home path`);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/i.test(item.text), `${item.id} carries a session id`);
  }
  const report = evaluator.score(suite);
  assert.equal(report.metrics.cases, suite.cases.length);
  assert.equal(report.metrics.truePositives + report.metrics.missed, report.metrics.positives);
  assert.equal(report.metrics.falsePositives + (report.metrics.negatives - report.metrics.falsePositives), report.metrics.negatives);
  assert.ok(report.metrics.precision !== null && report.metrics.recall !== null);
});

test('scoring can be restricted to the held-out set', () => {
  const held = evaluator.score(suite, { set: 'held-out' });
  assert.ok(held.metrics.cases > 0, 'the suite needs held-out cases to measure on');
  assert.ok(held.metrics.cases < suite.cases.length);
  assert.equal(held.rows.every((row) => row.set === 'held-out'), true);
});

test('a suite with an unredacted excerpt or a bad label is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handback-suite-'));
  const write = (cases) => {
    const file = path.join(dir, `${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify({ version: 1, description: 'x', cases }));
    return file;
  };
  const base = { id: 'a', source: 's', class: 'authorized-command', text: 'please run `npm test`', reason: 'r', expected: 'handback' };
  assert.doesNotThrow(() => evaluator.loadSuite(write([base])));
  assert.throws(() => evaluator.loadSuite(write([{ ...base, expected: 'maybe' }])), /handback or ok/);
  assert.throws(() => evaluator.loadSuite(write([{ ...base, text: 'run it in /Users/someone/repo' }])), /unredacted/);
  assert.throws(() => evaluator.loadSuite(write([{ ...base, text: 'session 1a2b3c4d-1111-2222 asked' }])), /unredacted/);
  assert.throws(() => evaluator.loadSuite(write([base, base])), /unique/);
  fs.rmSync(dir, { recursive: true, force: true });
});
