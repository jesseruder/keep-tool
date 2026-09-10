'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { close } = require('./shell-cleanup');
const { IDLE_MS, refusal, startScheduler } = require('./session-cleanup');
const now = Date.now();
const pane = { id: 'p', pid: 123, createdAt: 'yesterday', alive: true, cmd: '/bin/zsh', args: ['-l'],
  attached: 0, lastOutputAt: new Date(now - IDLE_MS).toISOString(), meta: { agent: 'shell' } };
const prompt = '(base) ~/keep (main) >';
const empty = { text: prompt, cursor: { x: prompt.length + 1, y: 0 } };

test('shell cleanup closes empty old shells and exited Claude shells, preserving unsafe cases', async () => {
  for (const mode of ['plain', 'exited-claude', 'recent', 'pinned', 'attached', 'child', 'draft', 'unknown-cursor', 'unknown-agent', 'live-agent', 'wrong-process', 'race-child', 'race-viewer', 'race-output']) {
    let snapshots = 0, processReads = 0, writes = 0;
    const p = structuredClone(pane);
    const state = { panes: [p], sessions: [], pinned: new Set() };
    if (mode === 'recent') p.lastOutputAt = new Date(now - IDLE_MS + 1).toISOString();
    if (mode === 'pinned') state.pinned.add('p');
    if (mode === 'attached') p.attached = 1;
    if (['exited-claude', 'unknown-agent', 'live-agent'].includes(mode)) {
      p.meta = { agent: 'claude', sessionId: 's' };
      if (mode !== 'unknown-agent') state.sessions = [{ id: 's', pane: 'p', state: mode === 'live-agent' ? 'idle' : 'exited' }];
    }
    const original = structuredClone(p);
    const deps = { now: () => now,
      snapshot: async () => {
        if (++snapshots === 2 && mode === 'race-viewer') p.attached = 1;
        if (snapshots === 2 && mode === 'race-output') p.lastOutputAt = new Date(now).toISOString();
        return state;
      },
      processes: async () => {
        processReads++;
        return [{ pid: 123, ppid: 1, args: mode === 'wrong-process' ? 'vim' : '/bin/zsh -l' },
          ...((mode === 'child' || (mode === 'race-child' && processReads === 2)) ? [{ pid: 124, ppid: 123, args: 'sleep 99999' }] : [])];
      },
      screen: async () => mode === 'draft' ? { text: prompt + ' git push', cursor: { x: 99, y: 0 } }
        : mode === 'unknown-cursor' ? { text: prompt } : empty,
      eof: async () => writes++,
    };
    if (['plain', 'exited-claude'].includes(mode)) await close(original, deps);
    else await assert.rejects(close(original, deps), undefined, mode);
    assert.equal(writes, ['plain', 'exited-claude'].includes(mode) ? 1 : 0, mode);
  }
});

test('agent cleanup uses an eight-hour boundary for transcript and output activity', () => {
  const p = { ...pane, meta: { agent: 'claude', sessionId: 's' } };
  const s = { id: 's', kind: 'claude', state: 'idle', endedTurn: true, mtime: now - IDLE_MS };
  assert.equal(IDLE_MS, 8 * 3600e3);
  assert.equal(refusal(s, p, new Set(), now, { automatic: true }), null);
  assert.match(refusal({ ...s, mtime: s.mtime + 1 }, p, new Set(), now, { automatic: true }), /8 hours/);
  assert.match(refusal(s, { ...p, lastOutputAt: new Date(now - IDLE_MS + 1).toISOString() }, new Set(), now, { automatic: true }), /recent/);
});

test('scheduler includes shells and throttles failed closure attempts', async () => {
  const events = []; let calls = 0;
  const scheduler = startScheduler({ now: () => now,
    snapshot: async () => ({ sessions: [], panes: [pane], pinned: new Set() }),
    close: async () => assert.fail('no agent'),
    closeShell: async () => { calls++; throw Error('draft'); }, record: async e => events.push(e) });
  try { await scheduler.tick(); await scheduler.tick(); }
  finally { scheduler.stop(); }
  assert.equal(calls, 1);
  assert.match(events[0].outcome, /shell not closed: draft/);
});
