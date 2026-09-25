// Secret Drop: the panel a session's stage shows while that session is waiting on
// Owner for a secret (`keep secret request`, bin/secret-requests.js).
//
// It appears only on the session that asked, above its terminal, and nowhere else:
// no queue row, no notification. The value typed here is sent once to the daemon,
// which writes it to the named file on the named machine, and is never kept: not in
// a draft, not in browser storage, not in a retry closure. The field is dropped with
// the panel when the request is answered or the stage moves on.
import * as api from './api.js';

const KEY_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2.5 2.5"/></svg>';
const FULFILL_TIMEOUT_MS = 45e3;

// The pending request for a session, oldest first when there are several: the
// panel answers one at a time and the next takes its place.
export function secretRequestFor(data, sessionId) {
  if (!sessionId) return null;
  const rows = (data?.secretRequests || []).filter((r) => r && r.status === 'pending' && r.sessionId === sessionId);
  rows.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return rows.length ? { request: rows[0], more: rows.length - 1 } : null;
}

// What the counter under the field says: enough to catch a wrong paste or a stray
// line break, nothing about the value itself.
export function valueShape(value, multiline) {
  const text = multiline ? value : value.replace(/[\r\n]+$/, '');
  if (!text) return '';
  const chars = [...text].length;
  const lines = text.split('\n').length;
  const lineText = lines === 1 ? 'one line' : `${lines} lines`;
  const warn = !multiline && /[\r\n]/.test(text) ? ' · has line breaks' : '';
  return `${chars} char${chars === 1 ? '' : 's'} · ${lineText}${warn}`;
}

function displayPath(path, home) {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

// The count beside the title when a session asked for several at once.
export function waitingText(more) { return more ? `${more + 1} waiting` : ''; }

export function secretDropHTML(esc, request, { home = '', more = 0, saved = '' } = {}) {
  const target = displayPath(request.path, home);
  const as = request.key
    ? `<div class="sd-row"><span class="sd-label">As</span><span><code>${esc(request.key)}=…</code> <span class="sd-note">${request.replace ? 'replaces the current value if there is one' : 'new key'}</span></span></div>`
    : `<div class="sd-row"><span class="sd-label">As</span><span class="sd-note">${request.replace ? 'the whole file, replacing it if it exists' : 'the whole file (new)'}</span></div>`;
  const field = request.multiline
    ? '<textarea class="sd-value masked" name="value" rows="4" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true" aria-label="Secret value"></textarea>'
    : '<input class="sd-value" name="value" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true" aria-label="Secret value">';
  return `<div class="sd-card" role="dialog" aria-label="Secret requested">${saved ? `<div class="sd-saved" role="status">${esc(saved)}</div>` : ''}<div class="sd-head"><span class="sd-icon">${KEY_ICON}</span><div class="sd-titles"><div class="sd-title">Secret requested · <code>${esc(request.name)}</code>${more ? ` <span class="sd-more">${waitingText(more)}</span>` : ''}</div>${request.purpose ? `<div class="sd-purpose">${esc(request.purpose)}</div>` : ''}</div><button type="button" class="btn sd-later" title="Hide this over the terminal; the key button brings it back">Later</button></div>`
    + `<div class="sd-dest"><div class="sd-row"><span class="sd-label">Goes to</span><span><span class="sd-node">${esc(request.node)}</span> <code class="sd-path" title="${esc(request.path)}">${esc(target)}</code></span></div>${as}</div>`
    + `<form class="sd-form" autocomplete="off"><div class="sd-field">${field}<button type="button" class="btn sd-reveal" aria-pressed="false" title="Show the value">Show</button></div>`
    + '<div class="sd-shape mono" aria-live="polite"></div><div class="sd-error" role="alert" hidden></div>'
    + `<div class="sd-actions"><button type="button" class="btn sd-decline">Decline…</button><span class="sd-spacer"></span><button type="submit" class="btn primary sd-save" disabled>Save to ${esc(request.node)}</button></div>`
    + '<div class="sd-declining" hidden><input class="sd-reason" type="text" maxlength="400" autocomplete="off" placeholder="Why (optional, sent to the session)" aria-label="Reason for declining"><button type="button" class="btn sd-decline-confirm">Decline request</button><button type="button" class="btn sd-decline-cancel">Cancel</button></div>'
    + '</form></div>'
    + `<button type="button" class="sd-pill" title="Secret requested: ${esc(request.name)}" aria-label="Show the secret request for ${esc(request.name)}">${KEY_ICON}<span>${esc(request.name)}</span></button>`;
}

// Requests Owner put off with Later, for this page's life only: the card stays
// folded into its key button until he opens it again.
const later = new Set();

// The request just answered on this page, so the next one a session asked for opens
// saying so and takes the cursor: without it the next card looked like the same one
// refusing to close.
let justAnswered = null;

function setFolded(root, folded) {
  root.classList.toggle('folded', folded);
  root.querySelector('.sd-card').hidden = folded;
  root.querySelector('.sd-pill').hidden = !folded;
}

function setBusy(root, busy, label) {
  root.classList.toggle('busy', busy);
  root.querySelectorAll('button, input, textarea').forEach((el) => { el.disabled = busy; });
  const save = root.querySelector('.sd-save');
  if (busy && label) save.textContent = label;
  if (!busy) {
    save.textContent = `Save to ${root.dataset.node}`;
    save.disabled = !root.querySelector('.sd-value').value;
  }
}

function showError(root, message) {
  const box = root.querySelector('.sd-error');
  box.textContent = message || '';
  box.hidden = !message;
}

function install(root, ctx, request) {
  const form = root.querySelector('.sd-form');
  const field = root.querySelector('.sd-value');
  const shape = root.querySelector('.sd-shape');
  const save = root.querySelector('.sd-save');
  const reveal = root.querySelector('.sd-reveal');
  const declining = root.querySelector('.sd-declining');
  const update = () => {
    shape.textContent = valueShape(field.value, request.multiline);
    save.disabled = !field.value || root.classList.contains('busy');
    showError(root, '');
  };
  field.addEventListener('input', update);
  root.querySelector('.sd-later').addEventListener('click', () => {
    later.add(request.id);
    setFolded(root, true);
    // The button just went away with the card: hand the keyboard back to the
    // terminal rather than leave it on nothing.
    root.closest('.stage-body')?.querySelector('.stage-terminal .xterm-helper-textarea')?.focus();
  });
  root.querySelector('.sd-pill').addEventListener('click', () => {
    later.delete(request.id);
    setFolded(root, false);
    field.focus();
  });
  reveal.addEventListener('click', () => {
    const shown = reveal.getAttribute('aria-pressed') !== 'true';
    reveal.setAttribute('aria-pressed', String(shown));
    reveal.textContent = shown ? 'Hide' : 'Show';
    if (field.tagName === 'INPUT') field.type = shown ? 'text' : 'password';
    else field.classList.toggle('masked', !shown);
    field.focus();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!field.value || root.classList.contains('busy')) return;
    setBusy(root, true, 'Saving…');
    try {
      // No `retry`: a retry closure would keep the value alive in the failure record.
      await api.write('/api/secrets/fulfill', { id: request.id, value: field.value }, 'POST',
        { label: 'Handing off secret', timeoutMs: FULFILL_TIMEOUT_MS });
      field.value = '';
      root.dataset.done = '1';
      root.hidden = true;
      justAnswered = { sessionId: request.sessionId, text: `✓ ${request.name} saved on ${request.node}`, at: Date.now() };
      ctx.toast(`${request.name} written to ${displayPath(request.path, ctx.data?.scopes?.home)} on ${request.node}`);
      ctx.refresh();
    } catch (error) {
      api.dismissWriteFailure(error?.writeFailureId);
      showError(root, error?.message || String(error));
      setBusy(root, false);
      field.focus();
    }
  });
  root.querySelector('.sd-decline').addEventListener('click', () => {
    declining.hidden = false;
    root.querySelector('.sd-reason').focus();
  });
  root.querySelector('.sd-decline-cancel').addEventListener('click', () => { declining.hidden = true; });
  const confirmDecline = async () => {
    setBusy(root, true);
    try {
      await api.write('/api/secrets/decline', { id: request.id, reason: root.querySelector('.sd-reason').value },
        'POST', { label: 'Declining secret request' });
      field.value = '';
      root.dataset.done = '1';
      root.hidden = true;
      justAnswered = { sessionId: request.sessionId, text: `Declined ${request.name}`, at: Date.now() };
      ctx.toast(`Declined ${request.name}`);
      ctx.refresh();
    } catch (error) {
      showError(root, error?.message || String(error));
      setBusy(root, false);
    }
  };
  root.querySelector('.sd-decline-confirm').addEventListener('click', confirmDecline);
  root.querySelector('.sd-reason').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); confirmDecline(); }
    if (event.key === 'Escape') { event.preventDefault(); declining.hidden = true; }
  });
}

