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
// names a different one, which is the whole point of the mapping. The projects
// are paths because a bare name is resolved against the real checkout tree and
// would fail the write in a fixture root; the area here is chosen by `match` and
// `default`, not by the bot's project.
const AREAS = {
  areas: {
    sandboxes: { project: '/tmp/castle-sandboxes', match: ['^Sandbox '] },
    'app-server': { project: '/tmp/ghost-server', default: true, agent: 'app-responder' },
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
    assert.equal(created.lastEvent, null);
    assert.deepEqual(created.unseen, { count: 0, needsYou: false });

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

test('the record tracks the feed’s end, so a state build never opens events.jsonl', () => {
  const root = makeRoot();
  try {
    agents.ensure('sandboxes', { role: 'incident-responder' }, { root });
    agents.emit('sandboxes', { kind: 'diagnosed', card: 'inc-one', text: 'host pool is full' }, { root, now: 1000 });
    agents.emit('sandboxes', { kind: 'needs-you', card: 'inc-one', needsYou: true, text: 'raise the cap?' }, {
      root, now: 2000, sendAlert: () => {},
    });

    // Every emit advanced the record inside the lock that appended the event.
    const record = agents.readRecord('sandboxes', root);
    assert.deepEqual(record.unseen, { count: 2, needsYou: true });
    assert.deepEqual(record.lastEvent, {
      at: 2000, kind: 'needs-you', card: 'inc-one', severity: 'med', needsYou: true, text: 'raise the cap?',
    });
    assert.equal(Object.hasOwn(record.lastEvent, 'seenAt'), false, 'the row needs a summary, not the event');

    // markSeen recomputes both from the file it rewrites.
    agents.markSeen('sandboxes', 1000, { root, now: 3000 });
    assert.deepEqual(agents.readRecord('sandboxes', root).unseen, { count: 1, needsYou: true });
    agents.markSeen('sandboxes', 9000, { root, now: 4000 });
    assert.deepEqual(agents.readRecord('sandboxes', root).unseen, { count: 0, needsYou: false });
    assert.equal(agents.readRecord('sandboxes', root).lastEvent.kind, 'needs-you', 'seen is not forgotten');

    // A count left behind by a write that failed half-way is repaired, not kept.
    agents.writeRecord('sandboxes', { unseen: { count: 99, needsYou: true } }, { root });
    assert.equal(agents.markSeen('sandboxes', 9000, { root, now: 5000 }).count, 0);
    assert.deepEqual(agents.readRecord('sandboxes', root).unseen, { count: 0, needsYou: false });

    // And the dashboard row comes out of record.json alone: a feed that cannot
    // be read at all changes nothing about it.
    const realReadFileSync = fs.readFileSync;
    let feedReads = 0;
    fs.readFileSync = (file, ...rest) => {
      if (String(file).endsWith('events.jsonl')) { feedReads += 1; throw new Error('events.jsonl is not readable'); }
      return realReadFileSync(file, ...rest);
    };
    let rows;
    try { rows = agents.dashboardAgents({ root }); } finally { fs.readFileSync = realReadFileSync; }
    assert.equal(feedReads, 0, 'the state build did not even try to open the feed');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'sandboxes');
    assert.equal(rows[0].lastEvent.kind, 'needs-you');
    assert.deepEqual(rows[0].unseen, { count: 0, needsYou: false });
  } finally { cleanup(root); }
});

test('a feed read parses only the end of the file', () => {
  const root = makeRoot();
  try {
    agents.ensure('sandboxes', {}, { root });
    // A feed longer than the tail window, written directly: emit would be the
    // slow way to build one and the point here is the read.
    const filler = 'x'.repeat(2000);
    const rows = [];
    for (let index = 0; index < 1200; index += 1) {
      rows.push(JSON.stringify(agents.normalizeEvent({ kind: `e${index}`, at: 1000 + index, text: filler }, 0)));
    }
    fs.writeFileSync(agents.eventsFile('sandboxes', root), rows.join('\n') + '\n');
    assert.ok(fs.statSync(agents.eventsFile('sandboxes', root)).size > agents.TAIL_BYTES,
      'the fixture is bigger than the window');

    const page = agents.readEvents('sandboxes', { root, limit: 3 });
    assert.deepEqual(page.map((event) => event.kind), ['e1199', 'e1198', 'e1197'], 'newest first');
    // The window starts mid-file, so the line it cut in half is dropped rather
    // than parsed as a truncated record.
    const all = agents.readEvents('sandboxes', { root, limit: 2000 });
    assert.ok(all.length > 1 && all.length < 1200, `a bounded slice of the feed, got ${all.length}`);
    assert.equal(all.every((event) => /^e\d+$/.test(event.kind)), true, 'no half-parsed line survived');
    // markSeen still sees the whole file: it rewrites it.
    assert.equal(agents.markSeen('sandboxes', 9000, { root, now: 5000 }).marked, 1200);
  } finally { cleanup(root); }
});

// One line of a feed, exactly `lineBytes` long including its newline, so a test
// can put the tail window's start on a byte it chose.
function paddedFeedLine(index, lineBytes) {
  const event = { at: 1000 + index, kind: `e${index}`, card: '', severity: 'med', needsYou: false, seenAt: 0, text: '' };
  const pad = lineBytes - 1 - JSON.stringify(event).length;
  assert.ok(pad >= 0, `line ${index} does not fit in ${lineBytes} bytes`);
  event.text = 'x'.repeat(pad);
  const line = JSON.stringify(event);
  assert.equal(Buffer.byteLength(line) + 1, lineBytes);
  return line;
}

function writePaddedFeed(root, name, count, lineBytes) {
  const rows = [];
  for (let index = 0; index < count; index += 1) rows.push(paddedFeedLine(index, lineBytes));
  fs.writeFileSync(agents.eventsFile(name, root), rows.join('\n') + '\n');
  return count * lineBytes;
}

test('a tail window that starts on a line start keeps that line', () => {
  const root = makeRoot();
  try {
    agents.ensure('sandboxes', {}, { root });
    // 512 divides the window exactly, so `size - TAIL_BYTES` lands on a line
    // start and nothing was cut: every line in the window is a whole record.
    const size = writePaddedFeed(root, 'sandboxes', 600, 512);
    const start = size - agents.TAIL_BYTES;
    assert.equal(start % 512, 0, 'the fixture puts the window start on a line start');
    const kept = agents.readEvents('sandboxes', { root, limit: 2000 });
    assert.equal(kept.length, 512, 'the whole window, with no line discarded');
    assert.equal(kept[0].kind, 'e599');
    assert.equal(kept.at(-1).kind, `e${start / 512}`, 'the line at the window edge survived');

    // 500 does not, so the offset lands inside a line; that one is dropped and
    // nothing else is.
    const oddSize = writePaddedFeed(root, 'sandboxes', 600, 500);
    const oddStart = oddSize - agents.TAIL_BYTES;
    assert.notEqual(oddStart % 500, 0, 'the fixture cuts a line in half');
    const cut = agents.readEvents('sandboxes', { root, limit: 2000 });
    assert.equal(cut.length, 600 - Math.ceil(oddStart / 500), 'exactly the cut line is missing');
    assert.equal(cut.at(-1).kind, `e${Math.ceil(oddStart / 500)}`);
    assert.equal(cut.every((event) => /^e\d+$/.test(event.kind)), true, 'no half-parsed line survived');
  } finally { cleanup(root); }
});

test('a feed that cannot be read fails markSeen instead of emptying the record', async () => {
  const root = makeRoot();
  try {
    agents.ensure('sandboxes', {}, { root });
    agents.emit('sandboxes', { kind: 'diagnosed', card: 'inc-one', text: 'host pool is full' }, { root, now: 1000 });
    agents.emit('sandboxes', { kind: 'needs-you', card: 'inc-one', needsYou: true, text: 'raise the cap?' }, {
      root, now: 2000, sendAlert: () => {},
    });
    const before = fs.readFileSync(agents.recordFile('sandboxes', root), 'utf8');
    const feed = fs.readFileSync(agents.eventsFile('sandboxes', root), 'utf8');

    const realReadFileSync = fs.readFileSync;
    fs.readFileSync = (file, ...rest) => {
      if (String(file).endsWith('events.jsonl')) {
        const error = new Error(`EACCES: permission denied, open '${file}'`);
        error.code = 'EACCES';
        throw error;
      }
      return realReadFileSync(file, ...rest);
    };
    try {
      // An unreadable feed is not an empty one. Rewriting it from nothing would
      // delete the events and reset the summary while both were fine on disk.
      assert.throws(() => agents.markSeen('sandboxes', 9000, { root, now: 3000 }), /EACCES/);
      assert.equal(fs.existsSync(agents.agentsDir(root)), true);

      // The route turns it into a 500 rather than a silent success.
      const { routes, matchRoute } = require('./serve/routes.js');
      const list = routes({ keep: { ROOT: root }, broadcast: () => {}, json: (res, status, value) => ({ status, value }) });
      const url = new URL('http://x/api/agents/sandboxes/seen');
      const route = matchRoute(list, { req: { method: 'POST', headers: {} }, url, body: {} });
      const answer = await route.handle({ req: { method: 'POST', headers: {} }, res: {}, url, body: {} });
      assert.equal(answer.status, 500);
      assert.match(answer.value.error, /EACCES/);
    } finally { fs.readFileSync = realReadFileSync; }

    assert.equal(fs.readFileSync(agents.recordFile('sandboxes', root), 'utf8'), before, 'the record is untouched');
    assert.equal(fs.readFileSync(agents.eventsFile('sandboxes', root), 'utf8'), feed, 'and so is the feed');
    assert.deepEqual(agents.readRecord('sandboxes', root).unseen, { count: 2, needsYou: true });

    // A feed that is simply not there yet is still empty, not an error.
    agents.ensure('app-responder', {}, { root });
    assert.deepEqual(agents.loadEvents('app-responder', root), []);
    assert.deepEqual(agents.readEvents('app-responder', { root }), []);
    assert.equal(agents.markSeen('app-responder', 9000, { root }).marked, 0);
    // And one unreadable line is skipped, not fatal.
    fs.appendFileSync(agents.eventsFile('app-responder', root), 'not json\n');
    agents.emit('app-responder', { kind: 'note', text: 'after the bad line' }, { root, now: 4000 });
    assert.deepEqual(agents.readEvents('app-responder', { root }).map((entry) => entry.kind), ['note']);
  } finally { cleanup(root); }
});

test('an event that landed keeps its alert and heals the summary on the next emit', () => {
  const root = makeRoot();
  try {
    agents.ensure('sandboxes', {}, { root });
    agents.emit('sandboxes', { kind: 'diagnosed', card: 'inc-one', text: 'host pool is full' }, { root, now: 1000 });
    assert.deepEqual(agents.readRecord('sandboxes', root).unseen, { count: 1, needsYou: false });
    agents.flushCommits(root);

    const sent = [];
    const stderr = [];
    const realWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = (file, ...rest) => {
      if (String(file).includes('record.json')) throw new Error('ENOSPC: no space left on device');
      return realWriteFileSync(file, ...rest);
    };
    let landed;
    try {
      landed = agents.emit('sandboxes', {
        kind: 'needs-you', card: 'inc-two', needsYou: true, text: 'raise the cap or drain?',
      }, { root, now: 2000, sendAlert: (request) => sent.push(request), write: (line) => stderr.push(line) });
    } finally { fs.writeFileSync = realWriteFileSync; }

    // The append is the durable act: the event exists, so it alerts and it is
    // committed, whatever happened to the summary afterwards.
    assert.equal(landed.kind, 'needs-you');
    assert.equal(lines(root, 'sandboxes').length, 2);
    assert.equal(sent.length, 1, 'a needs-you event that landed still reaches Owner');
    assert.equal(sent[0].key, 'agent:sandboxes:inc-two');
    assert.deepEqual(agents.pendingNames(root), ['sandboxes'], 'and it is still waiting to be committed');
    assert.equal(stderr.length, 1);
    assert.match(stderr[0], /wrote the needs-you event for sandboxes but not its summary/);
    assert.deepEqual(agents.readRecord('sandboxes', root).unseen, { count: 1, needsYou: false }, 'the summary is stale');

    // The next emit rebuilds the summary from the feed rather than counting up
    // from the stale record, so it heals instead of drifting further.
    agents.emit('sandboxes', { kind: 'watching', card: 'inc-two', text: 'waiting for the next scrape' }, { root, now: 3000 });
    const record = agents.readRecord('sandboxes', root);
    assert.deepEqual(record.unseen, { count: 3, needsYou: true }, 'three unseen, not the stale one plus one');
    assert.equal(record.lastEvent.kind, 'watching');
    assert.equal(record.lastEvent.at, 3000);
  } finally { cleanup(root); }
});

test('markSeen rewrites and emit appends under one lock each, losing neither write', () => {
  const root = makeRoot();
  try {
    agents.ensure('sandboxes', {}, { root });
    let depth = 0;
    let nested = false;
    const holds = [];
    const withLock = (fn) => {
      if (depth > 0) nested = true;
      depth += 1;
      holds.push('enter');
      try { return fn(); } finally { depth -= 1; holds.push('exit'); }
    };
    agents.emit('sandboxes', { kind: 'one', at: 1000 }, { root, withLock });
    agents.emit('sandboxes', { kind: 'two', at: 2000 }, { root, withLock });
    // The whole load-stamp-rewrite is one hold: an emit that landed between the
    // read and the rewrite would be erased by it, which is why they share a lock.
    assert.equal(agents.markSeen('sandboxes', 9000, { root, now: 3000, withLock }).marked, 2);
    // A third event arrives after the rewrite and is not lost by it.
    agents.emit('sandboxes', { kind: 'three', at: 4000 }, { root, withLock });

    assert.equal(nested, false, 'no write takes the registry lock twice');
    assert.equal(holds.length, 8, 'one enter/exit pair per write, read-modify-write included');
    const written = lines(root, 'sandboxes');
    assert.deepEqual(written.map((event) => event.kind), ['one', 'two', 'three']);
    assert.deepEqual(written.map((event) => event.seenAt), [3000, 3000, 0]);
    assert.deepEqual(agents.readRecord('sandboxes', root).unseen, { count: 1, needsYou: false });
    assert.equal(agents.readRecord('sandboxes', root).lastEvent.kind, 'three');
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

test('a session carrying an agent is marked with its name, by id, pane or pane meta', () => {
  const root = makeRoot();
  try {
    agents.ensure('sandboxes', { session: { id: 'sess-1', pane: 'pane-1' } }, { root });
    agents.ensure('app-responder', { session: { id: '', pane: 'pane-2' } }, { root });
    const sessions = [
      { id: 'sess-1', pane: 'pane-9' },
      { id: 'sess-2', pane: 'pane-2' },
      { id: 'sess-3', pane: 'pane-3', runtime: { paneId: 'pane-2' } },
      { id: 'sess-4', pane: 'pane-4' },
      { id: 'sess-5', pane: 'pane-5' },
    ];
    const panes = [
      // A pane an agent owns names it, and a record that has not caught up with
      // a replaced pane does not hide it.
      { id: 'pane-5', meta: { agent: 'claude', agentName: 'sandboxes' } },
      // `meta.agent` on its own is the provider and names no agent at all.
      { id: 'pane-4', meta: { agent: 'codex' } },
      { id: 'pane-6', meta: { agentName: 'not-a-record' } },
    ];
    agents.applySessions(sessions, agents.records(root), panes);
    assert.deepEqual(sessions.map((session) => session.agentName),
      ['sandboxes', 'app-responder', 'app-responder', undefined, 'sandboxes']);
  } finally { cleanup(root); }
});

// `agent` is the provider — claude or codex — on sessions, pane meta, process
// rows and the mobile contract. The standing agent's name is a separate field
// precisely so a codex-backed agent session does not surface as codex-less.
test('the provider field survives: a codex session keeps agent and gains agentName', () => {
  const root = makeRoot();
  try {
    agents.ensure('sandboxes', { session: { id: 'sess-codex', pane: 'pane-1' } }, { root });
    const session = { id: 'sess-codex', kind: 'codex', agent: 'codex', pane: 'pane-1' };
    agents.applySessions([session], agents.records(root));
    assert.equal(session.agent, 'codex', 'the provider is untouched');
    assert.equal(session.kind, 'codex');
    assert.equal(session.agentName, 'sandboxes');

    // The mobile projection carries both, and they do not stand in for each other.
    const { sessionSummary, projectMobileState } = require('./mobile-state.js');
    const summary = sessionSummary(session);
    assert.equal(summary.agent, 'codex');
    assert.equal(summary.agentName, 'sandboxes');
    const view = projectMobileState({ sessions: [session], attention: [], tasks: [], panes: [], agents: [{ name: 'sandboxes' }] }, 'fleet');
    assert.equal(view.sessions[0].agent, 'codex');
    assert.equal(view.sessions[0].agentName, 'sandboxes');
    assert.deepEqual(view.agents, [{ name: 'sandboxes' }]);
  } finally { cleanup(root); }
});

// ---------- the routes ----------

test('the agent routes match through the real ladder without shadowing an exact path', async () => {
  const root = makeRoot();
  try {
    agents.ensure('sandboxes', {}, { root });
    agents.emit('sandboxes', { kind: 'diagnosed', card: 'inc-one', text: 'host pool is full' }, { root, now: 1000 });

    const { routes, matchRoute } = require('./serve/routes.js');
    const broadcasts = [];
    const list = routes({
      keep: { ROOT: root },
      broadcast: () => broadcasts.push('state'),
      json: (res, status, value) => ({ status, value }),
    });
    const match = (method, pathname) => {
      const url = new URL(`http://x${pathname}`);
      const route = matchRoute(list, { req: { method, headers: { 'x-keep': '1' } }, url, body: {} });
      return { route, url };
    };
    const call = async (method, pathname, body = {}) => {
      const { route, url } = match(method, pathname);
      assert.ok(route, `${method} ${pathname} matched no route`);
      return route.handle({ req: { method, headers: { 'x-keep': '1' } }, res: {}, url, body });
    };

    const read = await call('GET', '/api/agents/sandboxes/events?limit=5');
    assert.equal(read.status, 200);
    assert.deepEqual(read.value.events.map((event) => event.kind), ['diagnosed']);

    const seen = await call('POST', '/api/agents/sandboxes/seen');
    assert.equal(seen.status, 200);
    assert.deepEqual({ marked: seen.value.marked, count: seen.value.count }, { marked: 1, count: 0 });
    assert.deepEqual(broadcasts, ['state'], 'the badge only clears on a rebuilt state');

    // An encoded traversal reaches the route — the pathname keeps its %2F — and
    // the handler refuses it rather than reading whatever it points at.
    for (const pathname of ['/api/agents/..%2F..%2Fetc/events', '/api/agents/Sandboxes/events']) {
      const refused = await call('GET', pathname);
      assert.equal(refused.status, 400);
      assert.equal(refused.value.error, 'bad agent name');
    }
    assert.equal((await call('POST', '/api/agents/..%2F..%2Fetc/seen')).status, 400);
    assert.equal(fs.existsSync(path.join(root, '.keep', 'agents', '..')), true, 'the parent dir, untouched');
    assert.deepEqual(fs.readdirSync(path.join(root, '.keep', 'agents')), ['sandboxes']);

    // A missing x-keep header is still a 403 on the read, as on every other
    // route that exposes session detail.
    const { route: guarded, url } = match('GET', '/api/agents/sandboxes/events');
    assert.equal((await guarded.handle({ req: { method: 'GET', headers: {} }, res: {}, url })).status, 403);

    // The patterns own exactly their own paths, and nothing else moved.
    assert.equal(match('GET', '/api/agents/sandboxes/seen').route, null);
    assert.equal(match('POST', '/api/agents/sandboxes/events').route, null);
    assert.equal(match('GET', '/api/agents/a/b/events').route, null);
    assert.equal(match('GET', '/api/state').route.path, '/api/state');
    assert.equal(match('POST', '/api/terminal-profile').route.path, '/api/terminal-profile');
    assert.equal(match('GET', '/api/panes').route.path, '/api/panes');
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
