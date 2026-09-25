import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = new URL('http://localhost:7777/app/');

const { secretRequestFor, valueShape, secretDropHTML } = await import('./secret-drop.js');

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const request = (extra = {}) => ({
  id: 'a1b2c3d4', name: 'GITHUB_TOKEN', purpose: 'release <script>', sessionId: 's1', node: 'aws1',
  path: '/Users/j/castle/app/.env', key: 'GITHUB_TOKEN', replace: false, multiline: false,
  status: 'pending', createdAt: 2, ...extra,
});

test('only the focused session\'s pending requests show, oldest first', () => {
  const data = { secretRequests: [
    request({ id: 'b', createdAt: 5 }), request({ id: 'a', createdAt: 1 }),
    request({ id: 'c', sessionId: 's2' }), request({ id: 'd', status: 'delivered' }),
  ] };
  assert.deepEqual(secretRequestFor(data, 's1'), { request: data.secretRequests[1], more: 1 });
  assert.equal(secretRequestFor(data, 's3'), null);
  assert.equal(secretRequestFor(data, undefined), null);
  assert.equal(secretRequestFor({}, 's1'), null);
  assert.deepEqual(secretRequestFor(data, 's1', new Set([data.secretRequests[1].id])).more, 0, 'an answered request is skipped');
});

test('the counter says length and lines, never the value', () => {
  assert.equal(valueShape('', false), '');
  assert.equal(valueShape('abc\n', false), '3 chars · one line');
  assert.equal(valueShape('a\nb', false), '3 chars · 2 lines · has line breaks');
  assert.equal(valueShape('a\nb\n', true), '4 chars · 3 lines');
});

test('the panel names the machine, the file and the key, escaped, with a masked field', () => {
  const html = secretDropHTML(esc, request(), { home: '/Users/j', more: 2 });
  assert.match(html, /<code>GITHUB_TOKEN<\/code> <span class="sd-more">3 waiting<\/span>/);
  assert.match(html, /release &lt;script&gt;/);
  assert.match(html, /<span class="sd-node">aws1<\/span> <code class="sd-path" title="\/Users\/j\/castle\/app\/.env">~\/castle\/app\/.env<\/code>/);
  assert.match(html, /<code>GITHUB_TOKEN=…<\/code> <span class="sd-note">new key/);
  assert.match(html, /type="password" autocomplete="off"/);
  assert.match(html, /Save to aws1/);
  const file = secretDropHTML(esc, request({ key: null, multiline: true, replace: true }), {});
  assert.match(file, /<textarea class="sd-value masked"/);
  assert.match(file, /the whole file, replacing it/);
});
