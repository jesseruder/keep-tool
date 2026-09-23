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
