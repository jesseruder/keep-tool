'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const agents = require('./agents.js');
const incidents = require('./incidents.js');

const GHOST_BOT = 'B06PX3MFG5C';
const SANDBOX_BOT = 'B0C1KEHNH8F';
const ALERT_BOTS = { [GHOST_BOT]: 'ghost-server', [SANDBOX_BOT]: 'castle-sandboxes' };
// `sandboxes` keeps the area's own name as its agent (the default); `app-server`
// names a different one, which is the whole point of the mapping.
const AREAS = {
  areas: {
    sandboxes: { project: 'castle-sandboxes', match: ['^Sandbox '] },
    'app-server': { project: 'ghost-server', default: true, agent: 'app-responder' },
  },
  quietMin: 60,
  reopenHours: 24,
};

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-agents-'));
  for (const directory of ['tasks', 'archive', 'digests', 'watch']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'watch', 'slack.json'), JSON.stringify({
    channels: ['#errors'], mode: 'cards', intervalMin: 15, model: 'haiku',
    backfillHours: 6, maxPerPoll: 60, alertBots: ALERT_BOTS,
  }));
  fs.writeFileSync(path.join(root, 'watch', 'incidents.json'), JSON.stringify(AREAS));
  return root;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

function lines(root, name) {
  let text;
  try { text = fs.readFileSync(agents.eventsFile(name, root), 'utf8'); } catch { return []; }
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// Enough of a registry for incidents.js to write a card and read it back.
function fakeRegistry(root) {
  const bodies = new Map();
  const created = [];
  return {
    created,
    deps: {
      addTask(options) {
        const task = { id: 'unset', fm: {}, body: '' };
        if (options.beforeSave) options.beforeSave(task);
        created.push(task.id);
        bodies.set(task.id, String(options.note || ''));
        fs.writeFileSync(path.join(root, 'tasks', `${task.id}.md`), bodies.get(task.id));
        return task;
      },
      checkinTask(id, options) {
        bodies.set(id, `${bodies.get(id) || ''}\n## ${options.heading}\n${options.message}\n`);
        fs.writeFileSync(path.join(root, 'tasks', `${id}.md`), bodies.get(id));
      },
      commitAndPush() {},
    },
  };
}

// ---------- records ----------

test('a record round-trips through the lock, and a second write merges rather than replaces', () => {
  const root = makeRoot();
  try {
    let held = 0;
    const withLock = (fn) => { held += 1; try { return fn(); } finally { held -= 1; } };
    const created = agents.writeRecord('sandboxes', {
      role: 'incident-responder', model: 'fable', account: 'claude-secondary',
      project: 'castle-sandboxes', cwd: '/wt/castle-sandboxes/responder', area: 'sandboxes',
      session: { id: 'sess-1', pane: 'pane-1', startedAt: 1000 },
    }, { root, withLock, now: 5000 });
    assert.equal(held, 0, 'the lock is released');
    assert.equal(created.name, 'sandboxes');
    assert.equal(created.lifecycle, 'idle', 'an unset lifecycle defaults to idle');
    assert.equal(created.createdAt, 5000);

    const read = agents.readRecord('sandboxes', root);
    assert.deepEqual(read, created);
    assert.equal(fs.existsSync(agents.recordFile('sandboxes', root)), true);

    const updated = agents.writeRecord('sandboxes', { lifecycle: 'working', session: { pane: 'pane-2' } }, { root, now: 9000 });
    assert.equal(updated.lifecycle, 'working');
    assert.equal(updated.session.id, 'sess-1', 'the session id survives a pane-only write');
    assert.equal(updated.session.pane, 'pane-2');
    assert.equal(updated.model, 'fable', 'untouched fields survive');
    assert.equal(updated.createdAt, 5000, 'createdAt is written once');

    // ensure() creates once and then leaves what is on disk alone.
    assert.equal(agents.ensure('sandboxes', { role: 'something-else' }, { root }).role, 'incident-responder');
    const fresh = agents.ensure('app-responder', { role: 'incident-responder', area: 'app-server' }, { root });
    assert.equal(fresh.role, 'incident-responder');
    assert.equal(fs.existsSync(agents.notesFile('app-responder', root)), true, 'notes.md is created with the record');
    assert.deepEqual(agents.records(root).map((record) => record.name), ['app-responder', 'sandboxes']);

    // A fixture root is not the registry this process was configured with, so
    // nothing tries to commit into it.
    assert.equal(agents.flushCommits(root), false);
    assert.equal(agents.pendingNames(root).length, 0, 'the flush clears what it declined to commit');
  } finally { cleanup(root); }
});

test('a name that is not a usable directory or path segment is refused everywhere', () => {
  const root = makeRoot();
  try {
    for (const name of ['../escape', 'Sandboxes', '-lead', 'has space', '', 'a'.repeat(64)]) {
      assert.equal(agents.validName(name), false, `${JSON.stringify(name)} is not a name`);
      assert.throws(() => agents.writeRecord(name, {}, { root }), /bad agent name/);
      assert.equal(agents.readRecord(name, root), null);
    }
    assert.equal(agents.nameFromPath('/api/agents/..%2F..%2Fetc/seen'), '');
    assert.equal(agents.nameFromPath('/api/agents/sandboxes/seen'), 'sandboxes');
    assert.equal(agents.nameFromPath('/api/agents/sandboxes/events'), 'sandboxes');
    assert.equal(agents.nameFromPath('/api/agents/sandboxes/notes'), '');
  } finally { cleanup(root); }
});

// ---------- events ----------

test('emit appends, markSeen stamps only what it was asked for, and the feed reads newest first', () => {
  const root = makeRoot();
  try {
    agents.ensure('sandboxes', { role: 'incident-responder' }, { root });
    const first = agents.emit('sandboxes', { kind: 'diagnosed', card: 'inc-one', severity: 'high', text: 'host pool is full' }, { root, now: 1000 });
    agents.emit('sandboxes', { kind: 'watching', card: 'inc-one', text: 'waiting for the next scrape' }, { root, now: 2000 });
    agents.emit('sandboxes', { kind: 'noise', card: 'inc-two', severity: 'nonsense', text: 'flapping again' }, { root, now: 3000 });

    assert.equal(first.at, 1000);
    assert.equal(first.severity, 'high');
    const written = lines(root, 'sandboxes');
    assert.equal(written.length, 3);
    assert.deepEqual(written.map((event) => event.kind), ['diagnosed', 'watching', 'noise']);
    assert.equal(written[2].severity, 'med', 'an unknown severity falls back to med');
    assert.equal(written.every((event) => event.seenAt === 0), true);

    assert.deepEqual(agents.readEvents('sandboxes', { root }).map((event) => event.kind),
      ['noise', 'watching', 'diagnosed'], 'newest first');
    assert.deepEqual(agents.readEvents('sandboxes', { root, limit: 1 }).map((event) => event.kind), ['noise']);
    assert.deepEqual(agents.unseenSummary(agents.loadEvents('sandboxes', root)), { count: 3, needsYou: false });

    // Everything at or before the cutoff is stamped; the newer event is not.
    const marked = agents.markSeen('sandboxes', 2000, { root, now: 4000 });
    assert.equal(marked.marked, 2);
    assert.deepEqual({ count: marked.count, needsYou: marked.needsYou }, { count: 1, needsYou: false });
    const after = lines(root, 'sandboxes');
    assert.deepEqual(after.map((event) => event.seenAt), [4000, 4000, 0]);
    assert.deepEqual(agents.readEvents('sandboxes', { root, unseen: true }).map((event) => event.kind), ['noise']);
    // Marking again is not a second stamp on an already-seen event.
    assert.equal(agents.markSeen('sandboxes', 2000, { root, now: 5000 }).marked, 0);
    assert.deepEqual(lines(root, 'sandboxes').map((event) => event.seenAt), [4000, 4000, 0]);
    assert.equal(agents.markSeen('sandboxes', 9000, { root, now: 6000 }).marked, 1);
  } finally { cleanup(root); }
});

test('needs-you routes one attention alert keyed to the agent and its card', () => {
  const root = makeRoot();
  try {
    agents.ensure('sandboxes', {}, { root });
    const sent = [];
    const sendAlert = (request) => { sent.push(request); return Promise.resolve({ ok: true }); };
    agents.emit('sandboxes', {
      kind: 'needs-you', card: 'inc-sandbox-open-health', needsYou: true,
      text: 'the host pool is out of capacity — raise the cap or drain?',
    }, { root, sendAlert, now: 7000 });
    agents.emit('sandboxes', { kind: 'diagnosed', card: 'inc-sandbox-open-health', text: 'nothing needed' }, { root, sendAlert });

    assert.equal(sent.length, 1, 'only a needs-you event alerts');
    assert.equal(sent[0].key, 'agent:sandboxes:inc-sandbox-open-health');
    assert.equal(sent[0].level, 'attention');
    assert.equal(sent[0].from, 'agent:sandboxes');
    assert.equal(sent[0].caller, 'manual');
    assert.equal(sent[0].card, 'inc-sandbox-open-health');
    assert.equal(sent[0].root, root);
    assert.match(sent[0].text, /agent sandboxes · card inc-sandbox-open-health · the host pool is out of capacity/);
    assert.deepEqual(agents.unseenSummary(agents.loadEvents('sandboxes', root)), { count: 2, needsYou: true });

    // A failing alert channel is not a reason to lose the event.
    const thrown = agents.emit('sandboxes', { kind: 'needs-you', card: 'inc-two', needsYou: true, text: 'x' }, {
      root, sendAlert: () => { throw new Error('no channel'); }, write: () => {},
    });
    assert.equal(thrown.kind, 'needs-you');
    assert.equal(lines(root, 'sandboxes').length, 3);
  } finally { cleanup(root); }
});

test('an event for a name with no record is dropped, not invented', () => {
  const root = makeRoot();
  try {
    const stderr = [];
    const write = (line) => stderr.push(line);
    const sent = [];
    const dropped = agents.emit('sandboxes', { kind: 'incident-opened', card: 'inc-one', needsYou: true }, {
      root, write, sendAlert: (request) => sent.push(request),
    });
    assert.equal(dropped, null);
    assert.equal(stderr.length, 1, 'one line, not a stack');
    assert.match(stderr[0], /no record for sandboxes; dropped its incident-opened event/);
    assert.equal(fs.existsSync(agents.agentDir('sandboxes', root)), false, 'no record and no directory were created');
    assert.equal(sent.length, 0, 'a dropped event raises no alert');

    // An unusable name is the same story with a different line.
    assert.equal(agents.emit('../escape', { kind: 'note' }, { root, write }), null);
    assert.equal(stderr.length, 2);
    assert.match(stderr[1], /unusable agent name/);
  } finally { cleanup(root); }
});

// ---------- the incidents hook ----------

test('the incident emitter routes each area to its agent and drops the areas without one', () => {
  const root = makeRoot();
  try {
    const cfg = incidents.config(root);
    assert.equal(cfg.areas['app-server'].agent, 'app-responder');
    assert.equal(cfg.areas.sandboxes.agent, 'sandboxes', 'an area with no agent named is its own agent');
    assert.equal(agents.areaAgent('app-server', cfg), 'app-responder');
    assert.equal(agents.areaAgent('nowhere', cfg), 'nowhere');

    agents.ensure('app-responder', { area: 'app-server' }, { root });
    const stderr = [];
    const registry = fakeRegistry(root);
    const emitAgentEvent = agents.incidentEmitter({ root, config: cfg, write: (line) => stderr.push(line) });

    const base = Math.floor(Date.now() / 1000);
    const { entries } = incidents.ingest({
      root, config: cfg, alertBots: ALERT_BOTS, channel: '#errors', domain: 'example',
      units: [
        { ts: `${base}.000100`, from: GHOST_BOT, channel: '#errors', text: 'Alert "Home feed empty" firing\n\ncastle-alerts-home-feed' },
        { ts: `${base}.000200`, from: SANDBOX_BOT, channel: '#errors', text: 'Alert "Sandbox Open Health" firing\n\ncastle-alerts-open-health' },
      ],
    }, { ...registry.deps, emitAgentEvent });

    assert.equal(entries.length, 2);
    // The app-server alert reached its agent's feed with pointers only.
    const feed = lines(root, 'app-responder');
    assert.equal(feed.length, 1);
    assert.equal(feed[0].kind, 'incident-opened');
    assert.equal(feed[0].area, 'app-server');
    assert.equal(feed[0].card, 'inc-castle-alerts-home-feed');
    assert.equal(feed[0].needsYou, false, 'an incident event does not badge on its own');
    assert.equal(feed[0].severity, 'med');

    // The sandboxes area has no record yet (Stage C creates it), so its event is
    // dropped with one line and no directory.
    assert.equal(fs.existsSync(agents.agentDir('sandboxes', root)), false);
    assert.equal(stderr.length, 1);
    assert.match(stderr[0], /no record for sandboxes/);
  } finally { cleanup(root); }
});

// ---------- the dashboard view ----------

test('the reviewer is derived from the reviewer field, never written, and never badged', () => {
  const root = makeRoot();
  try {
    const live = { id: 'r1', reviewer: true, pane: 'pane-r', runtime: { state: 'live' }, state: 'running' };
    const working = agents.reviewerView({ reviewer: { id: 'r1', state: 'running', model: 'fable' }, sessions: [live] });
    assert.equal(working.name, 'fleet-reviewer');
    assert.equal(working.role, 'fleet reviewer');
    assert.equal(working.model, 'fable');
    assert.equal(working.lifecycle, 'working');
    assert.equal(working.derived, true);
    assert.deepEqual(working.session, { id: 'r1', pane: 'pane-r', startedAt: null });
    assert.deepEqual(working.unseen, { count: 0, needsYou: false });
    assert.equal(working.lastEvent, null);

    assert.equal(agents.reviewerView({ reviewer: { id: 'r1', state: 'idle' }, sessions: [live] }).lifecycle, 'idle');
    assert.equal(agents.reviewerView({ reviewer: { id: 'r1', state: 'recent' }, sessions: [live] }).lifecycle, 'idle');
    assert.equal(agents.reviewerView({
      reviewer: { id: 'r1', state: 'running' },
      sessions: [{ ...live, runtime: { state: 'exited' } }],
    }).lifecycle, 'stopped', 'a dead pane is stopped whatever the marker says');
    assert.equal(agents.reviewerView({ reviewer: { id: 'r1', state: 'gone' }, sessions: [] }).lifecycle, 'stopped');
    assert.equal(agents.reviewerView({ reviewer: null, sessions: [] }), null, 'no reviewer, no row');

    // Deriving it writes nothing at all.
    assert.equal(fs.existsSync(agents.agentDir('fleet-reviewer', root)), false);

    agents.ensure('sandboxes', { role: 'incident-responder', lifecycle: 'working', card: 'inc-one' }, { root });
    agents.emit('sandboxes', { kind: 'needs-you', card: 'inc-one', needsYou: true, text: 'raise the cap?' }, {
      root, now: 8000, sendAlert: () => {},
    });
    const rows = agents.dashboardAgents({ root, reviewer: { id: 'r1', state: 'running' }, sessions: [live] });
    assert.deepEqual(rows.map((row) => row.name), ['fleet-reviewer', 'sandboxes']);
    const sandboxes = rows[1];
    assert.equal(sandboxes.lifecycle, 'working');
    assert.equal(sandboxes.card, 'inc-one');
    assert.deepEqual(sandboxes.unseen, { count: 1, needsYou: true });
    assert.equal(sandboxes.lastEvent.kind, 'needs-you');
    assert.equal(sandboxes.lastEvent.text, 'raise the cap?');
    assert.equal(sandboxes.lastEvent.at, 8000);
    assert.equal(agents.dashboardAgents({ root: path.join(root, 'nothing-here') }).length, 0);
  } finally { cleanup(root); }
});

test('a session carrying an agent is marked with its name, by id or by pane', () => {
  const root = makeRoot();
  try {
    agents.ensure('sandboxes', { session: { id: 'sess-1', pane: 'pane-1' } }, { root });
    agents.ensure('app-responder', { session: { id: '', pane: 'pane-2' } }, { root });
    const sessions = [
      { id: 'sess-1', pane: 'pane-9' },
      { id: 'sess-2', pane: 'pane-2' },
      { id: 'sess-3', pane: 'pane-3', runtime: { paneId: 'pane-2' } },
      { id: 'sess-4', pane: 'pane-4' },
    ];
    agents.applySessions(sessions, agents.records(root));
    assert.deepEqual(sessions.map((session) => session.agent),
      ['sandboxes', 'app-responder', 'app-responder', undefined]);
  } finally { cleanup(root); }
});

// ---------- the CLI ----------

test('keep agents lists, emits and marks seen from the command line', () => {
  const root = makeRoot();
  try {
    agents.ensure('sandboxes', { role: 'incident-responder', area: 'sandboxes' }, { root });
    const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1', KEEP_ALERT_CHANNELS: 'none' };
    // A keep process spawned from a session would otherwise stamp this session
    // onto everything it writes.
    delete env.CLAUDE_CODE_SESSION_ID;
    const keepBin = path.join(__dirname, 'keep.js');
    const run = (...args) => spawnSync(process.execPath, [keepBin, 'agents', ...args], { encoding: 'utf8', env });

    const emitted = run('emit', 'sandboxes', '--kind', 'diagnosed', '--card', 'inc-one', '--severity', 'high', '-m', 'the pool is full');
    assert.equal(emitted.status, 0, emitted.stderr);
    assert.match(emitted.stdout, /sandboxes: diagnosed on inc-one/);

    const listed = JSON.parse(run('--json').stdout);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'sandboxes');
    assert.deepEqual(listed[0].unseen, { count: 1, needsYou: false });
    assert.equal(listed[0].lastEvent.severity, 'high');

    const events = JSON.parse(run('events', 'sandboxes', '--unseen', '--json').stdout);
    assert.equal(events.length, 1);
    assert.equal(events[0].text, 'the pool is full');

    const seen = run('seen', 'sandboxes');
    assert.equal(seen.status, 0, seen.stderr);
    assert.match(seen.stdout, /marked 1 event seen/);
    assert.equal(JSON.parse(run('events', 'sandboxes', '--unseen', '--json').stdout).length, 0);

    // An agent with no record is an error the caller sees, not a record created.
    const missing = run('emit', 'nobody', '--kind', 'note', '-m', 'hello');
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /no agent record for nobody/);
    assert.equal(fs.existsSync(agents.agentDir('nobody', root)), false);
  } finally { cleanup(root); }
});
