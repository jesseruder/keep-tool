'use strict';
// The transcript verb's `pi-event` op: a node answering for the Keep Pi extension's
// phase file of a session it runs (integrations/pi/keep.ts writes it there).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handle, validate } = require('./node-transcript.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-node-pi-event-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keepDir = path.join(root, 'keep');
  const dir = path.join(keepDir, '.keep', 'pi-events');
  fs.mkdirSync(dir, { recursive: true });
  return { root, keepDir, dir, env: { HOME: root, KEEP_DIR: keepDir } };
}

const ID = '11111111-2222-4333-8444-555555555555';
const ask = (f, extra = {}) => handle({ type: 'transcript', id: 7, op: 'pi-event', kind: 'pi', sessionId: ID, ...extra }, { env: f.env });

test('pi-event answers the phase file the extension wrote on this node', async (t) => {
  const f = fixture(t);
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(f.dir, `${ID}.json`), JSON.stringify({
    id: ID, phase: 'running', at, pid: 42, instance: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sessionFile: null, leafId: null,
  }));
  assert.deepEqual(await ask(f), { event: {
    id: ID, phase: 'running', at, pid: 42, instance: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sessionFile: null, leafId: null,
  } });
  // No account is needed, or looked at: the path is this node's own and fixed.
  assert.equal((await ask(f, { account: undefined })).event.phase, 'running');
});

test('pi-event without KEEP_DIR reads under the home keep directory', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, `${ID}.json`), JSON.stringify({ id: ID, phase: 'settled', at: 'x' }));
  const result = await handle({ op: 'pi-event', kind: 'pi', sessionId: ID }, { env: { HOME: f.root } });
  assert.equal(result.event.phase, 'settled');
});

test('pi-event answers null when there is no phase file, or none that is this session', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await ask(f), { event: null });
  fs.writeFileSync(path.join(f.dir, `${ID}.json`), JSON.stringify({ id: 'someone-else', phase: 'running' }));
  assert.deepEqual(await ask(f), { event: null }, 'another id');
  fs.writeFileSync(path.join(f.dir, `${ID}.json`), JSON.stringify({ id: ID, phase: 'dancing' }));
  assert.deepEqual(await ask(f), { event: null }, 'an unknown phase');
});

test('pi-event refuses a malformed request before it reads anything', async (t) => {
  const f = fixture(t);
  for (const sessionId of ['../escape', '', 'a/b', 'x'.repeat(129), 7]) {
    await assert.rejects(ask(f, { sessionId }), (error) => error.code === 'transcript-invalid', String(sessionId));
  }
  await assert.rejects(ask(f, { kind: 'claude' }), (error) => error.code === 'transcript-invalid' && /for pi sessions/.test(error.message));
  assert.throws(() => validate({ op: 'pi-event', kind: 'pi' }), /not a session id/);
});

test('pi-event fails, rather than saying "none", on a phase file it cannot read', async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, `${ID}.json`);
  fs.writeFileSync(file, '{"id":');
  await assert.rejects(ask(f), (error) => error.code === 'transcript-unreadable' && /not JSON/.test(error.message));
  fs.rmSync(file);
  fs.mkdirSync(file);
  await assert.rejects(ask(f), (error) => ['transcript-refused', 'transcript-unreadable'].includes(error.code));
  fs.rmSync(file, { recursive: true });
  const elsewhere = path.join(f.root, 'elsewhere.json');
  fs.writeFileSync(elsewhere, JSON.stringify({ id: ID, phase: 'running' }));
  fs.symlinkSync(elsewhere, file);
  await assert.rejects(ask(f), (error) => error.code === 'transcript-refused' && /symbolic link/.test(error.message));
  fs.rmSync(file);
  fs.writeFileSync(file, JSON.stringify({ id: ID, phase: 'running', pad: 'x'.repeat(70 * 1024) }));
  await assert.rejects(ask(f), (error) => error.code === 'transcript-unreadable' && /too large/.test(error.message));
});

// The `meta` op: what a Codex session's rollout says about itself, read on the node
// that has it: its session_meta line and the model of its last turn.
function codexFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-node-meta-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'codex');
  const now = new Date();
  const day = path.join(configDir, 'sessions', String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  const account = { id: 'codex-a', agent: 'codex', configDir };
  return { root, configDir, day, account, options: { accounts: () => [account] } };
}

const line = (value) => `${JSON.stringify(value)}\n`;

test('meta answers a Codex rollout\'s session_meta and its last turn\'s model', async (t) => {
  const f = codexFixture(t);
  const file = path.join(f.day, `rollout-2026-09-23T10-00-00-${ID}.jsonl`);
  fs.writeFileSync(file, line({ type: 'session_meta', payload: { id: ID, cwd: '/work/project', originator: 'codex-tui', model: 'gpt-meta' } })
    + line({ type: 'turn_context', payload: { model: 'gpt-first', cwd: '/work/project' } })
    + line({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } })
    + line({ type: 'turn_context', payload: { model: 'gpt-last', cwd: '/work/project' } }));
  const answer = await handle({ op: 'meta', kind: 'codex', sessionId: ID, account: { id: 'codex-a', configDir: f.configDir } }, f.options);
  assert.equal(answer.path, file);
  assert.equal(answer.model, 'gpt-last');
  assert.deepEqual(answer.meta, { id: ID, cwd: '/work/project', model: 'gpt-meta', originator: 'codex-tui', parentThreadId: null, child: false, headless: false });
  // The same answer for a rollout on the daemon's own machine, with no account check.
  const local = require('./node-transcript.js').rolloutMeta(f.configDir, ID);
  assert.equal(local.model, 'gpt-last');
  assert.equal(local.meta.id, ID);
  // A rollout with no turn yet has no last model.
  fs.writeFileSync(file, line({ type: 'session_meta', payload: { id: ID, cwd: '/work/project' } }));
  assert.equal((await handle({ op: 'meta', kind: 'codex', sessionId: ID, account: { id: 'codex-a', configDir: f.configDir } }, f.options)).model, null);
});

