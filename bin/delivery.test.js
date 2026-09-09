'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { deliver, userText } = require('./delivery');

test('wrapped prompt fingerprints and exact recovery drafts tolerate terminal hard wraps', () => {
  const { codexTypedTextVisible, exactDraft } = require('./serve');
  const text = '[keep] scheduled check due; Full card: keep show example-regression-208.';
  const screen = '› [keep] scheduled check due; Full card: keep show example-regression-\n  208.\n\n  ~/repo · main';
  assert.equal(codexTypedTextVisible(screen, text), true);
  assert.equal(exactDraft(screen, text, 'codex'), true);
  assert.equal(exactDraft(screen.replace('scheduled', 'changed'), text, 'codex'), false);
  assert.equal(exactDraft("› run echo 'ab'\n\nstatus", "run echo 'a b'", 'codex'), false);
  assert.equal(exactDraft('› hello\n\nWould you like to run the following command?', 'hello', 'codex'), false);
});

test('delayed screen confirmation recovers only the exact draft without retyping', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delayed-draft-'));
  try {
    for (const mode of ['exact', 'changed', 'guard']) {
      const file = path.join(dir, mode); fs.writeFileSync(file, '');
      let typed = 0, submitted = 0, polls = 0;
      const args = { session: { id: mode, kind: 'claude' }, pane: 'p', text: 'scheduled result', file,
        directory: dir, attempts: 2, precheck: async () => {},
        type: async () => { typed++; throw new Error(mode === 'guard' ? 'session changed' : 'message was typed but could not be confirmed; Enter was not pressed'); },
        pause: async () => { polls++; },
        draftMatches: async () => mode === 'exact' && polls >= 2,
        submitDraft: async () => { submitted++; fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { content: 'scheduled result' } }) + '\n'); },
      };
      if (mode === 'exact') assert.equal((await deliver(args)).delivery, 'received');
      else await assert.rejects(deliver(args), mode === 'guard' ? /session changed/ : /could not be confirmed/);
      assert.equal(typed, 1);
      assert.equal(submitted, mode === 'exact' ? 1 : 0);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('receipts survive more than eight MiB of later output and are discoverable by scheduler', async () => {
  const { statusForText } = require('./delivery');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-'));
  const file = path.join(dir, 'transcript'); fs.writeFileSync(file, '');
  const directory = path.join(dir, 'journal');
  try {
    await assert.rejects(deliver({ session: { id: 's', kind: 'claude' }, pane: 'p', text: 'scheduled check', file, directory, precheck: async () => {}, type: async () => {}, submitDraft: async () => assert.fail(), draftMatches: async () => false, pause: async () => {}, attempts: 1 }), /unconfirmed/);
    assert.equal(statusForText(directory, 'scheduled check').received, false);
    fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { content: 'scheduled check' } }) + '\n' + 'x\n'.repeat(5 * 1024 * 1024));
    assert.deepEqual(statusForText(directory, 'scheduled check'), { sessionId: 's', kind: 'claude', received: true, pending: false });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scheduled receipt survives unrelated sends and card renaming until scheduler acknowledgement', async () => {
  const { statusForText, acknowledge } = require('./delivery');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-'));
  const file = path.join(dir, 'transcript'); fs.writeFileSync(file, '');
  const directory = path.join(dir, 'journal');
  const append = (text) => fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { content: text } }) + '\n');
  const args = { session: { id: 's', kind: 'claude' }, pane: 'p', file, directory, precheck: async () => {}, submitDraft: async () => assert.fail(), draftMatches: async () => false, pause: async () => {}, attempts: 1 };
  try {
    await assert.rejects(deliver({ ...args, text: 'check old title', key: 'card:date', retainReceipt: true, type: async () => {} }), /unconfirmed/);
    assert.equal(statusForText(directory, 'check renamed title', 'card:date').received, false);
    append('check old title');
    await deliver({ ...args, text: 'unrelated message', type: async () => append('unrelated message') });
    assert.equal(statusForText(directory, 'check renamed title', 'card:date').received, true);
    assert.equal(fs.readdirSync(directory).filter((f) => f.endsWith('.json')).length, 0);
    acknowledge(directory, 'check renamed title', 'card:date');
    assert.equal(statusForText(directory, 'check renamed title', 'card:date'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const kind of ['claude', 'codex']) test(`${kind} requires a matching transcript receipt and recovers without retyping`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-'));
  const file = path.join(dir, 'transcript');
  fs.writeFileSync(file, '');
  let typed = 0, submitted = 0, draft = false;
  const receipt = () => fs.appendFileSync(file, JSON.stringify(kind === 'claude'
    ? { type: 'user', message: { content: [{ type: 'text', text: 'hello world' }] } }
    : { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello world' }] } }) + '\n');
  const args = { session: { id: 's', kind }, pane: 'p', text: 'hello world', file, directory: path.join(dir, 'journal'),
    precheck: async () => {}, type: async () => { typed++; }, submitDraft: async () => { submitted++; receipt(); },
    draftMatches: async () => draft, pause: async () => {}, attempts: 1 };
  try {
    await assert.rejects(deliver(args), /unconfirmed/);
    assert.equal(typed, 1);
    await assert.rejects(deliver({ ...args, text: 'different message' }), /Previous delivery/);
    assert.equal(typed, 1);
    draft = true;
    assert.equal((await deliver(args)).delivery, 'received');
    assert.equal(typed, 1);
    assert.equal(submitted, 1);
    assert.equal(fs.readdirSync(args.directory).length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('late receipt is recovered before touching a changed draft or pane', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-'));
  const file = path.join(dir, 'transcript'); fs.writeFileSync(file, '');
  let typed = 0;
  const args = { session: { id: 's', kind: 'claude' }, pane: 'p', text: 'hello', file, directory: path.join(dir, 'journal'), precheck: async () => {}, type: async () => { typed++; }, submitDraft: async () => assert.fail(), draftMatches: async () => false, pause: async () => {}, attempts: 1 };
  try {
    await assert.rejects(deliver(args), /unconfirmed/);
    fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n');
    assert.equal((await deliver({ ...args, pane: 'resumed-pane' })).recovered, true);
    assert.equal(typed, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('tool output and assistant echoes cannot acknowledge delivery', () => {
  assert.equal(userText({ type: 'user', message: { content: [{ type: 'tool_result', content: 'hello' }] } }, 'claude'), null);
  assert.equal(userText({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'hello' }] } }, 'codex'), null);
});

test('idle cleanup reconciles a late receipt after its card clears the schedule', async () => {
  const { pendingForSession, statusForText } = require('./delivery');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-'));
  const file = path.join(dir, 'transcript'); fs.writeFileSync(file, '');
  const directory = path.join(dir, 'journal');
  try {
    await assert.rejects(deliver({ session: { id: 's', kind: 'claude' }, pane: 'p', text: 'check', key: 'card:date', retainReceipt: true, file, directory, precheck: async () => {}, type: async () => {}, submitDraft: async () => assert.fail(), draftMatches: async () => false, pause: async () => {}, attempts: 1 }), /unconfirmed/);
    assert.equal(pendingForSession(directory, 's'), true);
    fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { content: 'check' } }) + '\n');
    assert.equal(pendingForSession(directory, 's'), false);
    assert.equal(pendingForSession(directory, 's'), false);
    assert.equal(statusForText(directory, 'check', 'card:date').received, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
