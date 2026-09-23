'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const delivery = require('./delivery');
const { inspect } = require('./delivery-health');
const hash = text => crypto.createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');

async function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-reconcile-'));
  const directory = path.join(root, '.keep/delivery');
  fs.mkdirSync(directory, { recursive: true });
  const add = (kind, text, overrides = {}) => {
    const entry = { kind, sessionId: kind + '-session', pane: 'pane', file: path.join(root, kind + '.jsonl'),
      offset: 0, hash: hash(text), createdAt: Date.now() - 300e3, retainReceipt: false, ...overrides };
    fs.writeFileSync(entry.file, '');
    const journal = path.join(directory, hash(entry.sessionId) + '.json');
    fs.writeFileSync(journal, JSON.stringify(entry));
    return { entry, journal, append: record => fs.appendFileSync(entry.file, JSON.stringify(record) + '\n') };
  };
  try { await fn({ root, directory, add }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('Claude native local-command receipts settle only the exact top-level command', () => fixture(f => {
  const x = f.add('claude', '/exit');
  const text = '<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>';
  x.append({ type: 'assistant', message: { content: text } });
  x.append({ type: 'user', isSidechain: true, message: { content: text } });
  x.append({ type: 'user', message: { content: 'Quoted example: ' + text } });
  x.append({ type: 'user', message: { content: text.replace('/exit', '/help') } });
  assert.equal(delivery.received(x.entry), false);
  x.append({ type: 'user', message: { content: text } });
  assert.equal(delivery.received(x.entry), true);
  assert.deepEqual(inspect(f), []);
  assert.deepEqual(delivery.reconcile(f.directory), [x.entry.sessionId]);
  assert.equal(fs.existsSync(x.journal), false);
}));

test('Codex compaction completion confirms /compact without acknowledging later unrelated work', () => fixture(f => {
  const x = f.add('codex', '/compact', { retainReceipt: true });
  x.append({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'compact-turn' } });
  x.append({ type: 'compacted', payload: { message: '', replacement_history: [] } });
  assert.equal(delivery.received(x.entry), true);
  delivery.reconcile(f.directory);
  assert.equal(delivery.statusForText(f.directory, '/compact').received, true);
  for (const intervening of [
    [{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new work' }] } }],
    [{ type: 'event_msg', payload: { type: 'task_complete' } }],
    [{ type: 'event_msg', payload: { type: 'error' } }],
    [{ type: 'event_msg', payload: { type: 'agent_message' } }],
    [{ type: 'event_msg', payload: { type: 'task_started' } }, { type: 'event_msg', payload: { type: 'task_started' } }],
  ]) {
    const y = f.add('codex', '/compact');
    intervening.forEach(y.append);
    y.append({ type: 'compacted', payload: {} });
    assert.equal(delivery.received(y.entry), false);
    assert.deepEqual(delivery.reconcile(f.directory), []);
  }
  const normal = f.add('codex', 'ordinary reminder');
  normal.append({ type: 'compacted', payload: {} });
  assert.equal(delivery.received(normal.entry), false);
  const prior = f.add('codex', '/compact');
  prior.append({ type: 'compacted', payload: {} });
  prior.entry.offset = fs.statSync(prior.entry.file).size;
  assert.equal(delivery.received(prior.entry), false);
}));

test('unreadable evidence and pending ordinary drafts remain untouched by reconciliation', () => fixture(f => {
  const x = f.add('codex', 'still pending');
  fs.unlinkSync(x.entry.file);
  fs.writeFileSync(path.join(f.directory, 'corrupt.json'), 'broken');
  assert.deepEqual(delivery.reconcile(f.directory), []);
  assert.ok(fs.existsSync(x.journal));
  assert.ok(fs.existsSync(path.join(f.directory, 'corrupt.json')));
  assert.equal(inspect(f).length, 2);
}));

test('late receipt survives reconciliation until the owner retries, without duplicate typing', () => fixture(async f => {
  const x = f.add('codex', 'late answer');
  fs.unlinkSync(x.journal);
  let typed = 0;
  const args = { session: { id: x.entry.sessionId, kind: 'codex' }, pane: 'pane', text: 'late answer', file: x.entry.file,
    directory: f.directory, attempts: 0, precheck: async () => {}, type: async () => { typed++; },
    submitDraft: async () => assert.fail('unexpected Enter'), draftMatches: async () => false };
  await assert.rejects(delivery.deliver(args), /unconfirmed/);
  x.append({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: args.text }] } });
  delivery.reconcile(f.directory);
  assert.equal(fs.existsSync(x.journal), false);
  assert.equal(delivery.statusForText(f.directory, args.text).received, true);
  assert.deepEqual(await delivery.deliver(args), { ok: true, delivery: 'received', recovered: true });
  assert.equal(typed, 1);
  // An archived receipt for a different message must not suppress new work.
  const y = f.add('codex', 'completed command');
  y.append({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'completed command' }] } });
  delivery.reconcile(f.directory);
  const next = { ...args, text: 'new work', attempts: 1, pause: async () => {}, type: async () => {
    typed++;
    y.append({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new work' }] } });
  } };
  assert.equal((await delivery.deliver(next)).delivery, 'received');
  assert.equal(typed, 2);
}));

