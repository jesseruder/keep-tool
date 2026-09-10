'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordSessionPane } = require('./keep.js');

test('Codex conversation switches rebind the pane only with direct process and open-rollout evidence', async () => {
  for (const scenario of ['switch', 'nested', 'other-pane', 'old-rollout', 'argv-only', 'changed-pane', 'missing-process']) {
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
      assert.equal(record.bound, scenario === 'switch', scenario);
      assert.equal(owner, scenario === 'switch' ? 'new' : 'old', scenario);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
