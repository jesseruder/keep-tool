'use strict';

// The daemon runs every scheduler tick and every HTTP route on one event loop. A
// synchronous child process there (execFileSync, spawnSync, execSync) blocks all of
// it, host requests included, for as long as the child runs: that is how git
// spawns and the handoff tick ended up as multi-second stalls. This test keeps the
// class from coming back quietly. Every synchronous spawn in the daemon's tick and
// route files, and in the modules whose schedulers the daemon runs in-process, has
// to be on the allowlist below: either with the reason it is safe, or marked as
// known debt so a new site beside it still fails.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const FILES = [
  'bin/serve.js', 'bin/serve/schedulers.js', 'bin/serve/routes.js', 'bin/handoff-queue.js',
  // Modules whose startScheduler the daemon calls, so their ticks run on its loop.
  'bin/landed.js', 'bin/lint.js', 'bin/review.js', 'bin/self-repair.js',
];
const SYNC_SPAWN = /\b(execFileSync|spawnSync|execSync)\b/g;

// Keyed by file and the enclosing top-level declaration (a function, or the
// `const` a top-level object or import is bound to; '(top level)' for a
// destructured import); `count` is the exact number of mentions there (imports
// and injectable defaults count, so a new call beside the allowed ones fails).
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
  // ---- Known debt: synchronous today, on a daemon tick. Do not copy these; move
  // them to an async child when their module is next touched.
  {
    file: 'bin/landed.js',
    function: 'deps',
    count: 2,
    // DEBT: the test seam every landed.js git call goes through. The module memoizes
    // answers (repo, default branch, commit dependencies) so a state build rarely
    // spawns, but a cache miss spawns git synchronously on the daemon loop.
    why: 'debt: landed.js git seam, synchronous on a cache miss',
  },
  {
    file: 'bin/landed.js',
    function: 'git',
    count: 1,
    // DEBT: the one caller of the seam above.
    why: 'debt: landed.js git(), synchronous on a cache miss',
  },
  {
    file: 'bin/lint.js',
    function: '(top level)',
    count: 1,
    // DEBT: the import the two sites below use.
    why: 'debt: lint.js execFileSync import',
  },
  {
    file: 'bin/lint.js',
    function: 'checkoutState',
    count: 1,
    // DEBT: git status of each main checkout, on the 30-minute lint tick.
    why: 'debt: lint.js checkout status, synchronous on the lint tick',
  },
  {
    file: 'bin/lint.js',
    function: 'git',
    count: 1,
    // DEBT: the lint rules' local git reads, on the 30-minute lint tick.
    why: 'debt: lint.js git(), synchronous on the lint tick',
  },
  {
    file: 'bin/review.js',
    function: '(top level)',
    count: 1,
    // DEBT: the import the two sites below use.
    why: 'debt: review.js execFileSync import',
  },
  {
    file: 'bin/review.js',
    function: 'git',
    count: 1,
    // DEBT: the fleet reviewer's git reads (diffs, logs) for its bundle.
    why: 'debt: review.js git(), synchronous in the reviewer tick',
  },
  {
    file: 'bin/review.js',
    function: 'scanSubagentsForCodex',
    count: 1,
    // DEBT: grep over transcript chunks to find the session that launched a Codex job.
    why: 'debt: review.js grep over transcripts',
  },
  {
    file: 'bin/self-repair.js',
    function: 'patchIdOf',
    count: 1,
    // DEBT: git patch-id when the self-repair tick checks whether a repair card's
    // commit landed through a reviewed patch; runs in the daemon, not a child.
    why: 'debt: self-repair.js patch-id, synchronous in the self-repair tick',
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
    const declared = /^(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)\s*\(/.exec(line);
    const bound = /^(?:const|let|var)\s+([A-Za-z0-9_$]+)\b/.exec(line);
    if (declared) enclosing = declared[1];
    else if (bound) enclosing = bound[1];
    else if (/^(?:const|let|var)\s*[{[]/.test(line) || /^module\.exports\b/.test(line)) enclosing = '(top level)';
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