test('busy injection lock skips reconciliation while continuing read-only health inspection', () => fixture(async f => {
  const rows = [];
  let attempts = 0;
  // The sweep waits the lock out before giving up, so the window is shortened here
  // and its sleep stubbed; what this test is about is what happens once it expires.
  let at = 0;
  const options = { ...f, health: { record: (_name, row) => rows.push(row) },
    reconcileWaitMs: 500, reconcilePollMs: 250, clock: () => at, sleep: ms => { at += ms; return Promise.resolve(); },
    reconcile: async () => { attempts++; throw Object.assign(Error('busy'), { status: 429 }); } };
  const { sweep } = require('./delivery-health');
  for (let n = 0; n < 4; n++) assert.deepEqual(await sweep(options), []);
  assert.equal(attempts, 8, 'each sweep retries the busy lock across its window');
  assert.ok(rows.every(row => row.ok === true));
  f.add('claude', 'genuinely stuck');
  assert.equal((await sweep(options)).length, 1);
  assert.equal(rows.at(-1).ok, false, 'contention must not conceal a real stale draft');
}));

test('retained receipts have a single owner and cannot reappear after acknowledgement', () => fixture(async f => {
  const x = f.add('codex', 'scheduled check', { retainReceipt: true, key: 'card:date', receiptId: hash('key:card:date') });
  x.append({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'scheduled check' }] } });
  delivery.reconcile(f.directory);
  assert.equal(delivery.statusForText(f.directory, 'scheduled check', 'card:date').received, true);
  delivery.acknowledge(f.directory, 'scheduled check', 'card:date');
  assert.equal(delivery.statusForText(f.directory, 'scheduled check', 'card:date'), null);
  await assert.rejects(delivery.deliver({ session: { id: x.entry.sessionId, kind: 'codex' }, pane: 'pane', text: 'unrelated message',
    file: x.entry.file, directory: f.directory, attempts: 0, precheck: async () => {}, type: async () => {},
    submitDraft: async () => assert.fail('unexpected Enter'), draftMatches: async () => false }), /unconfirmed/);
  assert.equal(delivery.statusForText(f.directory, 'scheduled check', 'card:date'), null);
}));