// Called on every stage render. The panel is built once per request and left
// alone after that, so a state refresh never wipes what Owner is typing; it is
// torn down (and the field with it) when the request is answered or the stage
// shows another session.
//
// It floats over the terminal rather than taking a row above it: a panel in the
// layout resized the pane when it came and went, and every resize makes the agent
// redraw — and a refit's focus report reached the pane as input mid-delivery.
export function syncSecretDrop(stage, ctx, item) {
  let root = stage.querySelector('.secret-drop');
  if (!root) {
    const body = stage.querySelector('.stage-body');
    if (!body) return;
    root = document.createElement('section');
    root.className = 'secret-drop';
    root.hidden = true;
    root.setAttribute('aria-label', 'Secret requested');
    body.append(root);
  }
  // Over the terminal only: when the agent log sits beside it, stop at its edge.
  const aside = stage.querySelector('.stage-agent-log');
  root.style.setProperty('--sd-right', aside && !aside.hidden && aside.offsetWidth ? `${aside.offsetWidth}px` : '0px');
  const found = secretRequestFor(ctx.data, item?.sessionId);
  if (!found) {
    if (!root.hidden || root.dataset.requestId) {
      root.hidden = true;
      root.replaceChildren();
      delete root.dataset.requestId;
      delete root.dataset.done;
    }
    return;
  }
  const { request, more } = found;
  if (root.dataset.requestId === request.id && root.dataset.done !== '1') {
    const counter = root.querySelector('.sd-more');
    if (counter) counter.textContent = waitingText(more);
    return;
  }
  // A request answered here stays hidden until the state stops listing it.
  if (root.dataset.requestId === request.id && root.dataset.done === '1') return;
  const answered = justAnswered && justAnswered.sessionId === request.sessionId && Date.now() - justAnswered.at < 15000
    ? justAnswered : null;
  justAnswered = null;
  root.innerHTML = secretDropHTML(ctx.esc, request, { home: ctx.data?.scopes?.home || '', more, saved: answered?.text || '' });
  root.dataset.requestId = request.id;
  root.dataset.node = request.node;
  delete root.dataset.done;
  root.hidden = false;
  install(root, ctx, request);
  setFolded(root, later.has(request.id));
  // Straight on to the next one, the way Owner was going.
  if (answered && !later.has(request.id)) root.querySelector('.sd-value')?.focus();
}
