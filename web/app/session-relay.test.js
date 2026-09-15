import test from 'node:test';
import assert from 'node:assert/strict';

// api.js reads `location` inside request(); nothing here calls it, but the module
// is imported transitively, so give it one anyway.
globalThis.location = new URL('http://localhost:7777/app/');

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function ctxFor(sessions = [], panes = []) {
  return {
    esc,
    data: { sessions, panes },
    paneMap: () => new Map(panes.map((pane) => [pane.id, pane])),
    toast: () => {},
  };
}

const SOURCE = { id: 'source-session-id', kind: 'claude', pane: 'pane-a', title: 'The finder', lastAssistant: 'The retry path double-sends on a 502.' };
const TARGET = { id: 'target-session-id', kind: 'codex', pane: 'pane-b', title: 'The fixer', taskId: 'retry-card' };
const DEAD = { id: 'dead-session-id', kind: 'claude', pane: 'pane-c', title: 'Exited' };
const PANES = [{ id: 'pane-a', alive: true }, { id: 'pane-b', alive: true }, { id: 'pane-c', alive: false }];

test('the relay text is the prefix, one space, and the trimmed message', async () => {
  const { relayText, relayPrefix } = await import('./session-relay.js');
  assert.equal(relayPrefix('codex', 'abcdefghijkl'), '[keep relay from codex abcdefgh]');
  assert.equal(relayText('claude', 'source-session-id', '  the retry double-sends  '),
    '[keep relay from claude source-s] the retry double-sends');
  // A missing agent still produces a well-formed prefix rather than "undefined".
  assert.equal(relayText('', '', ''), '[keep relay from session] ');
});

test('the target picker lists live sessions only, and never the source', async () => {
  const { relayTargets } = await import('./session-relay.js');
  const targets = relayTargets(ctxFor([SOURCE, TARGET, DEAD], PANES), SOURCE.id);
  assert.deepEqual(targets.map((target) => target.id), [TARGET.id]);
  assert.equal(targets[0].agent, 'codex');
  assert.equal(targets[0].card, 'retry-card');
});

test('the dialog shows the exact text that will be sent, escaped', async () => {
  const { relayDialogHTML, relayTargets } = await import('./session-relay.js');
  const ctx = ctxFor([SOURCE, TARGET, DEAD], PANES);
  const targets = relayTargets(ctx, SOURCE.id);
  const html = relayDialogHTML(ctx, {
    sourceSessionId: SOURCE.id, sourceAgent: SOURCE.kind, targets, targetId: TARGET.id,
    text: '<img src=x> the retry path double-sends', error: '',
  });
  assert.match(html, /\[keep relay from claude source-s\] &lt;img src=x&gt; the retry path double-sends/);
  assert.equal(html.includes('<img src=x>'), false, 'relayed text is escaped, not interpolated');
  assert.match(html, /<option value="target-session-id" selected>/);
  assert.equal(html.includes('value="dead-session-id"'), false);
  assert.equal(/data-relay-send [^>]*disabled/.test(html), false, 'a target and text enable Send');
});

test('Send is disabled with no target or no text, and an error is shown verbatim', async () => {
  const { relayDialogHTML } = await import('./session-relay.js');
  const ctx = ctxFor([SOURCE], [{ id: 'pane-a', alive: true }]);
  const alone = relayDialogHTML(ctx, { sourceSessionId: SOURCE.id, sourceAgent: 'claude', targets: [], targetId: '', text: 'hi', error: '' });
  assert.match(alone, /No other session has a live pane/);
  assert.match(alone, /data-relay-send disabled/);

  const empty = relayDialogHTML(ctx, { sourceSessionId: SOURCE.id, sourceAgent: 'claude', targets: [{ id: TARGET.id, agent: 'codex', title: 't', card: '' }], targetId: TARGET.id, text: '   ', error: '' });
  assert.match(empty, /data-relay-send disabled/);

  // 404 (no live host pane) and 429 (injection busy) both arrive as the server's sentence.
  const failed = relayDialogHTML(ctx, { sourceSessionId: SOURCE.id, sourceAgent: 'claude', targets: [], targetId: '', text: 'hi', error: 'target-session-id has no live host pane' });
  assert.match(failed, /class="relay-error" role="alert">target-session-id has no live host pane/);
});

test('the note about the server’s flattening appears only when it applies', async () => {
  const { relayWarning, relayDialogHTML, RELAY_LIMIT } = await import('./session-relay.js');
  assert.equal(relayWarning('one line'), '');
  assert.equal(relayWarning('two\nlines'), 'newlines will be collapsed; 2000 characters max');
  assert.equal(relayWarning('x'.repeat(RELAY_LIMIT + 1)), 'newlines will be collapsed; 2000 characters max');

  const ctx = ctxFor([SOURCE, TARGET], PANES);
  const state = { sourceSessionId: SOURCE.id, sourceAgent: 'claude', targets: [{ id: TARGET.id, agent: 'codex', title: 't', card: '' }], targetId: TARGET.id, error: '' };
  assert.equal(relayDialogHTML(ctx, { ...state, text: 'one line' }).includes('relay-note'), false);
  assert.match(relayDialogHTML(ctx, { ...state, text: 'two\nlines' }), /relay-note[^>]*>newlines will be collapsed; 2000 characters max/);
});
