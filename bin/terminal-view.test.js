const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');

const imagePasteSource = fs.readFileSync(path.join(__dirname, '../web/app/image-paste.js'), 'utf8').replace(/^export /gm, '');
const source = imagePasteSource + '\n' + fs.readFileSync(path.join(__dirname, '../web/app/terminal.js'), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export function mountTerminal', 'function mountTerminal');

test('Triage and Watch move one terminal viewer instead of retaining a hidden primary', () => {
  const app = fs.readFileSync(path.join(__dirname, '../web/app/app.js'), 'utf8');
  const mountSource = app.slice(app.indexOf('function mount(container'), app.indexOf('function disposeUnusedTerminals'));
  let count = 0;
  const shown = [];
  const context = vm.createContext({
    terminals: new Map(), terminalRender: 1, visibleTerminals: [],
    data: { sessions: [] },
    document: { activeElement: null },
    paneMap: () => new Map(),
    mountTerminal(container, pane, options) {
      count++;
      const element = { parentElement: container };
      return { element, show: (focus) => shown.push(focus), viewer: options.slot };
    },
  });
  vm.runInContext(mountSource, context);
  const triage = { replaceChildren(el) { el.parentElement = this; } };
  const watch = { replaceChildren(el) { el.parentElement = this; } };
  const first = context.mount(triage, 'p', { slot: 'triage' });
  const second = context.mount(watch, 'p', { slot: 'watch:p' });
  assert.equal(first, second);
  assert.equal(second.element.parentElement, watch);
  const third = context.mount(triage, 'p', { slot: 'triage' });
  assert.equal(third, first);
  assert.equal(third.element.parentElement, triage);
  assert.equal(count, 1);
  assert.deepEqual(shown, [false, false], 'both moves schedule layout without requiring a click');
});

function fixture() {
  class Element {
    constructor() {
      this.dataset = {};
      this.style = {};
      this.clientWidth = 300;
      this.clientHeight = 200;
      this.offsetWidth = 600;
      this.offsetHeight = 750;
      this.children = new Map();
      this.listeners = new Map();
      this.classList = { add() {}, remove() {}, toggle() {} };
      this.isConnected = true;
    }
    querySelector(selector) {
      if (!this.children.has(selector)) this.children.set(selector, new Element());
      return this.children.get(selector);
    }
    replaceChildren() {}
    getClientRects() { return [{ width: 800, height: 500 }]; }
    getBoundingClientRect() { return { width: this.offsetWidth, height: this.offsetHeight }; }
    contains() { return false; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    dispatch(type, event = {}) { this.listeners.get(type)?.({ stopPropagation() {}, ...event }); }
  }
  let terminal, fits = 0;
  class Terminal extends HeadlessTerminal {
    constructor(options) { super(options); terminal = this; this.textarea = new Element(); this.visualElement = new Element(); }
    get element() { return this.visualElement; }
    open() {
      const screen = this.visualElement.querySelector('.xterm-screen');
      Object.defineProperties(screen, {
        offsetWidth: { configurable: true, get: () => this.cols * this.options.fontSize * 0.6 },
        offsetHeight: { configurable: true, get: () => this.rows * this.options.fontSize * 1.2 },
      });
    }
    loadAddon() {}
    attachCustomKeyEventHandler(handler) { this.keyHandler = handler; }
    focus() {}
  }
  class WebSocket {
    static OPEN = 1;
    static CLOSING = 2;
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; this.visibility = []; }
    send(data) {
      if (typeof data === 'string' && JSON.parse(data).t === 'visibility') this.visibility.push(JSON.parse(data).visible);
      else this.sent.push(data);
    }
    close() { this.readyState = 3; }
  }
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    TextEncoder, Uint8Array, URLSearchParams, WebSocket, devicePixelRatio: 2,
    document: { createElement: () => new Element(), activeElement: null },
    window: {
      Terminal,
      FitAddon: { FitAddon: class { fit() { fits++; terminal.resize(80, 30); } } },
      SearchAddon: { SearchAddon: class {} },
    },
    ResizeObserver: class { observe() {} disconnect() {} },
    sessionStorage: { getItem: () => 'viewer' },
    location: { protocol: 'http:', host: 'localhost' },
    performance: { now: () => 1 },
    getComputedStyle: () => ({ paddingLeft: '8', paddingRight: '8', paddingTop: '8', paddingBottom: '0' }),
    resolvedTheme() {}, getPalette() {}, xtermTheme: () => ({}),
    captureFocusIntent: () => () => true,
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  });
  vm.runInContext(source, context);
  const mounted = context.mountTerminal(new Element(), 'pane', { focus: true });
  const socket = mounted.socket;
  const message = (value) => socket.onmessage({ data: JSON.stringify(value) });
  socket.onopen();
  message({ t: 'attached', pane: { id: 'pane', primary: 'viewer', cols: 80, rows: 50 } });
  const drain = () => new Promise((resolve) => terminal.write('', resolve));
  return { mounted, terminal, socket, message, drain, timers, get fits() { return fits; } };
}

