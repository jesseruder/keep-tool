'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/app/restart-session.js'), 'utf8')
  .replace(/^import .*;\n/gm, '').replaceAll('export function', 'function'), context);
test('restart failure labels belong to the original process, not a later resume', () => {
  const entry = { sessionId: 's', pane: 'old', pid: 10, status: 'failed', reason: 'Old failure' };
  const pane = { id: 'old', pid: 10, alive: true, meta: { sessionId: 's', agent: 'codex' } };
  const render = panes => context.restartControls({ data: { restarts: [entry], panes }, esc: s => s }, 's');
  assert.match(render([pane]), /Restart failed/);
  assert.doesNotMatch(render([{ ...pane, pid: 20 }]), /Restart failed/);
  assert.doesNotMatch(render([{ ...pane, id: 'new', pid: 20 }]), /Restart failed/);
  for (const panes of [[], [{ ...pane, pid: 20, alive: false }], [{ ...pane, pid: undefined }],
    [{ ...pane, pid: 20, agentAlive: false }],
    [{ ...pane, pid: 20, meta: { sessionId: 'other', agent: 'codex' } }],
    [pane, { ...pane, id: 'other', pid: 20 }]]) assert.match(render(panes), /Restart failed/);
  assert.equal(entry.status, 'failed', 'display reconciliation does not rewrite history');
  entry.status = 'queued'; assert.match(render([{ ...pane, pid: 20 }]), /Restart queued/);
  entry.status = 'restarting'; assert.match(render([{ ...pane, pid: 20 }]), /Restarting/);
});
test('a live session offers one forced Restart; pending states replace it', () => {
  const pane = { id: 'p', pid: 10, alive: true, meta: { sessionId: 's', agent: 'claude' } };
  const render = (restarts, panes = [pane]) => context.restartControls({ data: { restarts, panes }, esc: (s) => s }, 's');
  const idle = render([]);
  assert.match(idle, /data-restart="now" data-owner-force="1"/);
  assert.equal((idle.match(/data-restart=/g) || []).length, 1);
  assert.doesNotMatch(render([], []), /data-restart=/, 'no live pane, nothing to restart');
  assert.doesNotMatch(render([], [pane, { ...pane, id: 'q', pid: 11 }]), /data-restart=/, 'two live panes are ambiguous');
  assert.doesNotMatch(render([], [{ ...pane, meta: { sessionId: 's', agent: 'shell' } }]), /data-restart=/);
  for (const status of ['queued', 'restarting', 'recovery-needed']) {
    const html = render([{ sessionId: 's', status, reason: 'reason' }]);
    assert.doesNotMatch(html, /data-restart="now"/, status);
    assert.equal(html.includes('data-restart="cancel"'), status === 'queued');
  }
  assert.match(render([{ sessionId: 's', status: 'done' }]), /data-restart="now"/, 'a finished restart can be repeated');
  assert.match(render([{ sessionId: 's', status: 'failed', reason: 'r', pane: 'p', pid: 10 }]), /Restart failed.*data-restart="now"/);
});
