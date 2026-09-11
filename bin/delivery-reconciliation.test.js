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
  const questions = records => {
    fs.mkdirSync(path.join(root, '.keep/review'), { recursive: true });
    fs.writeFileSync(path.join(root, '.keep/review/_questions.json'), JSON.stringify(records));
  };
  try { await fn({ root, directory, add, questions }); }
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

test('explicit answer cancellation reconciles only the exact recipient/payload, never fakes receipt or resends', () => fixture(async f => {
  const question = { id: 'q-one', status: 'answered', from: { agent: 'codex', sessionId: 'codex-session' },
    answer: 'Enable nudges for all finding kinds.', answeredBy: { agent: 'codex', sessionId: 'codex-session', reviewer: false },
    answerDelivery: { pending: false, cancelledAt: Date.now() } };
  const text = require('./review').answerMessage(question.id, question.answer, { agent: 'codex', sessionId: 'codex-session', fromReviewer: false });
  const x = f.add('codex', text);
  for (const other of [
    { ...question, answerDelivery: { pending: false, gaveUp: true } },
    { ...question, answerDelivery: { pending: true, cancelledAt: Date.now() } },
    { ...question, from: { agent: 'claude', sessionId: 'codex-session' } },
    { ...question, from: { agent: 'codex', sessionId: 'other-session' } },
    { ...question, answer: 'Changed answer' },
  ]) {
    f.questions([other]);
    assert.equal(delivery.cancelled(x.entry, f.directory), false);
    assert.equal(inspect(f).length, 1);
  }
  f.questions([question]);
  assert.equal(delivery.received(x.entry), false);
  assert.deepEqual(delivery.statusForText(f.directory, text), { sessionId: 'codex-session', kind: 'codex', received: false, pending: false, cancelled: true });
  assert.deepEqual(inspect(f), []);
  delivery.reconcile(f.directory);
  assert.equal(fs.existsSync(x.journal), false);
  assert.equal(fs.existsSync(path.join(f.directory, 'receipts')), false);
  const unexpected = async () => assert.fail('cancelled delivery touched terminal');
  await assert.rejects(delivery.deliver({ session: { id: 'codex-session', kind: 'codex' }, pane: 'pane', text,
    file: x.entry.file, directory: f.directory, precheck: unexpected, type: unexpected, submitDraft: unexpected, draftMatches: unexpected }), /explicitly cancelled/);
  f.questions([{ ...question, answerDelivery: { pending: false, acknowledgedAt: Date.now() } }]);
  assert.equal(delivery.cancelled(x.entry, f.directory), true);
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