test('cached terminal visibility reports hide, show and reattachment', () => {
  const f = fixture();
  assert.equal(f.socket.visibility.at(-1), true);
  f.mounted.hide();
  assert.equal(f.socket.visibility.at(-1), false);
  f.message({ t: 'attached', pane: { id: 'pane', primary: 'viewer', cols: 80, rows: 50 } });
  assert.equal(f.socket.visibility.at(-1), false);
  f.mounted.show();
  assert.equal(f.socket.visibility.at(-1), true);
  f.mounted.dispose();
});

test('hidden terminal cache is bounded and expires without terminating host sessions', () => {
  const app = fs.readFileSync(path.join(__dirname, '../web/app/app.js'), 'utf8');
  const source = app.slice(app.indexOf('function disposeUnusedTerminals'), app.indexOf('function scheduleFocus'));
  const terminals = new Map();
  const disposed = [];
  const now = Date.now();
  for (let i = 0; i < 12; i++) terminals.set(String(i), new Map([['console', { render: 1, hiddenSince: now - i, mounted: { hide() {}, dispose() { disposed.push(i); } } }]]));
  terminals.set('visible', new Map([['console', { render: 2, mounted: { dispose() { assert.fail('visible terminal evicted'); } } }]]));
  const context = vm.createContext({ terminals, terminalRender: 2, paneMap: () => new Map([...terminals.keys()].map((k) => [k, {}])), setTimeout: (fn) => fn(), Date, state: {} });
  vm.runInContext(source, context);
  context.disposeUnusedTerminals();
  assert.equal(terminals.size, 9);
  assert.equal(disposed.length, 4);
  for (const [id, mounts] of terminals) if (id !== 'visible') mounts.get('console').hiddenSince = now - 6 * 60e3;
  context.disposeUnusedTerminals();
  assert.equal(terminals.size, 1);
  assert.equal(disposed.length, 12);
});

test('snapshot parses at its original size before fit or user input', async () => {
  const f = fixture();
  try {
    // With a premature 30-row resize these absolute addresses all clamp to
    // row 30, producing STATUSpt and leaving the input cursor on the status.
    f.socket.onmessage({ data: new TextEncoder().encode('\x1b[48;1H› prompt\x1b[50;1HSTATUS\x1b[48;3H').buffer });
    f.mounted.fit();
    assert.equal(f.terminal.rows, 50, 'layout callbacks must not resize during replay');
    f.message({ t: 'replay-end' });
    assert.equal(f.fits, 0, 'the wire marker is not a parser completion marker');
    f.terminal.keyHandler({ type: 'keydown', metaKey: true, ctrlKey: false, key: 'Enter', preventDefault() {} });
    assert.equal(f.socket.sent.length, 0, 'input must wait for the parser and resize');
    await f.drain();
    assert.equal(f.fits, 1);
    assert.equal(f.terminal.rows, 30);
    assert.equal(JSON.parse(f.socket.sent[0]).t, 'primary');
    assert.ok(f.socket.sent[1] instanceof Uint8Array);
    const buffer = f.terminal.buffer.active;
    assert.equal(buffer.getLine(buffer.baseY + buffer.cursorY).translateToString(true), '› prompt');
  } finally { f.mounted.dispose(); }
});

