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

test('a draft taken back off the screen leaves no journal and blocks no later send', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-cleared-'));
  const file = path.join(dir, 'transcript'); fs.writeFileSync(file, '');
  const directory = path.join(dir, 'journal');
  let typed = 0;
  // What typeAndSubmit throws when it could not confirm the text on screen and the
  // guarded discard then took it back: characters were written, and nothing remains.
  const cleared = () => Object.assign(new Error('message was typed but could not be confirmed; the typed message was cleared'),
    { typingStarted: true, draftCleared: true });
  const base = { session: { id: 's', kind: 'claude' }, pane: 'p', text: 'the tick', file, directory,
    precheck: async () => {}, submitDraft: async () => assert.fail('unexpected Enter'),
    type: async () => { typed += 1; throw cleared(); },
    draftMatches: async () => false, pause: async () => {}, attempts: 1, staleJournalMs: 15 * 60e3 };
  try {
    await assert.rejects(deliver(base), /the typed message was cleared/);
    assert.deepEqual(fs.readdirSync(directory).filter((name) => name.endsWith('.json')), [],
      'nothing reached the pane, so nothing is left claiming it might have');
    // The same message a moment later is a fresh attempt, not "previous delivery is
    // unconfirmed": the old entry would have refused it for the next fifteen minutes.
    await assert.rejects(deliver(base), /the typed message was cleared/);
    assert.equal(typed, 2, 'and it is free to type again');

    // A draft that stayed on the screen is still the other thing entirely.
    const stuck = { ...base, type: async () => { typed += 1; throw Object.assign(
      new Error('message was typed but could not be confirmed; Enter was not pressed'),
      { typingStarted: true, draftLeftOnScreen: true }); } };
    await assert.rejects(deliver(stuck), /Enter was not pressed/);
    const journal = path.join(directory, fs.readdirSync(directory).find((name) => name.endsWith('.json')));
    assert.ok(Number(JSON.parse(fs.readFileSync(journal, 'utf8')).typedAt) > 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed discard records the exact pane state only when the error proves a draft was left', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-left-draft-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'journal');
  const attempt = async (id, error) => {
    const file = path.join(root, `${id}.jsonl`); fs.writeFileSync(file, '');
    await assert.rejects(deliver({
      session: { id, kind: 'claude' }, pane: `pane-${id}`, text: `message-${id}`, file, directory,
      precheck: async () => {}, type: async () => { throw error; },
      submitDraft: async () => assert.fail('unexpected Enter'), draftMatches: async () => false,
      pause: async () => {}, attempts: 1,
    }), new RegExp(error.message));
    return JSON.parse(fs.readFileSync(path.join(directory, `${textHash(id)}.json`), 'utf8'));
  };
  const left = await attempt('left', Object.assign(new Error('turn became busy'), {
    typingStarted: true, draftLeftOnScreen: true, draftReason: 'turn running',
    leftDraft: { pid: 4242, inputCount: 19 },
  }));
  assert.equal(left.leftDraft.pid, 4242);
  assert.equal(left.leftDraft.inputCount, 19);
  assert.ok(Number(left.leftDraft.at) > 0);

  const ordinary = await attempt('ordinary', Object.assign(new Error('ordinary type failure'), {
    typingStarted: true, leftDraft: { pid: 5151, inputCount: 23 },
  }));
  assert.equal(ordinary.leftDraft, undefined);
});

test('a guarded refusal before the first character leaves no pending journal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-notyped-'));
  const file = path.join(dir, 'transcript'); fs.writeFileSync(file, '');
  const directory = path.join(dir, 'journal');
  let typed = 0;
  const base = { session: { id: 's', kind: 'codex' }, pane: 'p', text: 'the tick', file, directory,
    precheck: async () => {}, submitDraft: async () => assert.fail('unexpected Enter'),
    draftMatches: async () => false, pause: async () => {}, attempts: 1 };
  try {
    await assert.rejects(deliver({ ...base, type: async () => {
      typed += 1;
      throw Object.assign(new Error('input baseline moved; nothing was typed'), { nothingTyped: true });
    } }), /nothing was typed/);
    assert.deepEqual(fs.readdirSync(directory).filter((name) => name.endsWith('.json')), []);

    await assert.rejects(deliver({ ...base, type: async () => { typed += 1; } }), /unconfirmed/);
    assert.equal(typed, 2, 'the immediate retry is not blocked by a phantom pending send');
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

test('partial chunk progress is durable, resumable only for the same send, and never expired while unfinished', async () => {
  const { reconcile, textHash } = require('./delivery');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-partial-'));
  const file = path.join(dir, 'transcript'); fs.writeFileSync(file, '');
  const directory = path.join(dir, 'journal');
  const base = { session: { id: 'partial', kind: 'codex' }, pane: 'pane', text: 'abcdef', file, directory,
    precheck: async () => {}, submitDraft: async () => assert.fail('unexpected recovery Enter'),
    draftMatches: async () => false, pause: async () => {}, attempts: 1 };
  let first = true;
  const type = async (progress) => {
    if (first) {
      first = false;
      progress.plan({ pid: 42, initialInputCount: 7, chunkChars: 3, chunkCount: 2,
        operationSeed: 'delivery_1234567890abcdef' });
      progress.start(0);
      progress.acknowledge(0, textHash('abc'));
      progress.start(1);
      throw new Error('host acknowledgement was lost');
    }
    assert.equal(progress.state.inFlightChunk, 1);
    assert.equal(progress.operationId(1), 'delivery_1234567890abcdef-1');
    progress.acknowledge(1, textHash('abcdef'));
    progress.complete();
    fs.appendFileSync(file, `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'abcdef' }] } })}\n`);
  };
  try {
    await assert.rejects(deliver({ ...base, type }), /acknowledgement was lost/);
    const journal = path.join(directory, `${textHash('partial')}.json`);
    const entry = JSON.parse(fs.readFileSync(journal, 'utf8'));
    assert.equal(entry.typedAt, undefined, 'chunk completion is not submission evidence');
    assert.equal(entry.typing.inFlightChunk, 1);
    // A live pane may still be holding this prefix, so the sweep never touches it,
    // however old it gets. (A pane the host has stopped listing is the other case:
    // "the reconcile sweep retires an unsubmitted draft once its pane is gone"
    // covers it, and half a message is retired there with no receipt of any kind.)
    assert.deepEqual(reconcile(directory, { now: Date.now() + 60 * 60e3, panes: new Set(['pane']) }), []);
    assert.equal(fs.existsSync(journal), true);
    await assert.rejects(deliver({ ...base, text: 'different', type: async () => assert.fail('must not type') }), /partially typed/);
    // Unfinished typing keeps its chunks at any age: only a journal with nothing
    // left to write gives up its resume, and this one still owes a chunk.
    fs.writeFileSync(journal, JSON.stringify({ ...JSON.parse(fs.readFileSync(journal, 'utf8')), createdAt: Date.now() - 60 * 60e3 }));
    assert.deepEqual(await deliver({ ...base, type }), { ok: true, delivery: 'received' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('partial resume removes a proven cleared draft but preserves evidence when only the retry typed nothing', async () => {
  const { textHash } = require('./delivery');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-partial-clear-'));
  const file = path.join(dir, 'transcript'); fs.writeFileSync(file, '');
  const seed = async (sessionId, directory) => {
    const base = { session: { id: sessionId, kind: 'codex' }, pane: 'pane', text: 'abcdef', file, directory,
      precheck: async () => {}, submitDraft: async () => assert.fail('unexpected Enter'),
      draftMatches: async () => false, pause: async () => {}, attempts: 1 };
    await assert.rejects(deliver({ ...base, type: async (progress) => {
      progress.plan({ pid: 42, initialInputCount: 7, chunkChars: 3, chunkCount: 2,
        operationSeed: `delivery_${sessionId.padEnd(16, '0')}` });
      progress.start(0);
      progress.acknowledge(0, textHash('abc'));
      throw new Error('stop between chunks');
    } }), /stop between chunks/);
    return { base, journal: path.join(directory, `${textHash(sessionId)}.json`) };
  };
  try {
    const cleared = await seed('cleared', path.join(dir, 'cleared'));
    await assert.rejects(deliver({ ...cleared.base, type: async () => {
      throw Object.assign(new Error('guard moved; draft cleared'), { typingStarted: true, draftCleared: true });
    } }), /draft cleared/);
    assert.equal(fs.existsSync(cleared.journal), false, 'an exact guarded clear releases the stale partial plan');

    const untouched = await seed('untouched', path.join(dir, 'untouched'));
    await assert.rejects(deliver({ ...untouched.base, type: async () => {
      throw Object.assign(new Error('retry typed nothing'), { nothingTyped: true });
    } }), /typed nothing/);
    assert.equal(fs.existsSync(untouched.journal), true,
      'nothingTyped on a retry does not erase chunks acknowledged by the earlier attempt');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The delivery incident of 2026-09-21 (delivery:343bbbb6): a Codex send typed all
// three of its chunks and was then refused Enter at the exact-draft guard, because
// the box had gained something else. Since 018ac71 that entry counts as partially
// typed with no `typedAt`, so every later send resumed it - with no chunks left to
// write, straight back into the same guard - and the expiry that had settled this
// shape before could never run. 32 consecutive delivery sweeps reported it.
//
// It must expire, and it must NOT simply be deleted as unsent: that draft was still
// in a live box, and 57 minutes later somebody pressed Enter on it. A journal thrown
// away for being unsent cannot recognise that receipt, and the next retry sends the
// message a second time.
test('an old fully typed journal expires through the send path instead of resuming forever', async () => {
  const { reconcile, textHash } = require('./delivery');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-refused-enter-'));
  const file = path.join(dir, 'rollout.jsonl'); fs.writeFileSync(file, '');
  const directory = path.join(dir, 'journal');
  const journal = path.join(directory, textHash('wedged') + '.json');
  let typed = 0;
  const typeAll = async (progress) => {
    typed += 1;
    if (!progress.state) {
      progress.plan({ pid: 42, initialInputCount: 1225, chunkChars: 9, chunkCount: 2,
        operationSeed: 'delivery_1234567890abcdef' });
    }
    for (let index = progress.state.acknowledgedChunks; index < 2; index += 1) {
      progress.start(index);
      progress.acknowledge(index, textHash('chunk-' + index));
    }
    progress.complete();
    // What bin/serve.js throws when the last guard finds the box holding more than
    // the typed message. The text stays on screen; Enter is not pressed.
    throw Object.assign(new Error('the input box no longer holds only the typed message; Enter was not pressed'),
      { typingStarted: true, draftLeftOnScreen: true });
  };
  const base = { session: { id: 'wedged', kind: 'codex' }, pane: 'live', text: 'the whole message',
    file, directory, precheck: async () => {}, submitDraft: async () => assert.fail('unexpected Enter'),
    draftMatches: async () => false, pause: async () => {}, attempts: 1 };
  const panes = new Set(['live']);
  try {
    await assert.rejects(deliver({ ...base, type: typeAll }), /Enter was not pressed/);
    const entry = JSON.parse(fs.readFileSync(journal, 'utf8'));
    assert.equal(entry.typedAt, undefined, 'a completed draft is not submission evidence');
    assert.equal(entry.typing.acknowledgedChunks, entry.typing.chunkCount);

    // A prompt retry still resumes, and finds nothing left to type.
    await assert.rejects(deliver({ ...base, type: typeAll }), /Enter was not pressed/);
    assert.equal(typed, 2, 'the young entry was resumed, not retyped from scratch');

    // The sweep leaves it alone while the pane lives, however old it gets: that
    // draft is in a box, and its receipt can still arrive.
    assert.deepEqual(reconcile(directory, { now: Date.now() + 60 * 60e3, panes }), []);
    assert.equal(fs.existsSync(journal), true);

    // The send that arrives after the stale window does not resume it a third time.
    // The whole message did reach the pane, so it expires as assumed delivered and
    // is never typed twice - exactly as it did before 018ac71.
    fs.writeFileSync(journal, JSON.stringify({ ...entry, createdAt: Date.now() - 60 * 60e3 }));
    assert.deepEqual(await deliver({ ...base, type: async () => assert.fail('retyped an expired send') }),
      { ok: true, delivery: 'assumed-delivered', expired: true });
    assert.equal(fs.existsSync(journal), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Only a dead pane turns "Enter was never pressed" into "and never will be": it can
// show the draft to nobody and take no key. A whole message that got there settles,
// so the retry does not type it again; a half-typed one leaves no record at all.
test('the reconcile sweep retires an unsubmitted draft once its pane is gone', async () => {
  const { reconcile, statusForText, textHash } = require('./delivery');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-gone-draft-'));
  const file = path.join(dir, 'rollout.jsonl'); fs.writeFileSync(file, '');
  const directory = path.join(dir, 'journal');
  const journalFor = (session) => path.join(directory, textHash(session) + '.json');
  const typeChunks = (acknowledged) => async (progress) => {
    progress.plan({ pid: 42, initialInputCount: 4, chunkChars: 9, chunkCount: 2,
      operationSeed: 'delivery_1234567890abcdef' });
    for (let index = 0; index < acknowledged; index += 1) {
      progress.start(index);
      progress.acknowledge(index, textHash('chunk-' + index));
    }
    if (acknowledged === 2) progress.complete();
    throw new Error('Enter was not pressed');
  };
  const send = (session, options = {}) => deliver({ session: { id: session, kind: 'codex' }, pane: 'probe',
    text: 'the whole message', file, directory, precheck: async () => {},
    submitDraft: async () => assert.fail('unexpected Enter'), draftMatches: async () => false,
    pause: async () => {}, attempts: 1, ...options });
  const panes = new Set(['live']);
  const later = Date.now() + 60 * 60e3;
  try {
    await assert.rejects(send('whole', { type: typeChunks(2) }), /Enter was not pressed/);
    await assert.rejects(send('half', { type: typeChunks(1) }), /Enter was not pressed/);
    await assert.rejects(send('check', { type: typeChunks(2), retainReceipt: true, key: 'check-1' }),
      /Enter was not pressed/);

    // Young, or with no pane list to prove the pane is gone: nothing is retired.
    assert.deepEqual(reconcile(directory, { panes }), []);
    assert.deepEqual(reconcile(directory, { now: later, panes: new Set() }), []);
    assert.equal(fs.existsSync(journalFor('whole')), true);

    assert.deepEqual(reconcile(directory, { now: later, panes }).sort(), ['check', 'half', 'whole']);
    assert.equal(fs.existsSync(journalFor('whole')), false);
    assert.equal(fs.existsSync(path.join(directory, 'settled', textHash('whole') + '.json')), true,
      'the whole message was on the dead pane, so its retry must not type it again');
    assert.deepEqual(await send('whole', { type: async () => assert.fail('retyped a retired send') }),
      { ok: true, delivery: 'received', recovered: true });

    assert.equal(fs.existsSync(journalFor('half')), false);
    assert.equal(fs.existsSync(path.join(directory, 'settled', textHash('half') + '.json')), false,
      'half a message is not a delivery');

    // A scheduled check keeps no false receipt: its owner must be free to run it.
    assert.equal(fs.existsSync(journalFor('check')), false);
    assert.equal(statusForText(directory, 'the whole message', 'check-1'), null);

    // Including when the pane may in fact have taken the Enter and only its reply
    // was lost, which leaves a journal nothing can tell from a refused one. The
    // check may then run a second time; that is the deliberate trade, and the same
    // one Keep already makes for a `typedAt` entry whose pane is gone.
    fs.writeFileSync(file, '');
    await assert.rejects(send('lost', { retainReceipt: true, key: 'check-2',
      type: async (progress) => {
        progress.plan({ pid: 42, initialInputCount: 4, chunkChars: 9, chunkCount: 1,
          operationSeed: 'delivery_1234567890abcdef' });
        progress.start(0);
        progress.acknowledge(0, textHash('chunk-0'));
        progress.complete();
        // Thrown from past the Enter, so it carries no claim either way.
        throw new Error('terminal host disconnected during non-idempotent input');
      } }), /host disconnected/);
    assert.deepEqual(reconcile(directory, { now: later, panes }), ['lost']);
    assert.equal(fs.existsSync(journalFor('lost')), false);
    assert.equal(fs.existsSync(path.join(directory, 'settled', textHash('lost') + '.json')), false);
    assert.equal(statusForText(directory, 'the whole message', 'check-2'), null,
      'no record at all, so the check falls back to a headless run');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Expiring an old complete draft must not become a way to type it somewhere else.
// The first copy is still in the original pane's box, where the incident's was, and
// somebody can submit it long afterwards - so a send aimed at another pane, or
// carrying other words, is refused exactly as it was before the entry went stale.
test('an old fully typed journal is never expired on behalf of a different send', async () => {
  const { textHash } = require('./delivery');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-other-pane-'));
  const file = path.join(dir, 'rollout.jsonl'); fs.writeFileSync(file, '');
  const directory = path.join(dir, 'journal');
  const journal = path.join(directory, textHash('wedged') + '.json');
  const base = { session: { id: 'wedged', kind: 'codex' }, pane: 'live', text: 'the whole message',
    file, directory, precheck: async () => {}, submitDraft: async () => assert.fail('unexpected Enter'),
    draftMatches: async () => false, pause: async () => {}, attempts: 1 };
  try {
    await assert.rejects(deliver({ ...base, type: async (progress) => {
      progress.plan({ pid: 42, initialInputCount: 4, chunkChars: 9, chunkCount: 2,
        operationSeed: 'delivery_1234567890abcdef' });
      for (const index of [0, 1]) {
        progress.start(index);
        progress.acknowledge(index, textHash('chunk-' + index));
      }
      progress.complete();
      throw new Error('the input box no longer holds only the typed message; Enter was not pressed');
    } }), /Enter was not pressed/);
    const entry = JSON.parse(fs.readFileSync(journal, 'utf8'));
    fs.writeFileSync(journal, JSON.stringify({ ...entry, createdAt: Date.now() - 60 * 60e3 }));

    const mustNotType = async () => assert.fail('typed a second copy of a draft still in another box');
    await assert.rejects(deliver({ ...base, pane: 'elsewhere', type: mustNotType }), /partially typed/);
    await assert.rejects(deliver({ ...base, text: 'something else', type: mustNotType }), /partially typed/);
    assert.equal(fs.existsSync(journal), true, 'and the record of the first copy is kept');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the turn index as a second witness ----------
//
// Every fixture below is generated: random session ids, temp directories, and a
// synthetic Codex rollout ingested into a temporary index with turn-index's own
// ingestFile, so the index rows have exactly the shape the daemon writes.
const crypto = require('crypto');
const turnIndex = require('./turn-index.js');

const generatedId = (label) => `${label}-${crypto.randomBytes(8).toString('hex')}`;

// Writes one rollout per session holding `texts` as typed user messages at `at`,
// and ingests it into `db`.
function indexMessages(dir, db, sessionId, texts, at = Date.now()) {
  const stamp = new Date(at).toISOString();
  const records = [
    { type: 'session_meta', timestamp: stamp, payload: { id: sessionId, cwd: dir, timestamp: stamp, originator: 'codex-tui', source: 'cli' } },
    ...texts.flatMap((text) => [
      { type: 'response_item', timestamp: stamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
      { type: 'event_msg', timestamp: stamp, payload: { type: 'task_complete' } },
    ]),
  ];
  const file = path.join(dir, `rollout-${sessionId}.jsonl`);
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const result = turnIndex.ingestFile(file, { agent: 'codex', db });
  turnIndex.close();
  assert.equal(result.ok, true);
}

function indexFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delivery-index-'));
  // The receipt transcript stays empty for good: the hook receipt never lands.
  const file = path.join(dir, 'receipt-transcript.jsonl'); fs.writeFileSync(file, '');
  return { dir, file, directory: path.join(dir, 'journal'), db: path.join(dir, 'turns.sqlite') };
}

// A type() whose Enter the agent records: the index gets the row after the journal
// was written, as a real transcript line is, but the watched receipt file never does.
const recordedOnEnter = (f, sessionId, texts) => async () => indexMessages(f.dir, f.db, sessionId, texts);

const plainSend = (f, sessionId, text, extra = {}) => deliver({
  session: { id: sessionId, kind: 'codex' }, pane: 'pane-' + sessionId, text, file: f.file, directory: f.directory,
  indexDb: f.db, precheck: async () => {}, type: async () => {}, submitDraft: async () => assert.fail('unexpected Enter'),
  draftMatches: async () => false, draftOnScreen: async () => false, pause: async () => {}, attempts: 1, ...extra,
});

test('a delivery whose transcript receipt never lands is confirmed by the turn index', async () => {
  const f = indexFixture();
  const sessionId = generatedId('codex');
  const stages = [];
  try {
    const result = await plainSend(f, sessionId, '[keep] from another session:\n  please rebase', {
      trace: (stage) => stages.push(stage), type: recordedOnEnter(f, sessionId, ['[keep] from another session: please rebase']) });
    assert.deepEqual(result, { ok: true, delivery: 'received', source: 'turn-index' });
    assert.ok(stages.includes('receipt-from-index'));
    assert.deepEqual(fs.readdirSync(f.directory).filter((name) => name.endsWith('.json')), [], 'the journal is finished');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('a message longer than the index cap is confirmed by its stored prefix', async () => {
  const f = indexFixture();
  const sessionId = generatedId('codex');
  const text = 'long message '.repeat(Math.ceil(turnIndex.TEXT_CAP / 10));
  try {
    assert.equal((await plainSend(f, sessionId, text, { type: recordedOnEnter(f, sessionId, [text]) })).source, 'turn-index');
    // The same stored prefix under a different ending is not this message.
    const other = generatedId('codex');
    await assert.rejects(plainSend(f, other, text.slice(0, turnIndex.TEXT_CAP - 50), { type: recordedOnEnter(f, other, [text]) }),
      /no matching transcript receipt/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('the turn index does not confirm other words, another session, or an old identical message', async () => {
  const f = indexFixture();
  const sessionId = generatedId('codex');
  const old = generatedId('codex');
  const elsewhere = generatedId('codex');
  try {
    await assert.rejects(plainSend(f, sessionId, 'please rebase onto main', { type: recordedOnEnter(f, sessionId, ['please rebase onto master']) }),
      /no matching transcript receipt/);
    await assert.rejects(plainSend(f, generatedId('codex'), 'run the tests', { type: recordedOnEnter(f, elsewhere, ['run the tests']) }),
      /no matching transcript receipt/);
    // The same words sent ten minutes before this attempt answer that attempt, not this one.
    indexMessages(f.dir, f.db, old, ['continue'], Date.now() - 10 * 60e3);
    await assert.rejects(plainSend(f, old, 'continue'), /no matching transcript receipt/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('a missing turn index leaves the unconfirmed error exactly as before', async () => {
  const f = indexFixture();
  const sessionId = generatedId('codex');
  const stages = [];
  try {
    await assert.rejects(plainSend(f, sessionId, 'hello', { trace: (stage) => stages.push(stage) }),
      /Delivery unconfirmed: no matching transcript receipt/);
    assert.ok(stages.includes('index-missing'));
    assert.equal(fs.existsSync(f.db), false, 'the delivery path never creates the index');
    assert.equal(fs.readdirSync(f.directory).filter((name) => name.endsWith('.json')).length, 1, 'the attempt is retained');
    // A file that is not an index at all is no evidence either, and no exception.
    fs.writeFileSync(f.db, 'not a database');
    stages.length = 0;
    await assert.rejects(plainSend(f, generatedId('codex'), 'hello', { trace: (stage) => stages.push(stage) }), /Delivery unconfirmed: no matching transcript receipt/);
    assert.ok(stages.includes('index-error'));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('reconcile settles a typed journal the turn index confirms and leaves the rest alone', async () => {
  const { reconcile, statusForText, textHash } = require('./delivery');
  const f = indexFixture();
  const confirmed = generatedId('codex');
  const other = generatedId('codex');
  const check = generatedId('codex');
  const untyped = generatedId('codex');
  const long = generatedId('codex');
  const longText = 'x'.repeat(turnIndex.TEXT_CAP + 100);
  const journalFor = (id) => path.join(f.directory, textHash(id) + '.json');
  try {
    // Sent while the index had not caught up (it does not exist yet), so each is
    // left unconfirmed with its text on the pane.
    for (const [id, text, extra] of [[confirmed, 'ship it'], [other, 'ship it too'], [check, 'scheduled check', { retainReceipt: true, key: 'check-key' }], [long, longText]]) {
      await assert.rejects(plainSend(f, id, text, extra), /no matching transcript receipt/);
    }
    assert.ok(JSON.parse(fs.readFileSync(journalFor(long), 'utf8')).indexPrefixHash, 'a long message records its indexed prefix');
    // Typing failed before Enter: nothing reached the transcript, and it must not be looked up.
    await assert.rejects(plainSend(f, untyped, 'never sent', { type: async () => { throw new Error('host refused'); } }), /host refused/);

    indexMessages(f.dir, f.db, confirmed, ['ship it']);
    indexMessages(f.dir, f.db, other, ['something unrelated']);
    indexMessages(f.dir, f.db, check, ['scheduled check']);
    indexMessages(f.dir, f.db, untyped, ['never sent']);
    indexMessages(f.dir, f.db, long, [longText]);

    // Inside the grace the send path's own last look stands; nothing is settled.
    assert.deepEqual(reconcile(f.directory, { indexDb: f.db }), []);
    const later = Date.now() + 61e3;
    assert.deepEqual(reconcile(f.directory, { now: later, indexDb: f.db }).sort(), [check, confirmed, long].sort());
    assert.equal(fs.existsSync(journalFor(confirmed)), false);
    assert.equal(fs.existsSync(path.join(f.directory, 'settled', textHash(confirmed) + '.json')), true, 'a plain send settles as received');
    assert.deepEqual(statusForText(f.directory, 'scheduled check', 'check-key'), { sessionId: check, kind: 'codex', received: true });
    assert.equal(fs.existsSync(journalFor(other)), true, 'other words leave the journal unconfirmed');
    assert.equal(fs.existsSync(journalFor(untyped)), true, 'an untyped journal keeps its old stale handling');
    // The settled journal is recovered by the next send of the same text, without retyping.
    assert.deepEqual(await plainSend(f, confirmed, 'ship it', { type: async () => assert.fail('retyped') }),
      { ok: true, delivery: 'received', recovered: true });
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('an identical message recorded before the attempt does not confirm it; one recorded after does', async () => {
  const f = indexFixture();
  const before = generatedId('codex');
  const after = generatedId('codex');
  try {
    // Ten seconds before this send: a repeated "continue", not this one.
    indexMessages(f.dir, f.db, before, ['continue'], Date.now() - 10e3);
    await assert.rejects(plainSend(f, before, 'continue'), /no matching transcript receipt/);
    // Recorded by the agent after this send typed it, as a real transcript line is.
    const result = await plainSend(f, after, 'continue', {
      type: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); indexMessages(f.dir, f.db, after, ['continue']); },
    });
    assert.equal(result.source, 'turn-index');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('a pending typed journal the index confirms no longer blocks the next send', async () => {
  const f = indexFixture();
  const confirmed = generatedId('codex');
  const unconfirmed = generatedId('codex');
  const stages = [];
  const trace = (stage) => stages.push(stage);
  // The next send's own receipt lands in the watched transcript the usual way.
  const typeWithReceipt = (text) => async () => fs.appendFileSync(f.file, JSON.stringify({
    type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n');
  try {
    await assert.rejects(plainSend(f, confirmed, 'first message'), /no matching transcript receipt/);
    await assert.rejects(plainSend(f, unconfirmed, 'first message'), /no matching transcript receipt/);
    // The index catches up after the first send gave up; only one session recorded it.
    indexMessages(f.dir, f.db, confirmed, ['first message']);
    indexMessages(f.dir, f.db, unconfirmed, ['something else']);

    const result = await plainSend(f, confirmed, 'second message', { trace, type: typeWithReceipt('second message') });
    assert.deepEqual(result, { ok: true, delivery: 'received' }, 'delivered normally, by its own transcript receipt');
    assert.ok(stages.includes('pending-settled-by-index'));

    await assert.rejects(plainSend(f, unconfirmed, 'second message', { type: typeWithReceipt('second message') }),
      /Previous delivery is unconfirmed/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// ---------- the index never outranks a draft still in the box ----------

const ENTER_NOT_PRESSED = 'message was typed but could not be confirmed; Enter was not pressed';
// The per-chunk path: every chunk acknowledged, typing complete, and Enter refused,
// so the journal has completedTyping true and no typedAt.
const typeAllChunks = (progress) => {
  progress.plan({ pid: 42, initialInputCount: 0, chunkChars: 200, chunkCount: 1, operationSeed: 'delivery_' + crypto.randomBytes(8).toString('hex') });
  progress.start(0);
  progress.acknowledge(0, textHash('chunk-0'));
  progress.complete();
};
const journalOf = (f, id) => JSON.parse(fs.readFileSync(path.join(f.directory, textHash(id) + '.json'), 'utf8'));
const receiptLine = (f, text) => fs.appendFileSync(f.file, JSON.stringify({
  type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n');

test('the review scenario: an earlier identical confirmed send cannot confirm one whose Enter was lost', async () => {
  const f = indexFixture();
  const id = generatedId('codex');
  let enters = 0;
  try {
    // J0: X is sent and confirmed by the index.
    assert.equal((await plainSend(f, id, 'continue', { type: recordedOnEnter(f, id, ['continue']) })).source, 'turn-index');
    // J1: X again at once; typed, but Enter is lost and X sits in the box.
    await assert.rejects(plainSend(f, id, 'continue', { draftMatches: async () => true, draftOnScreen: async () => true, submitDraft: async () => { enters++; } }),
      /Delivery unconfirmed/);
    assert.equal(enters, 1, 'the existing retry pressed Enter once and it was lost again');
    // The next send of X finds J1 pending and submits the draft; J0's row does not recover it.
    let onScreen = true;
    const result = await plainSend(f, id, 'continue', {
      draftMatches: async () => onScreen, draftOnScreen: async () => onScreen,
      submitDraft: async () => { enters++; onScreen = false; receiptLine(f, 'continue'); },
      type: async () => assert.fail('retyped'),
    });
    assert.equal(enters, 2);
    assert.deepEqual(result, { ok: true, delivery: 'received' });
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('an index row never confirms a fully typed, unsubmitted draft that is still on screen', async () => {
  const f = indexFixture();
  const id = generatedId('codex');
  const stages = [];
  let enters = 0;
  try {
    // A matching row newer than createdAt exists, but the text is still in the box.
    await assert.rejects(plainSend(f, id, 'deploy now', {
      trace: (stage) => stages.push(stage),
      type: async (progress) => { typeAllChunks(progress); indexMessages(f.dir, f.db, id, ['deploy now']); throw new Error(ENTER_NOT_PRESSED); },
      draftMatches: async () => true, draftOnScreen: async () => true, submitDraft: async () => { enters++; },
    }), /Enter was not pressed/);
    assert.ok(stages.includes('index-match-draft-present'));
    assert.ok(!stages.includes('receipt-from-index'));
    const entry = journalOf(f, id);
    assert.equal(entry.typedAt, undefined);
    assert.equal(entry.typing.acknowledgedChunks, entry.typing.chunkCount, 'completedTyping, never submitted');

    // The same text again, draft still on screen: the pending path submits the draft
    // (a complete per-chunk entry resumes, whose only remaining step is Enter) rather
    // than recovering from the index.
    stages.length = 0;
    let onScreen = true, resumed = 0;
    const result = await plainSend(f, id, 'deploy now', {
      trace: (stage) => stages.push(stage),
      draftMatches: async () => onScreen, draftOnScreen: async () => onScreen,
      type: async (progress) => {
        resumed++;
        assert.equal(progress.state.acknowledgedChunks, progress.state.chunkCount, 'a resume with nothing left to type');
        onScreen = false; receiptLine(f, 'deploy now');
      },
      submitDraft: async () => assert.fail('the resume submits'),
    });
    assert.equal(resumed, 1);
    assert.ok(stages.includes('index-match-draft-present'));
    assert.ok(!stages.includes('pending-settled-by-index'));
    assert.deepEqual(result, { ok: true, delivery: 'received' }, 'delivered by submitting, not recovered');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('the index look before a typing error is rethrown confirms once the draft is gone', async () => {
  const f = indexFixture();
  const id = generatedId('codex');
  try {
    // Enter was reported refused, yet the agent recorded the message and the box is empty.
    const result = await plainSend(f, id, 'deploy now', {
      type: async (progress) => { typeAllChunks(progress); indexMessages(f.dir, f.db, id, ['deploy now']); throw new Error(ENTER_NOT_PRESSED); },
      draftMatches: async () => false,
    });
    assert.deepEqual(result, { ok: true, delivery: 'received', source: 'turn-index' });
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('the index window starts exactly at createdAt', async () => {
  const f = indexFixture();
  const early = generatedId('codex');
  const exact = generatedId('codex');
  try {
    await assert.rejects(plainSend(f, early, 'status?', {
      type: async () => indexMessages(f.dir, f.db, early, ['status?'], journalOf(f, early).createdAt - 1),
    }), /no matching transcript receipt/);
    const result = await plainSend(f, exact, 'status?', {
      type: async () => indexMessages(f.dir, f.db, exact, ['status?'], journalOf(f, exact).createdAt),
    });
    assert.equal(result.source, 'turn-index');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('reconcile looks for the index once per sweep and traces its absence once', async () => {
  const { reconcile } = require('./delivery');
  const f = indexFixture();
  try {
    for (const id of [generatedId('codex'), generatedId('codex'), generatedId('codex')]) {
      await assert.rejects(plainSend(f, id, 'hello'), /no matching transcript receipt/);
    }
    const events = () => fs.readFileSync(path.join(f.directory, 'diagnostics', 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.stage === 'index-missing');
    const before = fs.existsSync(path.join(f.directory, 'diagnostics', 'events.jsonl')) ? events().length : 0;
    assert.deepEqual(reconcile(f.directory, { now: Date.now() + 61e3, indexDb: f.db }), []);
    assert.equal(events().length - before, 1);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// draftMatches is false for any session mid-turn, whatever the box holds, so the
// index guard has its own screen check. This is the queued-Claude case: an earlier
// identical message's row is written after this attempt began, while this text sits
// in the box of a session that is busy.
test('a busy session with the text still in the box is never confirmed from the index', async () => {
  const f = indexFixture();
  const inBox = generatedId('claude');
  const gone = generatedId('claude');
  const stages = [];
  try {
    await assert.rejects(plainSend(f, inBox, 'rebase please', {
      trace: (stage) => stages.push(stage),
      type: recordedOnEnter(f, inBox, ['rebase please']),
      draftMatches: async () => false, // mid-turn: not ready to submit
      draftOnScreen: async () => true, // but the text is in the box
    }), /Delivery unconfirmed/);
    assert.ok(stages.includes('index-match-draft-present'));
    assert.equal(fs.existsSync(path.join(f.directory, textHash(inBox) + '.json')), true, 'the journal is kept');

    const result = await plainSend(f, gone, 'rebase please', {
      type: recordedOnEnter(f, gone, ['rebase please']),
      draftMatches: async () => false, draftOnScreen: async () => false,
    });
    assert.equal(result.source, 'turn-index');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('a caller that cannot see the box never confirms from the index, and a failed screen read counts as present', async () => {
  const f = indexFixture();
  const blind = generatedId('codex');
  const failing = generatedId('codex');
  try {
    await assert.rejects(plainSend(f, blind, 'hello', { type: recordedOnEnter(f, blind, ['hello']), draftOnScreen: undefined }),
      /Delivery unconfirmed/);
    await assert.rejects(plainSend(f, failing, 'hello', { type: recordedOnEnter(f, failing, ['hello']),
      draftOnScreen: async () => { throw new Error('host timed out'); } }), /Delivery unconfirmed/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// ---------- a delivery to a session on another node ----------

// A node as delivery sees one: its own path and size for the transcript, and a
// receipt it answers from what it read there. The "node" here reads a file in a temp
// directory with the same matcher the real host uses (matchesFrom); what matters is
// that deliver never opens entry.file itself.
function fakeNode(file, options = {}) {
  const { matchesFrom } = require('./delivery');
  const calls = [];
  let looks = 0;
  return {
    calls,
    remote: {
      node: 'aws1',
      stat: async () => {
        calls.push('stat');
        return { path: file, size: fs.statSync(file).size, generation: 'gen-1' };
      },
      receipt: async (entry, { timeoutMs }) => {
        calls.push(['receipt', timeoutMs]);
        if (options.silent && options.silent()) throw new Error('host request timed out (transcript)');
        // The node's long poll: a look now and one every 500 ms until the wait is spent.
        for (let look = 0; look <= Math.floor(timeoutMs / 500); look += 1) {
          looks += 1;
          if (options.beforeLook) options.beforeLook(looks);
          if (matchesFrom(file, entry.offset, { kind: entry.kind, hash: entry.hash }).matched) return true;
        }
        return false;
      },
    },
  };
}

function remoteDeliveryFixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `keep-remote-delivery-${name}-`));
  const file = path.join(root, 'node-transcript.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: 'earlier' } })}\n`);
  const directory = path.join(root, 'journal');
  const userLine = (text) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
  return { root, file, directory, userLine, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a delivery to a node session journals the node and is confirmed by the node\'s receipt', async () => {
  const f = remoteDeliveryFixture('confirmed');
  try {
    const offsetAtSend = fs.statSync(f.file).size;
    let journalled = null;
    // The agent writes the user line only after the node has looked twice.
    const node = fakeNode(f.file, { beforeLook: (n) => { if (n === 3) fs.appendFileSync(f.file, f.userLine('hello node')); } });
    const result = await deliver({
      session: { id: 'remote-session', kind: 'claude' }, pane: 'p7@aws1', text: 'hello node', file: null, remote: node.remote,
      directory: f.directory, retainReceipt: true, key: 'card:check',
      precheck: async () => {},
      type: async () => {
        journalled = JSON.parse(fs.readFileSync(path.join(f.directory, textHash('remote-session') + '.json'), 'utf8'));
      },
      submitDraft: async () => assert.fail('no Enter retry is needed'), draftMatches: async () => false,
      pause: async () => assert.fail('the node does the waiting, not this process'), attempts: 16,
    });
    assert.equal(result.delivery, 'received');
    assert.equal(journalled.node, 'aws1');
    assert.equal(journalled.file, f.file, 'the node\'s own path, recorded');
    assert.equal(journalled.offset, offsetAtSend, 'from the node\'s size when typing started');
    assert.equal(journalled.generation, 'gen-1');
    // One stat, then the node's long polls: 16 × 500 ms is at most nine seconds a request.
    assert.equal(node.calls[0], 'stat');
    assert.deepEqual(node.calls.slice(1).map((call) => call[1]), [8000]);
    // Settled: the active journal is gone and the retained receipt names the node.
    assert.equal(fs.existsSync(path.join(f.directory, textHash('remote-session') + '.json')), false);
    const receipts = fs.readdirSync(path.join(f.directory, 'receipts'));
    assert.equal(receipts.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, 'receipts', receipts[0]), 'utf8')),
      { sessionId: 'remote-session', kind: 'claude', received: true, node: 'aws1' });
  } finally { f.cleanup(); }
});

test('a node that stops answering leaves the delivery unconfirmed and its journal exactly as it was', async () => {
  const f = remoteDeliveryFixture('silent');
  try {
    let silent = false;
    const node = fakeNode(f.file, { silent: () => silent });
    const base = {
      session: { id: 'remote-session', kind: 'claude' }, pane: 'p7@aws1', text: 'hello node', file: null, remote: node.remote,
      directory: f.directory, precheck: async () => {}, submitDraft: async () => assert.fail('no Enter'),
      draftMatches: async () => false, pause: async () => {}, attempts: 2,
    };
    await assert.rejects(deliver({ ...base, type: async () => { silent = true; } }),
      /Delivery unconfirmed: aws1 did not answer for the transcript receipt .*Pending attempt retained; no automatic retyping/);
    const journal = path.join(f.directory, textHash('remote-session') + '.json');
    const before = fs.readFileSync(journal, 'utf8');
    assert.equal(JSON.parse(before).node, 'aws1');
    assert.equal(Number(JSON.parse(before).typedAt) > 0, true);

    // The next send to that session asks the node about the pending one first. Still
    // silent: nothing is typed and the journal is not touched.
    let typed = 0;
    await assert.rejects(deliver({ ...base, text: 'another message', type: async () => { typed += 1; } }),
      /Previous delivery could not be checked: aws1 did not answer/);
    assert.equal(typed, 0);
    assert.equal(fs.readFileSync(journal, 'utf8'), before);

    // It answers, and the line is there: the earlier message is recovered, not retyped.
    silent = false;
    fs.appendFileSync(f.file, f.userLine('hello node'));
    const recovered = await deliver({ ...base, type: async () => { typed += 1; } });
    assert.equal(recovered.recovered, true);
    assert.equal(typed, 0);
    assert.equal(fs.existsSync(journal), false);
  } finally { f.cleanup(); }
});

test('a node journal is never read as a local file, and never answered by a caller with no node to ask', async () => {
  const f = remoteDeliveryFixture('guarded');
  try {
    const { received, statusForText, pendingForSession, statusForTextAsync, pendingForSessionAsync } = require('./delivery');
    fs.appendFileSync(f.file, f.userLine('already there'));
    const entry = { createdAt: Date.now(), sessionId: 'remote-session', kind: 'claude', file: f.file, offset: 0,
      pane: 'p7@aws1', hash: textHash('already there'), node: 'aws1', retainReceipt: true, key: 'k' };
    assert.throws(() => received(entry), /the receipt for a delivery on aws1 is that node's to give/);
    fs.mkdirSync(f.directory, { recursive: true });
    const journal = path.join(f.directory, textHash('remote-session') + '.json');
    fs.writeFileSync(journal, JSON.stringify(entry));
    // A synchronous caller cannot ask: pending, and nothing moves.
    assert.deepEqual(statusForText(f.directory, 'already there', 'k'),
      { sessionId: 'remote-session', kind: 'claude', received: false, pending: true });
    assert.equal(pendingForSession(f.directory, 'remote-session'), true);
    assert.ok(fs.existsSync(journal));
    // An async one asks; a node that does not answer is still pending.
    assert.equal((await statusForTextAsync(f.directory, 'already there', 'k', { receiptFor: async () => { throw new Error('silent'); } })).pending, true);
    assert.equal(await pendingForSessionAsync(f.directory, 'remote-session', { receiptFor: async () => false }), true);
    assert.ok(fs.existsSync(journal));
    // A yes settles it as a local receipt would.
    assert.equal((await statusForTextAsync(f.directory, 'already there', 'k', { receiptFor: async () => true })).received, true);
    assert.equal(fs.existsSync(journal), false);

    // A send whose pending journal is on a node, made without a way to ask that node,
    // stops before typing.
    fs.writeFileSync(journal, JSON.stringify(entry));
    await assert.rejects(deliver({ session: { id: 'remote-session', kind: 'claude' }, pane: 'p7@aws1', text: 'x', file: f.file,
      directory: f.directory, precheck: async () => {}, type: async () => assert.fail('typed'), submitDraft: async () => {},
      draftMatches: async () => false, pause: async () => {}, attempts: 1 }),
    /Previous delivery could not be checked: .*cannot be asked from here/);
  } finally { f.cleanup(); }
});
