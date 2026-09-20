'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./fixture.cjs');

async function post(fixture, pathname, body) {
  const response = await fetch(`${fixture.url}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-keep': '1' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('fixture models keep-running and reply-driven resume without discarding the conversation row', async t => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const session = fixture.state.sessions[0];

  const kept = await post(fixture, '/api/session-keep-running', { sessionId: session.id, keepRunning: true });
  assert.equal(kept.status, 200);
  assert.deepEqual(kept.body, { ok: true, sessionId: session.id, keepRunning: true });
  assert.equal(session.keepRunning, true);

  const stalePane = fixture.state.panes.find(pane => pane.id === session.pane);
  stalePane.alive = false;
  Object.assign(session, { state: 'exited', exited: true,
    retirement: { automatic: true, at: new Date().toISOString(), reason: 'settled-attention' } });
  fixture.publish();

  const sent = await post(fixture, '/api/send', { sessionId: session.id, text: 'Here is the answer' });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.sessionId, session.id);
  assert.equal(session.id, fixture.state.sessions[0].id, 'the existing conversation row survives');
  assert.equal(session.retirement, undefined);
  assert.equal(session.exited, false);
  assert.equal(session.state, 'running');
  assert.equal(fixture.state.panes.find(pane => pane.id === session.pane)?.alive, true);
  const input = fixture.events.filter(event => event.event === 'input').at(-1);
  assert.deepEqual({ ...input, at: '<at>' },
    { at: '<at>', event: 'input', sessionId: session.id, text: 'Here is the answer' });
});
