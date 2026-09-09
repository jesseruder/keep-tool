const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../web/app/app.js'), 'utf8');
const shell = fs.readFileSync(path.join(__dirname, '../web/app/shell.js'), 'utf8').replace(/^export /gm, '');
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('startup subscribes despite a failed request, retries, and refreshes on reconnect', async () => {
  let onStatus, retry, attempts = 0, renders = 0;
  const label = { dataset: {} };
  const context = vm.createContext({
    document: { querySelector: () => label },
    api: {
      subscribe(_change, status) { onStatus = status; },
      getState() { return ++attempts === 1 ? Promise.reject(Error('offline')) : Promise.resolve({ panes: [] }); },
      getLayouts: async () => [],
    },
    setTimeout(fn) { retry = fn; return 1; }, clearTimeout() { retry = null; },
    reloadGeneration: 0, appliedReloadGeneration: 0, layoutRevision: 0, layoutSavesPending: 0,
    data: {}, optimisticSetAside: new Map(), droppedPanes: new Set(),
    historyRestored: false, sessionHistory: {}, state: { mode: 'triage', focusMode: false },
    deriveDismissed() {}, applyLayouts() {}, applyStateEffects() {}, toast() {},
    refresh() { renders++; }, installNotificationClicks() {}, selectAttention() {}, focusSession() {}, acknowledgeNotificationClick() {},
  });
  const reloadStart = app.indexOf('let reloadRetry;');
  vm.runInContext(app.slice(reloadStart, app.indexOf('\nconst ctx =', reloadStart)), context);
  vm.runInContext(app.slice(app.indexOf("document.querySelector('#connection').textContent = 'connecting';")), context);
  await settle();
  assert.equal(typeof onStatus, 'function');
  assert.equal(typeof retry, 'function');
  assert.equal(renders, 0);
  await retry();
  assert.equal(renders, 1);
  assert.equal(retry, null);
  onStatus('live');
  await settle();
  assert.equal(renders, 2);
  assert.equal(label.dataset.status, 'live');
});

test('Cmd+Enter reaches a focused terminal without moving focus or cancelling input', () => {
  let handler, focusChanges = 0, cancelled = 0;
  class Element {
    matches() { return true; }
    closest(selector) { return selector === 'dialog' || selector === '#sessionHistory' ? null : this; }
  }
  const textarea = new Element();
  const closed = { classList: { contains: () => false } };
  const start = app.indexOf("document.addEventListener('keydown', (event) => {");
  vm.runInNewContext(app.slice(start, app.indexOf('}, true);', start) + 9), {
    Element, state: { focused: true },
    document: { activeElement: textarea, querySelector: () => closed, addEventListener: (_event, fn) => { handler = fn; } },
    focusQueue: () => { focusChanges++; },
  });
  handler({ key: 'Enter', metaKey: true, target: textarea, preventDefault: () => { cancelled++; } });
  assert.equal(focusChanges, 0);
  assert.equal(cancelled, 0);
});

test('native notifications carry their session key and recover early and subsequent clicks', async () => {
  let listener, pending = 'early-session';
  const calls = [], selected = [];
  const context = vm.createContext({
    document: { documentElement: { classList: { toggle() {} } } },
    window: { __TAURI__: {
      notification: { isPermissionGranted: async () => true },
      event: { listen: async (_name, callback) => { listener = callback; } },
      core: { invoke: async (command, payload) => {
        calls.push({ command, payload });
        if (command === 'get_notification_click') return pending;
        if (command === 'acknowledge_notification_click' && pending === payload.key) pending = null;
      } },
    } },
  });
  vm.runInContext(shell, context);
  await context.installNotificationClicks((key) => selected.push(key));
  assert.deepEqual(selected, ['early-session']);
  assert.equal(pending, 'early-session', 'reading a click must survive a page reload');
  await context.acknowledgeNotificationClick('early-session');
  assert.equal(pending, null);
  await context.notify({ title: 'Question', body: 'Choose one', tag: 'next-session' });
  assert.equal(calls.at(-1).command, 'send_notification');
  assert.equal(calls.at(-1).payload.key, 'next-session');
  pending = 'next-session';
  listener();
  await settle();
  assert.deepEqual(selected, ['early-session', 'next-session']);
  await context.acknowledgeNotificationClick('early-session');
  assert.equal(pending, 'next-session', 'an older navigation must not clear a newer click');
});
