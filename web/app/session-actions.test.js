import test from 'node:test';
import assert from 'node:assert/strict';

import { installKeepRunningControl, keepRunningControlHTML } from './session-actions.js';

class FakeButton {
  constructor(text) {
    this.textContent = text;
    this.disabled = false;
    this.attributes = new Map();
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
}

function menuWith(button) {
  return { querySelector: selector => selector === '[data-keep-running]' ? button : null };
}

test('keep-running control distinguishes session lifetime from layout pinning', () => {
  const automatic = keepRunningControlHTML({ id: 'session-a' });
  assert.match(automatic, /Automatic close/);
  assert.match(automatic, /data-keep-running/);
  assert.match(automatic, /aria-pressed="false"/);
  assert.match(automatic, />Keep running<\/button>/);
  assert.doesNotMatch(automatic, /Watch|data-pin/);

  const protectedSession = keepRunningControlHTML({ id: 'session-a', keepRunning: true });
  assert.match(protectedSession, /aria-pressed="true"/);
  assert.match(protectedSession, />Allow automatic close<\/button>/);
  assert.equal(keepRunningControlHTML(null), '');
});

test('keep-running control exposes progress and refreshes its optimistic session state', async () => {
  const button = new FakeButton('Keep running');
  const session = { id: 'session-a' };
  const calls = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const ctx = { refreshes: 0, refresh() { this.refreshes += 1; }, toast() { assert.fail('unexpected toast'); } };
  installKeepRunningControl(menuWith(button), ctx, session, async (...args) => { calls.push(args); await pending; });

  const click = button.onclick();
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(button.textContent, 'Saving…');
  assert.deepEqual(calls, [['session-a', true]]);
  release();
  await click;

  assert.equal(session.keepRunning, true);
  assert.equal(ctx.refreshes, 1);
});

test('keep-running control restores the action and reports a failed save', async () => {
  const button = new FakeButton('Allow automatic close');
  const session = { id: 'session-a', keepRunning: true };
  const toasts = [];
  const ctx = { refresh() { assert.fail('failed writes do not refresh'); }, toast(message) { toasts.push(message); } };
  installKeepRunningControl(menuWith(button), ctx, session, async () => { throw new Error('fixture refused'); });

  await button.onclick();

  assert.equal(session.keepRunning, true);
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-busy'), null);
  assert.equal(button.textContent, 'Allow automatic close');
  assert.deepEqual(toasts, ['Could not update automatic close: fixture refused']);
});
