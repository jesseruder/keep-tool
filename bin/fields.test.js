'use strict';

for (const key of Object.keys(process.env)) {
  if (key.startsWith('KEEP_REVIEWER')) delete process.env[key];
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const keep = require('./keep.js');
const { entryFields, logEntries } = require('./review.js');

const CLI = path.join(__dirname, 'keep.js');

function run(command, args, env) {
  return spawnSync(command, args, { encoding: 'utf8', env });
}

function registry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-fields-'));
  const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' };
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID']) delete env[key];
  for (const directory of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  assert.equal(run('git', ['init', '-q', '--initial-branch=main', root], env).status, 0);
  assert.equal(run('git', ['-C', root, 'config', 'user.name', 'Keep Test'], env).status, 0);
  assert.equal(run('git', ['-C', root, 'config', 'user.email', 'keep@example.test'], env).status, 0);
  fs.writeFileSync(path.join(root, 'tasks', 'card.md'), [
    '---',
    'title: Structured card',
    'status: active',
    'kind: task',
    'tags: [personal]',
    'project: ~/keep',
    'created: 2026-09-03',
    'updated: 2026-09-03T09:00',
    '---',
    '',
  ].join('\n'));
  assert.equal(run('git', ['-C', root, 'add', 'tasks/card.md'], env).status, 0);
  assert.equal(run('git', ['-C', root, 'commit', '-q', '-m', 'fixture'], env).status, 0);
  return { root, env };
}

function cli(fixture, args) {
  return run(process.execPath, [CLI, ...args], fixture.env);
}

function newestEntry(fixture) {
  const task = keep.loadTask('card', fixture.root);
  return logEntries(task.body)[0];
}

test('checkin writes normalized trailers in fixed order and entryFields parses them', () => {
  const fixture = registry();
  try {
    const result = cli(fixture, [
      'checkin', 'card', '-m', 'Implemented the feature.', '--next', '  deploy   to\n staging  ',
      '--commit', 'ABCDEF1,123ABCD', '--commit', 'deadbee9',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const entry = newestEntry(fixture);
    assert.equal(entry.text, [
      'Implemented the feature.',
      'next: deploy to staging',
      'commits: abcdef1, 123abcd, deadbee9',
    ].join('\n'));
    assert.deepEqual(entryFields(entry), {
      next: 'deploy to staging',
      commits: ['abcdef1', '123abcd', 'deadbee9'],
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('entryFields ignores next labels in the middle of prose', () => {
  assert.deepEqual(entryFields({ text: 'First line.\nnext: not a trailer\nFinal prose line.' }), {
    next: null,
    commits: [],
  });
});

test('invalid commit values are rejected with exit 2', () => {
  const fixture = registry();
  try {
    const result = cli(fixture, ['checkin', 'card', '-m', 'No mutation.', '--commit', 'not-a-sha']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--commit values must be 7-40 hexadecimal characters/);
    assert.equal(logEntries(keep.loadTask('card', fixture.root).body).length, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('structured-field nudges print only when the matching flag is absent', () => {
  const fixture = registry();
  try {
    const missingCommit = cli(fixture, ['checkin', 'card', '-m', 'Landed as abd3da5.']);
    assert.equal(missingCommit.status, 0, missingCommit.stderr);
    assert.equal(missingCommit.stderr, 'keep: tip — pass --commit <sha> so the landed sweep can track it\n');

    const suppliedCommit = cli(fixture, ['checkin', 'card', '-m', 'Landed as abd3da5.', '--commit', 'abd3da5']);
    assert.equal(suppliedCommit.status, 0, suppliedCommit.stderr);
    assert.equal(suppliedCommit.stderr, '');

    const hexWord = cli(fixture, ['checkin', 'card', '-m', 'The release codename is decade2026.']);
    assert.equal(hexWord.stderr, '', 'a hex-looking word without a commit keyword is not a sha');

    const releasedAs = cli(fixture, ['checkin', 'card', '-m', 'Released as decade2026.']);
    assert.equal(releasedAs.stderr, '', 'generic release prose does not trigger the commit-field tip');

    const digitsOnly = cli(fixture, ['checkin', 'card', '-m', 'Landed as 1234567.']);
    assert.equal(digitsOnly.stderr, '', 'a commit token needs a hexadecimal letter');

    const lettersOnly = cli(fixture, ['checkin', 'card', '-m', 'Landed as abcdefa.']);
    assert.equal(lettersOnly.stderr, '', 'a commit token needs a digit');

    const missingNext = cli(fixture, ['checkin', 'card', '-m', 'Next: deploy to staging.']);
    assert.equal(missingNext.status, 0, missingNext.stderr);
    assert.equal(missingNext.stderr, 'keep: tip — pass --next "<text>" so the landed sweep can track it\n');

    const suppliedNext = cli(fixture, ['checkin', 'card', '-m', 'Next: deploy to staging.', '--next', 'deploy to staging']);
    assert.equal(suppliedNext.status, 0, suppliedNext.stderr);
    assert.equal(suppliedNext.stderr, '');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('done accepts commit and next fields', () => {
  const fixture = registry();
  try {
    const result = cli(fixture, ['done', 'card', '-m', 'Finished.', '--next', 'nothing', '--commit', 'ABC1234']);
    assert.equal(result.status, 0, result.stderr);
    const task = keep.loadTask('card', fixture.root);
    assert.equal(task.fm.status, 'done');
    assert.deepEqual(entryFields(logEntries(task.body)[0]), { next: 'nothing', commits: ['abc1234'] });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
