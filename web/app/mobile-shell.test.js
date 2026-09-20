import test from 'node:test';
import assert from 'node:assert/strict';

// The Android WebView shell's side of the bridge, standing in for the app: it
// injects window.keepShell before the page's scripts run and calls
// window.keepShellReceive to talk back.
const posted = [];
const toggled = [];
let reloads = 0;

// A DOM stub the size of what the handoff panel touches: elements addressed by
// the class names in their own innerHTML, and one click.
function element(tag = 'div') {
  const node = {
    tagName: tag,
    className: '',
    dataset: {},
    textContent: '',
    children: [],
    listeners: new Map(),
    addEventListener(type, fn) { node.listeners.set(type, fn); },
    click() { node.listeners.get('click')?.({ type: 'click' }); },
    remove() { node.removed = true; },
    querySelector(selector) {
      const wanted = selector.replace(/^\./, '');
      return node.children.find((child) => child.className.split(/\s+/).includes(wanted)) || null;
    },
  };
  Object.defineProperty(node, 'innerHTML', {
    get: () => node.html || '',
    set(html) {
      node.html = String(html);
      node.children = [...node.html.matchAll(/class="([^"]+)"[^>]*>([^<]*)/g)].map(([, className, text]) => {
        const child = element('div');
        child.className = className;
        child.textContent = text;
        return child;
      });
    },
  });
  return node;
}

globalThis.location = {
  protocol: 'http:', host: '10.0.0.4:7777', origin: 'http://10.0.0.4:7777', reload() { reloads += 1; },
};
globalThis.window = {
  keepShell: { platform: 'android', version: '0.1.0', post: (message) => posted.push(message) },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  addEventListener() {},
};
globalThis.document = {
  documentElement: { classList: { toggle: (name, on) => toggled.push([name, on]) }, dataset: {} },
  createElement: element,
};

const shell = await import('./shell.js');

test('the mobile shell is detected, announced, and given the badge', async () => {
  assert.equal(shell.isMobileShell(), true);
  assert.equal(shell.isDesktop(), false);
  assert.deepEqual(toggled, [['desktop', false], ['mobile', true]]);

  shell.setBadge(3);
  assert.deepEqual(posted.at(-1), { type: 'badge', count: 3 });
  shell.setBadge(3);
  assert.equal(posted.filter((message) => message.type === 'badge').length, 1, 'an unchanged count says nothing');
  shell.setBadge(0);
  assert.deepEqual(posted.at(-1), { type: 'badge', count: 0 });

  shell.shellReady();
  assert.deepEqual(posted.at(-1), { type: 'ready' });
});

