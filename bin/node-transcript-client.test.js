'use strict';
// The daemon's side of a node's transcripts: the session model built from a node's
// tail, a remote session loaded for an action, and the refusal for a node whose host
// predates the verb. The node side of the verb is tested in bin/host.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const serve = require('./serve.js');
const { connect } = require('./hostclient.js');

const line = (value) => `${JSON.stringify(value)}\n`;
const at = (offsetMs) => new Date(Date.now() - offsetMs).toISOString();

function claudeTranscript({ padding = 0 } = {}) {
  const lines = [
    line({ type: 'system', subtype: 'init', cwd: '/work/project', timestamp: at(9000), entrypoint: 'cli' }),
    line({ type: 'user', cwd: '/work/project', gitBranch: 'main', timestamp: at(8000), message: { role: 'user', content: 'please look at the build' } }),
  ];
  for (let i = 0; i < padding; i += 1) {
    lines.push(line({ type: 'assistant', timestamp: at(7000), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'x'.repeat(900) }] } }));
  }
  lines.push(line({ type: 'assistant', cwd: '/work/project', timestamp: at(5000), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'The build is green.' }] } }));
  return lines.join('');
}

// What the node's tail op answers for this file: the last 256 KiB and where they start.
function tailOf(file) {
  const bytes = fs.readFileSync(file);
  const stat = fs.statSync(file);
  const from = Math.max(0, bytes.length - 256 * 1024);
  return { path: file, size: stat.size, mtimeMs: stat.mtimeMs, generation: 'g', bytes: bytes.subarray(from).toString('base64'), from };
}

