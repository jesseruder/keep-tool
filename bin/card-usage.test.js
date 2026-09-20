'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const usage = require('./card-usage');
const start = Date.now() - 60000;
const timestamp = n => new Date(start + n).toISOString();
const claude = (id, at, output = 10, model = 'claude-test') => ({
  type: 'assistant', sessionId: 's', timestamp: timestamp(at),
  message: { id, model, usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: output } },
});
const meta = (id = 's', at = -1000, parent) => ({ type: 'session_meta', timestamp: timestamp(at), payload: { id, ...(parent ? { parent_thread_id: parent } : {}) } });
const context = model => ({ type: 'turn_context', payload: { model } });
const counts = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output });
const codex = (at, total, last = total) => ({ type: 'event_msg', timestamp: timestamp(at), payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
function fixture(t, agent = 'claude') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-card-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 's.jsonl');
  const files = [{ file, agent }];
  const tasks = [{ id: 'a', fm: { sessions: [{ id: 's', agent }] } }];
  const append = (...rows) => fs.appendFileSync(file, rows.map(r => JSON.stringify(r) + '\n').join(''));
  const collect = (opts = {}) => usage.collect(root, tasks, { now: start, files, ...opts });
  return { root, file, files, tasks, append, collect };
}
test('forward cutoff, repeated Claude chunks, model switches, retries and durable checkpoints', t => {
  const f = fixture(t);
  f.append(claude('old', -1));
  assert.equal(f.collect().cards.a, undefined);
  f.append(claude('one', 10), claude('one', 11), claude('one', 12, 20), claude('retry', 15, 5, 'other'));
  const first = f.collect();
  assert.equal(first.cards.a.calls, 2);
  assert.equal(first.cards.a.output, 25);
  assert.equal(first.cards.a.input, 200);
  assert.equal(first.cards.a.cacheRead, 400);
  assert.equal(first.cards.a.models['claude/other'].output, 5);
  assert.deepEqual(f.collect({ now: start + 5000 }).cards, first.cards);
});
test('ownership moves before a delayed collection without moving prior usage; release stops attribution', t => {
  const f = fixture(t);
  f.collect();
  f.append(claude('a-call', 10));
  usage.recordOwner(f.root, { id: 's', agent: 'claude' }, 'b', start + 20);
  f.append(claude('b-call', 30));
  usage.recordOwner(f.root, { id: 's', agent: 'claude' }, null, start + 40);
  f.append(claude('unassigned', 50));
  const result = f.collect();
  assert.equal(result.cards.a.calls, 1);
  assert.equal(result.cards.b.calls, 1);
  assert.equal(result.unassigned, 1);
  f.tasks.length = 0; // archived/deleted card is not required for retained totals
  assert.deepEqual(f.collect().cards, result.cards);
});
test('Claude child remains on original card after parent transfer, including late discovery', t => {
  const f = fixture(t);
  f.collect();
  const child = path.join(f.root, 's', 'subagents', 'agent-child.jsonl');
  fs.mkdirSync(path.dirname(child), { recursive: true });
  fs.writeFileSync(child, [ { type: 'user', timestamp: timestamp(10), sessionId: 's' }, claude('child-call', 40) ].map(r => JSON.stringify(r) + '\n').join(''));
  usage.recordOwner(f.root, { id: 's', agent: 'claude' }, 'b', start + 20);
  f.files.push({ file: child, agent: 'claude' });
  assert.equal(f.collect().cards.a.calls, 1);
});
test('Codex cumulative baseline, repeated counts, cache subset and model changes', t => {
  const f = fixture(t, 'codex');
  f.append(meta(), context('first'), codex(-1, counts(1000, 700, 20)));
  f.collect();
  f.append(codex(10, counts(1100, 780, 25)), codex(11, counts(1100, 780, 25)), context('second'), codex(20, counts(1300, 880, 35)));
  const r = f.collect().cards.a;
  assert.equal(r.calls, 2);
  assert.equal(r.input, 120);
  assert.equal(r.cacheRead, 180);
  assert.equal(r.output, 15);
  assert.equal(r.models['codex/first'].input, 20);
  assert.equal(r.models['codex/second'].input, 100);
});
test('Codex reset, transcript replacement and replay do not double charge', t => {
  const f = fixture(t, 'codex');
  f.collect();
  const rows = [meta(), context('m'), codex(10, counts(100, 50, 10)), codex(20, counts(20, 10, 2))];
  f.append(...rows);
  const before = f.collect().cards;
  fs.unlinkSync(f.file);
  f.append(...rows);
  assert.deepEqual(f.collect().cards, before);
  fs.writeFileSync(f.file, ''); f.collect();
  f.append(...rows, codex(30, counts(40, 20, 4)));
  assert.equal(f.collect().cards.a.output, 14);
});
test('nested Codex children resolve even when child file is processed before parent', t => {
  const f = fixture(t, 'codex'); f.collect();
  usage.recordOwner(f.root, { id: 's', agent: 'codex' }, 'b', start + 20);
  const child = path.join(f.root, 'child.jsonl');
  const grandchild = path.join(f.root, 'grandchild.jsonl');
  fs.writeFileSync(child, JSON.stringify(meta('child', 10, 's')) + '\n');
  fs.writeFileSync(grandchild, [meta('grandchild', 30, 'child'), context('m'), codex(40, counts(100, 0, 20))].map(r => JSON.stringify(r) + '\n').join(''));
  f.files.unshift({ file: grandchild, agent: 'codex' }, { file: child, agent: 'codex' });
  assert.equal(f.collect().cards.a.output, 20);
});
test('partial UTF-8 lines are retried only after newline and no checkpoint advances past them', t => {
  const f = fixture(t); f.collect();
  const row = JSON.stringify({ ...claude('partial', 10), extra: '🌺' }) + '\n';
  const bytes = Buffer.from(row); const split = bytes.indexOf(Buffer.from('🌺')) + 1;
  fs.writeFileSync(f.file, bytes.subarray(0, split));
  assert.equal(f.collect().cards.a, undefined);
  fs.appendFileSync(f.file, bytes.subarray(split));
  assert.equal(f.collect().cards.a.calls, 1);
  assert.equal(f.collect().cards.a.calls, 1);
});
test('corrupt persisted ledger fails closed without resetting the accounting cutoff', t => {
  const f = fixture(t); f.collect();
  const file = path.join(f.root, '.keep/card-usage/ledger.json');
  fs.writeFileSync(file, 'corrupt');
  assert.throws(() => f.collect());
  assert.equal(fs.readFileSync(file, 'utf8'), 'corrupt');
});
test('Claude replay in another transcript deduplicates by message identity', t => {
  const f = fixture(t); f.collect(); f.append(claude('one', 10));
  const other = path.join(f.root, 'copy.jsonl'); fs.copyFileSync(f.file, other);
  f.files.push({ file: other, agent: 'claude' });
  assert.equal(f.collect().cards.a.calls, 1);
});
test('usage renderer escapes model names and excludes reasoning from total', () => {
  const source = fs.readFileSync(path.join(__dirname, '../web/app/model-usage.js'), 'utf8').replace('export function', 'function');
  const ctx = vm.createContext({}); vm.runInContext(source, ctx);
  const html = ctx.modelUsageHTML({ since: start, input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 3, calls: 1, models: { '<script>': { input: 1, output: 4, calls: 1 } } });
  assert.match(html, /10 tokens/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
});

test('an old Claude response finishing after activation is excluded, not backfilled', t => {
  const f = fixture(t); f.append(claude('old', -1)); f.collect();
  f.append(claude('old', 10, 20), claude('new', 20));
  assert.equal(f.collect().cards.a.calls, 1);
  assert.equal(f.collect().cards.a.output, 10);
});
test('same-inode rewrite at the same size is detected, with prior totals retained', t => {
  const f = fixture(t); f.collect(); f.append(claude('aaa', 10)); f.collect();
  fs.writeFileSync(f.file, JSON.stringify(claude('bbb', 20)) + '\n');
  assert.equal(f.collect().cards.a.calls, 2);
});
test('a fully read file with unchanged size and mtime is not reopened', t => {
  const f = fixture(t); f.collect(); f.append(claude('one', 10));
  assert.equal(f.collect().cards.a.calls, 1);
  const openSync = fs.openSync; let opened = 0;
  fs.openSync = (file, ...rest) => { if (file === f.file) opened++; return openSync(file, ...rest); };
  t.after(() => { fs.openSync = openSync; });
  assert.equal(f.collect().cards.a.calls, 1);
  assert.equal(opened, 0);
  const later = new Date(fs.statSync(f.file).mtimeMs + 5000);
  fs.utimesSync(f.file, later, later);
  f.collect();
  assert.equal(opened, 1, 'a changed mtime re-checks the anchor');
});
test('initialize loads cards only when it creates the ledger', t => {
  const f = fixture(t);
  assert.equal(usage.initialize(f.root, () => f.tasks, start), true);
  assert.equal(usage.initialize(f.root, () => { throw new Error('cards loaded'); }, start), false);
});
test('the collect lock admits one collector, reclaims a dead holder, and releases on error', t => {
  const f = fixture(t);
  const lock = path.join(f.root, '.keep/card-usage/collect.lock');
  let inner;
  assert.equal(usage.withCollectLock(f.root, () => { inner = usage.withCollectLock(f.root, () => 'ran'); return 'outer'; }), 'outer');
  assert.deepEqual(inner, { skipped: true, pid: process.pid });
  assert.equal(fs.existsSync(lock), false);
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2 ** 31 - 2, at: start }));
  assert.equal(usage.withCollectLock(f.root, () => 'reclaimed'), 'reclaimed');
  assert.throws(() => usage.withCollectLock(f.root, () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(lock), false);
});
test('an owner change recorded while transcripts are being read applies to rows after it', t => {
  const f = fixture(t); f.collect(); f.append(claude('one', 10));
  const openSync = fs.openSync;
  fs.openSync = (file, ...rest) => {
    if (file === f.file) usage.recordOwner(f.root, { id: 's', agent: 'claude' }, 'b', start + 5);
    return openSync(file, ...rest);
  };
  t.after(() => { fs.openSync = openSync; });
  const result = f.collect();
  fs.openSync = openSync;
  assert.equal(result.cards.b?.calls, 1);
  assert.equal(result.cards.a, undefined);
});
test('a record larger than the pass budget makes forward progress', t => {
  const f = fixture(t); f.collect(); f.append(claude('large', 10), claude('next', 20));
  assert.equal(f.collect({ budget: 10 }).cards.a.calls, 2);
});
test('preexisting Codex rollout without a baseline uses only the last call and reports the gap', t => {
  const f = fixture(t, 'codex'); f.collect();
  f.append(meta(), context('m'), codex(10, counts(100000, 50000, 1000), counts(100, 50, 5)));
  const r = f.collect();
  assert.equal(r.cards.a.output, 5);
  assert.equal(r.issues.missingCodexBaseline, true);
});

