// A card's artifacts in the console: the files `keep artifact` stored under
// .keep/artifacts/<card>/, from this machine or from a node (bin/artifact-route.js).
// Images show as thumbnails that open full size in an overlay on the console; any
// other file is a link that downloads it.
//
// The bytes are fetched with the x-keep header (api.fetchCardArtifact) and shown
// from blob URLs, never by pointing an <img> or a link at the daemon route: a
// browser session's cookie does not reach it without the header. The full-size view
// is an overlay in the console itself, not a new tab: the desktop shell and the
// phone's WebView both drop window.open. It is still only an <img>, so an SVG with a
// script in it renders as a picture and runs nothing. A file that is not an image is
// only ever downloaded.
//
// The listing is fetched once per card version (the card's _detailVersion changes
// when `keep artifact` logs to it), and an older daemon without the route leaves the
// section out rather than showing an error.
import { fetchCardArtifact, getCardArtifacts } from './api.js';

// Thumbnails fetched per card; the rest are listed by name.
export const THUMB_LIMIT = 24;
const lists = new Map();
const blobs = new Map();
// Whether the stage's panel is open. Not remembered: the open panel floats over the
// reply field and the terminal, so each session starts with it closed.
let stageOpen = false;
let installed = false;

const defaultEsc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function humanSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

const blobKey = (card, item) => `${card}\n${item.name}\n${item.mtime}`;

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
  return `<section class="card-artifacts">${heading}<div class="artifact-body"><div class="artifact-grid">${rows}</div>${more}</div></section>`;
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

// The full-size view: the image over a dimmed console, closed by a click anywhere or
// Escape; ← and → step through the card's other images that have loaded. While it is
// up it takes every key, ahead of the console's own handlers and a focused terminal
// (a bare ESC in a Claude pane is an interrupt), and focus leaves the terminal so
// nothing typed reaches the hidden pane. Closing gives focus back.
let viewer = null;

// The card's images that can be shown, in the listing's order: those with thumbnails
// whose bytes have arrived.
function viewerImages(card) {
  return (lists.get(card)?.value?.artifacts || [])
    .filter((item, index) => item.image && index < THUMB_LIMIT)
    .map((item) => ({ item, url: blobs.get(blobKey(card, item))?.url }))
    .filter((entry) => entry.url);
}

function showInViewer(item, url) {
  const images = viewerImages(viewer.card);
  const index = images.findIndex((entry) => entry.item.name === item.name);
  viewer.name = item.name;
  viewer.image.src = url;
  viewer.image.alt = item.name;
  viewer.overlay.setAttribute('aria-label', item.name);
  viewer.caption.textContent = images.length > 1 ? `${item.name} · ${index + 1} / ${images.length}` : item.name;
}

function stepViewer(delta) {
  const images = viewerImages(viewer.card);
  if (images.length < 2) return;
  const index = images.findIndex((entry) => entry.item.name === viewer.name);
  const next = images[(Math.max(index, 0) + delta + images.length) % images.length];
  showInViewer(next.item, next.url);
}

function openViewer(card, item, url) {
  closeViewer();
  const overlay = document.createElement('div');
  overlay.className = 'artifact-viewer';
  overlay.tabIndex = -1;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const image = document.createElement('img');
  const caption = document.createElement('p');
  caption.className = 'artifact-viewer-caption';
  overlay.append(image, caption);
  viewer = { card, name: item.name, overlay, image, caption, returnFocus: document.activeElement };
  showInViewer(item, url);
  overlay.addEventListener('click', closeViewer);
  window.addEventListener('keydown', viewerKey, true);
  document.body.append(overlay);
  overlay.focus();
}

function viewerKey(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'Escape') closeViewer();
  else if (event.key === 'ArrowLeft') stepViewer(-1);
  else if (event.key === 'ArrowRight') stepViewer(1);
}

function closeViewer() {
  window.removeEventListener('keydown', viewerKey, true);
  if (!viewer) return;
  const { overlay, returnFocus } = viewer;
  viewer = null;
  overlay.remove();
  if (returnFocus?.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
}

function install(ctx) {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  // The open panel closes on a press outside the artifacts row and its full-size view.
  // Not on the phone, where it sits in flow and covers nothing: closing it there would
  // shift the page under the finger that pressed.
  document.addEventListener('pointerdown', (event) => {
    if (!stageOpen || document.documentElement.classList.contains('mobile') || (event.target instanceof Element && event.target.closest('.stage-artifacts, .artifact-viewer'))) return;
    stageOpen = false;
    ctx.refresh();
  }, true);
  document.addEventListener('click', async (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-artifact-open], [data-artifact-download], [data-artifacts-toggle]') : null;
    if (!target) return;
    if (target.hasAttribute('data-artifacts-toggle')) {
      stageOpen = !stageOpen;
      ctx.refresh();
      return;
    }
    const { card, name } = target.dataset;
    const item = lists.get(card)?.value?.artifacts?.find((entry) => entry.name === name);
    if (!item) return;
    if (target.hasAttribute('data-artifact-open')) {
      const url = blobs.get(blobKey(card, item))?.url;
      if (url) openViewer(card, item, url);
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
// one line that opens into a panel over the terminal (in flow on the phone).
export function cardArtifactsHTML(ctx, task, { collapsible = false } = {}) {
  if (!task?.id || typeof ctx?.refresh !== 'function') return '';
  install(ctx);
  const card = task.id;
  const list = ensureList(ctx, card, task._detailVersion || task.fm?.updated || '');
  const expanded = !collapsible || stageOpen;
  const blobOf = (item) => (expanded ? ensureBlob(ctx, card, item) : null);
  return artifactsSectionHTML({
    card, list, blobOf, esc: ctx.esc || defaultEsc, rel: ctx.rel ? (at) => ctx.rel(Date.parse(at)) : undefined,
    collapsible, expanded,
  });
}
