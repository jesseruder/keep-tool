'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/app/restart-session.js'), 'utf8')
  .replace(/^import .*;\n/m, '').replaceAll('export function', 'function'), context);
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
test('headers offer no restart buttons, but queued restarts remain cancellable', () => {
  for (const status of [undefined, 'done', 'failed', 'cancelled', 'queued', 'restarting']) {
    const html = context.restartControls({ data: { restarts: status ? [{ sessionId: 's', status, reason: 'reason' }] : [] }, esc: s => s }, 's');
    assert.doesNotMatch(html, /data-restart="(?:now|idle)"/);
    assert.equal(html.includes('data-restart="cancel"'), status === 'queued');
    if (!status || ['done', 'cancelled'].includes(status)) assert.equal(html, '');
  }
});