test('forked Codex transcripts baseline inherited counters without charging copied parent calls', t => {
  const f = fixture(t, 'codex'); f.collect();
  f.append(meta('s', 0), context('m'), codex(10, counts(100, 50, 10)));
  const child = path.join(f.root, 'child.jsonl');
  fs.writeFileSync(child, [meta('child', 20, 's'), context('m'), codex(10, counts(100, 50, 10)), codex(30, counts(130, 60, 15))].map(r => JSON.stringify(r) + '\n').join(''));
  f.files.push({ file: child, agent: 'codex' });
  const r = f.collect().cards.a;
  assert.equal(r.output, 15); assert.equal(r.input, 70); assert.equal(r.calls, 2);
});
test('Claude-to-Codex child ownership uses the explicit parent record', t => {
  const f = fixture(t); f.collect();
  const record = path.join(f.root, '.keep/codex-parents/c.json');
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, JSON.stringify({ parent: 's' }));
  const child = path.join(f.root, 'c.jsonl');
  fs.writeFileSync(child, [meta('c', 10), context('m'), codex(30, counts(100, 10, 5))].map(r => JSON.stringify(r) + '\n').join(''));
  usage.recordOwner(f.root, { id: 's', agent: 'claude' }, 'b', start + 20);
  f.files.push({ file: child, agent: 'codex' });
  assert.equal(f.collect().cards.a.output, 5);
});

