import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = new URL('http://localhost:7777/app/');
const { runAction } = await import(`./action.js?action=${Date.now()}`);

class FakeButton {
  constructor(html = 'Close') { this.innerHTML = html; this.disabled = false; this.attributes = new Map(); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
}

test('runAction shows busy state and restores the button after success', async () => {
  const button = new FakeButton('<b>Close</b>');
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const action = runAction(button, () => pending, { label: 'Closing…' });
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.match(button.innerHTML, /spin/);
  assert.match(button.innerHTML, /Closing…/);
  release('done');
  assert.equal(await action, 'done');
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-busy'), null);
  assert.equal(button.innerHTML, '<b>Close</b>');
});

test('runAction restores the button and records a retryable failure', async () => {
  const button = new FakeButton();
  const retry = () => {};
  await assert.rejects(runAction(button, async () => { throw new Error('daemon refused [load 8.2, swap 1G]'); },
    { label: 'Closing…', retry }), /daemon refused/);
  const api = await import('./api.js');
  assert.equal(button.disabled, false);
  assert.equal(api.lastWriteFailure().message, 'daemon refused [load 8.2, swap 1G]');
  assert.equal(api.lastWriteFailure().retry, retry);
});
