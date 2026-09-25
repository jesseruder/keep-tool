// A card's artifacts in the console: the files `keep artifact` stored under
// .keep/artifacts/<card>/, from this machine or from a node (bin/artifact-route.js).
// Images show as thumbnails that open full size in a new tab; any other file is a
// link that downloads it.
//
// The bytes are fetched with the x-keep header (api.fetchCardArtifact) and shown
// from blob URLs, never by pointing an <img> or a link at the daemon route: a
// browser session's cookie does not reach it without the header. A blob URL is
// same-origin with the console, so a full-size image opens inside a small page whose
// own policy allows nothing but that image: an SVG with a script in it renders as a
// picture and runs nothing. A file that is not an image is only ever downloaded.
//
// The listing is fetched once per card version (the card's _detailVersion changes
// when `keep artifact` logs to it), and an older daemon without the route leaves the
// section out rather than showing an error.
import { fetchCardArtifact, getCardArtifacts } from './api.js';

const OPEN_KEY = 'keep.console.artifacts.open';
// Thumbnails fetched per card; the rest are listed by name.
export const THUMB_LIMIT = 24;
const lists = new Map();
const blobs = new Map();
let stageOpen = null;
let installed = false;

const defaultEsc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function humanSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

const blobKey = (card, item) => `${card}\n${item.name}\n${item.mtime}`;

function stageExpanded() {
  if (stageOpen === null) {
    stageOpen = false;
    try { stageOpen = localStorage.getItem(OPEN_KEY) === '1'; } catch {}
  }
  return stageOpen;
}

function setStageExpanded(value) {
  stageOpen = Boolean(value);
  try { localStorage.setItem(OPEN_KEY, stageOpen ? '1' : '0'); } catch {}
}

// The section, from what has been fetched so far. Pure, so a test can render it.
// `list` is { status, value, error } for the card's listing; `blobOf(item)` is the
// blob URL of an image's bytes once fetched, or null.
export function artifactsSectionHTML({ card, list, blobOf = () => null, esc = defaultEsc, rel = (at) => at, collapsible = false, expanded = true }) {
  if (!list || list.status === 'idle') return '';
  if (list.status === 'error') {
    // An older daemon has no such route: nothing to show, not a failure.
    if (list.errorStatus === 404) return '';
    return `<section class="card-artifacts"><p class="muted" role="alert">Could not list artifacts: ${esc(list.error)}</p></section>`;
  }
  const artifacts = list.value?.artifacts || [];
  if (!artifacts.length) return '';
  const count = list.value.truncated || artifacts.length;
  const heading = collapsible
    ? `<button type="button" class="artifacts-toggle" data-artifacts-toggle aria-expanded="${expanded}">${expanded ? '▾' : '▸'} Artifacts · ${esc(count)}</button>`
    : `<h4 class="artifacts-heading">Artifacts · ${esc(count)}</h4>`;
  if (!expanded) return `<section class="card-artifacts collapsed">${heading}</section>`;
  const attrs = (item) => `data-card="${esc(card)}" data-name="${esc(item.name)}"`;
  const caption = (item, named = true) => `<figcaption>${named ? `<span class="artifact-name">${esc(item.name)}</span>` : ''}`
    + `<span class="artifact-meta">${esc(humanSize(item.size))} · <time datetime="${esc(item.mtime)}">${esc(rel(item.mtime))}</time></span></figcaption>`;
  const rows = artifacts.map((item, index) => {
    if (item.image && index < THUMB_LIMIT) {
      const url = blobOf(item);
      const picture = url
        ? `<img src="${esc(url)}" alt="${esc(item.name)}">`
        : '<span class="artifact-placeholder" role="status">Loading…</span>';
      return `<figure class="artifact image"><button type="button" class="artifact-thumb" data-artifact-open ${attrs(item)} title="Open ${esc(item.name)} full size"${url ? '' : ' disabled'}>${picture}</button>${caption(item)}</figure>`;
    }
    return `<figure class="artifact file"><button type="button" class="artifact-link" data-artifact-download ${attrs(item)} title="Download ${esc(item.name)}">${esc(item.name)}</button>${caption(item, false)}</figure>`;
  }).join('');
  const more = list.value.truncated ? `<p class="muted">Showing the newest ${esc(artifacts.length)} of ${esc(list.value.truncated)}.</p>` : '';
  return `<section class="card-artifacts">${heading}<div class="artifact-grid">${rows}</div>${more}</section>`;
}