// A pane the list does not mention is normally a draft that will never be typed.
// On a node that did not answer, it is a draft nobody can speak for.
test('a journal on a node that did not answer is left exactly as it was', () => fixture(f => {
  const cold = f.add('claude', 'cold start', { sessionId: 'remote-session', pane: 'r1@aws1', typedAt: Date.now() - 20 * 60e3, createdAt: Date.now() - 20 * 60e3 });
  const gone = f.add('codex', 'really gone', { sessionId: 'gone-session', pane: 'r2@aws1', typedAt: Date.now() - 20 * 60e3, createdAt: Date.now() - 20 * 60e3 });
  const panes = new Set(['local-1']);

  // Cold start: the daemon has just come up and the remote node is unreachable, so
  // its panes are missing from the list for a reason that says nothing about them.
  assert.deepEqual(delivery.reconcile(f.directory, { panes, unknownNodes: new Set(['aws1']) }), []);
  assert.ok(fs.existsSync(cold.journal));
  assert.ok(fs.existsSync(gone.journal));

  // The same after that node's memo has expired and its panes have dropped out of
  // the merged list entirely: still unknown, still not settled.
  assert.deepEqual(delivery.reconcile(f.directory, { panes, unknownNodes: new Set(['aws1']) }), []);
  assert.ok(fs.existsSync(cold.journal));

  // A complete list is a different statement: the node answered and did not mention
  // the pane, so the draft really is gone and is settled as it always was.
  const settled = delivery.reconcile(f.directory, { panes: new Set(['local-1', 'r1@aws1']), unknownNodes: new Set() });
  assert.deepEqual(settled.sort(), ['gone-session']);
  assert.ok(fs.existsSync(cold.journal), 'the pane the node still lists keeps its journal');
  assert.equal(fs.existsSync(gone.journal), false);
}));

test('a journal on the daemon node is unaffected by another node being unknown', () => fixture(f => {
  const local = f.add('claude', 'local draft', { pane: 'p1', typedAt: Date.now() - 20 * 60e3, createdAt: Date.now() - 20 * 60e3 });
  assert.deepEqual(delivery.reconcile(f.directory, { panes: new Set(['p2']), unknownNodes: new Set(['aws1']) }),
    [local.entry.sessionId]);
  assert.equal(fs.existsSync(local.journal), false);
}));

test('with no readable node list, every remote journal is left alone', () => fixture(f => {
  const remote = f.add('claude', 'unreachable node', {
    sessionId: 'remote-session', pane: 'r1@aws1', typedAt: Date.now() - 20 * 60e3, createdAt: Date.now() - 20 * 60e3,
  });
  const local = f.add('codex', 'local draft', {
    sessionId: 'local-session', pane: 'p1', typedAt: Date.now() - 20 * 60e3, createdAt: Date.now() - 20 * 60e3,
  });
  // No node could be named, so no node could be asked: every pane that is not this
  // machine's is one nobody has heard from.
  assert.deepEqual(delivery.reconcile(f.directory, { panes: new Set(['p2']), unknownRemote: true }), ['local-session']);
  assert.ok(fs.existsSync(remote.journal));
  assert.equal(fs.existsSync(local.journal), false, 'this machine still speaks for its own panes');
}));

// ---------- journals on another node, answered by that node ----------

// A typed, stale journal for a session on aws1 whose pane the node still lists. Its
// `file` is the node's path: nothing here may open it (received() refuses a node
// journal outright), so the answers come only from receiptFor.
function nodeJournal(f, text, overrides = {}) {
  return f.add('claude', text, {
    sessionId: `node-session-${hash(text).slice(0, 8)}`, pane: 'r1@aws1', node: 'aws1',
    typedAt: Date.now() - 20 * 60e3, createdAt: Date.now() - 20 * 60e3, ...overrides,
  });
}

test('a node journal is kept while its node says the text is not there', () => fixture(async f => {
  const x = nodeJournal(f, 'not there yet');
  const before = fs.readFileSync(x.journal, 'utf8');
  const asked = [];
  const settled = await delivery.reconcileAsync(f.directory, {
    panes: new Set(['r1@aws1']), receiptFor: async (entry) => { asked.push(entry.sessionId); return false; },
  });
  assert.deepEqual(settled, []);
  assert.deepEqual(asked, [x.entry.sessionId]);
  assert.equal(fs.readFileSync(x.journal, 'utf8'), before, 'kept, byte for byte');
}));

test('a node journal settles when its node says the text is there', () => fixture(async f => {
  // A scheduled check's journal: settling it files the receipt its owner reads.
  const x = nodeJournal(f, 'it landed', { retainReceipt: true });
  const settled = await delivery.reconcileAsync(f.directory, { panes: new Set(['r1@aws1']), receiptFor: async () => true });
  assert.deepEqual(settled, [x.entry.sessionId]);
  assert.equal(fs.existsSync(x.journal), false);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.directory, 'receipts', hash('it landed') + '.json'), 'utf8'));
  assert.deepEqual(receipt, { sessionId: x.entry.sessionId, kind: 'claude', received: true, node: 'aws1' });
}));

