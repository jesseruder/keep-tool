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

// ---------- a Codex session on a node ----------

function codexRollout(sid, { padding = 0, ended = true, meta = {} } = {}) {
  const lines = [
    line({ type: 'session_meta', timestamp: at(9000), payload: { id: sid, cwd: '/work/project', originator: 'codex_cli_rs', ...meta } }),
    line({ type: 'event_msg', timestamp: at(8500), payload: { type: 'task_started' } }),
    line({ type: 'event_msg', timestamp: at(8000), payload: { type: 'user_message', message: 'please look at the build' } }),
  ];
  for (let i = 0; i < padding; i += 1) {
    lines.push(line({ type: 'response_item', timestamp: at(7000), payload: { type: 'function_call_output', call_id: `c${i}`, output: 'x'.repeat(900) } }));
  }
  lines.push(line({ type: 'event_msg', timestamp: at(6000), payload: { type: 'agent_message', message: 'The build is green.' } }));
  if (ended) lines.push(line({ type: 'event_msg', timestamp: at(5000), payload: { type: 'task_complete' } }));
  return lines.join('');
}

// A rollout where the node's own lookups find it: <config>/sessions/<today>/rollout-*-<sid>.jsonl.
function writeCodexRollout(configDir, sid, text) {
  const now = new Date();
  const day = path.join(configDir, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-2026-01-01T00-00-00-${sid}.jsonl`);
  fs.writeFileSync(file, text);
  return file;
}

test('a Codex session built from a node\'s meta and tail is the one a local rollout with the same bytes gives', () => {
  const codex = require('./codex.js');
  const nodeTranscript = require('./node-transcript.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-tail-model-'));
  try {
    for (const [padding, ended] of [[0, true], [0, false], [400, true]]) {
      const sid = `sess-codex-model-${padding}-${ended}`;
      const file = writeCodexRollout(dir, sid, codexRollout(sid, { padding, ended }));
      const stat = fs.statSync(file);
      if (padding) assert.ok(stat.size > 256 * 1024, 'the long case really is past one tail');
      // What the node's meta op answers, from the node's own code.
      const meta = nodeTranscript.rolloutMeta(dir, sid);
      assert.equal(meta.meta.id, sid);
      const remote = serve.codexSessionFromTail(sid, meta, tailOf(file), { accountId: 'codex-a', node: 'aws1' });
      assert.equal(remote.node, 'aws1');
      assert.equal(remote.kind, 'codex');
      assert.equal(remote.accountId, 'codex-a');
      assert.equal(remote.project, '/work/project');
      assert.equal(remote.endedTurn, ended);
      assert.equal(remote.state, ended ? 'idle' : 'running');
      assert.equal(remote.lastAssistant, 'The build is green.');
      assert.equal(remote.size, stat.size);
      assert.equal(remote.mtime, stat.mtimeMs);
      assert.equal(remote.title, '');
      if (!padding) {
        // The whole file is in the tail: the same row codex.sessionFor builds here.
        const local = codex.sessionFromRollout(codex.scanRollout(file, { includeHeadless: true }), stat, '', Date.now(), 'codex-a');
        const { node, ...rest } = remote;
        assert.deepEqual(rest, local, `ended ${ended}`);
        assert.equal(remote.lastUser, 'please look at the build');
      } else {
        // Past the tail, the user message is the tail's own: none.
        assert.equal(remote.lastUser, '');
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a child Codex thread, or a rollout that names another session, is refused; a headless one is read', () => {
  const tail = (text) => ({ path: '/node/rollout.jsonl', size: Buffer.byteLength(text), mtimeMs: Date.now() - 5000, generation: 'g',
    bytes: Buffer.from(text).toString('base64'), from: 0 });
  const sid = 'sess-codex-kinds';
  const facts = (extra) => ({ meta: { id: sid, cwd: '/work/project', model: null, originator: 'codex_cli_rs', parentThreadId: null,
    child: false, headless: false, ...extra }, model: null });
  const text = codexRollout(sid);
  assert.throws(() => serve.codexSessionFromTail(sid, facts({ child: true, parentThreadId: 'parent' }), tail(text), { node: 'aws1' }),
    (error) => error.status === 409 && error.extra.reason === 'remote-node' && /is a child Codex thread/.test(error.message));
  assert.throws(() => serve.codexSessionFromTail(sid, facts({ id: 'another-thread' }), tail(text), { node: 'aws1' }),
    (error) => error.status === 409 && error.extra.reason === 'remote-node' && /does not name that session/.test(error.message));
  assert.throws(() => serve.codexSessionFromTail(sid, { meta: null, model: null }, tail(text), { node: 'aws1' }),
    (error) => error.status === 409 && error.extra.reason === 'remote-node');
  const headless = serve.codexSessionFromTail(sid, facts({ headless: true, originator: 'codex_exec' }), tail(text), { node: 'aws1' });
  assert.equal(headless.id, sid);
  assert.equal(headless.endedTurn, true);
});

function codexNodeFixture(sid, node, { agent = 'codex', text = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-remote-'));
  fs.mkdirSync(path.join(root, '.keep', 'session-accounts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.keep', 'session-accounts', `${sid}.json`), JSON.stringify({
    version: 1, sessionId: sid, agent, accountId: `${agent}/default`, node,
  }));
  const bytes = Buffer.from(text == null ? codexRollout(sid) : text);
  const mtimeMs = Date.now() - 5000;
  const asked = [];
  const described = { path: `/node/home/.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-${sid}.jsonl`, size: bytes.length, mtimeMs, generation: 'g' };
  const hostRequest = async (type, params, options) => {
    asked.push(type === 'transcript' ? `${params.op}:${params.kind}` : type);
    assert.equal(options.node, node);
    if (type === 'hello') return { transcript: 4 };
    if (type === 'transcript' && params.op === 'meta') {
      return { ...described, meta: { id: sid, cwd: '/work/project', model: 'gpt-test', originator: 'codex_cli_rs', parentThreadId: null,
        child: false, headless: false }, model: 'gpt-test' };
    }
    if (type === 'transcript' && params.op === 'tail') return { ...described, bytes: bytes.toString('base64'), from: 0 };
    if (type === 'transcript' && params.op === 'stat') return described;
    throw new Error(`unexpected ${type} ${params && params.op}`);
  };
  return { root, asked, mtimeMs, deps: { root, hostNodes: ['main', node], hostRequest },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a Codex session on aws1 is loaded for an action from its node\'s meta and tail', async () => {
  const sid = 'sess-codex-remote';
  const f = codexNodeFixture(sid, 'aws3');
  try {
    // Its attention marker here, as for a local Codex session.
    fs.mkdirSync(path.join(f.root, '.keep', 'attention'), { recursive: true });
    fs.writeFileSync(path.join(f.root, '.keep', 'attention', `${sid}.json`), JSON.stringify({
      source: 'codex', type: 'complete', message: 'done', at: Date.now(), mt: f.mtimeMs,
    }));
    const session = await serve.loadSessionForAction(sid, f.deps);
    assert.equal(session.id, sid);
    assert.equal(session.kind, 'codex');
    assert.equal(session.node, 'aws3');
    assert.equal(session.accountId, 'codex/default');
    assert.equal(session.project, '/work/project');
    assert.equal(session.endedTurn, true);
    assert.equal(session.state, 'idle');
    assert.equal(session.lastUser, 'please look at the build');
    assert.equal(session.lastAssistant, 'The build is green.');
    assert.equal(session.mtime, f.mtimeMs);
    assert.equal(session.notify && session.notify.type, 'complete');
    assert.deepEqual(f.asked.filter((op) => op !== 'hello').sort(), ['meta:codex', 'tail:codex']);
    // The same read is what a send's re-checks use.
    const again = await serve.remoteSessionRead(sid, f.deps);
    assert.equal(again.kind, 'codex');
    assert.equal(again.node, 'aws3');
  } finally { f.cleanup(); }
});

test('a Codex rollout whose meta and tail name different files is read again once, then refused', async () => {
  const sid = 'sess-codex-race';
  const f = codexNodeFixture(sid, 'aws3');
  try {
    // The node's two answers, each from whichever rollout was newest when it was asked:
    // a fresh running rollout's meta beside the old file's ended tail.
    const oldText = Buffer.from(codexRollout(sid, { ended: true }));
    const newText = Buffer.from(codexRollout(sid, { ended: false }));
    const file = (name, bytes, generation) => ({ path: `/node/home/.codex/sessions/2026/01/01/${name}-${sid}.jsonl`,
      size: bytes.length, mtimeMs: Date.now() - 5000, generation });
    const metaOf = (described) => ({ ...described, meta: { id: sid, cwd: '/work/project', model: null, originator: 'codex_cli_rs',
      parentThreadId: null, child: false, headless: false }, model: null });
    const tailOf = (described, bytes) => ({ ...described, bytes: bytes.toString('base64'), from: 0 });
    const oldFile = file('rollout-old', oldText, 'g-old');
    const newFile = file('rollout-new', newText, 'g-new');
    const client = (metas, tails) => {
      const asked = [];
      return { asked, factory: (node, session) => {
        assert.equal(node, 'aws3');
        assert.equal(session.kind, 'codex');
        return { meta: async () => { asked.push('meta'); return metas.shift(); }, tail: async () => { asked.push('tail'); return tails.shift(); } };
      } };
    };

    // Disagree once, then agree: the second read is the one used.
    const settles = client([metaOf(newFile), metaOf(newFile)], [tailOf(oldFile, oldText), tailOf(newFile, newText)]);
    const session = await serve.remoteSessionRead(sid, { ...f.deps, nodeTranscript: settles.factory });
    assert.equal(session.endedTurn, false, 'the running rollout, not the old file\'s ended tail');
    assert.equal(session.state, 'running');
    assert.deepEqual(settles.asked.sort(), ['meta', 'meta', 'tail', 'tail']);

    // Disagree twice: refused, never paired.
    const flaps = client([metaOf(newFile), metaOf(oldFile)], [tailOf(oldFile, oldText), tailOf(newFile, newText)]);
    await assert.rejects(serve.remoteSessionRead(sid, { ...f.deps, nodeTranscript: flaps.factory }),
      (error) => error.status === 409 && error.extra.reason === 'remote-node'
        && error.message === `the rollout of ${sid} changed on aws3 while it was read; nothing was sent`);
    // The same path with another generation (re-created) is a different file too.
    const recreated = client([metaOf(oldFile), metaOf(oldFile)], [tailOf({ ...oldFile, generation: 'g-again' }, oldText),
      tailOf({ ...oldFile, generation: 'g-again' }, oldText)]);
    await assert.rejects(serve.remoteSessionRead(sid, { ...f.deps, nodeTranscript: recreated.factory }),
      (error) => error.status === 409 && /changed on aws3 while it was read/.test(error.message));
  } finally { f.cleanup(); }
});

test('a Codex session on aws1 carries the reviewer marker, and a keep-spawned one is no session', async () => {
  const sid = 'sess-codex-markers';
  const f = codexNodeFixture(sid, 'aws3');
  try {
    const plain = await serve.loadSessionForAction(sid, f.deps);
    assert.equal(plain.reviewer, undefined);
    fs.mkdirSync(path.join(f.root, '.keep', 'reviewer'), { recursive: true });
    fs.writeFileSync(path.join(f.root, '.keep', 'reviewer', sid), '');
    assert.equal((await serve.loadSessionForAction(sid, f.deps)).reviewer, true);
    fs.rmSync(path.join(f.root, '.keep', 'reviewer', sid));
    fs.mkdirSync(path.join(f.root, '.keep', 'spawned'), { recursive: true });
    fs.writeFileSync(path.join(f.root, '.keep', 'spawned', sid), '');
    await assert.rejects(serve.loadSessionForAction(sid, f.deps), (error) => error.status === 404);
  } finally { f.cleanup(); }
});

test('a Codex session on aws1 outside the window is no session, as a local one would be', async () => {
  const sid = 'sess-codex-old';
  const f = codexNodeFixture(sid, 'aws3');
  try {
    const hostRequest = f.deps.hostRequest;
    const deps = { ...f.deps, hostRequest: async (type, params, options) => {
      const answer = await hostRequest(type, params, options);
      return answer && typeof answer.mtimeMs === 'number' ? { ...answer, mtimeMs: Date.now() - 30 * 86400e3 } : answer;
    } };
    await assert.rejects(serve.loadSessionForAction(sid, deps), (error) => error.status === 404);
  } finally { f.cleanup(); }
});

test('keep pane send to a Codex pane on aws1 reaches that session', async () => {
  const sid = 'sess-codex-pane-send';
  const f = codexNodeFixture(sid, 'aws7');
  try {
    const reached = [];
    const deps = {
      ...f.deps,
      resolveSessionTarget: async (session, hint) => ({ pane: hint.expectedPane }),
      sendToResolvedTarget: async (session, target, text) => {
        reached.push({ id: session.id, node: session.node, kind: session.kind, pane: target.pane, text, endedTurn: session.endedTurn });
        return { ok: true };
      },
    };
    const result = await serve.sendToSessionLocked({ sessionId: sid, pane: 'p3@aws7', text: 'hello' }, deps);
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(reached, [{ id: sid, node: 'aws7', kind: 'codex', pane: 'p3@aws7', text: 'hello', endedTurn: true }]);
  } finally { f.cleanup(); }
});

test('a Pi session, or one of no known agent, on a node is still refused by name and nothing is asked', async () => {
  const f = codexNodeFixture('sess-pi-remote', 'aws1', { agent: 'pi' });
  try {
    await assert.rejects(serve.loadSessionForAction('sess-pi-remote', f.deps), (error) => error.status === 409
      && error.extra.reason === 'remote-node'
      && error.message === "delivery is not available for a pi session on aws1 yet; only a Claude or Codex session's receipt can be read on a node");
    assert.deepEqual(f.asked, []);
  } finally { f.cleanup(); }
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

test('keep pane send to an agent pane on aws1 reaches that session instead of "no session"', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-pane-send-remote-'));
  try {
    const sid = 'sess-pane-send';
    fs.mkdirSync(path.join(root, '.keep', 'session-accounts'), { recursive: true });
    fs.writeFileSync(path.join(root, '.keep', 'session-accounts', `${sid}.json`), JSON.stringify({
      version: 1, sessionId: sid, agent: 'claude', accountId: 'claude/default', node: 'aws7',
    }));
    // The node's transcript, as bytes over the wire.
    const bytes = Buffer.from(claudeTranscript());
    const reached = [];
    const deps = {
      root,
      hostNodes: ['main', 'aws7'],
      hostRequest: async (type, params) => {
        if (type === 'hello') return { transcript: 1 };
        if (type === 'transcript' && params.op === 'tail') {
          return { path: '/node/home/.claude/projects/-work-project/sess-pane-send.jsonl', size: bytes.length,
            mtimeMs: Date.now() - 5000, generation: 'g', bytes: bytes.toString('base64'), from: 0 };
        }
        throw new Error(`unexpected ${type}`);
      },
      resolveSessionTarget: async (session, hint) => {
        assert.equal(hint.expectedPane, 'p3@aws7');
        return { pane: hint.expectedPane };
      },
      sendToResolvedTarget: async (session, target, text) => {
        reached.push({ id: session.id, node: session.node, kind: session.kind, pane: target.pane, text });
        return { ok: true };
      },
    };
    // What `keep pane send p3@aws7 -- hello` posts for an agent pane.
    const result = await serve.sendToSessionLocked({ sessionId: sid, pane: 'p3@aws7', text: 'hello' }, deps);
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(reached, [{ id: sid, node: 'aws7', kind: 'claude', pane: 'p3@aws7', text: 'hello' }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a send a node cannot confirm is refused before anything is typed', async () => {
  const typed = [];
  const deps = {
    hostNodes: ['main', 'aws1'],
    hostRequest: async (type) => { typed.push(type); throw new Error(`unexpected ${type}`); },
  };
  // A Pi session there takes no API delivery anywhere (and is refused before the node
  // is asked for anything).
  await assert.rejects(serve.sendToResolvedTarget({ id: 'sess-pi', kind: 'pi', node: 'aws1' }, { pane: 'p1@aws1' }, 'hi', {}, deps),
    (error) => error.status === 409 && /Pi API message delivery is unavailable/.test(error.message));
  // A pane on one machine and a session on another: nothing is sent anywhere.
  await assert.rejects(serve.sendToResolvedTarget({ id: 'sess-split', kind: 'claude', node: 'aws1' }, { pane: 'p1' }, 'hi', {}, deps),
    (error) => error.status === 409 && /pane p1 is on main but session sess-split is on aws1/.test(error.message));
  assert.deepEqual(typed, []);
  // What is still refused is named by remoteDeliveryRefusal; a Claude or Codex session
  // there is not.
  assert.equal(serve.remoteDeliveryRefusal({ id: 'x', node: 'aws1', kind: 'claude' }, deps), null);
  assert.equal(serve.remoteDeliveryRefusal({ id: 'x', node: 'aws1', kind: 'codex' }, deps), null);
  assert.equal(serve.remoteDeliveryRefusal({ id: 'x', node: 'aws1' }, deps, 'codex'), null);
  assert.equal(serve.remoteDeliveryRefusal({ id: 'x', kind: 'pi' }, deps), null, 'a session here is never refused');
  assert.equal(serve.remoteDeliveryRefusal({ id: 'x', node: 'aws1', kind: 'pi' }, deps).message,
    "delivery is not available for a pi session on aws1 yet; only a Claude or Codex session's receipt can be read on a node");
  assert.match(serve.remoteDeliveryRefusal({ id: 'x', node: 'aws1' }, deps).message, /a session whose agent is not known on aws1/);
});

test('a session placed on a node whose agent cannot be named is refused by name, not called unknown', async () => {
  const sid = 'sess-agent-unknown';
  const root = authorityRoot(sid, 'aws1');
  try {
    const asked = [];
    const deps = {
      root,
      hostNodes: ['main', 'aws1'],
      sessionLocation: () => null,
      hostRequest: async (type) => { asked.push(type); throw new Error(`unexpected ${type}`); },
    };
    await assert.rejects(serve.loadSessionForAction(sid, deps), (error) => error.status === 409
      && error.extra.reason === 'remote-node'
      && /a session whose agent is not known on aws1/.test(error.message));
    assert.deepEqual(asked, [], 'nothing was asked of the node');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function authorityRoot(sid, node) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-send-authority-'));
  fs.mkdirSync(path.join(root, '.keep', 'session-accounts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.keep', 'session-accounts', `${sid}.json`), JSON.stringify({
    version: 1, sessionId: sid, agent: 'claude', accountId: 'claude/default', node,
  }));
  return root;
}

test('a pane on aws1 whose meta names a session the authority record places here is never typed into', async () => {
  const sid = 'sess-recorded-here';
  const root = authorityRoot(sid, 'main');
  try {
    const typed = [];
    const deps = {
      root,
      hostNodes: ['main', 'aws1'],
      hostRequest: async (type) => { typed.push(type); throw new Error(`unexpected ${type}`); },
    };
    // A local session row carries no node; the pane's node is not taken as its answer.
    await assert.rejects(serve.sendToResolvedTarget({ id: sid, kind: 'claude' }, { pane: 'p1@aws1' }, 'hi', {}, deps),
      (error) => error.status === 409 && new RegExp(`pane p1@aws1 is on aws1 but session ${sid} is on main`).test(error.message));
    assert.deepEqual(typed, [], 'nothing was typed or asked of either node');

    const stray = { id: 'p1@aws1', node: 'aws1', alive: true, agentAlive: true, meta: { sessionId: sid, agent: 'claude' } };
    const here = { id: 'p2', alive: true, agentAlive: true, meta: { sessionId: sid, agent: 'claude' } };
    const withPanes = (panes) => ({ ...deps, listHostPaneResult: async () => ({ panes, failure: null, missingNodes: [] }) });
    // The only live pane for the id is on aws1: refused by name, not picked.
    await assert.rejects(serve.resolveSessionTarget({ id: sid, kind: 'claude' }, null, withPanes([stray])),
      (error) => error.status === 409 && /is recorded on main but its live pane p1@aws1 is not/.test(error.message));
    // A pane on the recorded node wins over the stray one, whichever is listed first.
    assert.deepEqual(await serve.resolveSessionTarget({ id: sid, kind: 'claude' }, null, withPanes([stray, here])), { pane: 'p2' });
    assert.deepEqual(typed, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a session the authority record places on aws1 still resolves to its aws1 pane, and a single node is unchanged', async () => {
  const sid = 'sess-recorded-there';
  const root = authorityRoot(sid, 'aws1');
  try {
    const there = { id: 'p1@aws1', node: 'aws1', alive: true, agentAlive: true, meta: { sessionId: sid, agent: 'claude' } };
    const here = { id: 'p2', alive: true, agentAlive: true, meta: { sessionId: sid, agent: 'claude' } };
    const deps = (hostNodes, panes) => ({ root, hostNodes,
      listHostPaneResult: async () => ({ panes, failure: null, missingNodes: [] }),
      hostRequest: async (type) => { throw new Error(`unexpected ${type}`); } });
    assert.deepEqual(await serve.resolveSessionTarget({ id: sid, kind: 'claude' }, null, deps(['main', 'aws1'], [here, there])), { pane: 'p1@aws1' });
    // Single node: the record is not read (it would say aws1), and the one pane is the answer.
    assert.deepEqual(await serve.resolveSessionTarget({ id: sid, kind: 'claude' }, null, deps(['main'], [here])), { pane: 'p2' });
    assert.equal(serve.sessionNodeOf({ id: sid }, { root, hostNodes: ['main'] }), 'main');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- a node session's freshness in the publication ----------

function freshnessFixture(node, sid) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-remote-freshness-'));
  fs.mkdirSync(path.join(root, '.keep', 'session-accounts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.keep', 'session-accounts', `${sid}.json`), JSON.stringify({
    version: 1, sessionId: sid, agent: 'claude', accountId: 'claude/default', node,
  }));
  let bytes = Buffer.from(claudeTranscript());
  let mtimeMs = Date.now() - 4000;
  const asked = [];
  let silent = false;
  let clock = Date.now();
  const hostRequest = async (type, params, options) => {
    asked.push(type === 'transcript' ? params.op : type);
    if (silent) throw new Error('host request timed out');
    if (type === 'hello') return { transcript: 1 };
    const stat = { path: `/node/home/.claude/projects/-work-project/${sid}.jsonl`, size: bytes.length, mtimeMs, generation: 'g1' };
    if (params.op === 'stat') return stat;
    if (params.op === 'tail') return { ...stat, bytes: bytes.toString('base64'), from: 0 };
    throw new Error('unexpected');
  };
  const pane = { id: `p1@${node}`, node, hostPaneId: 'p1', alive: true, agentAlive: true, createdAt: new Date(Date.now() - 3600e3).toISOString(),
    meta: { agent: 'claude', sessionId: sid, openingMessage: true } };
  return {
    root, pane, asked,
    deps: { root, hostNodes: ['main', node], hostRequest, now: () => clock },
    advance: (ms) => { clock += ms; },
    append: (line) => { bytes = Buffer.concat([bytes, Buffer.from(line)]); mtimeMs = Date.now(); },
    setSilent: (value) => { silent = value; },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('a row for a pane on a node carries its transcript size, mtime and endedTurn from that node', async () => {
  const f = freshnessFixture('aws6', 'sess-fresh');
  try {
    const read = await serve.remoteSessionFreshness([f.pane, { id: 'p9', alive: true, meta: { agent: 'claude', sessionId: 'local-one' } }], f.deps);
    assert.deepEqual(Object.keys(read), ['sess-fresh'], 'only the pane on another node is asked about');
    const model = read['sess-fresh'];
    assert.equal(model.size, Buffer.byteLength(claudeTranscript()));
    assert.equal(model.endedTurn, true);
    assert.equal(model.node, 'aws6');
    assert.deepEqual(f.asked, ['hello', 'stat', 'tail']);

    // Within 2.5 s nothing is asked again; after it, a stat, and a tail only on change.
    await serve.remoteSessionFreshness([f.pane], f.deps);
    assert.deepEqual(f.asked, ['hello', 'stat', 'tail']);
    f.advance(3000);
    await serve.remoteSessionFreshness([f.pane], f.deps);
    assert.deepEqual(f.asked, ['hello', 'stat', 'tail', 'stat']);
    f.advance(3000);
    f.append(`${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'next thing' } })}\n`);
    const changed = (await serve.remoteSessionFreshness([f.pane], f.deps))['sess-fresh'];
    assert.deepEqual(f.asked.slice(-2), ['stat', 'tail']);
    assert.equal(changed.endedTurn, false, 'a turn started on the node shows as one here');
    assert.equal(changed.state, 'running');

    // The row the publication builds from it: the node's size and mtime, not the pane's.
    const sessions = [];
    serve.backfillHostSessions(sessions, [f.pane], { root: f.root, hostNodes: ['main', 'aws6'], claudeSessionFor: () => null,
      nodeSessions: { 'sess-fresh': changed } });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].size, changed.size);
    assert.equal(sessions[0].mtime, changed.mtime);
    assert.equal(sessions[0].endedTurn, false);
    assert.equal(sessions[0].node, 'aws6');
    assert.equal(sessions[0].pane, 'p1@aws6');
    assert.equal(sessions[0].hostOnly, true);
  } finally { f.cleanup(); }
});

test('a node that does not answer leaves its row without a transcript size, which is never stalled', async () => {
  const f = freshnessFixture('aws5', 'sess-silent');
  try {
    f.setSilent(true);
    assert.equal(await serve.remoteSessionFreshness([f.pane], f.deps), null);
    const sessions = [];
    serve.backfillHostSessions(sessions, [f.pane], { root: f.root, hostNodes: ['main', 'aws5'], claudeSessionFor: () => null });
    assert.equal(sessions.length, 1);
    assert.equal('size' in sessions[0], false, 'no size nobody read');
    assert.equal(sessions[0].node, 'aws5');
    // The pane says an opening message is in flight, so the row reads as running; with
    // no size the stalled detector passes it by however long it has been seen.
    assert.equal(sessions[0].state, 'running');
    const { detectStalledSessions } = require('./stalled.js');
    const observations = { 'sess-silent': { size: 0, at: Date.now() - 24 * 3600e3 } };
    assert.deepEqual(detectStalledSessions(sessions, Date.now(), { observations }), []);
    // A pane whose session the authority record does not place on that node is not asked about.
    const stranger = { ...f.pane, meta: { ...f.pane.meta, sessionId: 'sess-not-recorded' } };
    f.setSilent(false);
    assert.equal(await serve.remoteSessionFreshness([stranger], f.deps), null);
  } finally { f.cleanup(); }
});

test('a silent node adds no wait to the publication: its panes are not asked about, and a slow read is cut at the list budget', async () => {
  const f = freshnessFixture('aws4', 'sess-slow');
  try {
    // The listing could not hear from aws4 (its remembered panes are still listed).
    const listing = { panes: [f.pane], failure: null, nodes: { main: { ok: true }, aws4: { ok: false, reason: 'timeout', stale: true } },
      missingNodes: ['aws4'] };
    assert.deepEqual(serve.unansweredNodes(listing), ['aws4']);
    assert.deepEqual(serve.unansweredNodes({ panes: [], failure: null }), [], 'a single-node listing names nobody');
    let started = Date.now();
    assert.equal(await serve.remoteSessionFreshness(listing.panes, f.deps, { skipNodes: serve.unansweredNodes(listing) }), null);
    assert.deepEqual(f.asked, [], 'nothing was asked of the silent node');
    assert.ok(Date.now() - started < 200);

    // A node that answered the list but hangs on the read: the publication step waits
    // for the budget and no longer, and the row goes without a size this cycle.
    let release;
    const hanging = new Promise((resolve) => { release = resolve; });
    const deps = { ...f.deps, hostRemoteListTimeoutMs: 60, cachedRemoteSession: async () => { await hanging; return { id: 'sess-slow', size: 1 }; } };
    started = Date.now();
    assert.equal(await serve.remoteSessionFreshness([f.pane], deps, { skipNodes: [] }), null);
    const waited = Date.now() - started;
    assert.ok(waited >= 50 && waited < 1000, `waited ${waited} ms`);
    release();
  } finally { f.cleanup(); }
});

// ---------- a Pi session's phase on a node ----------

function piFixture(node, sid) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-remote-pi-phase-'));
  fs.mkdirSync(path.join(root, '.keep', 'session-accounts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.keep', 'session-accounts', `${sid}.json`), JSON.stringify({
    version: 1, sessionId: sid, agent: 'pi', accountId: 'pi/default', node,
  }));
  const asked = [];
  let event = { id: sid, phase: 'running', at: new Date().toISOString(), instance: 'i-1' };
  let silent = false;
  let clock = Date.now();
  const hostRequest = async (type, params, options) => {
    asked.push([type, params && params.op, options.node]);
    if (silent) throw new Error('host request timed out');
    if (type === 'transcript' && params.op === 'pi-event' && params.kind === 'pi' && params.sessionId === sid) return { event };
    throw new Error(`unexpected ${type}`);
  };
  const pane = { id: `p1@${node}`, node, hostPaneId: 'p1', alive: true, agentAlive: true, createdAt: new Date(Date.now() - 3600e3).toISOString(),
    meta: { agent: 'pi', sessionId: sid, project: '/work/project', card: 'card' } };
  return {
    root, pane, asked,
    deps: { root, hostNodes: ['main', node], hostRequest, now: () => clock },
    advance: (ms) => { clock += ms; },
    setEvent: (value) => { event = value; },
    setSilent: (value) => { silent = value; },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('a Pi pane on a node gets its turn state from the phase file its node reads', async () => {
  const f = piFixture('aws7', 'pi-remote-1');
  try {
    const read = await serve.remoteSessionFreshness([f.pane], f.deps);
    assert.deepEqual(Object.keys(read), ['pi-remote-1']);
    assert.equal(read['pi-remote-1'].kind, 'pi');
    assert.equal(read['pi-remote-1'].piEvent.phase, 'running');
    assert.deepEqual(f.asked, [['transcript', 'pi-event', 'aws7']]);
    // One read per session per cycle window.
    await serve.remoteSessionFreshness([f.pane], f.deps);
    assert.equal(f.asked.length, 1);

    const build = (nodeSessions) => {
      const sessions = [];
      serve.backfillHostSessions(sessions, [f.pane], { root: f.root, hostNodes: ['main', 'aws7'], piSessionFor: () => null, nodeSessions });
      return sessions[0];
    };
    const running = build(read);
    assert.equal(running.kind, 'pi');
    assert.equal(running.node, 'aws7');
    assert.equal(running.hostOnly, true);
    assert.equal(running.project, '/work/project', 'the row is the pane\'s');
    assert.equal(running.state, 'running');
    assert.equal(running.toolRunning, true);
    assert.equal(running.endedTurn, false);
    assert.equal('size' in running, false);

    f.advance(3000);
    f.setEvent({ id: 'pi-remote-1', phase: 'prompt', at: new Date().toISOString() });
    const asking = build(await serve.remoteSessionFreshness([f.pane], f.deps));
    assert.equal(asking.state, 'idle');
    assert.equal(asking.endedTurn, true);
    assert.deepEqual(asking.pendingQuestion, { question: 'Pi is waiting for input.' });

    // A node that stops answering keeps what it last said, and a row with no phase at
    // all is the pane's alone.
    f.advance(3000);
    f.setSilent(true);
    const kept = await serve.remoteSessionFreshness([f.pane], f.deps);
    assert.equal(kept['pi-remote-1'].piEvent.phase, 'prompt');
    const bare = build(null);
    assert.equal(bare.state, 'recent');
    assert.equal(bare.endedTurn, true);
    assert.equal(bare.pendingQuestion, undefined);
    // A phase that names another session is not this one's.
    const wrong = build({ 'pi-remote-1': { id: 'pi-remote-1', kind: 'pi', node: 'aws7', piEvent: { id: 'someone', phase: 'running' } } });
    assert.equal(wrong.state, 'recent');
  } finally { f.cleanup(); }
});

test('a Pi phase read slower than the listing budget publishes the cached phase meanwhile, and the next cycle the fresh one', async () => {
  const f = piFixture('aws9', 'pi-remote-3');
  try {
    const first = await serve.remoteSessionFreshness([f.pane], f.deps);
    assert.equal(first['pi-remote-3'].piEvent.phase, 'running');
    // The node now answers late: past the listing's budget.
    f.advance(3000);
    f.setEvent({ id: 'pi-remote-3', phase: 'settled', at: new Date().toISOString() });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const slow = { ...f.deps, hostRemoteListTimeoutMs: 20,
      hostRequest: async (...args) => { await gate; return f.deps.hostRequest(...args); } };
    const late = await serve.remoteSessionFreshness([f.pane], slow);
    assert.equal(late['pi-remote-3'].piEvent.phase, 'running', 'the cached phase, not no row');
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The read finished into the cache: the next cycle has it without asking again.
    const next = await serve.remoteSessionFreshness([f.pane], f.deps);
    assert.equal(next['pi-remote-3'].piEvent.phase, 'settled');
    assert.equal(f.asked.length, 2);
  } finally { f.cleanup(); }
});

test('piEventFor reads the registry on the daemon node and the node otherwise, and a failed node read is no signal', async () => {
  const f = piFixture('aws8', 'pi-remote-2');
  try {
    const local = path.join(f.root, '.keep', 'pi-events');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'pi-remote-2.json'), JSON.stringify({ id: 'pi-remote-2', phase: 'settled', at: 'x' }));
    assert.equal((await serve.piEventFor('pi-remote-2', 'main', f.deps)).phase, 'settled');
    assert.equal((await serve.piEventFor('pi-remote-2', null, f.deps)).phase, 'settled');
    assert.deepEqual(f.asked, [], 'the daemon node is never asked through a host');
    assert.equal((await serve.piEventFor('pi-remote-2', 'aws8', f.deps)).phase, 'running');
    f.setSilent(true);
    assert.equal(await serve.piEventFor('pi-remote-2', 'aws8', f.deps), null);
    f.setSilent(false);
    f.setEvent({ id: 'pi-remote-2', phase: 'nonsense' });
    assert.equal(await serve.piEventFor('pi-remote-2', 'aws8', f.deps), null);
    assert.equal(await serve.piEventFor('../x', 'aws8', f.deps), null);

    // waitForPiStart through the node: resolves on the node's start phase.
    f.setEvent({ id: 'pi-remote-2', phase: 'start', at: new Date().toISOString() });
    const started = await serve.waitForPiStart('pi-remote-2', Date.now(), { ...f.deps, now: Date.now, sleep: async () => {} }, 'aws8');
    assert.equal(started.phase, 'start');

    // Clock skew: a node's start stamped up to 5 s before the daemon's launch is this
    // launch's; the daemon node's own phase keeps its 1 s.
    let clock = 1_900_000_000_000;
    const waitDeps = { ...f.deps, now: () => clock, sleep: async (ms) => { clock += ms; } };
    const at = (ms) => new Date(1_900_000_000_000 - ms).toISOString();
    f.setEvent({ id: 'pi-remote-2', phase: 'start', at: at(4000) });
    assert.equal((await serve.waitForPiStart('pi-remote-2', clock, waitDeps, 'aws8')).phase, 'start');
    clock = 1_900_000_000_000;
    f.setEvent({ id: 'pi-remote-2', phase: 'start', at: at(6000) });
    await assert.rejects(serve.waitForPiStart('pi-remote-2', clock, waitDeps, 'aws8'), (error) => error.status === 504);
    clock = 1_900_000_000_000;
    f.setEvent({ id: 'pi-remote-2', phase: 'start', at: at(500) });
    fs.writeFileSync(path.join(local, 'pi-remote-2.json'), JSON.stringify({ id: 'pi-remote-2', phase: 'start', at: at(4000) }));
    await assert.rejects(serve.waitForPiStart('pi-remote-2', clock, waitDeps, 'main'), (error) => error.status === 504);
    // Both reads take the daemon node from the same place openSession does.
    assert.equal((await serve.piEventFor('pi-remote-2', 'elsewhere', { ...f.deps, env: { KEEP_DAEMON_NODE: 'elsewhere' } })).phase, 'start',
      'the launch env names the daemon node: its phase file is the registry\'s');
  } finally { f.cleanup(); }
});
