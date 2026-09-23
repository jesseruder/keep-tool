'use strict';
// The `artifacts` verb for a Codex session (kind 'codex'): its root rollout and the
// rollouts of its child threads, listed with their digests, carried by the same
// read/stage/publish walk a Claude session's files take, under the Codex account's
// own directory. Called in-process, as the daemon node calls it; host.test.js covers
// the verb over a host connection.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const artifacts = require('./session-artifacts.js');
const transport = require('./artifact-transport.js');

const ROOT_ID = '11111111-2222-4333-8444-555555555555';
const CHILD_A = '22222222-3333-4444-8555-666666666666';
const CHILD_B = '33333333-4444-4555-8666-777777777777';
const OTHER = '44444444-5555-4666-8777-888888888888';
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const line = (value) => `${JSON.stringify(value)}\n`;

// One Codex account's directory, with the session's root rollout, a child thread, a
// grandchild thread in the archive, and an unrelated conversation beside them.
function codexNode(t, name, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `keep-codex-artifacts-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'codex-a');
  fs.mkdirSync(configDir, { recursive: true });
  const account = { id: 'codex-a', agent: 'codex', configDir };
  const put = (rel, text) => {
    const file = path.join(configDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const rel = {
    root: `sessions/2026/09/20/rollout-2026-09-20T10-00-00-${ROOT_ID}.jsonl`,
    childA: `sessions/2026/09/21/rollout-2026-09-21T11-00-00-${CHILD_A}.jsonl`,
    childB: `archived_sessions/rollout-2026-09-21T12-00-00-${CHILD_B}.jsonl`,
    other: `sessions/2026/09/20/rollout-2026-09-20T09-00-00-${OTHER}.jsonl`,
  };
  if (options.session !== false) {
    put(rel.root, line({ type: 'session_meta', payload: { id: ROOT_ID, cwd: '/work/project', originator: 'codex-tui' } })
      + line({ type: 'turn_context', payload: { model: 'gpt-test' } }) + crypto.randomBytes(2000).toString('hex') + '\n');
    put(rel.childA, line({ type: 'session_meta', payload: { id: CHILD_A, parent_thread_id: ROOT_ID, cwd: '/work/project' } }));
    put(rel.childB, line({ type: 'session_meta', payload: { id: CHILD_B, parent_thread_id: CHILD_A, cwd: '/work/project' } }));
    put(rel.other, line({ type: 'session_meta', payload: { id: OTHER, cwd: '/work/project' } }));
  }
  const options_ = { accounts: () => [account] };
  const ask = (params) => artifacts.handle({ kind: 'codex', account: { id: account.id, configDir }, ...params }, options_);
  return { root, configDir, account, put, rel, ask, options: options_ };
}

test('a Codex session lists its root rollout and every child thread, with digests, and nothing else', async (t) => {
  const node = codexNode(t, 'list');
  const listed = await node.ask({ op: 'list', sessionId: ROOT_ID });
  assert.equal(listed.projectName, null);
  assert.deepEqual(listed.files.map((file) => file.relPath), [node.rel.root, node.rel.childA, node.rel.childB]);
  for (const file of listed.files) {
    assert.equal(file.sha256, sha256(fs.readFileSync(path.join(node.configDir, ...file.relPath.split('/')))), file.relPath);
  }
  // The account's own indexes are never a conversation's state.
  node.put('session_index.jsonl', '{}\n');
  node.put('history.jsonl', '{}\n');
  node.put('state_5.sqlite', 'db');
  assert.equal((await node.ask({ op: 'list', sessionId: ROOT_ID })).files.length, 3);
  // A Claude request for the same account is refused: it is not a Claude account.
  await assert.rejects(artifacts.handle({ op: 'list', sessionId: ROOT_ID, account: { id: 'codex-a', configDir: node.configDir } }, node.options),
    (error) => error.code === 'artifacts-refused' && /not a claude account/.test(error.message));
  await assert.rejects(node.ask({ op: 'list', sessionId: ROOT_ID, kind: 'pi' }), (error) => error.code === 'artifacts-invalid');
});

test('a missing root is artifacts-missing, an archived root is refused, a child is not a root', async (t) => {
  const empty = codexNode(t, 'empty', { session: false });
  await assert.rejects(empty.ask({ op: 'list', sessionId: ROOT_ID }), (error) => error.code === 'artifacts-missing');

  const archived = codexNode(t, 'archived');
  const from = path.join(archived.configDir, ...archived.rel.root.split('/'));
  const to = path.join(archived.configDir, 'archived_sessions', path.basename(from));
  fs.renameSync(from, to);
  await assert.rejects(archived.ask({ op: 'list', sessionId: ROOT_ID }), (error) => error.code === 'artifacts-archived' && /unarchive it/.test(error.message));
  await assert.rejects(archived.ask({ op: 'read', sessionId: ROOT_ID, relPath: `archived_sessions/${path.basename(from)}`, from: 0, length: 10 }),
    (error) => error.code === 'artifacts-archived');

  const node = codexNode(t, 'child');
  await assert.rejects(node.ask({ op: 'list', sessionId: CHILD_A }), (error) => error.code === 'artifacts-refused' && /child thread/.test(error.message));
});

test('a read is scoped to the session\'s own rollouts and its threads\'', async (t) => {
  const node = codexNode(t, 'read');
  const piece = await node.ask({ op: 'read', sessionId: ROOT_ID, relPath: node.rel.childA, from: 0, length: 4096 });
  assert.equal(Buffer.from(piece.bytes, 'base64').toString(), fs.readFileSync(path.join(node.configDir, ...node.rel.childA.split('/')), 'utf8'));
  // Another top-level conversation has the shape but is not this session's.
  await assert.rejects(node.ask({ op: 'read', sessionId: ROOT_ID, relPath: node.rel.other, from: 0, length: 10 }),
    (error) => error.code === 'artifacts-refused' && /not a rollout of session/.test(error.message));
  for (const relPath of ['session_index.jsonl', 'sessions/2026/09/rollout-x.jsonl', `sessions/2026/09/20/${ROOT_ID}.jsonl`, 'auth.json', '../x']) {
    await assert.rejects(node.ask({ op: 'read', sessionId: ROOT_ID, relPath, from: 0, length: 10 }),
      (error) => ['artifacts-refused', 'artifacts-invalid'].includes(error.code), relPath);
  }
});

test('a Codex session is carried whole between two accounts, publish needs the root, provenance under the Codex directory', async (t) => {
  const source = codexNode(t, 'source');
  const target = codexNode(t, 'target', { session: false });
  const from = transport.localArtifacts(source.account, { accounts: source.options.accounts });
  const to = transport.localArtifacts(target.account, { accounts: target.options.accounts });
  const tx = 'mv-0123456789abcdef01234567';

  // A publish without the root rollout is refused before anything moves.
  const listed = await from.list(ROOT_ID);
  const child = listed.files.find((file) => file.relPath === source.rel.childA);
  await assert.rejects(to.publish(ROOT_ID, tx, [{ relPath: child.relPath, sha256: child.sha256, size: child.size }]),
    (error) => error.code === 'artifacts-invalid' && /root rollout/.test(error.message));

  const carried = await transport.transfer({ sessionId: ROOT_ID, tx, from, to, pieceBytes: 1024 });
  assert.equal(carried.files.length, 3);
  for (const rel of [source.rel.root, source.rel.childA, source.rel.childB]) {
    assert.deepEqual(fs.readFileSync(path.join(target.configDir, ...rel.split('/'))), fs.readFileSync(path.join(source.configDir, ...rel.split('/'))), rel);
  }
  assert.equal(fs.existsSync(path.join(target.configDir, ...source.rel.other.split('/'))), false, 'the unrelated conversation stayed');
  const provenance = JSON.parse(fs.readFileSync(path.join(target.configDir, '.keep-move', 'provenance', `${ROOT_ID}.json`), 'utf8'));
  assert.deepEqual(Object.keys(provenance.files).sort(), [source.rel.root, source.rel.childA, source.rel.childB].sort());
  assert.ok(fs.existsSync(path.join(target.configDir, '.keep-move', tx, 'published.json')), 'staged under the Codex directory');

  // The source is released; a later move back may replace what it left.
  assert.equal((await from.release(ROOT_ID)).files, 3);
  assert.ok(fs.existsSync(path.join(source.configDir, '.keep-move', 'provenance', `${ROOT_ID}.json`)));

  // A transfer that lists no root rollout is refused by the transport.
  await assert.rejects(transport.transfer({ sessionId: ROOT_ID, tx, from: { ...from, list: async () => ({ files: [child] }) }, to }),
    /listed no transcript/);
});

test('a profile of 2,000 unrelated rollouts lists the root and its threads reading only first lines, once', async (t) => {
  const node = codexNode(t, 'many');
  // Older conversations, filed before the root's day: never opened. Newer ones, some
  // large: their first line only, once, and not again while they are unchanged.
  const body = 'y'.repeat(64 * 1024);
  for (let index = 0; index < 1000; index += 1) {
    const id = crypto.randomUUID();
    node.put(`sessions/2026/08/${String(1 + (index % 28)).padStart(2, '0')}/rollout-2026-08-01T00-00-00-${id}.jsonl`,
      line({ type: 'session_meta', payload: { id, cwd: '/work/other' } }));
  }
  for (let index = 0; index < 1000; index += 1) {
    const id = crypto.randomUUID();
    node.put(`sessions/2026/09/${String(20 + (index % 5)).padStart(2, '0')}/rollout-2026-09-22T00-00-00-${id}.jsonl`,
      line({ type: 'session_meta', payload: { id, cwd: '/work/other' } }) + (index % 10 === 0 ? `${JSON.stringify({ pad: body })}\n` : ''));
  }
  const before = artifacts.scanStats.firstLineReads;
  const started = Date.now();
  const listed = await node.ask({ op: 'list', sessionId: ROOT_ID });
  assert.deepEqual(listed.files.map((file) => file.relPath), [node.rel.root, node.rel.childA, node.rel.childB]);
  const firstReads = artifacts.scanStats.firstLineReads - before;
  // The root, its two threads and the unrelated one on its day, plus the 1,000 newer
  // conversations: the 1,000 older ones are never opened.
  assert.ok(firstReads <= 1004, `read ${firstReads} first lines`);
  assert.ok(firstReads >= 1003);
  assert.ok(Date.now() - started < 20000, 'a generous bound on a slow machine');
  // A second listing of the same move reads no first line again.
  const again = artifacts.scanStats.firstLineReads;
  assert.equal((await node.ask({ op: 'list', sessionId: ROOT_ID })).files.length, 3);
  assert.equal(artifacts.scanStats.firstLineReads, again);
  // A thread whose rollout grew is read again, and only it.
  fs.appendFileSync(path.join(node.configDir, ...node.rel.childA.split('/')), line({ type: 'event_msg' }));
  await node.ask({ op: 'list', sessionId: ROOT_ID });
  assert.equal(artifacts.scanStats.firstLineReads, again + 1);
});

test('a thread filed a day before its root still travels; a duplicate thread id refuses the list', async (t) => {
  const node = codexNode(t, 'edges');
  const late = crypto.randomUUID();
  node.put(`sessions/2026/09/19/rollout-2026-09-19T23-59-00-${late}.jsonl`,
    line({ type: 'session_meta', payload: { id: late, parent_thread_id: ROOT_ID } }));
  const listed = await node.ask({ op: 'list', sessionId: ROOT_ID });
  assert.ok(listed.files.some((file) => file.relPath.endsWith(`-${late}.jsonl`)));
  node.put(`sessions/2026/09/22/rollout-2026-09-22T09-00-00-${late}.jsonl`,
    line({ type: 'session_meta', payload: { id: late, parent_thread_id: ROOT_ID } }));
  await assert.rejects(node.ask({ op: 'list', sessionId: ROOT_ID }), (error) => error.code === 'artifacts-refused' && /more than once/.test(error.message));
});
