'use strict';

for (const key of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[key];

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const notes = require('./notes.js');
const keep = require('./keep.js');
const wait = require('./wait.js');
const { buildBrief } = require('./alerts.js');

const KEEP = path.join(__dirname, 'keep.js');
const PROJECT = '/work/sandboxes';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-notes-test-'));
  for (const directory of ['tasks', 'archive']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  return root;
}

function cliEnv(root) {
  const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1', KEEP_PORT: '1' };
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) delete env[key];
  return env;
}

function cli(root, args, extra = {}) {
  return spawnSync(process.execPath, [KEEP, ...args], { encoding: 'utf8', env: cliEnv(root), ...extra });
}

function stamp(ms) {
  return notes.stampOf(new Date(ms));
}

function seed(root, overrides = {}) {
  return notes.addNote({
    root,
    project: PROJECT,
    scopes: ['staging'],
    by: { sessionId: 'author-session', agent: 'claude' },
    message: 'staging is home-only, no deck-persistence config',
    until: stamp(Date.now() + 2 * 3600e3),
    ...overrides,
  });
}

test('a note round-trips through its own project file', () => {
  const root = makeRoot();
  try {
    const note = seed(root);
    assert.match(note.id, /^note-[a-z0-9]+$/);
    assert.equal(note.project, PROJECT);
    assert.deepEqual(note.scopes, ['staging']);
    assert.equal(note.cleared, '');
    assert.equal(note.nagged, null);
    const file = notes.noteFile(PROJECT, root);
    assert.ok(fs.existsSync(file), file);
    assert.deepEqual(notes.loadNotes(PROJECT, root).map((row) => row.id), [note.id]);
    assert.equal(notes.findNote(note.id, root).id, note.id);
    // One file per project, keyed by basename plus a digest of the full path.
    assert.match(path.basename(file), /^sandboxes-[0-9a-f]{8}\.json$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the message is sanitized and capped at 300 characters', () => {
  const root = makeRoot();
  try {
    const note = seed(root, { message: `<<<fence\u0007 and  spaces>>> ${'x'.repeat(400)}` });
    assert.equal(note.message.length, 300);
    assert.match(note.message, /^---fence and spaces--- x+$/);
    assert.equal(/[\u0000-\u001f]/.test(note.message), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('activeNotes splits active from expired-unconfirmed and forgets neither too early', () => {
  const root = makeRoot();
  const now = Date.now();
  try {
    const live = seed(root, { message: 'still true' });
    const justExpired = seed(root, { message: 'expired an hour ago', until: stamp(now - 3600e3) });
    seed(root, { message: 'expired two days ago', until: stamp(now - 2 * 86400e3) });
    const result = notes.activeNotes(PROJECT, now, { root });
    assert.deepEqual(result.active.map((row) => row.id), [live.id]);
    assert.deepEqual(result.expired.map((row) => row.id), [justExpired.id]);
    // A different project sees none of them.
    assert.deepEqual(notes.activeNotes('/work/other', now, { root }).active, []);
    // A scope filter narrows without inventing expiry.
    assert.deepEqual(notes.activeNotes(PROJECT, now, { root, scope: ['prod'] }).active, []);
    assert.deepEqual(notes.activeNotes(PROJECT, now, { root, scope: ['staging'] }).active.map((r) => r.id), [live.id]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('clearing and extending a note are recorded, and a write prunes old rows', () => {
  const root = makeRoot();
  const now = Date.now();
  try {
    const note = seed(root);
    const stale = seed(root, { message: 'ancient', until: stamp(now - 30 * 86400e3) });
    const extended = notes.extendNote(note.id, stamp(now + 6 * 3600e3), { root });
    assert.equal(extended.until, stamp(now + 6 * 3600e3));
    assert.equal(extended.extended.length, 1);
    // The pruning write dropped the row that expired a month ago.
    assert.equal(notes.findNote(stale.id, root), null);
    const cleared = notes.clearNote(note.id, 'staging is back to normal', { root });
    assert.ok(cleared.cleared);
    assert.match(cleared.message, /cleared: staging is back to normal$/);
    assert.deepEqual(notes.activeNotes(PROJECT, now, { root }).active, []);
    assert.deepEqual(notes.activeNotes(PROJECT, now, { root }).expired, []);
    // Clearing twice is a no-op, not a second timestamp.
    const again = notes.clearNote(note.id, 'again', { root });
    assert.equal(again.cleared, cleared.cleared);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a note never blocks a wait — keep wait --no-hold does not see one', () => {
  const root = makeRoot();
  const now = Date.now();
  try {
    seed(root, { project: '/project', scopes: ['terraform'] });
    const deps = {
      now: () => now,
      resolveProject: (value) => value,
      activeHolds: (project, at, options) => keep.activeHolds(project, at, { ...options, root }),
    };
    const unscoped = wait.parseWaitArgs(['--no-hold', '/project']).conditions;
    assert.equal(wait.evaluate(unscoped, deps).satisfied, true, 'a state note is not a hold');
    const scoped = wait.parseWaitArgs(['--no-hold', '/project', '--scope', 'terraform']).conditions;
    assert.equal(wait.evaluate(scoped, deps).satisfied, true, 'not even on the note\'s own scope');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the broadcast text says plainly that nothing is blocked', () => {
  const root = makeRoot();
  try {
    const note = seed(root);
    const created = notes.announcementFor(note, 'create');
    assert.match(created, /^\[keep\] state note on staging \(sandboxes\): staging is home-only, no deck-persistence config — by claude author-s, until \d{2}:\d{2}\. Information only; nothing is blocked\.$/);
    assert.match(notes.announcementFor(note, 'extend'), /^\[keep\] state note on staging \(sandboxes\) extended:/);
    assert.match(notes.announcementFor({ ...note, cleared: 'now' }, 'clear'),
      /^\[keep\] state note on staging \(sandboxes\) cleared: .* Information only; nothing is blocked\.$/);
    assert.match(notes.nagFor(note), /^\[keep\] your state note on staging expired: is ".*" still true\? keep note --extend note-[a-z0-9]+ --for \+2h, or keep note --clear note-[a-z0-9]+\.$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the expiry sweep nags the live author once and leaves the rest to Owner', async () => {
  const root = makeRoot();
  const now = Date.now();
  try {
    const mine = seed(root, { until: stamp(now - 60e3) });
    const orphan = seed(root, { until: stamp(now - 60e3), by: { sessionId: 'gone-session', agent: 'codex' } });
    const future = seed(root, { until: stamp(now + 3600e3) });
    const sent = [];
    const options = {
      root, now,
      sessions: () => [{ id: 'author-session', kind: 'claude', endedTurn: true, state: 'idle' }],
      send: (sessionId, text) => { sent.push([sessionId, text]); },
      health: { record: () => {} },
    };
    const first = await notes.sweep(options);
    assert.deepEqual(first, { changed: 2, nagged: 1, owner: 1, deferred: 0 });
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 'author-session');
    assert.match(sent[0][1], /your state note on staging expired/);
    assert.ok(notes.findNote(mine.id, root).nagged.sessionId === 'author-session');
    assert.equal(notes.findNote(orphan.id, root).nagged.owner, true);
    assert.equal(notes.findNote(future.id, root).nagged, null);
    // One nag per note, ever.
    const second = await notes.sweep(options);
    assert.deepEqual(second, { changed: 0, nagged: 0, owner: 0, deferred: 0 });
    assert.equal(sent.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a busy author is retried, not written off, and gives up after six sweeps', async () => {
  const root = makeRoot();
  const now = Date.now();
  try {
    seed(root, { until: stamp(now - 60e3) });
    const sent = [];
    const busy = {
      root, now,
      sessions: () => [{ id: 'author-session', kind: 'claude', endedTurn: false }],
      send: (sessionId, text) => sent.push([sessionId, text]),
    };
    const first = await notes.sweep(busy);
    assert.deepEqual(first, { changed: 0, nagged: 0, owner: 0, deferred: 1 });
    assert.deepEqual(sent, []);
    let [note] = notes.allNotes(root);
    assert.equal(note.nagged, null, 'mid-turn is transient; the nag is still owed');
    assert.equal(note.nagAttempts, 1);
    assert.match(note.lastNagAttempt.reason, /mid-turn/);

    // It comes back when the session frees up.
    await notes.sweep({ ...busy, sessions: () => [{ id: 'author-session', kind: 'claude', endedTurn: true, state: 'idle' }] });
    assert.equal(sent.length, 1);
    assert.match(sent[0][1], /your state note on staging expired/);

    // A session that stays busy is eventually Owner's problem.
    const stuck = seed(root, { until: stamp(now - 60e3) });
    for (let i = 0; i < notes.NAG_ATTEMPT_LIMIT - 1; i += 1) {
      const round = await notes.sweep(busy);
      assert.equal(round.deferred, 1, `sweep ${i}`);
    }
    const last = await notes.sweep(busy);
    assert.equal(last.owner, 1);
    const final = notes.findNote(stuck.id, root);
    assert.equal(final.nagged.owner, true);
    assert.equal(final.nagAttempts, notes.NAG_ATTEMPT_LIMIT);
    assert.match(final.nagged.reason, /after 6 attempts/);
    assert.equal(sent.length, 1, 'nothing was ever typed into the busy session');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an exited author is handed to Owner at once, with no retries', async () => {
  const root = makeRoot();
  const now = Date.now();
  try {
    seed(root, { until: stamp(now - 60e3) });
    const result = await notes.sweep({
      root, now,
      sessions: () => [{ id: 'author-session', kind: 'claude', state: 'exited', exited: true }],
      send: () => { throw new Error('must not send'); },
    });
    assert.deepEqual(result, { changed: 1, nagged: 0, owner: 1, deferred: 0 });
    const [note] = notes.allNotes(root);
    assert.equal(note.nagged.owner, true);
    assert.match(note.nagged.reason, /exited/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('activeNotes: null is every project, an empty string is none', () => {
  const root = makeRoot();
  const now = Date.now();
  try {
    seed(root, { project: '/work/a' });
    seed(root, { project: '/work/b' });
    assert.equal(notes.activeNotes(null, now, { root }).active.length, 2, 'null means the fleet');
    assert.equal(notes.activeNotes(undefined, now, { root }).active.length, 2);
    assert.deepEqual(notes.activeNotes('', now, { root }).active, [],
      'an unresolved project must not silently return everyone\'s notes');
    assert.deepEqual(notes.activeNotes('   ', now, { root }).active, []);
    assert.equal(notes.activeNotes('/work/a', now, { root }).active.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('every note writer runs under the registry lock', async () => {
  const root = makeRoot();
  const now = Date.now();
  const keepApi = require('./keep.js');
  const seen = [];
  const realWithLock = keepApi.withLock;
  keepApi.withLock = (fn) => { seen.push('lock'); return realWithLock(fn); };
  try {
    const note = seed(root, { until: stamp(now - 60e3) });
    notes.extendNote(note.id, stamp(now + 3600e3), { root });
    notes.clearNote(note.id, 'done', { root });
    assert.ok(seen.length >= 3, `add, extend and clear each take the lock (${seen.length})`);

    // A sweep write and an add do not lose each other: both go through the lock,
    // so the note added mid-sweep survives the sweep's own rewrite.
    const expired = seed(root, { until: stamp(now - 60e3) });
    let added = null;
    await notes.sweep({
      root, now,
      sessions: () => [{ id: 'author-session', kind: 'claude', endedTurn: true, state: 'idle' }],
      send: () => { added = seed(root, { message: 'written while the sweep ran' }); },
    });
    assert.ok(added, 'the add happened');
    assert.ok(notes.findNote(added.id, root), 'and it is still there after the sweep marked the nag');
    assert.ok(notes.findNote(expired.id, root).nagged, 'and the nag mark survived the add');
  } finally {
    keepApi.withLock = realWithLock;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the brief lists state notes and flags the unconfirmed ones', () => {
  const now = Date.now();
  const brief = buildBrief({
    now,
    tasks: [],
    notes: {
      active: [{ scopes: ['staging'], project: PROJECT, until: '2026-09-14T18:00', message: 'home-only mode' }],
      expired: [{ scopes: ['terraform'], project: PROJECT, until: '2026-09-14T09:00', message: 'state file locked' }],
    },
  });
  assert.match(brief.text, /^State notes \(2\)$/m);
  assert.match(brief.text, /^- staging on \/work\/sandboxes until 2026-09-14T18:00 — home-only mode$/m);
  assert.match(brief.text, /^- terraform on \/work\/sandboxes — expired, unconfirmed since 2026-09-14T09:00 — state file locked$/m);
  // A note never wins the spoken line.
  assert.doesNotMatch(brief.spoken, /state note/i);
});

test('keep note writes, lists, extends and clears from the CLI', () => {
  const root = makeRoot();
  const project = path.join(root, 'sandboxes');
  fs.mkdirSync(project, { recursive: true });
  try {
    const written = cli(root, ['note', project, '--scope', 'staging', '-m', 'home-only, no deck persistence', '--for', '+2h']);
    assert.equal(written.status, 0, written.stderr);
    assert.match(written.stdout, /\[staging\] until \d{4}-\d{2}-\d{2}T\d{2}:\d{2} — home-only, no deck persistence/);
    assert.match(written.stdout, /Information only; nothing is blocked by a note/);
    const id = written.stdout.match(/^(note-[a-z0-9]+):/m)[1];

    const listed = cli(root, ['notes']);
    assert.match(listed.stdout, new RegExp(`^${id} `, 'm'));

    const extended = cli(root, ['note', '--extend', id, '--for', '+6h']);
    assert.equal(extended.status, 0, extended.stderr);
    assert.match(extended.stdout, new RegExp(`^${id}: extended until`, 'm'));

    const cleared = cli(root, ['note', '--clear', id, '-m', 'restored']);
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.match(cli(root, ['notes']).stdout, /no state notes/);
    assert.match(cli(root, ['notes', '--all']).stdout, new RegExp(`^${id} .*\\[cleared `, 'm'));

    const missing = cli(root, ['note', '--clear', 'note-nope']);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /no state note "note-nope"/);

    const noScope = cli(root, ['note', project, '-m', 'x', '--for', '+2h']);
    assert.notEqual(noScope.status, 0);
    assert.match(noScope.stderr, /at least one --scope/);

    const badFor = cli(root, ['note', project, '--scope', 'staging', '-m', 'x', '--for', 'soon']);
    assert.notEqual(badFor.status, 0);
    assert.match(badFor.stderr, /--for must be a duration/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a scope must be declared once the project declares anything', () => {
  const root = makeRoot();
  const project = path.join(root, 'sandboxes');
  fs.mkdirSync(project, { recursive: true });
  try {
    // Nothing declared: any well-formed resource label is allowed.
    assert.equal(cli(root, ['note', project, '--scope', 'anything-goes', '-m', 'x', '--for', '+1h']).status, 0);
    assert.notEqual(cli(root, ['note', project, '--scope', 'Not A Label', '-m', 'x', '--for', '+1h']).status, 0);

    cli(root, ['resources', project, '--add', 'staging', '--command', 'terraform apply']);
    const refused = cli(root, ['note', project, '--scope', 'prod', '-m', 'x', '--for', '+1h']);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /prod is not a resource declared on/);
    assert.match(refused.stderr, /declared here: staging/);
    assert.equal(cli(root, ['note', project, '--scope', 'staging', '-m', 'x', '--for', '+1h']).status, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep note --task checks the card in, like a hold does', () => {
  const root = makeRoot();
  const project = path.join(root, 'sandboxes');
  fs.mkdirSync(project, { recursive: true });
  // checkinTask commits the registry, so the root has to be one.
  for (const directory of ['digests']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'notes@example.test');
  git('config', 'user.name', 'Notes Test');
  try {
    const added = cli(root, ['add', 'Staging work', '--claim']);
    assert.equal(added.status, 0, added.stderr);
    const card = added.stdout.match(/\b([a-z0-9-]+-[a-z0-9]{4,})\b/)[1];
    const written = cli(root, ['note', project, '--scope', 'staging', '-m', 'home-only', '--for', '+2h', '--task', card]);
    assert.equal(written.status, 0, written.stderr);
    const body = fs.readFileSync(path.join(root, 'tasks', `${card}.md`), 'utf8');
    assert.match(body, /— state note/);
    assert.match(body, /State note on .*\[staging\] until .* home-only/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep who and the session-start hook show notes as information, not as a hold', () => {
  const root = makeRoot();
  const project = path.join(root, 'sandboxes');
  fs.mkdirSync(project, { recursive: true });
  try {
    cli(root, ['note', project, '--scope', 'staging', '-m', 'home-only, no deck persistence', '--for', '+2h']);
    const snapshot = cli(root, ['who', project]);
    assert.equal(snapshot.status, 0, snapshot.stderr);
    assert.match(snapshot.stdout, /^state notes \(information only; nothing is blocked\):$/m);
    assert.match(snapshot.stdout, /scope: staging · until .* home-only, no deck persistence/);

    const hook = cli(root, ['hook', 'session-start'], {
      cwd: project,
      input: JSON.stringify({ session_id: 'session-notes', cwd: project }),
    });
    assert.equal(hook.status, 0, hook.stderr);
    assert.match(hook.stdout, /^State notes on this project:$/m);
    assert.match(hook.stdout, /\[staging\] home-only, no deck persistence/);
    assert.match(hook.stdout, /Notes are information only; nothing is blocked by one/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the announce path skips the author and never reaches the reviewer', async () => {
  const serve = require('./serve.js');
  const root = keep.ROOT;
  fs.mkdirSync(path.join(root, '.keep'), { recursive: true });
  const note = notes.addNote({
    root,
    project: PROJECT,
    scopes: ['staging'],
    by: { sessionId: 'author-session', agent: 'claude' },
    message: 'home-only, no deck persistence',
    until: stamp(Date.now() + 3600e3),
  });
  try {
    const sent = [];
    const result = await serve.announceStateNote(note.id, {
      send: (sessionId, text) => { sent.push([sessionId, text]); },
      excluded: new Set(['spawned-session']),
      liveSessionsInCheckout: () => ({
        available: true,
        sessions: [{ id: 'author-session' }, { id: 'sibling-session' }, { id: 'reviewer-session' }, { id: 'spawned-session' }],
      }),
      scanSessions: () => [
        { id: 'sibling-session', endedTurn: true, mtime: 2 },
        { id: 'reviewer-session', endedTurn: true, reviewer: true, mtime: 3 },
        { id: 'spawned-session', endedTurn: true, mtime: 1 },
        { id: 'busy-session', endedTurn: false, mtime: 4 },
      ],
    });
    assert.deepEqual(result.sent, ['sibling-session']);
    assert.deepEqual(sent.map((row) => row[0]), ['sibling-session']);
    assert.match(sent[0][1], /^\[keep\] state note on staging \(sandboxes\): home-only, no deck persistence/);
    assert.match(sent[0][1], /Information only; nothing is blocked\.$/);
    assert.equal((await serve.announceStateNote('note-nope', {})).error, 'no state note "note-nope"');

    // Replay: the same request again is refused rather than typed a second time.
    const replay = await serve.announceStateNote(note.id, {
      send: () => { throw new Error('must not send twice'); },
      excluded: new Set(),
      liveSessionsInCheckout: () => ({ available: true, sessions: [{ id: 'sibling-session' }] }),
      scanSessions: () => [{ id: 'sibling-session', endedTurn: true, mtime: 2 }],
    });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.event, 'create');
  } finally {
    fs.rmSync(notes.notesDir(root), { recursive: true, force: true });
  }
});

test('the announce path excludes the author even when the ledger would list it', async () => {
  const serve = require('./serve.js');
  const root = keep.ROOT;
  const note = notes.addNote({
    root,
    project: PROJECT,
    scopes: ['staging'],
    by: { sessionId: 'author-session', agent: 'claude' },
    message: 'still home-only',
    until: stamp(Date.now() + 3600e3),
  });
  try {
    notes.extendNote(note.id, stamp(Date.now() + 7200e3), { root });
    let excludedIds = null;
    const result = await serve.announceStateNote(note.id, {
      send: () => {},
      excluded: new Set(),
      liveSessionsInCheckout: (project, exclude) => {
        excludedIds = [...(exclude || [])];
        return { available: true, sessions: [{ id: 'sibling-session' }] };
      },
      scanSessions: () => [{ id: 'sibling-session', endedTurn: true, mtime: 1 }],
    });
    assert.deepEqual(excludedIds, ['author-session']);
    assert.match(result.text, /extended:/);
  } finally {
    fs.rmSync(notes.notesDir(root), { recursive: true, force: true });
  }
});

test('sanitize strips bidi overrides, zero-width characters, and odd spaces', () => {
  const root = makeRoot();
  try {
    const note = seed(root, { message: 'staging' + '\u202e' + ' is' + '\u200b' + 'home-only' + '\u00a0' + 'now' + '\u2066' });
    assert.equal(note.message, 'staging is home-only now');
    assert.equal(/[\p{Cf}\p{Zl}\p{Zp}]/u.test(note.message), false);
    // The compatibility spelling of a separator is the same separator.
    assert.equal(notes.scrub('a' + '\u3000' + 'b'), 'a b');
    // Folding detects; it is never what gets stored. A ligature, a unit, and
    // half-width katakana are text somebody wrote, and they round-trip.
    assert.equal(notes.scrub('\ufb01le'), '\ufb01le');
    assert.equal(notes.scrub('5 \u338f'), '5 \u338f');
    assert.equal(notes.scrub('\uff76\uff80\uff76\uff85'), '\uff76\uff80\uff76\uff85');
    const kept = seed(root, { message: 'the \ufb01le is 5 \u338f (\uff76\uff80\uff76\uff85)' + '\u202e' });
    assert.equal(kept.message, 'the \ufb01le is 5 \u338f (\uff76\uff80\uff76\uff85)');
    // And what is stored is what the watcher would have been willing to deliver.
    const live = require('./watcher-live.js');
    assert.equal(live.safeDeliveryText(notes.announcementFor(note, 'create')) !== null, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the announced event is the note\'s own state, not the caller\'s word for it', async () => {
  const serve = require('./serve.js');
  const root = keep.ROOT;
  const note = notes.addNote({
    root,
    project: PROJECT,
    scopes: ['staging'],
    by: { sessionId: 'author-session', agent: 'claude' },
    message: 'home-only',
    until: stamp(Date.now() + 3600e3),
  });
  const deps = () => ({
    send: () => {},
    excluded: new Set(),
    liveSessionsInCheckout: () => ({ available: true, sessions: [{ id: 'sibling-session' }] }),
    scanSessions: () => [{ id: 'sibling-session', endedTurn: true, mtime: 2 }],
  });
  try {
    // An uncleared note cannot be announced as cleared, however it is asked for.
    const created = await serve.announceStateNote(note.id, deps());
    assert.equal(created.event, 'create');
    assert.doesNotMatch(created.text, /cleared/);

    // Each extension is its own event; a replay of the same one is refused.
    notes.extendNote(note.id, stamp(Date.now() + 7200e3), { root });
    assert.equal((await serve.announceStateNote(note.id, deps())).event, 'extend');
    assert.equal((await serve.announceStateNote(note.id, deps())).duplicate, true);
    notes.extendNote(note.id, stamp(Date.now() + 10800e3), { root });
    assert.equal((await serve.announceStateNote(note.id, deps())).event, 'extend', 'a second extension is not a replay');

    notes.clearNote(note.id, 'restored', { root });
    const cleared = await serve.announceStateNote(note.id, deps());
    assert.equal(cleared.event, 'clear');
    assert.match(cleared.text, /cleared:/);
    assert.equal((await serve.announceStateNote(note.id, deps())).duplicate, true);
  } finally {
    fs.rmSync(notes.notesDir(root), { recursive: true, force: true });
  }
});
