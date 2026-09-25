'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { routes, matchRoute, routeDenial } = require('./serve/routes.js');
const { listArtifacts, ARTIFACT_CSP } = require('./card-artifacts.js');

function tempDir(t, prefix = 'keep-card-artifacts-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function registry(t) {
  const root = tempDir(t);
  const dir = path.join(root, '.keep', 'artifacts', 'some-card');
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, content, at) => {
    fs.writeFileSync(path.join(dir, name), content);
    fs.utimesSync(path.join(dir, name), at, at);
  };
  write('shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), new Date('2026-09-20T10:00:00Z'));
  write('diagram.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', new Date('2026-09-21T10:00:00Z'));
  write('notes.txt', 'plain notes', new Date('2026-09-19T10:00:00Z'));
  write('page.html', '<script>alert(1)</script>', new Date('2026-09-18T10:00:00Z'));
  write('dump.bin', Buffer.from([0, 1, 2]), new Date('2026-09-17T10:00:00Z'));
  fs.mkdirSync(path.join(dir, 'nested'));
  return { root, dir };
}

// A response stand-in that records its head and collects what is piped into it.
function response() {
  const res = new PassThrough();
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.done = new Promise((resolve) => res.on('end', () => resolve(Buffer.concat(chunks))));
  return res;
}

function ladder(root) {
  return routes({ keep: { ROOT: root }, json: (res, status, value) => ({ status, value }) });
}

async function get(list, pathname, headers = { 'x-keep': '1' }) {
  const url = new URL(`http://x${pathname}`);
  const req = { method: 'GET', headers };
  const route = matchRoute(list, { req, url });
  assert.ok(route, `GET ${url.pathname} matched no route`);
  const res = response();
  const answer = await route.handle({ req, res, url });
  if (answer) return { route, status: answer.status, value: answer.value };
  return { route, status: res.status, headers: res.headers, body: await res.done };
}

test('the artifact routes answer the console\'s own callers only, with the x-keep header', async (t) => {
  const { root } = registry(t);
  const list = ladder(root);
  for (const pathname of ['/api/card-artifacts?card=some-card', '/api/card-artifact?card=some-card&name=shot.png']) {
    const { route } = await get(list, pathname);
    for (const principal of [{ class: 'proxy' }, { class: 'local' }, { class: 'admin' }]) assert.equal(routeDenial(route, principal), null);
    assert.deepEqual(routeDenial(route, { class: 'node', node: 'aws1' }), { status: 403, error: 'forbidden for node' });
    assert.deepEqual(routeDenial(route, null), { status: 403, error: 'forbidden for unauthorized' });
    const bare = await get(list, pathname, {});
    assert.equal(bare.status, 403);
    assert.equal(bare.value.error, 'missing x-keep header');
  }
});

test('a card\'s artifacts are listed newest first, with their size, time and kind', async (t) => {
  const { root } = registry(t);
  const answer = await get(ladder(root), '/api/card-artifacts?card=some-card');
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.value, {
    card: 'some-card',
    artifacts: [
      { name: 'diagram.svg', size: 71, mtime: '2026-09-21T10:00:00.000Z', image: true, contentType: 'image/svg+xml' },
      { name: 'shot.png', size: 4, mtime: '2026-09-20T10:00:00.000Z', image: true, contentType: 'image/png' },
      { name: 'notes.txt', size: 11, mtime: '2026-09-19T10:00:00.000Z', image: false, contentType: 'text/plain; charset=utf-8' },
      { name: 'page.html', size: 25, mtime: '2026-09-18T10:00:00.000Z', image: false, contentType: 'text/html; charset=utf-8' },
      { name: 'dump.bin', size: 3, mtime: '2026-09-17T10:00:00.000Z', image: false, contentType: 'application/octet-stream' },
    ],
  }, 'the nested directory is not an artifact');
  assert.deepEqual(await listArtifacts(root, 'no-artifacts-yet'), { card: 'no-artifacts-yet', artifacts: [] });
  const bad = await get(ladder(root), '/api/card-artifacts?card=../tasks');
  assert.equal(bad.status, 400);
});

test('an image is served inline with its type, anything else as an attachment, and every file sandboxed', async (t) => {
  const { root } = registry(t);
  const list = ladder(root);
  const png = await get(list, '/api/card-artifact?card=some-card&name=shot.png');
  assert.equal(png.status, 200);
  assert.equal(png.headers['content-type'], 'image/png');
  assert.equal(png.headers['content-length'], 4);
  assert.match(png.headers['content-disposition'], /^inline; filename="shot\.png"/);
  assert.equal(png.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual([...png.body], [0x89, 0x50, 0x4e, 0x47]);

  // An SVG may carry a script: it is an image, but under a policy that runs nothing.
  const svg = await get(list, '/api/card-artifact?card=some-card&name=diagram.svg');
  assert.equal(svg.headers['content-type'], 'image/svg+xml');
  assert.equal(svg.headers['content-security-policy'], ARTIFACT_CSP);
  assert.match(ARTIFACT_CSP, /default-src 'none'/);
  assert.match(ARTIFACT_CSP, /\bsandbox\b/);

  const html = await get(list, '/api/card-artifact?card=some-card&name=page.html');
  assert.equal(html.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(html.headers['content-disposition'], /^attachment; filename="page\.html"/);
  assert.equal(html.headers['content-security-policy'], ARTIFACT_CSP);
  const bin = await get(list, '/api/card-artifact?card=some-card&name=dump.bin');
  assert.equal(bin.headers['content-type'], 'application/octet-stream');
  assert.match(bin.headers['content-disposition'], /^attachment/);
});

test('nothing outside the card\'s artifacts directory is served', async (t) => {
  const { root, dir } = registry(t);
  const list = ladder(root);
  fs.mkdirSync(path.join(root, 'tasks'));
  fs.writeFileSync(path.join(root, 'tasks', 'some-card.md'), 'the card itself');
  const outside = tempDir(t, 'keep-card-artifacts-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
  const cases = [
    ['/api/card-artifact?card=some-card&name=../../../tasks/some-card.md', 400],
    ['/api/card-artifact?card=some-card&name=..%2F..%2F..%2Ftasks%2Fsome-card.md', 400],
    ['/api/card-artifact?card=..&name=tasks', 400],
    ['/api/card-artifact?card=some-card&name=..', 400],
    ['/api/card-artifact?card=some-card', 400],
    ['/api/card-artifact?card=some-card&name=link.txt', 404],
    ['/api/card-artifact?card=some-card&name=nested', 404],
    ['/api/card-artifact?card=some-card&name=missing.png', 404],
    ['/api/card-artifact?card=other-card&name=shot.png', 404],
  ];
  for (const [pathname, status] of cases) {
    const answer = await get(list, pathname);
    assert.equal(answer.status, status, pathname);
    assert.equal(answer.body, undefined, `${pathname} sent no bytes`);
  }
});