test('rewritten post-cutoff Codex file keeps the session cumulative baseline', t => {
  const f = fixture(t, 'codex'); f.collect();
  f.append(meta('s', 0), context('m'), codex(10, counts(100, 0, 10)));
  assert.equal(f.collect().cards.a.input, 100);
  fs.writeFileSync(f.file, [meta('s', 0), context('m'), codex(20, counts(120, 0, 12), counts(20, 0, 2))].map(r => JSON.stringify(r) + '\n').join(''));
  assert.equal(f.collect().cards.a.input, 120);
});
test('a late Claude-to-Codex parent record resolves checkpointed usage', t => {
  const f = fixture(t); f.collect();
  const child = path.join(f.root, 'c.jsonl');
  fs.writeFileSync(child, [meta('c', 10), context('m'), codex(20, counts(100, 0, 5))].map(r => JSON.stringify(r) + '\n').join(''));
  f.files.push({ file: child, agent: 'codex' });
  assert.equal(f.collect().unassigned, 1);
  const record = path.join(f.root, '.keep/codex-parents/c.json');
  fs.mkdirSync(path.dirname(record), { recursive: true }); fs.writeFileSync(record, JSON.stringify({ parent: 's' }));
  assert.equal(f.collect().cards.a.output, 5);
});
test('valid card slugs matching object prototype properties are accounted normally', t => {
  const f = fixture(t); f.tasks[0].id = 'constructor'; f.collect(); f.append(claude('one', 10));
  assert.equal(f.collect().cards.constructor.calls, 1);
});
test('a missing ledger cannot overwrite existing accounting with a new cutoff', t => {
  const f = fixture(t); f.collect(); f.append(claude('one', 10)); const prior = f.collect();
  fs.unlinkSync(path.join(f.root, '.keep/card-usage/ledger.json'));
  assert.throws(() => f.collect(), /ledger is missing/);
  assert.deepEqual(usage.snapshot(f.root).cards.a, prior.cards.a);
});