test('earlier output is loaded only after first paint and preserves queued input', async () => {
  const f = fixture();
  try {
    const history = f.mounted.element.querySelector('.term-history');
    assert.equal(history.hidden, true);
    f.message({ t: 'replay-end' });
    await f.drain();
    assert.equal(history.hidden, false);

    const first = f.socket;
    history.dispatch('click');
    const second = f.mounted.socket;
    assert.notEqual(second, first);
    assert.match(second.url || '', /history=full/);
    assert.equal(history.hidden, true);
    f.terminal.keyHandler({ type: 'keydown', metaKey: true, ctrlKey: false, key: 'Enter', preventDefault() {} });
    assert.equal(second.sent.length, 0, 'input waits for the full snapshot parser');
    second.onopen();
    second.onmessage({ data: JSON.stringify({ t: 'attached', pane: { id: 'pane', primary: 'viewer', cols: 80, rows: 50 } }) });
    second.onmessage({ data: JSON.stringify({ t: 'replay-end' }) });
    await f.drain();
    assert.ok(second.sent.some((item) => item instanceof Uint8Array));
  } finally { f.mounted.dispose(); }
});

test('a disconnected replay callback cannot resize or flush queued input', async () => {
  const f = fixture();
  try {
    f.message({ t: 'replay-end' });
    f.socket.close();
    await f.drain();
    assert.equal(f.fits, 0);
    assert.equal(f.socket.sent.length, 0);
  } finally { f.mounted.dispose(); }
});

test('a hidden primary cannot resize even while its DOM still has positive dimensions', async () => {
  const f = fixture();
  try {
    f.mounted.hide();
    f.message({ t: 'replay-end' });
    await f.drain();
    f.mounted.fit();
    assert.equal(f.fits, 0);
    assert.equal(f.socket.sent.length, 0);
    f.mounted.show(); f.mounted.fit();
    assert.equal(f.fits, 1, 'show explicitly restores layout ownership');
  } finally { f.mounted.dispose(); }
});

test('obsolete socket output and exit callbacks cannot affect the current terminal', () => {
  const f = fixture();
  try {
    f.socket.close(); f.socket.onclose();
    for (const [id, fn] of [...f.timers]) { f.timers.delete(id); fn(); }
    assert.notEqual(f.mounted.socket, f.socket);
    let writes = 0;
    const original = f.terminal.write.bind(f.terminal);
    f.terminal.write = (...args) => { writes++; return original(...args); };
    f.socket.onmessage({ data: new TextEncoder().encode('obsolete output').buffer });
    f.message({ t: 'exit', code: 0 });
    f.socket.onclose();
    assert.equal(writes, 0);
    assert.equal(f.timers.size, 0);
    f.mounted.dispose();
    f.mounted.socket.onmessage({ data: new TextEncoder().encode('disposed output').buffer });
    assert.equal(writes, 0);
  } finally { f.mounted.dispose(); }
});

test('hidden observers adopt remote dimensions before parsing cursor-addressed output', async () => {
  const f = fixture();
  try {
    f.message({ t: 'pane', pane: { id: 'pane', primary: 'other', cols: 80, rows: 30 } });
    f.message({ t: 'replay-end' });
    await f.drain();
    f.mounted.hide();
    f.message({ t: 'pane', pane: { id: 'pane', primary: 'other', cols: 100, rows: 60 } });
    f.socket.onmessage({ data: new TextEncoder().encode('\x1b[60;1Hbottom prompt').buffer });
    await f.drain();
    assert.equal(f.terminal.rows, 60);
    assert.equal(f.terminal.buffer.active.getLine(59).translateToString(true), 'bottom prompt');
    assert.equal(f.fits, 0);
    assert.equal(f.socket.sent.length, 0, 'remote buffer synchronization sends no PTY resize');
  } finally { f.mounted.dispose(); }
});