function ensureList(ctx, card, version) {
  const current = lists.get(card);
  if (current && current.version === version) return current;
  const entry = { version, status: 'loading', value: current?.value || null, error: '' };
  // Until the new listing arrives the old one stays on screen.
  if (entry.value) entry.status = 'ready';
  lists.set(card, entry);
  getCardArtifacts(card).then((value) => {
    if (lists.get(card) !== entry) return;
    entry.status = 'ready';
    entry.value = value;
    const keep = new Set((value?.artifacts || []).map((item) => blobKey(card, item)));
    for (const [key, blob] of blobs) {
      if (key.startsWith(`${card}\n`) && !keep.has(key)) {
        if (blob.url) URL.revokeObjectURL(blob.url);
        blobs.delete(key);
      }
    }
    ctx.refresh();
  }, (error) => {
    if (lists.get(card) !== entry) return;
    entry.status = 'error';
    entry.error = error?.message || 'request failed';
    entry.errorStatus = error?.status;
    ctx.refresh();
  });
  return entry;
}

function ensureBlob(ctx, card, item) {
  const key = blobKey(card, item);
  const current = blobs.get(key);
  if (current) return current.url || null;
  const entry = { status: 'loading', url: null };
  blobs.set(key, entry);
  fetchCardArtifact(card, item.name).then((blob) => {
    if (blobs.get(key) !== entry) return;
    // Typed by the listing, which the daemon decides, not by the bytes.
    entry.url = URL.createObjectURL(new Blob([blob], { type: item.contentType || blob.type }));
    entry.status = 'ready';
    ctx.refresh();
  }, () => {
    // Left as a placeholder; a new listing (another version) tries again.
    entry.status = 'error';
  });
  return null;
}

function viewerPage(url, name) {
  return '<!doctype html><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src 'unsafe-inline'">`
    + `<title>${defaultEsc(name)}</title>`
    + '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111}img{max-width:100%;height:auto}</style>'
    + `<img src="${defaultEsc(url)}" alt="${defaultEsc(name)}">`;
}

function install(ctx) {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('click', async (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-artifact-open], [data-artifact-download], [data-artifacts-toggle]') : null;
    if (!target) return;
    if (target.hasAttribute('data-artifacts-toggle')) {
      setStageExpanded(!stageExpanded());
      ctx.refresh();
      return;
    }
    const { card, name } = target.dataset;
    const item = lists.get(card)?.value?.artifacts?.find((entry) => entry.name === name);
    if (!item) return;
    if (target.hasAttribute('data-artifact-open')) {
      const url = blobs.get(blobKey(card, item))?.url;
      if (!url) return;
      // Opened in the click itself, so a popup blocker sees a user gesture.
      const page = URL.createObjectURL(new Blob([viewerPage(url, name)], { type: 'text/html' }));
      window.open(page, '_blank');
      setTimeout(() => URL.revokeObjectURL(page), 60e3);
      return;
    }
    try {
      const blob = await fetchCardArtifact(card, name);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60e3);
    } catch (error) {
      ctx.toast?.(`Could not download ${name}: ${error.message}`);
    }
  });
}

// The section for `task`, fetching what it needs. `collapsible` is the stage's form:
// one line until opened, remembered per viewer, so a card with artifacts does not
// take the terminal's height unasked.
export function cardArtifactsHTML(ctx, task, { collapsible = false } = {}) {
  if (!task?.id || typeof ctx?.refresh !== 'function') return '';
  install(ctx);
  const card = task.id;
  const list = ensureList(ctx, card, task._detailVersion || task.fm?.updated || '');
  const expanded = !collapsible || stageExpanded();
  const blobOf = (item) => (expanded ? ensureBlob(ctx, card, item) : null);
  return artifactsSectionHTML({
    card, list, blobOf, esc: ctx.esc || defaultEsc, rel: ctx.rel ? (at) => ctx.rel(Date.parse(at)) : undefined,
    collapsible, expanded,
  });
}
