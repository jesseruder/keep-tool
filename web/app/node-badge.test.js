import test from 'node:test';
import assert from 'node:assert/strict';

import { nodeBadgeHTML, remoteNode, remotePaneNode } from './node-badge.js';

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

test('a pane is remote only when its published id names its node', () => {
  assert.equal(remotePaneNode({ id: 'p7@aws1', node: 'aws1', hostPaneId: 'p7' }), 'aws1');
  // Every pane of a multi-node fleet carries node, the daemon's own included.
  assert.equal(remotePaneNode({ id: 'p7', node: 'main' }), '');
  assert.equal(remotePaneNode({ id: 'p7' }), '');
  assert.equal(remotePaneNode(undefined), '');
});

test('the row or session node wins over the pane, and nothing names the daemon node', () => {
  const pane = { id: 'p7@aws1', node: 'aws1' };
  assert.equal(remoteNode({ item: { node: 'aws2' }, session: { node: 'aws3' }, pane }), 'aws2');
  assert.equal(remoteNode({ item: {}, session: { node: 'aws3' }, pane }), 'aws3');
  assert.equal(remoteNode({ item: {}, session: {}, pane }), 'aws1');
  assert.equal(remoteNode({ item: {}, session: {}, pane: { id: 'p7', node: 'main' } }), '');
  assert.equal(remoteNode(), '');
});

test('an exited session whose record names the daemon node gets no badge from an old pane elsewhere', () => {
  const oldPane = { id: 'p7@aws1', node: 'aws1' };
  assert.equal(remoteNode({ item: {}, session: { nodeRecorded: true }, pane: oldPane }), '', 'the record, not the dead pane');
  assert.equal(remoteNode({ item: {}, session: { nodeRecorded: true, node: 'aws2' }, pane: oldPane }), 'aws2');
  assert.equal(remoteNode({ item: {}, session: {}, pane: oldPane }), 'aws1', 'with no record the pane still answers');
});

test('the badge names the node in text and title, and is empty without one', () => {
  assert.equal(nodeBadgeHTML(esc, 'aws1'), '<span class="node-badge" title="runs on node aws1">aws1</span>');
  assert.equal(nodeBadgeHTML(esc, ''), '');
});