test('a Claude session built from a node tail is the one a local file with the same bytes gives', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-tail-model-'));
  try {
    for (const padding of [0, 400]) {
      const project = path.join(dir, `-work-project-${padding}`);
      fs.mkdirSync(project, { recursive: true });
      const file = path.join(project, 'sess-model.jsonl');
      fs.writeFileSync(file, claudeTranscript({ padding }));
      const stat = fs.statSync(file);
      if (padding) assert.ok(stat.size > 256 * 1024, 'the long case really is past one tail');
      const now = Date.now();
      const local = serve.claudeSessionFromInfo('sess-model', serve.scanTranscript(file), stat, path.basename(project), false, now, 'claude-a');
      const remote = serve.claudeSessionFromTail('sess-model', tailOf(file), { accountId: 'claude-a', node: 'aws1' });
      assert.equal(remote.node, 'aws1');
      const { node, ...rest } = remote;
      assert.deepEqual(rest, local, `padding ${padding}`);
      assert.equal(remote.endedTurn, true);
      assert.equal(remote.size, stat.size);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a node whose host predates the transcript verb is refused by name, and nothing is asked of it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-tail-capability-'));
  try {
    fs.mkdirSync(path.join(root, '.keep', 'session-accounts'), { recursive: true });
    fs.writeFileSync(path.join(root, '.keep', 'session-accounts', 'sess-old-host.json'), JSON.stringify({
      version: 1, sessionId: 'sess-old-host', agent: 'claude', accountId: 'claude/default', node: 'aws9',
    }));
    const asked = [];
    const deps = {
      root,
      hostNodes: ['main', 'aws9'],
      hostRequest: async (type, params, options) => {
        asked.push([type, options.node]);
        if (type === 'hello') return { version: 1, guardedInput: true };
        throw new Error(`unexpected ${type}`);
      },
    };
    await assert.rejects(serve.loadSessionForAction('sess-old-host', deps), (error) => error.status === 409
      && error.extra.reason === 'remote-node'
      && /the terminal host on aws9 predates the transcript verb/.test(error.message));
    assert.deepEqual(asked, [['hello', 'aws9']], 'only hello was asked; no transcript request went out');
    // The local, synchronous loader is unchanged: it has no session for that id.
    assert.throws(() => serve.loadCurrentSession('sess-old-host'), (error) => error.status === 404);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a session on aws1 is loaded for an action from its node, and never from a local file', async (t) => {
  const { withTwoNodeFleet } = require('./fixtures/two-node-hosts.js');
  await withTwoNodeFleet(t, async (fleet) => {
    await serve.closeHostClient();
    try {
      const sid = 'sess-remote-load';
      require('./accounts.js').pinSession(sid, 'claude', fleet.accountId, { root: fleet.registry, node: 'aws1' });
      // The node's own transcript. Both hosts share this machine's disk in the test,
      // which is exactly why the daemon must never be the one to open it.
      const project = path.join(fleet.configDir, 'projects', '-work-project');
      fs.mkdirSync(project, { recursive: true });
      const file = path.join(project, `${sid}.jsonl`);
      fs.writeFileSync(file, claudeTranscript());
      const deps = { root: fleet.registry, connectHost: connect };
      const session = await serve.loadSessionForAction(sid, deps);
      assert.equal(session.id, sid);
      assert.equal(session.kind, 'claude');
      assert.equal(session.node, 'aws1');
      assert.equal(session.accountId, fleet.accountId);
      assert.equal(session.endedTurn, true);
      assert.equal(session.state, 'idle');
      assert.equal(session.lastAssistant, 'The build is green.');
      assert.equal(session.size, fs.statSync(file).size);
      // Where it is, as the node says: a path recorded, never opened here.
      const where = await serve.nodeTranscriptFileForSession({ id: sid, kind: 'claude', node: 'aws1' }, deps);
      assert.deepEqual({ node: where.node, path: where.path, size: where.size },
        { node: 'aws1', path: file, size: fs.statSync(file).size });
      assert.equal(serve.transcriptFileForSession({ id: sid, kind: 'claude', node: 'aws1' }), null,
        'the synchronous lookup has no file for a session on another node');
      // A session the node has no transcript for yet is the node's answer, coded.
      require('./accounts.js').pinSession('sess-remote-none', 'claude', fleet.accountId, { root: fleet.registry, node: 'aws1' });
      await assert.rejects(serve.loadSessionForAction('sess-remote-none', deps), (error) => error.code === 'transcript-missing');
    } finally { await serve.closeHostClient(); }
  });
});

test('a journal\'s receipt is the node\'s answer about the file the journal recorded, and nothing else', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-receipt-for-'));
  try {
    fs.mkdirSync(path.join(root, '.keep', 'session-accounts'), { recursive: true });
    fs.writeFileSync(path.join(root, '.keep', 'session-accounts', 'sess-receipt.json'), JSON.stringify({
      version: 1, sessionId: 'sess-receipt', agent: 'claude', accountId: 'claude/default', node: 'aws8',
    }));
    let answer = null;
    const sent = [];
    const deps = {
      root,
      hostRequest: async (type, params, options) => {
        if (type === 'hello') return { transcript: 1 };
        sent.push({ params, node: options.node, reply: options.hostRequestTimeoutMs });
        return answer;
      },
    };
    const entry = { sessionId: 'sess-receipt', kind: 'claude', node: 'aws8', file: '/node/home/.claude/projects/-p/sess-receipt.jsonl',
      offset: 120, hash: 'a'.repeat(64), generation: '1:2:3' };
    answer = { path: entry.file, generation: '1:2:3', matched: true };
    assert.equal(await serve.deliveryReceiptFor(entry, deps, 500), true);
    assert.equal(sent[0].node, 'aws8');
    assert.equal(sent[0].reply, 2500, 'the reply window is the node\'s wait plus two seconds');
    assert.deepEqual({ ...sent[0].params, account: undefined }, {
      op: 'match', kind: 'claude', sessionId: 'sess-receipt', account: undefined, fromOffset: 120, hash: 'a'.repeat(64), timeoutMs: 500,
    });
    assert.equal(sent[0].params.account.id, 'claude/default');
    assert.equal(sent[0].params.path, undefined, 'the node is never told which path to read');
    answer = { path: '/node/home/.claude/projects/-other/sess-receipt.jsonl', generation: '1:2:3', matched: true };
    assert.equal(await serve.deliveryReceiptFor(entry, deps), false, 'another file is not the journal\'s file');
    answer = { path: entry.file, generation: '9:9:9', matched: true };
    assert.equal(await serve.deliveryReceiptFor(entry, deps), false, 'nor is the same path re-created');
    answer = { path: entry.file, generation: '1:2:3', matched: false };
    assert.equal(await serve.deliveryReceiptFor(entry, deps), false);
    answer = {};
    await assert.rejects(serve.deliveryReceiptFor(entry, deps), /gave no receipt answer/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