test('a client choice in the borrowed rail closes the mobile filter sheet', async () => {
  const { handleMobileFilterChoice } = await import('./mobile.js');
  const client = { dataset: { client: 'codex' } };
  const project = { dataset: { project: '/work/a' } };
  const closed = [];
  const target = (choice) => ({ closest(selector) {
    assert.match(selector, /#rail \[data-client\]/);
    return choice;
  } });
  assert.equal(handleMobileFilterChoice(target(client), () => closed.push('client')), true);
  assert.equal(handleMobileFilterChoice(target(project), () => closed.push('project')), true);
  assert.equal(handleMobileFilterChoice(target(null), () => closed.push('other')), false);
  assert.deepEqual(closed, ['client', 'project']);
});

test('the app owns permissions, notifications and sounds', async () => {
  assert.equal(shell.notificationPermission(), 'granted');
  assert.equal(await shell.requestPermission(), 'granted');
  const before = posted.length;
  await shell.notify({ title: 'Question', body: 'Choose one', tag: 'next-session' });
  assert.deepEqual(posted.at(-1), { type: 'notify', title: 'Question', body: 'Choose one', key: 'next-session' });
  await shell.notify({});
  assert.deepEqual(posted.at(-1), { type: 'notify', title: 'Keep', body: '', key: '' });
  await shell.playAttentionSound();
  await shell.acknowledgeNotificationClick('next-session');
  assert.equal(posted.length, before + 2, 'sounds and acknowledgements are the app\'s own business');
});

test('a notification tap and a shell reload arrive through keepShellReceive', async () => {
  const clicked = [];
  await shell.installNotificationClicks((key) => clicked.push(key));
  assert.equal(typeof window.keepShellReceive, 'function');
  window.keepShellReceive({ type: 'notificationClick', key: 'session-9' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(clicked, ['session-9']);
  window.keepShellReceive({ type: 'notificationClick' });
  window.keepShellReceive({ type: 'nonsense' });
  window.keepShellReceive(null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(clicked, ['session-9']);
  assert.equal(reloads, 0);
  window.keepShellReceive({ type: 'reload' });
  assert.equal(reloads, 1);
});

test('a pane mounts as a handoff panel, not xterm, and its button posts openTerminal', async () => {
  const { mountTerminal } = await import('./terminal.js');
  assert.equal(window.Terminal, undefined, 'xterm is not even loaded here, so a mount attempt would throw');
  const container = { replaceChildren(...nodes) { container.nodes = nodes; } };
  const mounted = mountTerminal(container, 'pane-7', { session: 'session-9', title: 'castle: explore' });

  assert.deepEqual(container.nodes, [mounted.element]);
  assert.equal(mounted.element.querySelector('.xterm-host'), null);
  assert.equal(mounted.element.querySelector('.term-handoff-title').textContent, 'castle: explore');
  assert.equal(mounted.element.querySelector('.term-state').textContent, 'shell');
  assert.equal(mounted.terminal, null);
  assert.equal(mounted.socket, null);

  mounted.element.querySelector('.term-handoff-open').click();
  assert.deepEqual(posted.at(-1), {
    type: 'openTerminal', pane: 'pane-7', session: 'session-9', title: 'castle: explore',
  });

  // app.js drives every mount through these; the panel has to answer all of them.
  for (const name of ['focus', 'fit', 'setTheme', 'setRenderer', 'show', 'hide', 'syncVisibility', 'dispose']) {
    assert.equal(typeof mounted[name], 'function', name);
    mounted[name]({ mode: 'dark' });
  }
  assert.equal(mounted.element.removed, true);

  const untitled = mountTerminal(container, 'pane-8');
  untitled.element.querySelector('.term-handoff-open').click();
  assert.deepEqual(posted.at(-1), { type: 'openTerminal', pane: 'pane-8', session: '', title: 'pane-8' });
});

test('a 403 tells the shell its session is gone, at most once every ten seconds', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 403, headers: { 'content-type': 'application/json' },
  });
  const api = await import('./api.js');
  const before = posted.length;
  await assert.rejects(api.getState(), /unauthorized/);
  assert.deepEqual(posted.at(-1), { type: 'unauthorized' });
  await assert.rejects(api.getState(), /unauthorized/);
  assert.equal(posted.length, before + 1, 'a reload storm is one message, not one per request');
});

// Android's injectedJavaScriptBeforeContentLoaded is best-effort, so the page can
// run first. The shell then defines window.keepShell and says hello.
test('a shell that arrives after the page is picked up by hello', async () => {
  const late = [];
  const keepShell = window.keepShell;
  delete window.keepShell;
  const fresh = await import('./shell.js?late=1');
  assert.equal(fresh.isMobileShell(), false);
  assert.equal(typeof window.keepShellReceive, 'function', 'defined even with no shell in sight');
  toggled.length = 0;

  const clicked = [];
  await fresh.installNotificationClicks((key) => clicked.push(key));
  fresh.setBadge(5);
  fresh.shellReady();
  assert.deepEqual(late, []);

  window.keepShell = { platform: 'android', version: '0.1.0', post: (message) => late.push(message) };
  window.keepShellReceive({ type: 'hello' });
  assert.deepEqual(toggled, [['mobile', true]]);
  assert.deepEqual(late, [{ type: 'ready' }, { type: 'badge', count: 5 }]);

  window.keepShellReceive({ type: 'notificationClick', key: 'session-3' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(clicked, ['session-3'], 'the handler installed before the shell still runs');

  window.keepShell = keepShell;
});
