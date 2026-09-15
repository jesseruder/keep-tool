'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { deliver, userText, settleObserved, textHash } = require('./delivery');

test('exact Claude /mcp terminal evidence settles only the matching pending delivery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-mcp-delivery-'));
  const file = path.join(root, 'transcript'); fs.writeFileSync(file, '');
  const directory = path.join(root, 'journal');
  const base = { session: { id: 'session-a', kind: 'claude' }, pane: 'pane-a', text: '/mcp', file, directory,
    precheck: async () => {}, type: async () => {}, submitDraft: async () => assert.fail(),
    draftMatches: async () => false, pause: async () => {}, attempts: 1 };
  try {
    await assert.rejects(deliver(base), /unconfirmed/);
    const evidence = { sessionId: 'session-a', pane: 'pane-a', expectedHash: textHash('/mcp'), evidence: 'claude-mcp-menu' };
    assert.equal(settleObserved(directory, { ...evidence, sessionId: 'session-b' }), false);
    assert.equal(settleObserved(directory, { ...evidence, pane: 'pane-b' }), false);
    assert.equal(settleObserved(directory, { ...evidence, expectedHash: textHash('/mcp tools') }), false);
    assert.equal(settleObserved(directory, { ...evidence, evidence: 'other-menu' }), false);
    assert.equal(settleObserved(directory, evidence), true);
    assert.equal((await deliver(base)).recovered, true);

    const normal = { ...base, session: { id: 'normal', kind: 'claude' }, text: 'hello' };
    await assert.rejects(deliver(normal), /unconfirmed/);
    assert.equal(settleObserved(directory, {
      sessionId: 'normal', pane: 'pane-a', expectedHash: textHash('hello'), evidence: 'claude-mcp-menu',
    }), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Claude /mcp can settle from terminal evidence during receipt polling', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-mcp-delivery-'));
  const file = path.join(root, 'transcript'); fs.writeFileSync(file, '');
  const directory = path.join(root, 'journal');
  let typed = 0;
  try {
    const result = await deliver({ session: { id: 'session-a', kind: 'claude' }, pane: 'pane-a', text: '/mcp', file, directory,
      precheck: async () => {}, type: async () => { typed++; }, submitDraft: async () => assert.fail(),
      draftMatches: async () => false, pause: async () => {}, attempts: 1,
      observe: async () => settleObserved(directory, {
        sessionId: 'session-a', pane: 'pane-a', expectedHash: textHash('/mcp'), evidence: 'claude-mcp-menu',
      }) });
    assert.equal(result.delivery, 'received');
    assert.equal(typed, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ['absorbed mid-turn', 'enqueue', 'legacy enqueue', 'attachment', 'different attachment', 'different enqueue', 'remove only', 'before offset']) {
  test(`Claude queued delivery receipt: ${mode}`, async () => {
    const { received, reconcile, statusForText } = require('./delivery');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-queued-delivery-'));
    const file = path.join(dir, 'transcript');
    const directory = path.join(dir, 'journal');
    const enqueue = { type: 'queue-operation', operation: 'enqueue', content: 'hello\n world' };
    const attachment = { type: 'attachment', attachment: { type: 'queued_command', prompt: 'hello\n world' } };
    const remove = { type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', content: 'hello world' };
    const append = records => fs.appendFileSync(file, records.map(record => JSON.stringify(record) + '\n').join(''));
    fs.writeFileSync(file, '');
    try {
      if (mode === 'before offset') append([enqueue, attachment]);
      await assert.rejects(deliver({ session: { id: 's', kind: 'claude' }, pane: 'p', text: 'hello world', file, directory,
        precheck: async () => {}, type: async () => {}, submitDraft: async () => assert.fail('unexpected Enter'),
        draftMatches: async () => false, pause: async () => {}, attempts: 1 }), /unconfirmed/);
      const journal = path.join(directory, fs.readdirSync(directory).find(name => name.endsWith('.json')));
      const entry = JSON.parse(fs.readFileSync(journal, 'utf8'));
      const records = {
        'absorbed mid-turn': [enqueue, attachment, remove],
        enqueue: [enqueue], attachment: [attachment],
        'legacy enqueue': [{ type: 'queue-operation', content: enqueue.content }],
        'different attachment': [{ ...attachment, attachment: { ...attachment.attachment, prompt: 'different text' } }],
        'different enqueue': [{ ...enqueue, content: 'different text' }],
        'remove only': [remove], 'before offset': [],
      };
      append(records[mode]);
      const expected = ['absorbed mid-turn', 'enqueue', 'legacy enqueue', 'attachment'].includes(mode);
      assert.equal(received(entry), expected);
      assert.deepEqual(reconcile(directory), expected ? ['s'] : []);
      assert.equal(fs.existsSync(journal), !expected);
      assert.equal(statusForText(directory, 'hello world').received, expected);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('delivery diagnostics persist stages without text and rotate within a bounded footprint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-trace-'));
  try {
    const file = path.join(dir, 'transcript'); fs.writeFileSync(file, '');
    const directory = path.join(dir, 'journal');
    await assert.rejects(deliver({ session: { id: 's', kind: 'codex' }, pane: 'p', text: 'SECRET MESSAGE', file, directory,
      precheck: async () => {}, type: async () => { throw Error('SECRET SCREEN'); }, submitDraft: async () => {}, draftMatches: async () => false }), /SECRET SCREEN/);
    const trace = path.join(directory, 'diagnostics/events.jsonl');
    const raw = fs.readFileSync(trace, 'utf8');
    assert.doesNotMatch(raw, /SECRET|transcript/);
    assert.deepEqual(raw.trim().split('\n').map(l => JSON.parse(l).stage), ['attempt-start', 'precheck-start', 'precheck-ok', 'type-submit-start', 'type-submit-failed', 'attempt-unconfirmed']);
    assert.equal(fs.statSync(trace).mode & 0o777, 0o600);
    fs.writeFileSync(trace, 'x'.repeat(1024 * 1024));
    require('./delivery-trace').recorder(directory, { id: 's', kind: 'codex' }, 'p')('retry', { text: 'SECRET', matched: false });
    assert.equal(fs.statSync(trace + '.1').size, 1024 * 1024);
    assert.ok(fs.statSync(trace).size < 1000);
    assert.doesNotMatch(fs.readFileSync(trace, 'utf8'), /SECRET/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

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
    assert.equal(fs.readdirSync(args.directory).filter(f => f.endsWith('.json')).length, 0);
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

// The reviewer wedge of 2026-09-12: one journal entry nothing could confirm refused
// every later tick for 133 consecutive runs, because each tick's text differs from
// the stranded one and only a confirmed delivery ever removed the entry.
test('an old unconfirmed journal expires once the pane no longer holds its draft', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-stale-'));
  const file = path.join(dir, 'transcript'); fs.writeFileSync(file, '');
  const directory = path.join(dir, 'journal');
  let typed = 0;
  const base = { session: { id: 's', kind: 'claude' }, pane: 'p', file, directory,
    precheck: async () => {}, type: async () => { typed += 1; }, submitDraft: async () => assert.fail('unexpected Enter'),
    draftMatches: async () => false, pause: async () => {}, attempts: 1, staleJournalMs: 15 * 60e3 };
  try {
    await assert.rejects(deliver({ ...base, text: 'tick one' }), /unconfirmed/);
    const journal = path.join(directory, fs.readdirSync(directory).find((name) => name.endsWith('.json')));
    const entry = JSON.parse(fs.readFileSync(journal, 'utf8'));

    // Still fresh: a message that may yet be in flight is never discarded.
    await assert.rejects(deliver({ ...base, text: 'tick two' }), /Previous delivery is unconfirmed/);
    assert.equal(typed, 1, 'nothing was retyped while the entry was fresh');

    // Old, but the pane is still showing exactly this draft: recover it, never expire it.
    fs.writeFileSync(journal, JSON.stringify({ ...entry, createdAt: Date.now() - 60 * 60e3 }));
    let submitted = 0;
    await assert.rejects(deliver({ ...base, text: 'tick one', draftMatches: async () => true,
      submitDraft: async () => { submitted += 1; } }), /unconfirmed/);
    assert.ok(submitted >= 1, 'the exact surviving draft gets Enter, not a retype');
    assert.equal(typed, 1);

    // Old and gone from the screen: expire it and let the next message through.
    fs.writeFileSync(journal, JSON.stringify({ ...entry, createdAt: Date.now() - 60 * 60e3 }));
    await assert.rejects(deliver({ ...base, text: 'tick three' }), /no matching transcript receipt/);
    assert.equal(typed, 2, 'the new message was typed once the stale entry expired');
    assert.equal(JSON.parse(fs.readFileSync(journal, 'utf8')).hash, require('./delivery').textHash('tick three'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unconfirmed journal with no createdAt still expires on its file age', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-stale-mtime-'));
  const file = path.join(dir, 'transcript'); fs.writeFileSync(file, '');
  const directory = path.join(dir, 'journal');
  let typed = 0;
  const base = { session: { id: 's', kind: 'claude' }, pane: 'p', file, directory,
    precheck: async () => {}, type: async () => { typed += 1; }, submitDraft: async () => assert.fail('unexpected Enter'),
    draftMatches: async () => false, pause: async () => {}, attempts: 1, staleJournalMs: 15 * 60e3 };
  try {
    await assert.rejects(deliver({ ...base, text: 'legacy' }), /unconfirmed/);
    const journal = path.join(directory, fs.readdirSync(directory).find((name) => name.endsWith('.json')));
    const entry = JSON.parse(fs.readFileSync(journal, 'utf8'));
    delete entry.createdAt;
    fs.writeFileSync(journal, JSON.stringify(entry));
    const old = (Date.now() - 60 * 60e3) / 1000;
    fs.utimesSync(journal, old, old);
    await assert.rejects(deliver({ ...base, text: 'next' }), /no matching transcript receipt/);
    assert.equal(typed, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Expiry must not become a way to send a message twice. A stale entry whose text and
// pane match, with the draft gone from the box, most likely DID land — `received`
// cannot see a message whose session resumed onto a new transcript.
test('an expired journal for the same message on the same pane is never retyped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-assumed-'));
  const file = path.join(dir, 'transcript'); fs.writeFileSync(file, '');
  const directory = path.join(dir, 'journal');
  let typed = 0;
  const base = { session: { id: 's', kind: 'claude' }, pane: 'p', text: 'the same tick', file, directory,
    precheck: async () => {}, type: async () => { typed += 1; }, submitDraft: async () => assert.fail('unexpected Enter'),
    draftMatches: async () => false, pause: async () => {}, attempts: 1, staleJournalMs: 15 * 60e3 };
  try {
    await assert.rejects(deliver(base), /unconfirmed/);
    const journal = path.join(directory, fs.readdirSync(directory).find((name) => name.endsWith('.json')));
    const entry = JSON.parse(fs.readFileSync(journal, 'utf8'));
    fs.writeFileSync(journal, JSON.stringify({ ...entry, createdAt: Date.now() - 60 * 60e3 }));

    const result = await deliver(base);
    assert.deepEqual(result, { ok: true, delivery: 'assumed-delivered', expired: true });
    assert.equal(typed, 1, 'the text was typed once, ever');
    assert.equal(fs.existsSync(journal), false, 'and the session is no longer wedged');

    // With the session unwedged, the next different message goes through normally.
    await assert.rejects(deliver({ ...base, text: 'the next tick' }), /no matching transcript receipt/);
    assert.equal(typed, 2);

    // A different pane is not the same delivery, so it is not assumed: the message
    // was aimed somewhere else and has to be typed where it is wanted now.
    const second = path.join(directory, fs.readdirSync(directory).find((name) => name.endsWith('.json')));
    const stale = JSON.parse(fs.readFileSync(second, 'utf8'));
    fs.writeFileSync(second, JSON.stringify({ ...stale, createdAt: Date.now() - 60 * 60e3 }));
    await assert.rejects(deliver({ ...base, text: 'the next tick', pane: 'other-pane' }), /no matching transcript receipt/);
    assert.equal(typed, 3, 'a pane change still retypes');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The journal is written before typing so a crash mid-keystroke stays recoverable —
// which means the entry existing proves nothing about what reached the pane. Without
// that distinction a failed type would expire as "assumed-delivered" 15 minutes later,
// file a received receipt, and let a sweep tick consume the day for a message nobody
// ever saw.
test('an entry whose typing failed is retyped, not assumed delivered', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-typedat-'));
  const file = path.join(dir, 'transcript'); fs.writeFileSync(file, '');
  const directory = path.join(dir, 'journal');
  let typed = 0;
  let failTyping = true;
  const base = { session: { id: 's', kind: 'claude' }, pane: 'p', text: 'the tick', file, directory,
    precheck: async () => {}, submitDraft: async () => assert.fail('unexpected Enter'),
    type: async () => { typed += 1; if (failTyping) throw new Error('pane went away'); },
    draftMatches: async () => false, pause: async () => {}, attempts: 1, staleJournalMs: 15 * 60e3 };
  const age = (journal) => {
    const entry = JSON.parse(fs.readFileSync(journal, 'utf8'));
    fs.writeFileSync(journal, JSON.stringify({ ...entry, createdAt: Date.now() - 60 * 60e3 }));
    return entry;
  };
  try {
    await assert.rejects(deliver(base), /pane went away/);
    const journal = path.join(directory, fs.readdirSync(directory).find((name) => name.endsWith('.json')));
    assert.equal(JSON.parse(fs.readFileSync(journal, 'utf8')).typedAt, undefined, 'nothing reached the pane');

    // Expired with nothing ever typed: the entry goes, and the message is typed fresh.
    age(journal);
    failTyping = false;
    await assert.rejects(deliver(base), /no matching transcript receipt/);
    assert.equal(typed, 2, 'the message that was never typed is typed now');
    const stamped = JSON.parse(fs.readFileSync(journal, 'utf8'));
    assert.ok(Number(stamped.typedAt) > 0, 'a successful type stamps the journal');

    // Now that it really was typed, the same message expires without retyping.
    age(journal);
    assert.deepEqual(await deliver(base), { ok: true, delivery: 'assumed-delivered', expired: true });
    assert.equal(typed, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The delivery incident of 2026-09-13: typing into the reviewer pane failed, the
// reviewer moved to a new session, and no send ever reached the old one again - so
// the expiry above never ran and the watchdog reported the entry for two days.
test('the reconcile sweep expires an old never-typed journal nobody sends to again', async () => {
  const { reconcile } = require('./delivery');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-sweep-'));
  const file = path.join(dir, 'transcript'); fs.writeFileSync(file, '');
  const directory = path.join(dir, 'journal');
  const send = (session, type) => deliver({ session: { id: session, kind: 'claude' }, pane: 'p', text: 'the tick', file, directory,
    precheck: async () => {}, type, submitDraft: async () => assert.fail('unexpected Enter'),
    draftMatches: async () => false, pause: async () => {}, attempts: 1 });
  const journalFor = (session) => path.join(directory, textHash(session) + '.json');
  try {
    await assert.rejects(send('failed', async () => { throw new Error('pane went away'); }), /pane went away/);
    await assert.rejects(send('typed', async () => {}), /no matching transcript receipt/);
    const hour = 60 * 60e3;

    // Young entries may still be in flight; neither is touched.
    assert.deepEqual(reconcile(directory), []);
    assert.equal(fs.existsSync(journalFor('failed')), true);

    // Old: the never-typed entry goes, the typed one stays for the screen-aware send path.
    assert.deepEqual(reconcile(directory, { now: Date.now() + hour }), []);
    assert.equal(fs.existsSync(journalFor('failed')), false, 'nothing reached the pane, so nothing is left to confirm');
    assert.equal(fs.existsSync(journalFor('typed')), true, 'text on the pane is never expired blind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The delivery incident of 2026-09-15 (delivery:022ccb3f): a probe typed /model into a
// Codex pane, whose picker writes no user message, and then closed the pane. No send
// could reach that session again, so only the sweep can retire the typed entry.
test('the reconcile sweep retires an old typed journal whose pane is gone', async () => {
  const { reconcile, statusForText } = require('./delivery');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-gone-pane-'));
  const file = path.join(dir, 'rollout.jsonl'); fs.writeFileSync(file, '');
  const directory = path.join(dir, 'journal');
  const send = (session, pane, options = {}) => deliver({ session: { id: session, kind: 'codex' }, pane, text: '/model', file, directory,
    precheck: async () => {}, type: async () => {}, submitDraft: async () => assert.fail('unexpected Enter'),
    draftMatches: async () => false, pause: async () => {}, attempts: 1, ...options });
  const journalFor = (session) => path.join(directory, textHash(session) + '.json');
  const panes = new Set(['live']);
  const later = Date.now() + 60 * 60e3;
  try {
    await assert.rejects(send('closed', 'probe'), /no matching transcript receipt/);
    await assert.rejects(send('open', 'live'), /no matching transcript receipt/);

    // Young entries may still be settling, even in a pane that just closed.
    assert.deepEqual(reconcile(directory, { panes }), []);
    // Without the host's pane list, or with an empty one, nothing proves the pane is gone.
    assert.deepEqual(reconcile(directory, { now: later }), []);
    assert.deepEqual(reconcile(directory, { now: later, panes: new Set() }), []);
    assert.equal(fs.existsSync(journalFor('closed')), true);

    assert.deepEqual(reconcile(directory, { now: later, panes }), ['closed']);
    assert.equal(fs.existsSync(journalFor('closed')), false, 'a closed pane can take no further Enter');
    assert.equal(fs.existsSync(journalFor('open')), true, 'text on a listed pane is never expired blind');
    // A plain send settles, so retrying the same text never types it twice.
    assert.deepEqual(await send('closed', 'probe', { type: async () => assert.fail('retyped a retired send') }),
      { ok: true, delivery: 'received', recovered: true });

    // A scheduled check keeps no false "received": its owner must be free to run it headless.
    fs.writeFileSync(file, '');
    await assert.rejects(send('check', 'gone', { retainReceipt: true, key: 'check-1' }), /no matching transcript receipt/);
    assert.equal(statusForText(directory, '/model', 'check-1').pending, true);
    assert.deepEqual(reconcile(directory, { now: later, panes }), ['check']);
    assert.equal(statusForText(directory, '/model', 'check-1'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('text typed but never submitted still counts as having reached the pane', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-noenter-'));
  const file = path.join(dir, 'transcript'); fs.writeFileSync(file, '');
  const directory = path.join(dir, 'journal');
  let typed = 0;
  const base = { session: { id: 's', kind: 'claude' }, pane: 'p', text: 'the tick', file, directory,
    precheck: async () => {}, submitDraft: async () => assert.fail('unexpected Enter'),
    type: async () => { typed += 1; throw new Error('message was typed but could not be confirmed; Enter was not pressed'); },
    draftMatches: async () => false, pause: async () => {}, attempts: 1, staleJournalMs: 15 * 60e3 };
  try {
    await assert.rejects(deliver(base), /Enter was not pressed/);
    const journal = path.join(directory, fs.readdirSync(directory).find((name) => name.endsWith('.json')));
    const entry = JSON.parse(fs.readFileSync(journal, 'utf8'));
    assert.ok(Number(entry.typedAt) > 0, 'the characters did land, only Enter did not');
    fs.writeFileSync(journal, JSON.stringify({ ...entry, createdAt: Date.now() - 60 * 60e3 }));
    assert.equal((await deliver(base)).delivery, 'assumed-delivered');
    assert.equal(typed, 1, 'and it is never typed a second time');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
