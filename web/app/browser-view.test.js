import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = new URL('http://localhost:7777/app/');

const { browserViewFor, modifierBits, pagePoint, keyInput, parseFrame } = await import('./browser-view.js');

const key = (extra) => ({ key: 'a', code: 'KeyA', keyCode: 65, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });

test('a view shows on the session that asked, until closed here', () => {
  const data = { browserViews: [{ id: 'x', sessionId: 's1', createdAt: 5 }] };
  assert.equal(browserViewFor(data, 's1').id, 'x');
  assert.equal(browserViewFor(data, 's2'), null);
  assert.equal(browserViewFor(data, 's1', new Set(['x:5'])), null);
  assert.equal(browserViewFor({}, 's1'), null);
});

test('modifiers become CDP bits', () => {
  assert.equal(modifierBits(key({ altKey: true, shiftKey: true })), 9);
  assert.equal(modifierBits(key({ ctrlKey: true, metaKey: true })), 6);
});

test('a point on the letterboxed picture maps to the page and is clamped to it', () => {
  const rect = { left: 100, top: 50, width: 400, height: 300 };
  assert.deepEqual(pagePoint(rect, 300, 200, 800, 600), { x: 400, y: 300 });
  assert.deepEqual(pagePoint(rect, 0, 1000, 800, 600), { x: 0, y: 600 });
});

test('printable keys carry text; chords and named keys do not, except Enter and Tab', () => {
  assert.deepEqual(keyInput(key(), 'keyDown'), { kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0, text: 'a' });
  assert.equal(keyInput(key({ metaKey: true }), 'keyDown').type, 'rawKeyDown');
  assert.equal(keyInput(key({ metaKey: true }), 'keyDown').text, undefined);
  assert.equal(keyInput(key({ key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }), 'keyDown').type, 'rawKeyDown');
  assert.equal(keyInput(key({ key: 'Enter', code: 'Enter', keyCode: 13 }), 'keyDown').text, '\r');
  assert.deepEqual(keyInput(key(), 'keyUp'), { kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0 });
});

test('a binary frame splits into its header and image', () => {
  const header = new TextEncoder().encode(JSON.stringify({ seq: 2, tabId: 9, metadata: { deviceWidth: 10 } }));
  const bytes = new Uint8Array(4 + header.length + 3);
  new DataView(bytes.buffer).setUint32(0, header.length);
  bytes.set(header, 4);
  bytes.set([1, 2, 3], 4 + header.length);
  const { header: parsed, image } = parseFrame(bytes.buffer);
  assert.deepEqual(parsed, { seq: 2, tabId: 9, metadata: { deviceWidth: 10 } });
  assert.deepEqual([...image], [1, 2, 3]);
});
