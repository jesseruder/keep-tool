let dialog;
let runSequence = 0;

const labels = { shell: 'Plain shell', claude: 'Claude Code', codex: 'Codex' };

function ensureDialog() {
  if (dialog?.isConnected) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'session-launch-dialog';
  dialog.setAttribute('aria-labelledby', 'session-launch-title');
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.replaceChildren());
  return dialog;
}

function accountsFor(ctx, agent) {
  return (ctx.data.accounts || []).filter((account) => account.agent === agent);
}

function preferredAccount(ctx, agent, requested) {
  const choices = accountsFor(ctx, agent);
  return choices.find((account) => account.id === requested)?.id
    || choices.find((account) => account.isDefault)?.id || choices[0]?.id || '';
}

export function openSessionChooser(ctx, options) {
  const modal = ensureDialog();
  if (modal.open) return false;
  const kinds = (options.kinds || ['shell', 'claude', 'codex']).filter((kind) => labels[kind]);
  const initialKind = kinds.includes(options.initialKind) ? options.initialKind : kinds[0];
  const recordedAccountMissing = kinds.length === 1 && initialKind !== 'shell' && options.requireRecordedAccount === true
    && (!options.accountId || !accountsFor(ctx, initialKind).some((account) => account.id === options.accountId));
  const runId = String(++runSequence);
  const state = {
    kind: initialKind,
    accountId: recordedAccountMissing ? '' : preferredAccount(ctx, initialKind, options.accountId),
    models: {
      claude: options.models?.claude ?? (options.agent === 'claude' ? options.model || '' : ''),
      codex: options.models?.codex ?? (options.agent === 'codex' ? options.model || '' : ''),
    },
    error: '', busy: false, bound: false,
  };

  const render = () => {
    const choices = state.kind === 'shell' ? [] : accountsFor(ctx, state.kind);
    if (state.kind !== 'shell' && state.accountId && !choices.some((account) => account.id === state.accountId)) {
      state.accountId = preferredAccount(ctx, state.kind, options.accountId);
    }
    const noAccount = state.kind !== 'shell' && !choices.length;
    const providerField = kinds.length > 1
      ? `<label>Session type<select data-launch-kind ${state.busy || state.bound ? 'disabled' : ''}>${kinds.map((kind) => `<option value="${ctx.esc(kind)}" ${kind === state.kind ? 'selected' : ''}>${ctx.esc(labels[kind])}</option>`).join('')}</select></label>`
      : `<div class="session-launch-value"><span>Provider</span><strong>${ctx.esc(labels[state.kind])}</strong></div>`;
    const accountField = state.kind === 'shell' ? '' : `<label>Account<select data-launch-account ${state.busy || state.bound || noAccount ? 'disabled' : ''}>${recordedAccountMissing && !state.accountId ? `<option value="" selected disabled>Recorded account unavailable — choose another</option>` : ''}${choices.map((account) => {
      const suffix = account.id === options.accountId ? ' · current' : account.isDefault ? ' · default' : '';
      return `<option value="${ctx.esc(account.id)}" ${account.id === state.accountId ? 'selected' : ''}>${ctx.esc((account.label || account.id) + suffix)}</option>`;
    }).join('')}</select></label>`;
    const modelField = state.kind === 'shell' || options.showModel === false ? ''
      : `<label>Model <span>Optional; blank uses the account default</span><input data-launch-model autocomplete="off" ${state.busy || state.bound ? 'disabled' : ''} value="${ctx.esc(state.models[state.kind] || '')}" placeholder="Account default"></label>`;
    const unavailable = noAccount ? `No configured ${labels[state.kind]} account is available.`
      : recordedAccountMissing && !state.accountId ? `${options.accountId ? `The recorded account ${options.accountId}` : 'The recorded account identity'} is unavailable. Choose another account explicitly or transfer context.` : '';
    modal.dataset.launchRun = runId;
    modal.innerHTML = `<form method="dialog" class="session-launch-card">
      <header><div><span class="eyebrow">${ctx.esc(options.eyebrow || 'Session')}</span><h2 id="session-launch-title">${ctx.esc(options.title || 'New session')}</h2><p>${ctx.esc(options.description || '')}</p></div><button class="btn" type="button" data-launch-cancel ${state.busy ? 'disabled' : ''} aria-label="Close">Close</button></header>
      <div class="session-launch-fields">${providerField}${accountField}${modelField}<div class="session-launch-value wide"><span>Project</span><strong class="mono">${ctx.esc(options.project || 'Unknown project')}</strong></div></div>
      ${unavailable ? `<p class="session-launch-error" role="alert">${ctx.esc(unavailable)}</p>` : state.error ? `<p class="session-launch-error" role="alert">${ctx.esc(state.error)}</p>` : ''}
      <footer>${options.onTransfer ? `<button class="btn" type="button" data-launch-transfer ${state.busy || state.bound ? 'disabled' : ''}>Transfer context…</button>` : '<span></span>'}<button class="btn" type="button" data-launch-cancel ${state.busy ? 'disabled' : ''}>Cancel</button><button class="btn primary" type="submit" data-launch-submit ${state.busy || noAccount || !state.accountId && state.kind !== 'shell' ? 'disabled' : ''}>${ctx.esc(state.busy ? 'Opening…' : state.bound ? 'Resume setup' : options.confirmLabel || 'Open')}</button></footer>
    </form>`;
    modal.querySelector('[data-launch-kind]')?.addEventListener('change', (event) => {
      if (state.busy) return;
      state.kind = event.target.value; state.accountId = preferredAccount(ctx, state.kind); state.error = ''; render();
      queueMicrotask(() => modal.querySelector(state.kind === 'shell' ? '[data-launch-submit]' : '[data-launch-account]')?.focus());
    });
    modal.querySelector('[data-launch-account]')?.addEventListener('change', (event) => {
      const wasEmpty = !state.accountId;
      state.accountId = event.target.value;
      if (wasEmpty) render();
    });
    modal.querySelector('[data-launch-model]')?.addEventListener('input', (event) => { state.models[state.kind] = event.target.value; });
    modal.querySelectorAll('[data-launch-cancel]').forEach((button) => button.addEventListener('click', () => { if (!state.busy) modal.close(); }));
    modal.querySelector('[data-launch-transfer]')?.addEventListener('click', () => { if (!state.busy) { modal.close(); options.onTransfer(); } });
    modal.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.busy || noAccount) return;
      state.busy = true; state.error = ''; render();
      try {
        await options.onSubmit({ kind: state.kind, agent: state.kind === 'shell' ? null : state.kind,
          accountId: state.kind === 'shell' ? null : state.accountId,
          model: state.kind === 'shell' ? '' : String(state.models[state.kind] || '').trim() });
        if (modal.open && modal.dataset.launchRun === runId) modal.close();
      } catch (error) {
        if (!modal.open || modal.dataset.launchRun !== runId) return;
        state.busy = false;
        if (error?.body?.code === 'OPEN_EXISTING_PANE' && error.body.launch?.recoverable) state.bound = true;
        state.error = error?.body?.reason || error?.message || 'The session could not be opened.'; render();
        queueMicrotask(() => modal.querySelector('[data-launch-submit]')?.focus());
      }
    });
  };

  render();
  modal.oncancel = (event) => { if (state.busy) event.preventDefault(); };
  modal.showModal();
  queueMicrotask(() => modal.querySelector('[data-launch-kind], [data-launch-account], [data-launch-submit]')?.focus());
  return new Promise((resolve) => modal.addEventListener('close', () => resolve(true), { once: true }));
}
