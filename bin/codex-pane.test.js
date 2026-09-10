'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordSessionPane } = require('./keep.js');

test('pane discovery uses the open rollout even when the TUI launched with resume', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const live = await require('./serve').liveSessionPids({
    codexRolloutOnly: true,
    agentProcessRows: async () => [{ pid: 12, agent: 'codex', interactive: true, args: `codex resume ${id}` }],
    lsof: async () => `p12\nn/tmp/rollout-new-${id}.jsonl\n`,
    statMtime: async () => 200,
  });
  assert.equal(live.get(id).source, 'rollout');
  assert.equal(live.get(id).primary, true);
});

test('Codex conversation switches rebind the pane only with direct process and open-rollout evidence', async () => {
  for (const scenario of ['switch', 'nested', 'native-child', 'headless', 'unknown', 'other-pane', 'old-rollout', 'argv-only', 'changed-pane', 'missing-process']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-switch-'));
    try {
      let owner = 'old', gets = 0;
      const rows = [
        { pid: 10, ppid: 1, args: '/bin/zsh -l' },
        { pid: 11, ppid: scenario === 'other-pane' ? 99 : 10, args: '/bin/sh keep-codex-cli /bin/codex', interactive: true },
        { pid: 12, ppid: 11, args: '/bin/codex', interactive: true },
        { pid: 13, ppid: 12, args: '/bin/codex', interactive: true },
      ];
      const record = await recordSessionPane({ session_id: 'new', cwd: '/tmp/project' }, 'codex', {
        root, env: { KEEP_PANE: 'pane' }, attempts: 1,
        sessionMetaFor: () => scenario === 'unknown' ? null : { id: 'new', source: scenario === 'headless' ? 'exec' : 'cli',
          ...(scenario === 'native-child' ? { thread_source: 'subagent' } : {}) },
        agentProcessRows: async () => rows,
        liveSessionPids: async () => new Map([['new', {
          pid: scenario === 'nested' ? 13 : scenario === 'missing-process' ? 99 : 12,
          agent: 'codex', source: scenario === 'argv-only' ? 'argv' : 'rollout', primary: scenario !== 'old-rollout',
        }]]),
        connectHost: async () => ({
          async request(type, params) {
            if (type === 'get') return { pane: { alive: true, pid: scenario === 'changed-pane' && ++gets > 1 ? 20 : 10, meta: { sessionId: owner } } };
            assert.equal(type, 'meta');
            owner = params.patch.sessionId;
            return {};
          }, close() {},
        }),
      });
      // An exec-origin history can be resumed by the interactive TUI.
      const accepted = ['switch', 'headless'].includes(scenario);
      assert.equal(record.bound, accepted, scenario);
      assert.equal(owner, accepted ? 'new' : 'old', scenario);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
