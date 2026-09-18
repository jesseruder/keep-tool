const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../web/app/app.js'), 'utf8');
const shell = fs.readFileSync(path.join(__dirname, '../web/app/shell.js'), 'utf8').replace(/^export /gm, '');
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('startup subscribes despite a failed request, retries, and refreshes on reconnect', async () => {
  let onStatus, retry, attempts = 0, renders = 0, iconRefreshes = 0;
  const label = { dataset: {} };
  const context = vm.createContext({
    document: { querySelector: () => label },
    api: {
      subscribe(_change, status) { onStatus = status; },
      getState() { return ++attempts === 1 ? Promise.reject(Error('offline')) : Promise.resolve({ panes: [] }); },
      getLayouts: async () => [],
      getPortableTransfers: async () => ({ transfers: [] }),
    },
    detailStore: { reconcile() {} },
    setTimeout(fn) { retry = fn; return 1; }, clearTimeout() { retry = null; },
    reloadGeneration: 0, appliedReloadGeneration: 0, layoutRevision: 0, layoutSavesPending: 0,
    closingSessions: { reconcile() {} },
    data: {}, optimisticSetAside: new Map(), pruneSetAsideOverrides() {}, droppedPanes: new Set(), spawnedPanes: new Map(),
    historyRestored: false, sessionHistory: {}, state: { mode: 'triage', focusMode: false },
    deriveDismissed() {}, applyLayouts() {}, applyStateEffects() {}, toast() {},
    refreshProjectChoices() { iconRefreshes++; },
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
  assert.equal(iconRefreshes, 1);
  assert.equal(retry, null);
  onStatus('live');
  await settle();
  assert.equal(renders, 2);
  assert.equal(iconRefreshes, 2);
  assert.equal(label.dataset.status, 'live');
});

test('a daemon restart retries quietly; only a long outage or a real error toasts', async () => {
  let retry, clock = 1_000_000, failure = null;
  const toasts = [];
  const label = { dataset: { status: 'live' } };
  const context = vm.createContext({
    Date: { now: () => clock },
    document: { querySelector: () => label },
    api: {
      subscribe() {},
      getState() { return failure ? Promise.reject(failure) : Promise.resolve({ panes: [] }); },
      getLayouts: async () => [],
      getPortableTransfers: async () => ({ transfers: [] }),
    },
    detailStore: { reconcile() {} },
    setTimeout(fn) { retry = fn; return 1; }, clearTimeout() { retry = null; },
    reloadGeneration: 0, appliedReloadGeneration: 0, layoutRevision: 0, layoutSavesPending: 0,
    closingSessions: { reconcile() {} },
    data: {}, optimisticSetAside: new Map(), pruneSetAsideOverrides() {}, droppedPanes: new Set(), spawnedPanes: new Map(),
    historyRestored: false, sessionHistory: {}, state: { mode: 'triage', focusMode: false },
    deriveDismissed() {}, applyLayouts() {}, applyStateEffects() {}, toast(message) { toasts.push(message); },
    refreshProjectChoices() {}, refresh() {}, installNotificationClicks() {}, selectAttention() {}, focusSession() {}, acknowledgeNotificationClick() {},
  });
  const reloadStart = app.indexOf('let reloadRetry;');
  vm.runInContext(app.slice(reloadStart, app.indexOf('\nconst ctx =', reloadStart)), context);
  const reload = () => vm.runInContext('reload()', context);

  const unreachable = () => Object.assign(TypeError('Failed to fetch'), { transient: true });
  failure = Object.assign(Error('dashboard state is still loading'), { status: 503, transient: true });
  await reload();
  assert.deepEqual(toasts, [], 'a restarting daemon does not toast');
  assert.equal(label.dataset.status, 'reconnecting');
  assert.equal(typeof retry, 'function');
  clock += 20e3;
  failure = unreachable();
  await retry();
  assert.deepEqual(toasts, [], 'twenty seconds of refused connections stays quiet');
  failure = null;
  await retry();
  assert.equal(label.dataset.status, 'live', 'recovery clears the reconnecting state');
  assert.equal(retry, null);

  failure = unreachable();
  await reload();
  vm.runInContext("eventStreamStatus = 'reconnecting'", context);
  failure = null;
  await retry();
  assert.equal(label.dataset.status, 'reconnecting', 'a fetch recovery leaves the event stream status alone');
  vm.runInContext("eventStreamStatus = 'live'", context);
  label.dataset.status = 'live';

  failure = Object.assign(Error('dashboard action queue is full'), { status: 503, transient: false });
  await reload();
  assert.equal(toasts.length, 1, 'a 503 that is not a restart toasts immediately');
  failure = null;
  await retry();
  toasts.length = 0;

  failure = unreachable();
  await reload();
  clock += 61e3;
  await retry();
  assert.equal(toasts.length, 1, 'an outage past a minute toasts once');
  await retry();
  assert.equal(toasts.length, 1);
  failure = null;
  await retry();

  failure = Object.assign(Error('internal error'), { status: 500 });
  await reload();
  assert.equal(toasts.length, 2, 'a real server error toasts immediately');
});

// The global keydown handler, lifted out of app.js and run against a terminal
// textarea that owns the keyboard. The real leave-terminal module is wired in,
// so this is the app.js gate itself under test, not a restatement of it.
async function focusedTerminalKeys({ helpOpen = false } = {}) {
  const { handleLeaveTerminalKey } = await import('../web/app/leave-terminal.js');
  let handler, focusChanges = 0;
  class Element {
    matches() { return true; }
    closest(selector) { return selector === 'dialog' || selector === '#sessionHistory' ? null : this; }
  }
  const textarea = new Element();
  const closed = { classList: { contains: () => false, remove() {} } };
  const help = { on: helpOpen, classList: { contains: (name) => name === 'on' && help.on, remove: (name) => { if (name === 'on') help.on = false; } } };
  const document = {
    activeElement: textarea,
    querySelector: (selector) => (selector === '#help' ? help : selector === '#qlist .qitem.sel' ? queueItem : closed),
    querySelectorAll: () => [],
    addEventListener: (_event, fn) => { handler = fn; },
  };
  const queueItem = { focus() { document.activeElement = queueItem; } };
  const state = { focused: true, pendingFocus: false };
  const start = app.indexOf("document.addEventListener('keydown', (event) => {");
  vm.runInNewContext(app.slice(start, app.indexOf('}, true);', start) + 9), {
    Element, state, document, handleLeaveTerminalKey,
    focusQueue: () => { focusChanges++; },
    closePalettePopover() {}, closeReviewerPopover() {},
  });
  const press = (key, modifiers = {}) => {
    const event = { key, metaKey: false, target: textarea, cancelled: 0, stopped: 0, ...modifiers };
    event.preventDefault = () => { event.cancelled++; };
    event.stopPropagation = () => { event.stopped++; };
    handler(event);
    return event;
  };
  return { press, state, document, help, textarea, queueItem, focusChanges: () => focusChanges };
}

test('Cmd+Enter reaches a focused terminal without moving focus or cancelling input', async () => {
  const keys = await focusedTerminalKeys();
  const event = keys.press('Enter', { metaKey: true });
  assert.equal(keys.focusChanges(), 0);
  assert.equal(event.cancelled, 0);
  assert.equal(keys.document.activeElement, keys.textarea);
});

test('Cmd+Escape leaves a focused terminal for the selected queue item, stopped before xterm sees it', async () => {
  const keys = await focusedTerminalKeys();
  const plain = keys.press('Escape');
  assert.equal(keys.document.activeElement, keys.textarea, 'Escape alone stays with the terminal');
  assert.equal(plain.cancelled + plain.stopped, 0);
  const chord = keys.press('Escape', { metaKey: true });
  assert.equal(keys.document.activeElement, keys.queueItem);
  assert.equal(keys.state.focused, false);
  assert.equal(chord.cancelled, 1);
  assert.equal(chord.stopped, 1);
});

test('Cmd+Escape with the help sheet open closes the sheet first and keeps the terminal', async () => {
  const keys = await focusedTerminalKeys({ helpOpen: true });
  const chord = keys.press('Escape', { metaKey: true });
  assert.equal(keys.help.on, false);
  assert.equal(keys.document.activeElement, keys.textarea);
  assert.equal(chord.cancelled, 1);
  assert.equal(chord.stopped, 1, 'the pty must not receive a bare ESC for the Escape that closed the sheet');
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