test('an empty reserved-name card has a complete zero summary after JSON roundtrip', () => {
  const summary = JSON.parse(JSON.stringify({ since: start, cards: {} }));
  const card = usage.forCard(summary, 'constructor');
  assert.equal(card.input, 0); assert.equal(card.calls, 0); assert.deepEqual(card.models, {});
});

test('a new Codex root session counts its full first total even when it covers multiple calls', t => {
  const f = fixture(t, 'codex'); f.collect();
  f.append(meta('s', 0), context('m'), codex(10, counts(120, 30, 12), counts(20, 0, 2)));
  const r = f.collect();
  assert.equal(r.cards.a.input, 90); assert.equal(r.cards.a.cacheRead, 30); assert.equal(r.cards.a.output, 12);
  assert.deepEqual(r.issues, {});
});

test('a rewritten child rollout retains its parent after the temporary parent record is removed', t => {
  const f = fixture(t); f.collect();
  const record = path.join(f.root, '.keep/codex-parents/c.json');
  fs.mkdirSync(path.dirname(record), { recursive: true }); fs.writeFileSync(record, JSON.stringify({ parent: 's' }));
  const child = path.join(f.root, 'c.jsonl');
  const rows = [meta('c', 10), context('m'), codex(20, counts(100, 0, 5))];
  fs.writeFileSync(child, rows.map(r => JSON.stringify(r) + '\n').join(''));
  f.files.push({ file: child, agent: 'codex' }); assert.equal(f.collect().cards.a.output, 5);
  fs.unlinkSync(record); fs.unlinkSync(child);
  fs.writeFileSync(child, [meta('c', 10), context('m'), codex(30, counts(120, 0, 7), counts(20, 0, 2))].map(r => JSON.stringify(r) + '\n').join(''));
  assert.equal(f.collect().cards.a.output, 7);
});