test('meta finds the last turn_context however far back a long turn put it, within its bound', async (t) => {
  const f = codexFixture(t);
  const file = path.join(f.day, `rollout-2026-09-23T10-00-00-${ID}.jsonl`);
  // The only turn_context sits 600 KiB before the end, behind lines of tool output, one
  // of them longer than a chunk, so chunk edges cut lines.
  const output = (bytes) => line({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(bytes) } });
  fs.writeFileSync(file, line({ type: 'session_meta', payload: { id: ID, cwd: '/work/project' } })
    + line({ type: 'turn_context', payload: { model: 'gpt-old' } }) + output(4000)
    + line({ type: 'turn_context', payload: { model: 'gpt-far-back' } })
    + output(300 * 1024) + output(100 * 1024) + output(200 * 1024 - 7));
  const size = fs.statSync(file).size;
  assert.ok(size - fs.readFileSync(file, 'utf8').lastIndexOf('"turn_context"') > 600 * 1024);
  const answer = await handle({ op: 'meta', kind: 'codex', sessionId: ID, account: { id: 'codex-a', configDir: f.configDir } }, f.options);
  assert.equal(answer.model, 'gpt-far-back');
  assert.equal(require('./node-transcript.js').rolloutMeta(f.configDir, ID).model, 'gpt-far-back');
  // Bounded: a read that may not go back that far says it did not find one.
  const fd = fs.openSync(file, 'r');
  try {
    const { lastTurnModel } = require('./node-transcript.js');
    assert.equal(lastTurnModel(fd, size, 512 * 1024), null);
    assert.equal(lastTurnModel(fd, size, 1024 * 1024), 'gpt-far-back');
  } finally { fs.closeSync(fd); }
});

test('meta says transcript-missing for a session with no rollout, and refuses a malformed request', async (t) => {
  const f = codexFixture(t);
  const ask = (extra) => handle({ op: 'meta', kind: 'codex', sessionId: ID, account: { id: 'codex-a', configDir: f.configDir }, ...extra }, f.options);
  await assert.rejects(ask({}), (error) => error.code === 'transcript-missing');
  assert.equal(require('./node-transcript.js').rolloutMeta(f.configDir, ID), null);
  for (const sessionId of ['../escape', '', 'a/b', 7]) {
    await assert.rejects(ask({ sessionId }), (error) => error.code === 'transcript-invalid', String(sessionId));
  }
  await assert.rejects(ask({ kind: 'claude' }), (error) => error.code === 'transcript-invalid' && /for codex rollouts/.test(error.message));
  await assert.rejects(ask({ account: { id: 'codex-b', configDir: f.configDir } }), (error) => error.code === 'transcript-refused');
  assert.equal(require('./node-transcript.js').rolloutMeta(f.configDir, '../x'), null);
});

// The `close-proof` op (transcript verb 5): the whole-transcript scan an automatic
// close needs, run on the node that has the file.
test('close-proof scans a Codex rollout on the node for child agents, with the real worker', async (t) => {
  const f = codexFixture(t);
  const file = path.join(f.day, `rollout-2026-09-25T10-00-00-${ID}.jsonl`);
  const ask = () => handle({ op: 'close-proof', kind: 'codex', sessionId: ID, account: { id: 'codex-a', configDir: f.configDir } }, f.options);
  fs.writeFileSync(file, line({ type: 'session_meta', payload: { id: ID, cwd: '/work/project' } })
    + line({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}' } }));
  const quiet = await ask();
  assert.equal(quiet.path, file);
  assert.equal(quiet.launched, false);
  fs.appendFileSync(file, line({ type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', arguments: '{}' } }));
  assert.equal((await ask()).launched, true);
});

test('close-proof answers a Claude transcript\'s background state, and says transcript-missing for none', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-node-close-proof-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'claude');
  fs.mkdirSync(path.join(configDir, 'projects', '-work-project'), { recursive: true });
  const account = { id: 'claude-a', agent: 'claude', configDir };
  const request = { op: 'close-proof', kind: 'claude', sessionId: ID, account: { id: 'claude-a', configDir } };
  const scanned = [];
  const options = {
    accounts: () => [account],
    inspectCloseTranscript: (file, kind) => { scanned.push([file, kind]); return { hasBackgroundCommands: true, pendingBackground: false }; },
  };
  await assert.rejects(handle(request, options), (error) => error.code === 'transcript-missing');
  const file = path.join(configDir, 'projects', '-work-project', `${ID}.jsonl`);
  fs.writeFileSync(file, line({ type: 'user', message: { content: 'hi' } }));
  const answer = await handle(request, options);
  assert.equal(answer.path, file);
  assert.equal(answer.hasBackgroundCommands, true);
  assert.equal(answer.pendingBackground, false);
  assert.deepEqual(scanned, [[file, 'claude']]);
  // An account this node does not have is refused before anything is read.
  await assert.rejects(handle({ ...request, account: { id: 'claude-b', configDir } }, options), (error) => error.code === 'transcript-refused');
});
