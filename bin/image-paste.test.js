const test = require('node:test');
const assert = require('node:assert/strict');
const handlerModule = import('../web/app/image-paste.js');
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(options = {}) {
  const { createImagePasteHandler } = await handlerModule;
  const state = { desktop: true, agent: 'codex', active: true, ready: true, ...options };
  const calls = { pasted: 0, checks: 0, reports: [], prevented: 0, stopped: 0 };
  const handler = createImagePasteHandler({
    isDesktop: () => state.desktop, agent: () => state.agent, active: () => state.active, ready: () => state.ready,
    hasClipboardImage: () => { calls.checks++; return state.check ? state.check() : Promise.resolve(true); },
    pasteImage: () => calls.pasted++, report: (text) => calls.reports.push(text),
  });
  const paste = ({ text = '', image = false, types = [] } = {}) => handler({
    clipboardData: { items: image ? [{ kind: 'file', type: 'image/png' }] : [], types, getData: () => text },
    preventDefault() { calls.prevented++; }, stopImmediatePropagation() { calls.stopped++; },
  });
  return { state, calls, paste };
}

test('desktop image paste routes once for Codex and Claude, including mixed clipboard data', async () => {
  for (const agent of ['codex', 'claude']) {
    const f = await fixture({ agent }); f.paste({ image: true, text: 'image caption' });
    assert.equal(f.calls.pasted, 1); assert.equal(f.calls.prevented, 1); assert.equal(f.calls.stopped, 1); assert.equal(f.calls.checks, 0);
  }
});

test('ordinary multiline text paste stays entirely with xterm', async () => {
  const f = await fixture(); f.paste({ text: 'one\ntwo\n' });
  assert.equal(f.calls.pasted, 0); assert.equal(f.calls.prevented, 0); assert.equal(f.calls.checks, 0);
});

test('browser viewers, shells, and unfocused panes do not trigger host clipboard paste', async () => {
  for (const options of [{ desktop: false }, { agent: 'shell' }, { agent: undefined }, { active: false }]) {
    const f = await fixture(options); f.paste({ image: true });
    assert.equal(f.calls.pasted, 0); assert.equal(f.calls.prevented, 0); assert.equal(f.calls.checks, 0);
  }
});

test('hidden WebKit image formats use native detection and coalesce pending pastes', async () => {
  let resolve; const f = await fixture({ check: () => new Promise((r) => { resolve = r; }) });
  f.paste(); f.paste(); await settle();
  assert.equal(f.calls.checks, 1); resolve(true); await settle();
  assert.equal(f.calls.pasted, 1);
});

test('async clipboard check cannot target a pane after focus/visibility/disposal changes', async () => {
  let resolve; const f = await fixture({ check: () => new Promise((r) => { resolve = r; }) });
  f.paste(); await settle(); f.state.active = false; resolve(true); await settle();
  assert.equal(f.calls.pasted, 0);
});

test('disconnected paste reports retry instead of queueing a stale clipboard shortcut', async () => {
  const f = await fixture({ ready: false }); f.paste({ image: true });
  assert.equal(f.calls.pasted, 0); assert.match(f.calls.reports[0], /Reconnect/);
});

test('empty/non-image clipboard sends nothing and old desktop builds show a fallback', async () => {
  const empty = await fixture({ check: async () => false }); empty.paste(); await settle();
  assert.equal(empty.calls.pasted, 0); assert.equal(empty.calls.reports.length, 0);
  const old = await fixture({ check: async () => { throw new Error('command missing'); } }); old.paste(); await settle();
  assert.equal(old.calls.pasted, 0); assert.match(old.calls.reports[0], /Control\+V/);
});


test('delayed clipboard reply cannot send the shortcut after agent exits into a shell', async () => {
  let resolve; const f = await fixture({ check: () => new Promise((r) => { resolve = r; }) });
  f.paste(); await settle(); f.state.agent = 'shell'; resolve(true); await settle();
  assert.equal(f.calls.pasted, 0);
});
