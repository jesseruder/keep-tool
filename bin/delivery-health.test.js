'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspect, tick } = require('./delivery-health');

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-health-'));
  const directory = path.join(root, '.keep', 'delivery');
  fs.mkdirSync(path.join(directory, 'diagnostics'), { recursive: true });
  const now = Date.now();
  const message = 'PRIVATE message';
  const add = (kind, overrides = {}) => {
    const file = path.join(root, kind + '.jsonl'); fs.writeFileSync(file, '');
    const entry = { kind, sessionId: kind + '-session', pane: kind + '-pane', file, offset: 0,
      createdAt: now - 180e3, hash: crypto.createHash('sha256').update(message).digest('hex'), ...overrides };
    fs.writeFileSync(path.join(directory, kind + '.json'), JSON.stringify(entry));
    return entry;
  };
  const trace = rows => fs.writeFileSync(path.join(directory, 'diagnostics/events.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  try { return fn({ root, directory, now, message, add, trace }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('both agents detect screen/receipt failures, ignore young attempts and clear on actual receipts', () => fixture(f => {
  const codex = f.add('codex'); const claude = f.add('claude');
  f.trace([
    { session: codex.sessionId, pane: codex.pane, at: f.now - 179e3, stage: 'screen-confirmation', matched: false },
    { session: claude.sessionId, pane: claude.pane, at: f.now - 179e3, stage: 'enter-sent' },
  ]);
  let rows = inspect(f);
  assert.equal(rows.find(r => r.agent === 'codex').reason, 'screen-verification-failed');
  assert.equal(rows.find(r => r.agent === 'claude').reason, 'receipt-missing-after-enter');
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|\.jsonl/);
  // An assistant echo must not clear an incident.
  fs.appendFileSync(codex.file, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: f.message }] } }) + '\n');
  assert.equal(inspect(f).length, 2);
  fs.appendFileSync(codex.file, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: f.message }] } }) + '\n');
  assert.equal(inspect(f).length, 1, 'another session succeeding must not hide the failure');
  fs.appendFileSync(claude.file, JSON.stringify({ type: 'user', message: { content: f.message } }) + '\n');
  assert.deepEqual(inspect(f), []);
  assert.ok(fs.existsSync(path.join(f.directory, 'claude.json')), 'watchdog never deletes journals');
  f.add('claude', { createdAt: f.now - 30e3 });
  assert.deepEqual(inspect(f), []);
}));

test('restart/legacy journals use original file age and rotated diagnostics; unrelated traces cannot misclassify', () => fixture(f => {
  const entry = f.add('codex', { createdAt: undefined });
  const file = path.join(f.directory, 'codex.json');
  fs.utimesSync(file, new Date(f.now - 300e3), new Date(f.now - 300e3));
  f.trace([
    { session: entry.sessionId, pane: entry.pane, at: f.now - 400e3, stage: 'enter-sent' },
    { session: entry.sessionId, pane: 'old-pane', at: f.now - 200e3, stage: 'enter-sent' },
    { session: entry.sessionId, pane: entry.pane, at: f.now - 200e3, stage: 'draft-screen-check', matched: false },
  ]);
  fs.renameSync(path.join(f.directory, 'diagnostics/events.jsonl'), path.join(f.directory, 'diagnostics/events.jsonl.1'));
  f.trace([]);
  const first = inspect(f)[0];
  assert.equal(first.reason, 'screen-verification-failed');
  assert.equal(inspect({ ...f, now: f.now + 60e3 })[0].since, first.since);
}));

test('corrupt journals and missing transcripts are visible without leaking errors or hiding other incidents', () => fixture(f => {
  const entry = f.add('claude'); fs.unlinkSync(entry.file);
  fs.writeFileSync(path.join(f.directory, 'broken.json'), '{PRIVATE');
  const rows = inspect(f);
  assert.deepEqual(rows.map(r => r.reason).sort(), ['journal-unreadable', 'transcript-unreadable']);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE/);
}));

test('persistent delivery faults enter health attention once, stay stable, and recover', () => fixture(f => {
  const saved = process.env.KEEP_DIR;
  process.env.KEEP_DIR = f.root;
  delete require.cache[require.resolve('./health')];
  const health = require('./health');
  try {
    health.record('daemon', { at: f.now, pid: process.pid });
    const entry = f.add('codex');
    for (let n = 0; n < 3; n++) tick({ ...f, health, now: f.now + n * 60e3 });
    const attention = () => health.attentionItems(health.snapshot(f.now + 180e3)).filter(r => r.id === 'health:delivery');
    assert.equal(attention().length, 1);
    const first = attention()[0];
    assert.match(first.text, /codex-session.*receipt-missing.*keep pane screen codex-pane/);
    tick({ ...f, health, now: f.now + 180e3 });
    assert.equal(attention()[0].at, first.at, 'polling must not reannounce the same incident');
    const newer = f.add('claude', { createdAt: f.now - 150e3 });
    tick({ ...f, health, now: f.now + 200e3 });
    assert.equal(attention()[0].at, newer.createdAt, 'a new stuck delivery must surface while the older one remains');
    fs.appendFileSync(newer.file, JSON.stringify({ type: 'user', message: { content: f.message } }) + '\n');
    fs.appendFileSync(entry.file, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: f.message }] } }) + '\n');
    tick({ ...f, health, now: f.now + 240e3 });
    assert.deepEqual(attention(), []);
  } finally {
    if (saved === undefined) delete process.env.KEEP_DIR; else process.env.KEEP_DIR = saved;
    delete require.cache[require.resolve('./health')];
  }
}));