test('a node journal whose node does not answer is left untouched, even with its pane absent', () => fixture(async f => {
  const x = nodeJournal(f, 'nobody answered');
  const untyped = nodeJournal(f, 'never typed', { typedAt: undefined });
  const before = [fs.readFileSync(x.journal, 'utf8'), fs.readFileSync(untyped.journal, 'utf8')];
  // A complete pane list without the pane: for a local journal this retires it.
  const settled = await delivery.reconcileAsync(f.directory, {
    panes: new Set(['local-1']), receiptFor: async () => { throw new Error('host request timed out (transcript)'); },
  });
  assert.deepEqual(settled, []);
  assert.deepEqual([fs.readFileSync(x.journal, 'utf8'), fs.readFileSync(untyped.journal, 'utf8')], before);
  // And with no way to ask at all, the same.
  assert.deepEqual(delivery.reconcile(f.directory, { panes: new Set(['local-1']) }), []);
  assert.deepEqual([fs.readFileSync(x.journal, 'utf8'), fs.readFileSync(untyped.journal, 'utf8')], before);
}));

test('a node that answers "not there" gets the same expiry a local journal does', () => fixture(async f => {
  // Typed, and its pane is gone from a list the node answered: settled as a plain send,
  // exactly the local rule. Never typed and stale: dropped, exactly the local rule.
  const typed = nodeJournal(f, 'pane gone');
  const untyped = nodeJournal(f, 'never typed', { typedAt: undefined });
  const settled = await delivery.reconcileAsync(f.directory, { panes: new Set(['local-1']), receiptFor: async () => false });
  assert.deepEqual(settled, [typed.entry.sessionId]);
  assert.equal(fs.existsSync(typed.journal), false);
  assert.equal(fs.existsSync(untyped.journal), false);
}));

test('with no node journals, reconcileAsync is reconcile and asks nobody', () => fixture(async f => {
  const local = f.add('claude', 'local draft', { pane: 'p1', typedAt: Date.now() - 20 * 60e3, createdAt: Date.now() - 20 * 60e3 });
  const settled = await delivery.reconcileAsync(f.directory, {
    panes: new Set(['p2']), receiptFor: async () => assert.fail('no node journal, no question'),
  });
  assert.deepEqual(settled, [local.entry.sessionId]);
}));

test('the health inspection reports a node journal by its node\'s answer', () => fixture(async f => {
  const x = nodeJournal(f, 'health check');
  const name = path.basename(x.journal);
  const key = delivery.nodeReceiptKey(name, x.entry);
  const unanswered = inspect({ root: f.root, staleMs: 0 });
  assert.equal(unanswered.length, 1);
  assert.equal(unanswered[0].reason, 'node-unanswered');
  assert.equal(unanswered[0].node, 'aws1');
  assert.equal(inspect({ root: f.root, staleMs: 0, nodeReceipts: new Map([[key, false]]) })[0].reason, 'receipt-missing');
  assert.deepEqual(inspect({ root: f.root, staleMs: 0, nodeReceipts: new Map([[key, true]]) }), []);
  // The sweep gathers the answers itself when it is given a way to ask.
  const recorded = [];
  const health = { record: (name, value) => recorded.push(value) };
  const issues = await require('./delivery-health').sweep({ root: f.root, health, receiptFor: async () => false });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, 'receipt-missing');
  assert.equal(recorded.at(-1).ok, false);
}));

// ---------- the daemon's reconcile: node answers asked outside the injection lock ----------