test('discovery walks every configured account root while options.home stays isolated', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-card-usage-roots-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const records = [
    { id: 'claude-one', agent: 'claude', configDir: path.join(root, 'claude-one') },
    { id: 'claude-two', agent: 'claude', configDir: path.join(root, 'claude-two') },
    { id: 'codex-one', agent: 'codex', configDir: path.join(root, 'codex-one') },
  ];
  const expected = [];
  for (const account of records) {
    const folders = account.agent === 'claude' ? ['projects/p'] : ['sessions/2026/09/11', 'archived_sessions'];
    for (const folder of folders) {
      const file = path.join(account.configDir, folder, `${account.id}-${folder.includes('archived') ? 'old' : 'live'}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
      expected.push(`${account.id}:${file}`);
    }
  }
  const found = usage.discover(undefined, { accounts: { list: () => records } });
  assert.deepEqual(found.map((source) => `${source.accountId}:${source.file}`).sort(), expected.sort());

  const fixtureHome = path.join(root, 'fixture-home');
  const fixtureFile = path.join(fixtureHome, '.claude', 'projects', 'p', 'fixture.jsonl');
  fs.mkdirSync(path.dirname(fixtureFile), { recursive: true });
  fs.writeFileSync(fixtureFile, '');
  assert.deepEqual(usage.discover(fixtureHome), [{ file: fixtureFile, agent: 'claude' }]);
});

test('account authority filters copied transcript roots before attribution', t => {
  const f = fixture(t);
  f.collect();
  const source = path.join(f.root, 'source', 's.jsonl');
  const target = path.join(f.root, 'target', 's.jsonl');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(source, JSON.stringify(claude('wrong-account', 10, 90)) + '\n');
  fs.writeFileSync(target, JSON.stringify(claude('right-account', 20, 7)) + '\n');
  const result = f.collect({
    files: [
      { file: source, agent: 'claude', accountId: 'old-account' },
      { file: target, agent: 'claude', accountId: 'new-account' },
    ],
    authority: { s: { agent: 'claude', accountId: 'new-account' } },
  });
  assert.equal(result.cards.a.calls, 1);
  assert.equal(result.cards.a.output, 7);
});

test('staged target usage is replayed once after account authority commits', t => {
  const f = fixture(t);
  f.collect();
  f.append(claude('before-handoff', 10, 7));
  const target = path.join(f.root, 'target', 's.jsonl');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(f.file, target);
  fs.appendFileSync(target, JSON.stringify(claude('during-handoff', 20, 9)) + '\n');
  const files = [
    { file: f.file, agent: 'claude', accountId: 'old-account' },
    { file: target, agent: 'claude', accountId: 'new-account' },
  ];
  const staged = { s: { agent: 'claude', accountId: 'old-account', stagedAccountId: 'new-account' } };
  assert.equal(f.collect({ files, authority: staged }).cards.a.output, 7);
  assert.equal(f.collect({ files, authority: staged }).cards.a.output, 7);
  const committed = { s: { agent: 'claude', accountId: 'new-account' } };
  const result = f.collect({ files, authority: committed });
  assert.equal(result.cards.a.output, 16);
  assert.equal(result.cards.a.calls, 2, 'the copied historical message is not counted twice');
  assert.equal(f.collect({ files, authority: committed }).cards.a.output, 16);
});

test('usage recorded before a session links lands on the first card it links to', t => {
  const f = fixture(t);
  f.tasks.length = 0; // nothing is linked when the ledger is created
  f.collect();
  f.append(claude('pre-link', 10));
  assert.equal(f.collect().unassigned, 1, 'an unlinked session is unassigned until it links');
  usage.recordOwner(f.root, { id: 's', agent: 'claude' }, 'a', start + 20);
  f.append(claude('post-link', 30));
  const linked = f.collect();
  assert.equal(linked.cards.a.calls, 2, 'the already-recorded fact is re-resolved onto the first card');
  assert.equal(linked.unassigned, 0);
  usage.recordOwner(f.root, { id: 's', agent: 'claude' }, null, start + 40);
  f.append(claude('released', 50));
  const released = f.collect();
  assert.equal(released.cards.a.calls, 2, 'a release still stops attribution');
  assert.equal(released.unassigned, 1);
});

test('a Codex child spawned before its parent links is attributed to the first card', t => {
  const f = fixture(t);
  f.tasks.length = 0;
  f.collect();
  const record = path.join(f.root, '.keep/codex-parents/c.json');
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, JSON.stringify({ parent: 's' }));
  const child = path.join(f.root, 'c.jsonl');
  // Spawned at +10, before the parent's first link at +20 — previously frozen forever.
  fs.writeFileSync(child, [meta('c', 10), context('m'), codex(30, counts(100, 10, 5))].map(r => JSON.stringify(r) + '\n').join(''));
  f.files.push({ file: child, agent: 'codex' });
  assert.equal(f.collect().unassigned, 1);
  usage.recordOwner(f.root, { id: 's', agent: 'claude' }, 'a', start + 20);
  assert.equal(f.collect().cards.a.output, 5);
});

test('per-session totals roll descendants into the root session and count unassigned tokens', t => {
  const f = fixture(t);
  f.collect();
  f.append(claude('root-call', 10));
  const child = path.join(f.root, 's', 'subagents', 'agent-x.jsonl');
  fs.mkdirSync(path.dirname(child), { recursive: true });
  fs.writeFileSync(child, [{ type: 'user', timestamp: timestamp(10), sessionId: 's' }, claude('child-call', 20)]
    .map(r => JSON.stringify(r) + '\n').join(''));
  f.files.push({ file: child, agent: 'claude' });
  const summary = JSON.parse(JSON.stringify(f.collect()));
  const session = usage.forSession(summary, 'claude', 's');
  assert.equal(session.calls, 2, 'the subagent rolls up into the session a person opened');
  assert.equal(session.output, 20);
  assert.equal(usage.forSession(summary, 'claude', 's/agent-x').calls, 0, 'a descendant carries no separate row');
  assert.equal(session.updatedAt, undefined, 'no collector timestamp, so an idle row never churns');
  assert.equal(session.models, undefined, 'the per-model table belongs to the card');
  assert.deepEqual(usage.forSession(summary, 'claude', 'unknown'), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, calls: 0 });
  assert.equal(usage.forSession(null, 'claude', 's'), null);
  assert.equal(summary.unassignedTokens, 0);
  usage.recordOwner(f.root, { id: 's', agent: 'claude' }, null, start + 30);
  f.append(claude('loose', 40));
  const released = f.collect();
  assert.equal(released.unassigned, 1);
  // One response: 100 uncached input + 200 cache read + 30 cache write + 10 output.
  assert.equal(released.unassignedTokens, 340);
  assert.equal(usage.forSession(released, 'claude', 's').calls, 3, 'per-session totals count unassigned usage too');
});

test('the usage renderer adds a session figure only when one is supplied', () => {
  const source = fs.readFileSync(path.join(__dirname, '../web/app/model-usage.js'), 'utf8').replace('export function', 'function');
  const ctx = vm.createContext({}); vm.runInContext(source, ctx);
  const card = { since: start, input: 1000, cacheRead: 2000, cacheWrite: 300, output: 400, reasoning: 0, calls: 7, models: {} };
  const plain = ctx.modelUsageHTML(card);
  assert.match(plain, /<summary>3,700 tokens · 7 usage events<\/summary>/);
  assert.doesNotMatch(plain, /this session/);
  const withSession = ctx.modelUsageHTML(card, { input: 10, cacheRead: 20, cacheWrite: 3, output: 4, reasoning: 0, calls: 2 });
  assert.match(withSession, /<summary>3,700 tokens on this card · 37 this session · 7 usage events<\/summary>/);
  assert.match(withSession, /linked to now/);
});
