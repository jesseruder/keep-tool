let dialog;
let runSequence = 0;

const labels = { shell: 'Plain shell', claude: 'Claude Code', codex: 'Codex', pi: 'Pi' };
// Offered in the model dropdown; "Other…" still accepts any id the CLI takes.
const modelPresets = {
  claude: ['claude-fable-5-1', 'claude-fable-5-1[1m]', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-opus-5', 'claude-opus-5[1m]', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  codex: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
};
const OTHER_MODEL = '__other__';
// A fresh session's model per provider until the person picks another as default in the
// chooser; '' is the account default. Kept per browser, like the console's other choices.
const DEFAULT_MODELS_KEY = 'keep.launch.defaultModels';
const builtInDefaults = { claude: 'claude-opus-5-5[1m]', codex: '', pi: '' };

function readDefaults() {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(DEFAULT_MODELS_KEY) || 'null');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch { return {}; }
}

export function defaultModels() {
  const saved = readDefaults();
  const models = { ...builtInDefaults };
  for (const kind of Object.keys(models)) if (typeof saved[kind] === 'string') models[kind] = saved[kind].trim();
  return models;
}

export function setDefaultModel(kind, model) {
  if (!Object.hasOwn(builtInDefaults, kind)) return;
  try { globalThis.localStorage?.setItem(DEFAULT_MODELS_KEY, JSON.stringify({ ...readDefaults(), [kind]: String(model || '').trim() })); } catch {}
}
const isCustomModel = (kind, model) => !!model && !(modelPresets[kind] || []).includes(model);

function ensureDialog() {
  if (dialog?.isConnected) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'session-launch-dialog';
  dialog.setAttribute('aria-labelledby', 'session-launch-title');
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.replaceChildren());
  return dialog;
}

// The machines the daemon publishes (serve.js addNodeState), daemon node first. A
// one-node install publishes just its own, and an older daemon none: either way the
// chooser shows no Machine field and sends no `node`.
function nodesFor(ctx) {
  return Array.isArray(ctx.data?.nodes) ? ctx.data.nodes.filter((node) => node && typeof node.name === 'string' && node.name) : [];
}

function nodeLabel(node) {
  if (node.daemon) return `${node.name} (this machine)`;
  return node.ok === false ? `${node.name} (unreachable: ${node.reason || 'no answer'})` : node.name;
}

function accountsFor(ctx, agent) {
  return (ctx.data.accounts || []).filter((account) => account.agent === agent);
}

const claudeFamilies = ['fable', 'opus', 'sonnet', 'haiku'];

// The usage windows that would refuse this model on this account. For Claude, as the
// daemon's account budget reads them: the 5h window, the shared week, and the model
// family's own weekly bucket ("Fable wk" caps Fable only). Every Codex window caps.
// "Account default" ('') names no family, so no model bucket is weighed for it, though
// the daemon judges it against the account's settings model.
function capsFor(ctx, account, model) {
  const usage = ctx.data.usage?.accounts?.[account.id];
  if (account.agent !== 'claude') return (usage?.windows || []).filter(Boolean);
  const name = String(model || '').toLowerCase();
  const family = claudeFamilies.find((candidate) => name.includes(candidate));
  return (usage?.limits || []).filter((window) => {
    const label = String(window?.label || '').toLowerCase();
    return label === '5h' || label === 'week' || (!!family && / wk$/.test(label) && label.startsWith(family));
  });
}

function resetMs(value) {
  if (value == null || value === '') return NaN;
  const number = Number(value);
  if (Number.isFinite(number)) return number < 1e12 ? number * 1000 : number;
  return Date.parse(value);
}

// A window at 100% whose reset is unknown or still ahead.
const spentWindow = (window, now) => Number(window.percent) >= 100
  && !(resetMs(window.resetsAt) <= now);

// Out of usage: any capping window spent. An account with no reading is not called spent.
function spentAccount(ctx, account, model, now = Date.now()) {
  return capsFor(ctx, account, model).some((window) => spentWindow(window, now));
}

