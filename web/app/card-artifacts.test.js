import test from 'node:test';
import assert from 'node:assert/strict';

// card-artifacts.js imports api.js, which reads `location` inside its request
// helpers; nothing here calls one, but the import must not throw.
globalThis.location = new URL('http://localhost:7777/app/');

const listing = (artifacts, extra = {}) => ({ status: 'ready', value: { card: 'some-card', artifacts, ...extra }, error: '' });
const shot = { name: 'shot.png', size: 2048, mtime: '2026-09-20T10:00:00.000Z', image: true, contentType: 'image/png' };
const svg = { name: 'x"><script>.svg', size: 10, mtime: '2026-09-20T09:00:00.000Z', image: true, contentType: 'image/svg+xml' };
const log = { name: 'run.log', size: 3 * 1024 * 1024, mtime: '2026-09-19T10:00:00.000Z', image: false, contentType: 'text/plain; charset=utf-8' };

test('images render as thumbnails from their blob URLs, other files as download links', async () => {
  const { artifactsSectionHTML } = await import('./card-artifacts.js');
  const html = artifactsSectionHTML({
    card: 'some-card', list: listing([shot, log]),
    blobOf: (item) => (item.name === 'shot.png' ? 'blob:http://localhost:7777/1234' : null),
    rel: () => '2h ago',
  });
  assert.match(html, /<h4 class="artifacts-heading">Artifacts · 2<\/h4>/);
  assert.match(html, /<button type="button" class="artifact-thumb" data-artifact-open data-card="some-card" data-name="shot\.png" title="Open shot\.png full size"><img src="blob:http:\/\/localhost:7777\/1234" alt="shot\.png"><\/button>/);
  assert.match(html, /2\.0 KB · <time datetime="2026-09-20T10:00:00.000Z">2h ago<\/time>/);
  // An image has its own Download button next to its thumbnail.
  assert.match(html, /<button type="button" class="artifact-save" data-artifact-download data-card="some-card" data-name="shot\.png" title="Download shot\.png" aria-label="Download shot\.png">Download<\/button>/);
  assert.match(html, /<button type="button" class="artifact-link" data-artifact-download data-card="some-card" data-name="run\.log" title="Download run\.log">run\.log<\/button>/);
  assert.match(html, /3\.0 MB/);
  // Never a link to the daemon route itself: the bytes come only through fetch.
  assert.doesNotMatch(html, /\/api\/card-artifact/);
});

test('an image still loading is a disabled placeholder, and every name is escaped', async () => {
  const { artifactsSectionHTML } = await import('./card-artifacts.js');
  const html = artifactsSectionHTML({ card: 'some-card', list: listing([svg]) });
  assert.match(html, /disabled><span class="artifact-placeholder" role="status">Loading…<\/span>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /data-name="x&quot;&gt;&lt;script&gt;\.svg"/);
});

test('the stage form is one line until opened, and nothing shows for a card without artifacts', async () => {
  const { artifactsSectionHTML } = await import('./card-artifacts.js');
  const closed = artifactsSectionHTML({ card: 'some-card', list: listing([shot, log]), collapsible: true, expanded: false });
  assert.equal(closed, '<section class="card-artifacts collapsed"><button type="button" class="artifacts-toggle" data-artifacts-toggle aria-expanded="false">▸ Artifacts · 2</button></section>');
  const opened = artifactsSectionHTML({ card: 'some-card', list: listing([shot]), collapsible: true, expanded: true });
  assert.match(opened, /aria-expanded="true">▾ Artifacts · 1<\/button><div class="artifact-body"><div class="artifact-grid">/);
  assert.equal(artifactsSectionHTML({ card: 'some-card', list: listing([]) }), '');
  assert.equal(artifactsSectionHTML({ card: 'some-card', list: { status: 'loading', value: null } }), '');
  // An older daemon without the route answers 404: the section is left out.
  assert.equal(artifactsSectionHTML({ card: 'some-card', list: { status: 'error', error: 'not found', errorStatus: 404 } }), '');
  assert.match(artifactsSectionHTML({ card: 'some-card', list: { status: 'error', error: 'boom', errorStatus: 500 } }), /Could not list artifacts: boom/);
});

test('only the first thumbnails are fetched; the rest are listed by name, and a long listing says so', async () => {
  const { artifactsSectionHTML, THUMB_LIMIT } = await import('./card-artifacts.js');
  const many = Array.from({ length: THUMB_LIMIT + 2 }, (_, i) => ({ ...shot, name: `shot-${i}.png` }));
  const asked = [];
  const html = artifactsSectionHTML({
    card: 'some-card', list: listing(many, { truncated: 250 }), blobOf: (item) => { asked.push(item.name); return null; },
  });
  assert.equal(asked.length, THUMB_LIMIT);
  assert.match(html, new RegExp(`data-artifact-download data-card="some-card" data-name="shot-${THUMB_LIMIT}\\.png"`));
  assert.match(html, /Artifacts · 250/);
  assert.match(html, /Showing the newest 26 of 250\./);
});