test('observers also retain snapshot dimensions until parsing completes', async () => {
  const f = fixture();
  try {
    f.message({ t: 'pane', pane: { id: 'pane', primary: 'other', cols: 80, rows: 30 } });
    assert.equal(f.terminal.rows, 50);
    f.message({ t: 'replay-end' });
    await f.drain();
    assert.equal(f.terminal.rows, 30);
    assert.equal(f.fits, 0);
    assert.equal(f.terminal.options.fontSize, 5.25, 'xterm cell metrics shrink to fit above the status bar');
    assert.equal(f.terminal.element.style.transform, undefined, 'CSS must not distort pointer coordinates');
    f.message({ t: 'pane', pane: { id: 'pane', primary: 'viewer', cols: 80, rows: 30 } });
    assert.equal(f.terminal.options.fontSize, 12.5, 'taking control restores normal-sized rendering');
  } finally { f.mounted.dispose(); }
});

test('observer fitting remeasures changed cell metrics with unchanged geometry', async () => {
  const f = fixture();
  try {
    f.message({ t: 'pane', pane: { id: 'pane', primary: 'other', cols: 80, rows: 30 } });
    f.message({ t: 'replay-end' });
    await f.drain();
    const before = f.terminal.options.fontSize;
    const screen = f.terminal.element.querySelector('.xterm-screen');
    Object.defineProperty(screen, 'offsetWidth', { get: () => 80 * f.terminal.options.fontSize });
    f.mounted.fit();
    assert.ok(f.terminal.options.fontSize < before);
    assert.ok(screen.offsetWidth <= 284, 'changed renderer metrics still fit the padded host');
    assert.equal(f.socket.sent.length, 0, 'observer does not resize the live PTY');
  } finally { f.mounted.dispose(); }
});

test('exit during replay still fits the retained pane without reviving its status', async () => {
  for (const close of [false, true]) {
    const f = fixture();
    try {
      f.message({ t: 'replay-end' });
      f.message({ t: 'exit', code: 0 });
      if (close) f.socket.close();
      await f.drain();
      assert.equal(f.terminal.rows, 30);
      assert.equal(f.mounted.element.querySelector('.term-state').textContent, 'exited (code 0)');
      assert.equal(f.socket.sent.length, 0);
      f.mounted.fit();
      assert.equal(f.fits, 2, 'retained exited panes can still be fitted');
    } finally { f.mounted.dispose(); }
  }
});

test('observer fitting converges with rounded cell heights and grows only after a layout change', async () => {
  const f = fixture();
  try {
    const host = f.mounted.element.querySelector('.xterm-host');
    host.clientWidth = 5000;
    host.clientHeight = 628;
    const screen = f.terminal.element.querySelector('.xterm-screen');
    Object.defineProperty(screen, 'offsetHeight', { get: () => Math.ceil(f.terminal.options.fontSize * 1.2 * 2) / 2 * 60 });
    f.message({ t: 'pane', pane: { id: 'pane', primary: 'other', cols: 80, rows: 60 } });
    f.message({ t: 'replay-end' });
    await f.drain();
    const settleTimers = () => {
      for (let i = 0; i < 20 && f.timers.size; i++) {
        const pending = [...f.timers.values()];
        f.timers.clear();
        for (const fn of pending) fn();
      }
      assert.equal(f.timers.size, 0, 'font fitting must settle rather than oscillate');
    };
    assert.equal(f.terminal.options.fontSize, 8.25, 'font fits before deferred timers run');
    settleTimers();
    assert.equal(f.terminal.options.fontSize, 8.25);
    assert.ok(screen.offsetHeight <= host.clientHeight - 8);
    host.clientHeight = 908;
    f.mounted.fit();
    settleTimers();
    assert.ok(f.terminal.options.fontSize > 8.25);
    assert.equal(f.socket.sent.length, 0, 'observer sizing never resizes the live process');
  } finally { f.mounted.dispose(); }
});