// A named account wins (a reopen's recorded one). Otherwise the default account while it
// has usage left, then the account with usage left whose fullest window is emptiest, and
// only when every account is spent, the default anyway.
function preferredAccount(ctx, agent, requested, model) {
  const choices = accountsFor(ctx, agent);
  const named = choices.find((account) => account.id === requested);
  if (named) return named.id;
  const fallback = choices.find((account) => account.isDefault) || choices[0];
  if (!fallback) return '';
  if (!spentAccount(ctx, fallback, model)) return fallback.id;
  // An account with no reading ranks after every account with one; a window whose reset
  // has passed counts as empty.
  const now = Date.now();
  const fullest = (account) => {
    const caps = capsFor(ctx, account, model);
    return caps.length ? Math.max(...caps.map((window) => (resetMs(window.resetsAt) <= now ? 0 : Number(window.percent) || 0))) : 101;
  };
  const open = choices.filter((account) => !spentAccount(ctx, account, model)).sort((a, b) => fullest(a) - fullest(b));
  return (open[0] || fallback).id;
}

export function openSessionChooser(ctx, options) {
  const modal = ensureDialog();
  if (modal.open) return false;
  const kinds = (options.kinds || ['shell', 'claude', 'codex', 'pi']).filter((kind) => labels[kind]);
  const initialKind = kinds.includes(options.initialKind) ? options.initialKind : kinds[0];
  const recordedAccountMissing = kinds.length === 1 && initialKind !== 'shell' && options.requireRecordedAccount === true
    && (!options.accountId || !accountsFor(ctx, initialKind).some((account) => account.id === options.accountId));
  const runId = String(++runSequence);
  const state = {
    kind: initialKind,
    accountId: '',
    accountChosen: false,
    directory: String(options.directory ?? options.project ?? ''),
    models: {
      claude: options.models?.claude ?? (options.agent === 'claude' ? options.model || '' : ''),
      codex: options.models?.codex ?? (options.agent === 'codex' ? options.model || '' : ''),
      pi: options.models?.pi ?? (options.agent === 'pi' ? options.model || '' : ''),
    },
    customModel: {},
    // '' is Automatic: no `node` is sent, and the daemon's placement decides.
    node: '',
    error: '', busy: false, bound: false,
  };
  const pickAccount = () => preferredAccount(ctx, state.kind, options.accountId, state.models[state.kind]);
  if (!recordedAccountMissing) state.accountId = pickAccount();
  const accountText = (account) => (account.label || account.id)
    + (account.id === options.accountId ? ' · current' : account.isDefault ? ' · default' : '')
    + (spentAccount(ctx, account, state.models[state.kind]) ? ' · out of usage' : '');
  const nodes = options.chooseNode === true ? nodesFor(ctx) : [];
  // The caller's preferred machine starts selected while it is listed and reachable.
  const preferredNode = nodes.find((node) => node.name === options.defaultNode && !node.daemon && node.ok !== false);
  if (preferredNode) state.node = preferredNode.name;
  const daemonNode = nodes.find((node) => node.daemon)?.name || '';
  const nodeChoice = () => nodes.length >= 2 && state.kind !== 'shell';
  // Pi runs on the daemon node only, so it is named rather than left to placement,
  // which could otherwise pick the card's last node and be refused.
  const chosenNode = () => (!nodeChoice() ? undefined
    : state.kind === 'pi' ? daemonNode || undefined : state.node || undefined);

  for (const kind of ['claude', 'codex', 'pi']) state.customModel[kind] = isCustomModel(kind, state.models[kind]);

  const render = () => {
    const choices = state.kind === 'shell' ? [] : accountsFor(ctx, state.kind);
    if (state.kind !== 'shell' && state.accountId && !choices.some((account) => account.id === state.accountId)) {
      state.accountId = pickAccount();
    }
    const noAccount = state.kind !== 'shell' && !choices.length;
    const providerField = kinds.length > 1
      ? `<label>Session type<select data-launch-kind ${state.busy || state.bound ? 'disabled' : ''}>${kinds.map((kind) => `<option value="${ctx.esc(kind)}" ${kind === state.kind ? 'selected' : ''}>${ctx.esc(labels[kind])}</option>`).join('')}</select></label>`
      : `<div class="session-launch-value"><span>Provider</span><strong>${ctx.esc(labels[state.kind])}</strong></div>`;
    const accountField = state.kind === 'shell' ? '' : `<label>Account<select data-launch-account ${state.busy || state.bound || noAccount ? 'disabled' : ''}>${recordedAccountMissing && !state.accountId ? `<option value="" selected disabled>Recorded account unavailable — choose another</option>` : ''}${choices.map((account) => {
      return `<option value="${ctx.esc(account.id)}" ${account.id === state.accountId ? 'selected' : ''}>${ctx.esc(accountText(account))}</option>`;
    }).join('')}</select></label>`;
    const locked = state.busy || state.bound ? 'disabled' : '';
    const model = state.models[state.kind] || '';
    const customModel = !!state.customModel[state.kind];
    const selectedModel = customModel ? OTHER_MODEL : model;
    const defaults = options.defaultModels === true ? defaultModels() : null;
    const defaultTag = (value) => (defaults && defaults[state.kind] === value ? ' · default' : '');
    const modelOptions = [['', 'Account default' + defaultTag('')], ...(modelPresets[state.kind] || []).map((id) => [id, id + defaultTag(id)]), [OTHER_MODEL, 'Other…']];
    // A typed "Other…" id is not re-rendered per keystroke, so it always offers the save.
    const modelNote = !defaults ? ''
      : !customModel && defaults[state.kind] === model.trim() ? '<span>Your default for new sessions</span>'
        : `<span><button class="linkish" type="button" data-launch-model-default ${locked}>Make this the default</button></span>`;
    // With a note the field is a div, not a label: a label would adopt the note's button
    // as its control, so clicking "Model" would save the default.
    const modelField = state.kind === 'shell' || options.showModel === false ? ''
      : `${defaults ? `<div class="session-launch-model"><label for="session-launch-model-${runId}">Model</label>${modelNote}` : '<label>Model'}<select id="session-launch-model-${runId}" data-launch-model ${locked}>${modelOptions.map(([value, text]) => `<option value="${ctx.esc(value)}" ${value === selectedModel ? 'selected' : ''}>${ctx.esc(text)}</option>`).join('')}</select>${customModel
        ? `<input data-launch-model-custom aria-label="Model id" autocomplete="off" spellcheck="false" ${locked} value="${ctx.esc(model)}" placeholder="Model id">` : ''}${defaults ? '</div>' : '</label>'}`;
    const nodeField = !nodeChoice() ? ''
      : state.kind === 'pi'
        ? `<label>Machine <span>Pi sessions run on this machine only</span><select data-launch-node disabled><option value="${ctx.esc(daemonNode)}" selected>${ctx.esc(nodeLabel(nodes.find((node) => node.daemon) || { name: daemonNode, daemon: true }))}</option></select></label>`
        : `<label>Machine<select data-launch-node ${locked}><option value="" ${state.node ? '' : 'selected'}>Automatic</option>${nodes.map((node) => `<option value="${ctx.esc(node.name)}" ${node.name === state.node ? 'selected' : ''} ${node.ok === false ? 'disabled' : ''}>${ctx.esc(nodeLabel(node))}</option>`).join('')}</select></label>`;
    const projectField = options.editableDirectory
      ? `<label class="wide">Directory <span>Absolute path to an existing directory</span><input data-launch-directory autocomplete="off" spellcheck="false" ${state.busy || state.bound ? 'disabled' : ''} value="${ctx.esc(state.directory)}" placeholder="/absolute/path/to/project"></label>`
      : `<div class="session-launch-value wide"><span>Project</span><strong class="mono">${ctx.esc(options.project || 'Unknown project')}</strong></div>`;
    const unavailable = noAccount ? `No configured ${labels[state.kind]} account is available.`
      : recordedAccountMissing && !state.accountId ? `${options.accountId ? `The recorded account ${options.accountId}` : 'The recorded account identity'} is unavailable. Choose another account explicitly or transfer context.` : '';
    modal.dataset.launchRun = runId;
    modal.innerHTML = `<form method="dialog" class="session-launch-card">
      <header><div><span class="eyebrow">${ctx.esc(options.eyebrow || 'Session')}</span><h2 id="session-launch-title">${ctx.esc(options.title || 'New session')}</h2><p>${ctx.esc(options.description || '')}</p></div><button class="btn" type="button" data-launch-cancel ${state.busy ? 'disabled' : ''} aria-label="Close">Close</button></header>
      <div class="session-launch-fields">${providerField}${accountField}${modelField}${nodeField}${projectField}</div>
      ${unavailable ? `<p class="session-launch-error" role="alert">${ctx.esc(unavailable)}</p>` : state.error ? `<p class="session-launch-error" role="alert">${ctx.esc(state.error)}</p>` : ''}
      <footer>${options.onTransfer ? `<button class="btn" type="button" data-launch-transfer ${state.busy || state.bound ? 'disabled' : ''}>Transfer context…</button>` : '<span></span>'}<button class="btn" type="button" data-launch-cancel ${state.busy ? 'disabled' : ''}>Cancel</button><button class="btn primary" type="submit" data-launch-submit ${state.busy || noAccount || !state.accountId && state.kind !== 'shell' ? 'disabled' : ''}>${ctx.esc(state.busy ? 'Opening…' : state.bound ? 'Resume setup' : options.confirmLabel || 'Open')}</button></footer>
    </form>`;
    modal.querySelector('[data-launch-kind]')?.addEventListener('change', (event) => {
      if (state.busy) return;
      state.kind = event.target.value; state.accountId = pickAccount(); state.accountChosen = false; state.error = ''; render();
      queueMicrotask(() => modal.querySelector(state.kind === 'shell' ? '[data-launch-submit]' : '[data-launch-account]')?.focus());
    });
    modal.querySelector('[data-launch-account]')?.addEventListener('change', (event) => {
      const wasEmpty = !state.accountId;
      state.accountId = event.target.value;
      state.accountChosen = true;
      if (wasEmpty) render();
    });
    modal.querySelector('[data-launch-model]')?.addEventListener('change', (event) => {
      if (state.busy) return;
      const custom = event.target.value === OTHER_MODEL;
      state.customModel[state.kind] = custom;
      if (!custom) state.models[state.kind] = event.target.value;
      // A model with its own weekly bucket can be spent where another is not.
      if (!state.accountChosen && !recordedAccountMissing) state.accountId = pickAccount();
      render();
      queueMicrotask(() => modal.querySelector(custom ? '[data-launch-model-custom]' : '[data-launch-model]')?.focus());
    });
    modal.querySelector('[data-launch-node]')?.addEventListener('change', (event) => {
      if (state.busy || state.kind === 'pi') return;
      state.node = event.target.value;
    });
    modal.querySelector('[data-launch-model-custom]')?.addEventListener('input', (event) => { state.models[state.kind] = event.target.value; });
    // A typed id is weighed once it is committed, not per keystroke.
    modal.querySelector('[data-launch-model-custom]')?.addEventListener('change', (event) => {
      if (state.busy) return;
      state.models[state.kind] = event.target.value;
      if (!state.accountChosen && !recordedAccountMissing) state.accountId = pickAccount();
      // Updated in place: a re-render inside this blur or Enter would swallow the click,
      // Tab or submit that caused it.
      const rendered = [...(modal.querySelector('[data-launch-account]')?.options || [])];
      for (const option of rendered) {
        const account = accountsFor(ctx, state.kind).find((candidate) => candidate.id === option.value);
        if (account) { option.textContent = accountText(account); option.selected = account.id === state.accountId; }
      }
      // Accounts refreshed since the last render: never submit one the select does not show.
      if (rendered.length && state.accountId && !rendered.some((option) => option.value === state.accountId)) render();
    });
    modal.querySelector('[data-launch-model-default]')?.addEventListener('click', () => {
      if (state.busy) return;
      setDefaultModel(state.kind, state.models[state.kind]);
      render();
      queueMicrotask(() => modal.querySelector(state.customModel[state.kind] ? '[data-launch-model-custom]' : '[data-launch-model]')?.focus());
    });
    modal.querySelector('[data-launch-directory]')?.addEventListener('input', (event) => { state.directory = event.target.value; });
    modal.querySelectorAll('[data-launch-cancel]').forEach((button) => button.addEventListener('click', () => { if (!state.busy) modal.close(); }));
    modal.querySelector('[data-launch-transfer]')?.addEventListener('click', () => { if (!state.busy) { modal.close(); options.onTransfer(); } });
    modal.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.busy || noAccount) return;
      const directory = state.directory.trim();
      if (options.editableDirectory && !directory) {
        state.error = 'Directory is required.'; render();
        queueMicrotask(() => modal.querySelector('[data-launch-directory]')?.focus());
        return;
      }
      if (options.editableDirectory && !directory.startsWith('/')) {
        state.error = 'Directory must be an absolute path.'; render();
        queueMicrotask(() => modal.querySelector('[data-launch-directory]')?.focus());
        return;
      }
      if (options.editableDirectory) state.directory = directory;
      const node = chosenNode();
      state.busy = true; state.error = ''; render();
      try {
        await options.onSubmit({ kind: state.kind, agent: state.kind === 'shell' ? null : state.kind,
          accountId: state.kind === 'shell' ? null : state.accountId,
          model: state.kind === 'shell' ? '' : String(state.models[state.kind] || '').trim(),
          ...(node ? { node } : {}),
          ...(options.editableDirectory ? { cwd: directory } : {}) });
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
