import * as api from './api.js';

const drafts = new Map();
let dialog;

function latestTransfer(ctx, sessionId) {
  return (ctx.data.portableTransfers || []).filter((t) => t.sourceSessionId === sessionId)
    .sort((a, b) => {
      const priority = (t) => t.status === 'done' ? 3 : ['launching', 'ambiguous'].includes(t.status) ? 2 : 1;
      return priority(b) - priority(a) || Number(b.preparedAt) - Number(a.preparedAt);
    })[0];
}
function targetLabel(ctx, transfer) {
  return (ctx.data.accounts || []).find((a) => a.id === transfer?.targetAccountId)?.label
    || transfer?.targetAccountId || 'another account';
}
function ensureDialog() {
  if (dialog?.isConnected) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'portable-transfer-dialog';
  dialog.setAttribute('aria-labelledby', 'portable-transfer-title');
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.replaceChildren());
  return dialog;
}
function accountOptions(state, esc) {
  return state.draft.accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === state.accountId ? 'selected' : ''}>${esc(a.label)} · ${esc(a.agent)}</option>`).join('');
}

function renderDialog(ctx, state) {
  const modal = ensureDialog();
  const transfer = state.transfer;
  const account = state.draft.accounts.find((a) => a.id === state.accountId);
  const ambiguous = ['ambiguous', 'launching'].includes(transfer?.status);
  const resolutionCandidates = ambiguous ? (ctx.data.sessions || []).filter((session) => session.id !== transfer.sourceSessionId
    && session.accountId === transfer.targetAccountId && session.taskId === transfer.cardId
    && (ctx.data.panes || []).some((pane) => pane.meta?.sessionId === session.id && pane.meta?.portableTransferId === transfer.id)) : [];
  modal.innerHTML = `<form method="dialog" class="portable-transfer-card">
    <header><div><p class="eyebrow">Portable continuation</p><h2 id="portable-transfer-title">Transfer ${ctx.esc(state.draft.cardTitle || state.draft.cardId)}</h2><p>Start a fresh conversation from a reviewed, saved context package. The source session stays intact.</p></div><button class="btn" value="cancel" aria-label="Close transfer">✕</button></header>
    <div class="portable-transfer-fields">
      <label>Destination account<select data-transfer-account>${accountOptions(state, ctx.esc)}</select></label>
      <label>Destination model <span>optional</span><input data-transfer-model value="${ctx.esc(state.model)}" placeholder="${account?.agent === 'claude' ? 'claude-fable-5-1' : 'account default'}"></label>
      <label class="wide">Launch working directory<input data-transfer-cwd value="${ctx.esc(state.cwd)}" autocomplete="off"></label>
      <label class="wide">Handoff and next instruction<textarea data-transfer-context rows="8" maxlength="524288">${ctx.esc(state.context)}</textarea></label>
    </div>
    <aside class="portable-transfer-pause" role="note"><b>The successor pauses before work</b><span>${ctx.esc(state.draft.pausePolicy)}</span></aside>
    ${state.error ? `<p class="portable-transfer-error" role="alert">${ctx.esc(state.error)}</p>` : ''}
    ${state.preview ? `<section class="portable-transfer-preview"><div><h3>Immutable saved package</h3><span>${ctx.esc(transfer?.id?.slice(0, 16) || '')}</span></div><pre tabindex="0">${ctx.esc(state.preview)}</pre></section>` : ''}
    ${ambiguous ? `<section class="portable-transfer-resolution">${resolutionCandidates.length
    ? `<label>Observed successor<select data-transfer-resolution>${resolutionCandidates.map((session) => `<option value="${ctx.esc(session.id)}">${ctx.esc(session.title || session.id)} · ${ctx.esc(session.accountLabel || session.accountId)}</option>`).join('')}</select></label><button class="btn" type="button" data-resolve-transfer>Bind observed successor</button><small>Validates the saved launch receipt, destination account, and card. It never launches or sends again.</small>`
    : '<p role="status">No compatible existing successor was found. Inspect or finish the destination launch, then reopen this transfer; no duplicate will be started.</p>'}</section>` : ''}
    <footer><span>${ctx.esc(state.draft.sourceAgent)} · ${ctx.esc(state.draft.sourceAccountId || 'unknown source account')}</span>
      ${state.preview && transfer?.status === 'prepared' ? `${state.savedOnly ? '' : '<button class="btn" type="button" data-refresh-transfer>Prepare new preview</button>'}<button class="btn primary" type="button" data-launch-transfer>Launch reviewed package</button>` : ambiguous ? '' : '<button class="btn primary" type="button" data-prepare-transfer>Prepare preview</button>'}
    </footer></form>`;
  const invalidate = () => { state.transfer = null; state.preview = ''; state.error = ''; renderDialog(ctx, state); };
  modal.querySelector('[data-transfer-account]').onchange = (event) => {
    state.accountId = event.target.value;
    if (!state.modelEdited) state.model = state.draft.accounts.find((a) => a.id === state.accountId)?.agent === 'claude' ? 'claude-fable-5-1' : '';
    invalidate();
  };
  modal.querySelector('[data-transfer-model]').oninput = (event) => {
    if (state.transfer) state.dirty = true;
    state.model = event.target.value; state.modelEdited = true; state.transfer = null; state.preview = ''; state.error = '';
    modal.querySelector('[data-launch-transfer]')?.setAttribute('disabled', '');
  };
  modal.querySelector('[data-transfer-model]').onchange = () => { if (state.dirty) { state.dirty = false; renderDialog(ctx, state); } };
  modal.querySelector('[data-transfer-context]').oninput = (event) => {
    if (state.transfer) state.dirty = true;
    state.context = event.target.value; state.transfer = null; state.preview = ''; state.error = '';
    modal.querySelector('[data-launch-transfer]')?.setAttribute('disabled', '');
  };
  modal.querySelector('[data-transfer-context]').onchange = () => { if (state.dirty) { state.dirty = false; renderDialog(ctx, state); } };
  modal.querySelector('[data-transfer-cwd]').oninput = (event) => {
    if (state.transfer) state.dirty = true;
    state.cwd = event.target.value; state.transfer = null; state.preview = ''; state.error = '';
    modal.querySelector('[data-launch-transfer]')?.setAttribute('disabled', '');
  };
  modal.querySelector('[data-transfer-cwd]').onchange = () => { if (state.dirty) { state.dirty = false; renderDialog(ctx, state); } };
  modal.querySelector('[data-prepare-transfer]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const request = { sourceSessionId: state.draft.sourceSessionId, accountId: state.accountId,
      model: state.model.trim(), cwd: state.cwd.trim(), context: state.context };
    button.disabled = true; modal.querySelectorAll('input, select, textarea').forEach((field) => { field.disabled = true; }); state.error = '';
    try {
      const result = await api.preparePortableTransfer(request);
      state.transfer = result.transfer; state.preview = result.preview; renderDialog(ctx, state);
    } catch (error) { state.error = error.message; renderDialog(ctx, state); }
  });
  modal.querySelector('[data-launch-transfer]')?.addEventListener('click', async (event) => {
    const transferId = state.transfer.id;
    event.currentTarget.disabled = true; modal.querySelectorAll('input, select, textarea').forEach((field) => { field.disabled = true; }); state.error = '';
    try {
      const result = await api.launchPortableTransfer(transferId);
      state.transfer = result.transfer; await ctx.reload();
      if (state.transfer?.destinationSessionId) {
        modal.close(); ctx.toast('Opened the reviewed continuation; the original session is preserved');
        ctx.openReviewSession(state.transfer.destinationSessionId);
      } else renderDialog(ctx, state);
    } catch (error) {
      try { const current = await api.getPortableTransferPreview(transferId); state.transfer = current.transfer; state.preview = current.preview; } catch {}
      state.error = error.message; renderDialog(ctx, state);
    }
  });
  modal.querySelector('[data-refresh-transfer]')?.addEventListener('click', () => {
    state.transfer = null; state.preview = ''; state.error = ''; renderDialog(ctx, state);
  });
  modal.querySelector('[data-resolve-transfer]')?.addEventListener('click', async (event) => {
    const id = modal.querySelector('[data-transfer-resolution]').value;
    event.currentTarget.disabled = true; state.error = '';
    try {
      const result = await api.resolvePortableTransfer(state.transfer.id, id);
      state.transfer = result.transfer; await ctx.reload(); modal.close(); ctx.openReviewSession(id);
    } catch (error) { state.error = error.message; renderDialog(ctx, state); }
  });
}

async function openTransfer(ctx, sessionId, transfer) {
  let state = drafts.get(sessionId);
  try {
    if (!state) {
      let saved;
      if (transfer?.policyVersion === 2) saved = await api.getPortableTransferPreview(transfer.id);
      let result;
      try { result = await api.getPortableTransferDraft(sessionId); } catch (error) { if (!saved) throw error; }
      const source = (ctx.data.sessions || []).find((candidate) => candidate.id === sessionId);
      const draft = result?.draft || { sourceSessionId: sessionId, sourceAgent: transfer.sourceAgent,
        sourceAccountId: transfer.sourceAccountId, cardId: transfer.cardId, cardTitle: source?.title || transfer.cardId,
        accounts: (ctx.data.accounts || []).filter((account) => account.id !== transfer.sourceAccountId),
        accountId: transfer.targetAccountId, model: transfer.model || '', context: 'Saved in the immutable package below.',
        pausePolicy: 'The successor reads the package, card, and worktree, acknowledges readiness, then waits for Jesse or the user. Automated reminders do not resume it.' };
      state = { draft, accountId: transfer?.targetAccountId || draft.accountId, model: transfer?.model || draft.model || '', cwd: transfer?.cwd || draft.cwd || '',
        context: draft.context || '', modelEdited: false, savedOnly: !result?.draft,
        transfer: saved?.transfer || null, preview: saved?.preview || '', error: '' };
      drafts.set(sessionId, state);
    }
    if (transfer?.policyVersion === 2 && state.transfer?.id !== transfer.id) {
      const result = await api.getPortableTransferPreview(transfer.id);
      state.transfer = result.transfer; state.preview = result.preview;
      state.accountId = transfer.targetAccountId; state.model = transfer.model || '';
    }
    renderDialog(ctx, state);
    const modal = ensureDialog(); if (!modal.open) modal.showModal();
    queueMicrotask(() => modal.querySelector('[data-transfer-account]')?.focus());
  } catch (error) { ctx.toast(`Transfer unavailable: ${error.message}`); }
}

async function launchLegacy(ctx, button) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    const result = await api.launchPortableTransfer(button.dataset.portableTransfer); await ctx.reload();
    if (result.transfer?.destinationSessionId) {
      ctx.toast('Opened a fresh conversation with the saved context; the original session is preserved');
      ctx.openReviewSession(result.transfer.destinationSessionId);
    }
  } catch (error) { await ctx.reload(); ctx.toast(`Transfer not started: ${error.message}`); }
  finally { button.disabled = false; }
}

export function portableTransferControls(ctx, sessionId) {
  const transfer = latestTransfer(ctx, sessionId);
  const label = targetLabel(ctx, transfer);
  if (!transfer) return `<button class="btn" data-new-portable-transfer="${ctx.esc(sessionId)}">Transfer context…</button>`;
  if (transfer.status === 'done') return transfer.destinationSessionId
    ? `<button class="btn portable-transfer" data-open-portable="${ctx.esc(transfer.destinationSessionId)}"><span>Open successor</span><small>${ctx.esc(label)} · saved continuation</small></button>`
    : '<span class="portable-transfer-state" role="status">Successor is being indexed…</span>';
  if (['launching', 'ambiguous'].includes(transfer.status)) return `<button class="btn portable-transfer" data-review-portable="${ctx.esc(transfer.id)}" data-source-session="${ctx.esc(sessionId)}"><span>${transfer.status === 'launching' ? 'Starting successor…' : 'Resolve transfer…'}</span><small>${ctx.esc(label)} · no duplicate launch</small></button>`;
  if (transfer.status !== 'prepared') return `<span class="portable-transfer-state error" role="alert">Transfer ${ctx.esc(transfer.status || 'unavailable')}</span>`;
  return transfer.policyVersion === 2
    ? `<button class="btn portable-transfer" data-review-portable="${ctx.esc(transfer.id)}" data-source-session="${ctx.esc(sessionId)}"><span>Review transfer</span><small>${ctx.esc(label)} · saved preview</small></button>`
    : `<button class="btn portable-transfer" data-portable-transfer="${ctx.esc(transfer.id)}"><span>Continue on ${ctx.esc(label)}</span><small>fresh conversation with saved context</small></button>`;
}

export function installPortableTransferControls(container, ctx) {
  container.querySelectorAll('[data-new-portable-transfer]').forEach((b) => { b.onclick = () => openTransfer(ctx, b.dataset.newPortableTransfer); });
  container.querySelectorAll('[data-review-portable]').forEach((b) => {
    b.onclick = () => openTransfer(ctx, b.dataset.sourceSession, (ctx.data.portableTransfers || []).find((t) => t.id === b.dataset.reviewPortable));
  });
  container.querySelectorAll('[data-portable-transfer]').forEach((b) => { b.onclick = () => launchLegacy(ctx, b); });
  container.querySelectorAll('[data-open-portable]').forEach((b) => { b.onclick = () => ctx.openReviewSession(b.dataset.openPortable); });
}
