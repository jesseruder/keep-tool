'use strict';
// End to end: `keep tell` from the daemon to a Claude session on node aws1. Two real
// terminal hosts (bin/fixtures/two-node-hosts.js); the session is a small fake of
// Claude's TUI running in a pane on aws1, with its transcript under aws1's account.
// The daemon types into that pane through aws1's host exactly as it types anywhere,
// and learns whether the message arrived only from aws1's own `transcript` verb: the
// journal names the node, and nothing on the daemon side opens the node's path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { withTwoNodeFleet } = require('./fixtures/two-node-hosts.js');
const { connect } = require('./hostclient.js');
const serve = require('./serve.js');
const delivery = require('./delivery.js');

const line = (value) => `${JSON.stringify(value)}\n`;

// Enough of Claude's input box for the daemon's prechecks and its exact-draft check:
// an empty `❯` between two rules, the typed characters echoed on it, Backspace, and
// Enter. On Enter it records the message as a user line in its transcript - unless it
// was started with FAKE_CLAUDE_RECORDS=0, which is a session that takes the Enter and
// never writes it down.
const FAKE_CLAUDE_TUI = `
'use strict';
const fs = require('node:fs');
const transcript = process.env.FAKE_CLAUDE_TRANSCRIPT;
const records = process.env.FAKE_CLAUDE_RECORDS !== '0';
let draft = '';
const rule = '─'.repeat(60);
const draw = () => process.stdout.write('\\x1b[2J\\x1b[H' + ['fake claude', '', rule, '❯ ' + draft, rule, '  ? for shortcuts'].join('\\r\\n'));
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const ch of chunk) {
    if (ch === '\\r') {
      if (draft && records) {
        fs.appendFileSync(transcript, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(),
          message: { role: 'user', content: draft } }) + '\\n');
      }
      draft = '';
    } else if (ch === '\\x7f') draft = draft.slice(0, -1);
    else if (ch >= ' ') draft += ch;
  }
  draw();
});
draw();
`;

