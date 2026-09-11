'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { launch } = require('./reviewer-launch');

test('reviewer launches in a host-owned Claude pane with a pinned session and registration environment', async () => {
  const calls = [];
  let closed = false;
  const result = await launch(['sonnet'], '/tmp/private registry', {
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
    connect: async () => ({
      request: async (method, params) => { calls.push({ method, params }); return method === 'list' ? { panes: [] } : { pane: { id: 'review-pane' } }; },
      close: () => { closed = true; },
    }),
  });
  assert.equal(result.pane, 'review-pane');
  const spawn = calls.find((call) => call.method === 'spawn').params;
  assert.equal(spawn.meta.sessionId, result.sessionId);
  assert.equal(spawn.meta.agent, 'claude');
  assert.equal(spawn.meta.reviewer, true);
  assert.equal(spawn.env.KEEP_REVIEWER, '1');
  assert.equal(spawn.env.KEEP_DIR, '/tmp/private registry');
  // A five-card bundle is built to 40k tokens; Claude Code's default 30k-char Bash
  // truncation forced the reviewer to re-read the bundle file in chunks.
  assert.equal(spawn.env.BASH_MAX_OUTPUT_LENGTH, '200000');
  assert.match(spawn.args[1], /--session-id.*11111111-1111-4111-8111-111111111111/);
  assert.equal(closed, true);
});

test('an existing hosted reviewer prevents an accidental duplicate launch', async () => {
  let closed = false;
  await assert.rejects(launch([], '/tmp/registry', {
    connect: async () => ({
      request: async (method) => { assert.equal(method, 'list'); return { panes: [{ alive: true, meta: { reviewer: true } }] }; },
      close: () => { closed = true; },
    }),
  }), /already running/);
  assert.equal(closed, true);
});
