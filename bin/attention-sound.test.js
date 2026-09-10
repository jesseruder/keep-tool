'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('waiting sound does not replay an existing event after an empty snapshot', async () => {
  let sounds = 0, click;
  const saved = Object.fromEntries(['window', 'document', 'localStorage'].map((key) => [key, globalThis[key]]));
  globalThis.window = { __TAURI__: { core: { invoke: async () => { sounds++; } } } };
  globalThis.document = { documentElement: { classList: { toggle() {} } }, querySelector: () => ({ setAttribute() {}, classList: { toggle() {} }, addEventListener(_, fn) { click = fn; } }) };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  try {
    const { installAttentionSound } = await import('../web/app/attention-sound.js');
    const sound = installAttentionSound();
    sound.update(['boot:1']);
    sound.update([]);
    sound.update(['boot:1']);
    assert.equal(sounds, 0, 'startup events remain silent when restored');
    sound.update([]);
    sound.update(['a:1']);
    assert.equal(sounds, 1);
    for (let i = 0; i < 10; i++) { sound.update([]); sound.update(['a:1']); }
    assert.equal(sounds, 1, 'repeated empty/nonempty snapshots cannot replay a request');
    sound.update(['a:1', 'b:1']);
    sound.update([]);
    sound.update(['b:1']);
    assert.equal(sounds, 1, 'events first seen in a populated queue are also remembered');
    sound.update([]);
    sound.update(['a:2']);
    assert.equal(sounds, 2, 'a new request from the same session can sound');
    click();
    sound.update([]);
    sound.update(['a:3']);
    click();
    sound.update([]);
    sound.update(['a:3']);
    assert.equal(sounds, 2, 'unmuting does not replay a muted event');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
