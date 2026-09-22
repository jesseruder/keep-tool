'use strict';

// The daemon runs every scheduler tick and every HTTP route on one event loop. A
// synchronous child process there (execFileSync, spawnSync, execSync) blocks all of
// it, host requests included, for as long as the child runs: that is how git
// spawns and the handoff tick ended up as multi-second stalls. This test keeps the
// class from coming back quietly. Every synchronous spawn in the daemon's tick and
// route files has to be on the allowlist below, with the reason it is safe.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const FILES = ['bin/serve.js', 'bin/serve/schedulers.js', 'bin/serve/routes.js', 'bin/handoff-queue.js'];
const SYNC_SPAWN = /\b(execFileSync|spawnSync|execSync)\b/g;

// Keyed by file and the enclosing top-level function; `count` is the exact number
// of mentions there (the injectable default counts, so a new call beside the
// allowed ones fails the count).
const ALLOWLIST = [
  {
    file: 'bin/serve/schedulers.js',
    function: 'createRegistryPull',
    count: 4,
    // The injectable default (two mentions on one line), the rebase and the
    // abort. The rebase runs under the registry lock on purpose: every other
    // keep.withLock caller in
    // the process waits by blocking the loop, so an async holder could never be
    // woken to release it. It only runs when the fetch (asynchronous, unlocked)
    // found new commits, and with the objects already local it takes milliseconds.
    why: 'registry rebase under the registry lock, only after an async fetch found commits',
  },
];

// Line comments and block-comment lines are prose, not calls.
function codeOf(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
  const comment = line.indexOf(' // ');
  return comment >= 0 ? line.slice(0, comment) : line;
}

function syncSpawns(file) {
  const lines = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').split('\n');
  const found = [];
  let enclosing = '(top level)';
  lines.forEach((line, index) => {
    const declared = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/.exec(line);
    if (declared) enclosing = declared[1];
    for (const match of codeOf(line).matchAll(SYNC_SPAWN)) {
      found.push({ file, function: enclosing, line: index + 1, name: match[1], text: line.trim() });
    }
  });
  return found;
}

test('daemon tick and route files spawn children asynchronously, outside the allowlist', () => {
  const found = FILES.flatMap(syncSpawns);
  const groups = new Map();
  for (const hit of found) {
    const key = `${hit.file} ${hit.function}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(hit);
  }
  const problems = [];
  for (const [key, hits] of groups) {
    const allowed = ALLOWLIST.find((entry) => `${entry.file} ${entry.function}` === key);
    if (!allowed || hits.length !== allowed.count) {
      problems.push(...hits.map((hit) => `${hit.file}:${hit.line} (${hit.function}) ${hit.text}`));
    }
  }
  assert.deepEqual(problems, [], [
    'A synchronous child process in the daemon blocks every scheduler tick and HTTP route',
    'for as long as the child runs. Daemon tick and route paths spawn asynchronously',
    '(execFile/spawn with a callback or promise). If this call genuinely must be',
    'synchronous, add it with its reason to ALLOWLIST in bin/daemon-sync-guard.test.js.',
    'Unlisted or over-count sites:',
    ...problems,
  ].join('\n'));
});

test('every allowlisted site still exists, so the list cannot rot into a blanket pass', () => {
  const found = FILES.flatMap(syncSpawns);
  for (const entry of ALLOWLIST) {
    const hits = found.filter((hit) => hit.file === entry.file && hit.function === entry.function);
    assert.equal(hits.length, entry.count,
      `${entry.file} ${entry.function} is allowlisted for ${entry.count} synchronous spawn mentions but has ${hits.length}; update ALLOWLIST in bin/daemon-sync-guard.test.js`);
  }
});

test('the scanner sees a call and ignores prose', () => {
  assert.equal(codeOf('  // execFileSync says ETIMEDOUT'), '');
  assert.equal(codeOf('  run(); // spawnSync would block').includes('spawnSync'), false);
  assert.equal([...codeOf("  require('child_process').execSync('ls');").matchAll(SYNC_SPAWN)].length, 1);
});