function daemonReconcile(f, listing, receiptFor, events = []) {
  const { createDeliveryReconcile } = require('./serve/schedulers.js');
  let locked = false;
  return createDeliveryReconcile({
    directory: f.directory,
    listHostPaneResult: async () => listing,
    withInjectionLock: async (fn) => { locked = true; events.push('lock'); try { return await fn(); } finally { locked = false; events.push('unlock'); } },
    retireLeftDeliveryDrafts: async () => [],
    receiptFor: receiptFor && (async (entry) => { events.push(`ask ${entry.node}${locked ? ' (locked)' : ''}`); return receiptFor(entry); }),
  });
}

test('node receipts are asked before the injection lock, never of a node the list could not hear from, and once per sweep', () => fixture(async f => {
  const heard = nodeJournal(f, 'on aws1', { retainReceipt: true });
  const silent = nodeJournal(f, 'on aws2', { pane: 'r1@aws2', node: 'aws2' });
  const before = fs.readFileSync(silent.journal, 'utf8');
  const listing = { panes: [{ id: 'r1@aws1' }, { id: 'r1@aws2' }], failure: null,
    nodes: { main: { ok: true }, aws1: { ok: true }, aws2: { ok: false, reason: 'timeout', stale: true } }, missingNodes: ['aws2'] };
  const events = [];
  const context = {};
  const settled = await daemonReconcile(f, listing, async () => true, events)(context);
  assert.deepEqual(events, ['ask aws1', 'lock', 'unlock'], 'asked before the lock, and aws2 not at all');
  assert.deepEqual(settled, [heard.entry.sessionId]);
  assert.equal(fs.existsSync(heard.journal), false);
  assert.equal(fs.readFileSync(silent.journal, 'utf8'), before, 'the silent node\'s journal is untouched');
  assert.ok(context.nodeReceipts instanceof Map);

  // A journal replaced between the ask and the lock takes no answer.
  const replaced = nodeJournal(f, 'replaced meanwhile');
  const newer = JSON.stringify({ ...replaced.entry, createdAt: Date.now(), typedAt: Date.now(), offset: 99 });
  await daemonReconcile(f, listing, async (entry) => {
    if (entry.sessionId === replaced.entry.sessionId) fs.writeFileSync(replaced.journal, newer);
    return true;
  })({});
  assert.equal(fs.readFileSync(replaced.journal, 'utf8'), newer);

  // The whole sweep: each node journal is asked once, and the health report judges it
  // by that answer rather than asking again.
  fs.rmSync(replaced.journal);
  const asked = [];
  const recorded = [];
  const issues = await require('./delivery-health').sweep({ root: f.root, health: { record: (name, value) => recorded.push(value) },
    reconcile: daemonReconcile(f, { ...listing, nodes: { ...listing.nodes, aws2: { ok: true } }, missingNodes: [] },
      async (entry) => { asked.push(entry.node); return false; }) });
  assert.deepEqual(asked.sort(), ['aws2'], 'aws2 asked once');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, 'receipt-missing', 'judged by the answer the reconcile got');
}));

test('a single-node sweep reads each journal exactly as it did before node receipts, and asks nobody', () => fixture(async f => {
  const typed = { pane: 'p1', typedAt: Date.now() - 20 * 60e3, createdAt: Date.now() - 20 * 60e3 };
  f.add('claude', 'first draft', typed);
  f.add('codex', 'second draft', typed);
  const listing = { panes: [{ id: 'p1' }], failure: null };
  const reads = async (reconcile) => {
    const counted = [];
    const original = fs.readFileSync;
    fs.readFileSync = function (file, ...rest) {
      if (String(file).startsWith(f.directory) && String(file).endsWith('.json')) counted.push(path.basename(String(file)));
      return original.call(this, file, ...rest);
    };
    try {
      await require('./delivery-health').sweep({ root: f.root, health: { record: () => {} }, reconcile });
    } finally { fs.readFileSync = original; }
    return counted.sort();
  };
  // What the watchdog did before: reconcile, then inspect.
  const baseline = await reads(async () => delivery.reconcile(f.directory, { panes: new Set(['p1']), unknownNodes: new Set(), unknownRemote: false }));
  const now = await reads(daemonReconcile(f, listing, async () => assert.fail('a single node asks nobody')));
  assert.ok(baseline.length > 0);
  assert.deepEqual(now, baseline);
}));
