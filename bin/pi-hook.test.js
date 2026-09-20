'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordSessionPane, releaseSessionPane } = require('./commands/hook');

test('Pi releases a preassigned pane on session switch and ignores a stale instance end', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-pi-hook-'));
  const pane = { id: 'pane-pi', alive: true, meta: { agent: 'pi', sessionId: 'first' } };
  const requests = [];
  const deps = {
    root, env: { KEEP_PANE: pane.id, KEEP_AGENT_ACCOUNT_ID: 'pi/default' }, attempts: 1,
    connectHost: async () => ({
      request: async (kind, input) => {
        requests.push({ kind, input });
        if (kind === 'get') return { pane: structuredClone(pane) };
        if (kind === 'meta') {
          Object.assign(pane.meta, input.patch);
          return { pane: structuredClone(pane) };
        }
        throw new Error(`unexpected host request ${kind}`);
      },
      close() {},
    }),
  };
  const first = { session_id: 'first', cwd: root, instance: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  const second = { session_id: 'second', cwd: root, instance: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
  try {
    const bound = await recordSessionPane(first, 'pi', deps);
    assert.equal(bound.bound, true);
    assert.equal(bound.claimed, true, 'preassigned same-id Pi pane is owned by this instance');
    await releaseSessionPane(first, 'pi', deps);
    assert.equal(pane.meta.sessionId, 'first', 'exited pane keeps its identity for Reopen');
    assert.equal(pane.meta.agent, 'pi');
    assert.equal((await recordSessionPane(second, 'pi', deps)).bound, true);
    assert.equal(pane.meta.sessionId, 'second');
    const patches = requests.filter((entry) => entry.kind === 'meta').length;
    await releaseSessionPane({ ...second, instance: first.instance }, 'pi', deps);
    assert.equal(requests.filter((entry) => entry.kind === 'meta').length, patches);
    assert.equal(pane.meta.sessionId, 'second');
    await releaseSessionPane(second, 'pi', deps);
    assert.equal(pane.meta.sessionId, 'second');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
