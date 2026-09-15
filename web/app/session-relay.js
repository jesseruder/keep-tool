import * as api from './api.js';

// Relay one session's last message into another live session.
//
// The console could already type into the session on the stage (`sendReply`), but
// moving a finding from the session that found it to the session that has to act
// on it meant Owner retyping it. This is that move, with the source named in the
// text so the receiving agent knows the words are a relay and not its own user.
//
// `/api/send` is unchanged: it collapses every whitespace run to one space and
// truncates at 2000 characters, so the dialog says so rather than pretending
// otherwise.

export const RELAY_LIMIT = 2000;

export function relayPrefix(agent, sessionId) {
  const parts = [String(agent || 'session'), String(sessionId || '').slice(0, 8)].filter(Boolean);
  return `[keep relay from ${parts.join(' ')}]`;
}

// The exact text `/api/send` will receive. One space between the prefix and the
// body, because the server would collapse anything longer to that anyway.
export function relayText(agent, sessionId, text) {
  return `${relayPrefix(agent, sessionId)} ${String(text == null ? '' : text).trim()}`;
}

export function relayWarning(text) {
  const value = String(text || '');
  return value.length > RELAY_LIMIT || /[\n\r]/.test(value)
    ? 'newlines will be collapsed; 2000 characters max' : '';
}

// Every session with a live host pane except the one being relayed from. A dead
// target is a 404 from the server, so the picker never offers one.
export function relayTargets(ctx, sourceSessionId) {
  const panes = ctx.paneMap();
  return (ctx.data.sessions || [])
    .filter((session) => session.id && session.id !== sourceSessionId && !session.reviewer)
    .filter((session) => Boolean(session.pane && panes.get(session.pane)?.alive))
    .map((session) => ({
      id: session.id,
      agent: session.kind || 'session',
      title: session.title || session.taskId || 'untitled session',
      card: session.taskId || '',
    }));
}

function targetOptions(state, esc) {
  return (state.targets || []).map((target) => {
    const label = `${esc(target.agent)} ${esc(target.id.slice(0, 8))} · ${esc(target.title)}${target.card ? ` · ${esc(target.card)}` : ''}`;
    return `<option value="${esc(target.id)}" ${target.id === state.targetId ? 'selected' : ''}>${label}</option>`;
  }).join('');
}

export function relayDialogHTML(ctx, state) {
  const preview = relayText(state.sourceAgent, state.sourceSessionId, state.text);
  const warning = relayWarning(preview);
  const targets = state.targets || [];
  return `<form method="dialog" class="relay-card">
    <header><div><p class="eyebrow">Relay</p><h2 id="relay-title">Relay to another session</h2><p>Sends this text into a live session as a message from ${ctx.esc(relayPrefix(state.sourceAgent, state.sourceSessionId))}.</p></div><button class="btn" value="cancel" aria-label="Close relay">✕</button></header>
    <div class="relay-fields">
      ${targets.length
    ? `<label class="wide">Target session<select data-relay-target>${targetOptions(state, ctx.esc)}</select></label>`
    : '<p class="relay-empty" role="status">No other session has a live pane to relay into.</p>'}
      <label class="wide">Message<textarea data-relay-text rows="6" maxlength="8192">${ctx.esc(state.text || '')}</textarea></label>
    </div>
    <section class="relay-preview"><h3>Exactly what is sent</h3><pre tabindex="0">${ctx.esc(preview)}</pre>${warning ? `<p class="relay-note" role="note">${ctx.esc(warning)}</p>` : ''}</section>
    ${state.error ? `<p class="relay-error" role="alert">${ctx.esc(state.error)}</p>` : ''}
    <footer><button class="btn" type="button" data-relay-cancel>Cancel</button><button class="btn primary" type="button" data-relay-send ${targets.length && String(state.text || '').trim() ? '' : 'disabled'}>Send</button></footer>
  </form>`;
}

let dialog;
function ensureDialog() {
  if (dialog?.isConnected) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'relay-dialog';
  dialog.setAttribute('aria-labelledby', 'relay-title');
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.replaceChildren());
  return dialog;
}

function renderDialog(ctx, state) {
  const modal = ensureDialog();
  modal.innerHTML = relayDialogHTML(ctx, state);
  modal.querySelector('[data-relay-target]')?.addEventListener('change', (event) => { state.targetId = event.target.value; });
  const field = modal.querySelector('[data-relay-text]');
  // Only the preview and the Send state are updated as the text changes. Rerendering
  // the whole form on every keystroke tears out the textarea mid-composition, which
  // loses an IME's in-flight characters and the caret with them.
  field?.addEventListener('input', (event) => {
    state.text = event.target.value;
    const preview = relayText(state.sourceAgent, state.sourceSessionId, state.text);
    const pre = modal.querySelector('.relay-preview pre');
    if (pre) pre.textContent = preview;
    const warning = relayWarning(preview);
    let note = modal.querySelector('.relay-note');
    if (warning && !note) {
      note = document.createElement('p');
      note.className = 'relay-note';
      note.setAttribute('role', 'note');
      modal.querySelector('.relay-preview')?.append(note);
    }
    if (note) { note.textContent = warning; note.hidden = !warning; }
    const send = modal.querySelector('[data-relay-send]');
    if (send) send.disabled = !(state.targets || []).length || !String(state.text || '').trim();
  });
  modal.querySelector('[data-relay-cancel]')?.addEventListener('click', () => modal.close());
  modal.querySelector('[data-relay-send]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    state.error = '';
    const target = state.targetId;
    try {
      await api.send(target, relayText(state.sourceAgent, state.sourceSessionId, state.text));
      modal.close();
      ctx.toast(`relayed to ${String(target).slice(0, 8)}`);
    } catch (error) {
      // 404 (no live host pane) and 429 (injection busy) both carry the server's
      // own sentence; showing ours instead would hide which one happened.
      state.error = error.message;
      renderDialog(ctx, state);
    }
  });
}

// What Owner highlighted in the brief, when that is what he meant to relay.
// Anything selected outside the brief is somebody else's text, so it is ignored.
function selectedBriefText() {
  try {
    const selection = getSelection();
    if (!selection || selection.isCollapsed) return '';
    const brief = document.querySelector('#stage .brief');
    if (!brief || !brief.contains(selection.anchorNode) || !brief.contains(selection.focusNode)) return '';
    return String(selection).trim();
  } catch { return ''; }
}

export function openRelayDialog(ctx, sessionId) {
  const source = (ctx.data.sessions || []).find((session) => session.id === sessionId);
  const targets = relayTargets(ctx, sessionId);
  const state = {
    sourceSessionId: sessionId,
    sourceAgent: source?.kind || 'session',
    targets,
    targetId: targets[0]?.id || '',
    text: selectedBriefText() || source?.lastAssistant || '',
    error: '',
  };
  renderDialog(ctx, state);
  const modal = ensureDialog();
  if (!modal.open) modal.showModal();
  queueMicrotask(() => modal.querySelector('[data-relay-target]')?.focus());
}

export function relayControlsHTML(ctx, sessionId) {
  if (!sessionId) return '';
  return `<button class="btn" data-relay-session="${ctx.esc(sessionId)}">Relay to…</button>`;
}

export function installRelayControls(container, ctx) {
  container.querySelectorAll('[data-relay-session]').forEach((button) => {
    button.onclick = () => openRelayDialog(ctx, button.dataset.relaySession);
  });
}