async function openFakeSession(fleet, sid, { records = true } = {}) {
  // aws1's own transcript, under its own account: a finished turn, so the session is idle.
  const project = path.join(fleet.configDir, 'projects', '-work-project');
  fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(project, `${sid}.jsonl`);
  const at = new Date(Date.now() - 5000).toISOString();
  fs.writeFileSync(transcript, [
    line({ type: 'permission-mode', permissionMode: 'default', sessionId: sid }),
    line({ type: 'user', sessionId: sid, cwd: fleet.project, timestamp: at, message: { role: 'user', content: 'hello' } }),
    line({ type: 'assistant', sessionId: sid, cwd: fleet.project, timestamp: at,
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ready.' }] } }),
  ].join(''));
  require('./accounts.js').pinSession(sid, 'claude', fleet.accountId, { root: fleet.registry, node: 'aws1' });
  const script = path.join(fleet.fakeBin, 'fake-claude-tui.js');
  fs.writeFileSync(script, FAKE_CLAUDE_TUI);
  const remote = await connect({ node: 'aws1' });
  let pane;
  try {
    pane = (await remote.request('spawn', {
      cmd: process.execPath, args: [script], cwd: fleet.project, cols: 100, rows: 30,
      env: { FAKE_CLAUDE_TRANSCRIPT: transcript, FAKE_CLAUDE_RECORDS: records ? '1' : '0' },
      meta: { agent: 'claude', sessionId: sid, accountId: fleet.accountId },
    })).pane;
    // Wait for the box to be drawn before anything reads the screen.
    for (let i = 0; i < 100; i += 1) {
      const screen = await remote.request('screen', { pane: pane.id, lines: 30 });
      if (/❯/.test(String(screen.text || ''))) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally { remote.close(); }
  return { transcript, pane: `${pane.id}@aws1` };
}

function daemonDeps(fleet) {
  return {
    root: fleet.registry,
    connectHost: connect,
    deliveryDirectory: path.join(fleet.registry, '.keep', 'delivery'),
  };
}

test('keep tell to a Claude session on aws1 is confirmed by aws1\'s receipt, and an unwritten one is left unconfirmed', async (t) => {
  await withTwoNodeFleet(t, async (fleet) => {
    await serve.closeHostClient();
    // Every file opened in this process while it runs, apart from those aws1's host
    // opens to answer its transcript verb (both hosts live in this process in the
    // test, and the node's transcripts are this machine's files). What is left is the
    // daemon's own reading, and none of it may be a transcript of aws1's.
    const opened = [];
    const realOpen = fs.openSync;
    fs.openSync = function watchedOpen(file, ...rest) {
      if (!/node-transcript\.js/.test(String(new Error().stack))) opened.push(String(file));
      return realOpen.call(this, file, ...rest);
    };
    try {
      const deps = daemonDeps(fleet);
      const directory = deps.deliveryDirectory;

      // ---- delivered: the fake writes the user line, aws1 reads it, the journal settles.
      const sid = 'sess-remote-tell-ok';
      const ok = await openFakeSession(fleet, sid);
      const result = await serve.sendToSession({ sessionId: sid, text: 'hello from main' }, undefined,
        { retainReceipt: true, deliveryKey: 'e2e:ok' }, deps);
      assert.equal(result.delivery, 'received');
      const lines = fs.readFileSync(ok.transcript, 'utf8').trim().split('\n').map((row) => JSON.parse(row));
      assert.equal(lines.at(-1).message.content, 'hello from main', 'the agent recorded the message on aws1');
      assert.equal(fs.existsSync(path.join(directory, `${delivery.textHash(sid)}.json`)), false, 'the journal settled');
      const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'receipts',
        `${delivery.textHash('key:e2e:ok')}.json`), 'utf8'));
      assert.deepEqual(receipt, { sessionId: sid, kind: 'claude', received: true, node: 'aws1' });
      assert.deepEqual(opened.filter((file) => file.startsWith(fleet.configDir)), [],
        'the daemon never opened a transcript of aws1\'s');

      // ---- unconfirmed: the fake takes the Enter and never writes it down.
      const lost = 'sess-remote-tell-lost';
      await openFakeSession(fleet, lost, { records: false });
      // The pane was made behind the daemon's back (straight on aws1's host), so its
      // one-second pane list is refreshed before the send looks for it.
      await serve.listHostPaneResult(deps, true);
      await assert.rejects(serve.sendToSession({ sessionId: lost, text: 'this one is lost' }, undefined, {}, deps),
        (error) => /Delivery unconfirmed: no matching transcript receipt\. Pending attempt retained/.test(error.message)
          && error.typingStarted === true);
      const journal = path.join(directory, `${delivery.textHash(lost)}.json`);
      const entry = JSON.parse(fs.readFileSync(journal, 'utf8'));
      assert.equal(entry.node, 'aws1');
      assert.equal(entry.file, path.join(fleet.configDir, 'projects', '-work-project', `${lost}.jsonl`), 'aws1\'s own path, recorded');
      assert.ok(Number(entry.typedAt) > 0);
      const before = fs.readFileSync(journal, 'utf8');

      // Reconcile asks aws1, which says "not there": the journal stays, byte for byte,
      // even well past the stale window with its pane still listed.
      const listed = await serve.listHostPaneResult(deps, true);
      const panes = new Set(listed.panes.map((pane) => pane.id));
      const settled = await delivery.reconcileAsync(directory, {
        panes, now: Date.now() + 60 * 60e3, receiptFor: (row) => serve.deliveryReceiptFor(row, deps, 0),
      });
      assert.deepEqual(settled, []);
      assert.equal(fs.readFileSync(journal, 'utf8'), before);
      // And with aws1 gone silent, the same.
      const silent = await delivery.reconcileAsync(directory, {
        panes: new Set(['elsewhere']), now: Date.now() + 60 * 60e3,
        receiptFor: async () => { throw new Error('host request timed out (transcript)'); },
      });
      assert.deepEqual(silent, []);
      assert.equal(fs.readFileSync(journal, 'utf8'), before);
      assert.deepEqual(opened.filter((file) => file.startsWith(fleet.configDir)), []);
    } finally {
      fs.openSync = realOpen;
      await serve.closeHostClient();
    }
  });
});
