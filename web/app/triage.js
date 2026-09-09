import * as api from './api.js';
import { closeSession } from './close-session.js';
import { sessionLabel } from './status.js';
import { retainSelection, selectionIndex } from './selection.js';

const summaryCache = new Map(); // session id -> { text, fetchedAt, mtime, fresh }
const summaryInflight = new Map();

function waitText(since) {
  const age = Math.max(0, Date.now() - (typeof since === 'number' ? since : Date.parse(since) || Date.now()));
  const minutes = Math.floor(age / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function optionLabel(option) {
  return typeof option === 'string' ? option : option?.label || option?.description || String(option ?? '');
}

function itemSummary(item, session) {
  return item.question || item.detail || session?.lastAssistant || session?.lastAssistantFull || 'Waiting for your input.';
}

function ensurePinnedState(ctx) {
  if (typeof ctx.state.showPinned === 'boolean') return;
  let stored = null;
  try { stored = sessionStorage.getItem('keep-pinned-expanded'); } catch {}
  ctx.state.showPinned = stored === null ? true : stored === '1';
}

function togglePinned(ctx) {
  ctx.state.showPinned = !ctx.state.showPinned;
  if (!ctx.state.showPinned && ctx.state.currentItem?.kind === 'pinned') {
    ctx.state.selected = 0;
    ctx.state.selectedKey = null;
  }
  try { sessionStorage.setItem('keep-pinned-expanded', ctx.state.showPinned ? '1' : '0'); } catch {}
  ctx.refresh();
}

function fetchSessionSummary(ctx, item, session) {
  const id = item.sessionId;
  if (!id || summaryInflight.has(id)) return;
  const cached = summaryCache.get(id);
  const now = Date.now();
  const mtime = session?.mtime;
  const elapsed = cached ? now - cached.fetchedAt : Infinity;
  const changed = cached && mtime !== cached.mtime;
  if (cached?.retryAt && now < cached.retryAt && !changed) return;
  if (cached && !(changed && elapsed >= 15e3) && !(cached.fresh === false && elapsed >= 10e3)) return;

  const pending = api.getSessionSummary(id)
    .then((result) => {
      summaryCache.set(id, {
        text: typeof result?.text === 'string' ? result.text.trim() : '',
        fetchedAt: Date.now(),
        mtime,
        fresh: result?.fresh !== false,
      });
    })
    .catch((error) => {
      // api.request throws a plain Error carrying the daemon's message; a missing
      // transcript is "no session". Either way, wait for new activity before retrying.
      const missing = /no session/i.test(error?.message || '');
      // A missing transcript waits for new activity; a transient failure retries
      // after a minute (fresh:false plus retryAt) instead of every 10 s or never.
      summaryCache.set(id, {
        text: missing ? 'No transcript for this session' : cached?.text || '',
        fetchedAt: Date.now(),
        mtime,
        fresh: missing,
        retryAt: missing ? null : Date.now() + 60e3,
      });
    })
    .finally(() => {
      summaryInflight.delete(id);
      ctx.refresh();
    });
  summaryInflight.set(id, pending);
}

function shellProject(ctx) {
  const projects = ctx.knownProjects();
  const fallback = projects.find((project) => project.key === 'keep') || ctx.projectOf('~/keep');
  if (ctx.state.filter) return projects.find((project) => project.key === ctx.state.filter) || fallback;
  // The rail renders before the queue reconciles the numeric index, so trust the key.
  const items = ctx.triageItems();
  const item = (ctx.state.selectedKey && items.find((candidate) => ctx.triageKey(candidate) === ctx.state.selectedKey)) || items[ctx.state.selected];
  const projectPath = item?.project || ctx.sessionFor(item)?.project;
  if (!projectPath) return fallback;
  const selected = ctx.projectOf(projectPath);
  return projects.find((project) => project.key === selected.key) || (selected.path.startsWith('/') ? selected : fallback);
}

function renderRail(ctx, items) {
  const rail = document.querySelector('#rail');
  const counted = items.filter((item) => !ctx.state.dismissed.has(ctx.itemKey(item)));
  const counts = new Map();
  for (const item of counted) {
    const key = ctx.projectOf(item.project).key;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const projects = ctx.knownProjects().filter((project) => counts.has(project.key));
  const collapsed = ctx.state.collapsed.rail;
  const row = (project) => `<button data-project="${ctx.esc(project.key)}" class="${ctx.state.filter === project.key ? 'on' : ''}" style="--h:${project.h}"><i></i><span>${ctx.esc(project.name)}</span><span class="c ${counts.get(project.key) ? 'hot' : ''}">${counts.get(project.key) || ''}</span></button>`;
  const dot = (project) => `<button data-project="${ctx.esc(project.key)}" class="rail-dot ${ctx.state.filter === project.key ? 'on' : ''}" style="--h:${project.h}" title="${ctx.esc(project.name)}"><i></i></button>`;
  const shell = shellProject(ctx);
  const shellButton = collapsed
    ? '<button class="rail-shell rail-dot" data-shell title="New shell"><span class="rail-shell-mark">+</span></button>'
    : `<button class="rail-shell" data-shell title="New shell in ${ctx.esc(shell.name)}"><span class="rail-shell-mark">+</span><span>shell</span></button>`;
  rail.classList.toggle('collapsed', collapsed);
  rail.innerHTML = collapsed
    ? `<div class="rh"><button class="collapse" aria-expanded="false" title="Expand (⌘B)">›</button></div><button data-project="" class="rail-dot all ${ctx.state.filter ? '' : 'on'}" title="All"><i></i></button>${projects.map(dot).join('')}${shellButton}`
    : `<div class="rh"><span>Projects</span><button class="collapse" aria-expanded="true" title="Collapse (⌘B)">‹</button></div><button data-project="" class="all ${ctx.state.filter ? '' : 'on'}"><i></i><span>All</span><span class="c hot">${counted.length}</span></button>`
      + `<div class="scope">castle</div>${projects.filter((p) => p.scope === 'castle').map(row).join('')}`
      + `<div class="scope">personal</div>${projects.filter((p) => p.scope !== 'castle').map(row).join('')}${shellButton}`;
  rail.querySelector('.collapse').addEventListener('click', () => ctx.toggleCollapsed('rail'));
  rail.querySelectorAll('[data-project]').forEach((button) => button.addEventListener('click', () => {
    ctx.state.filter = button.dataset.project || null;
    ctx.setSelected(0);
    ctx.state.ensureSelectedVisible = true;
    ctx.refresh();
  }));
  rail.querySelector('[data-shell]').addEventListener('click', async (event) => {
    if (ctx.state.pendingFocus) return;
    const button = event.currentTarget;
    button.disabled = true;
    button.blur();
    ctx.state.pendingFocus = true;
    try {
      const pane = await ctx.startShell(shell.path, shell.name);
      const title = ctx.entityForPane(pane.id).title;
      const pinned = await ctx.pinPane(pane.id, title);
      if (!pinned) { ctx.refresh(); ctx.toast(`Shell started in ${shell.name}, but pinning failed; it is listed in Watch`); return; }
      const index = ctx.triageItems().findIndex((item) => item.kind === 'pinned' && item.pane === pane.id);
      if (index >= 0) ctx.setSelected(index, true);
      ctx.state.ensureSelectedVisible = true;
      ctx.state.focused = true;
      ctx.state.focusPane = pane.id;
      ctx.refresh();
      ctx.toast(`Shell started in ${shell.name}`);
    } catch (error) { ctx.toast(error.message); }
    finally { button.disabled = false; ctx.state.pendingFocus = false; }
  });
}

function queueRow(ctx, item) {
  const session = ctx.sessionFor(item);
  const title = item.title || session?.title || 'untitled session';
  const project = item.project || session?.project || '';
  const task = ctx.taskFor(item);
  if (item.kind === 'running' || item.kind === 'pinned' || item.kind === 'recent') {
    const sessionState = session ? sessionLabel(session) : item.state || 'unknown';
    const shell = item.kind === 'pinned' && ctx.paneMap().get(item.pane)?.meta?.agent === 'shell';
    const recentTime = item.kind === 'recent' ? `<span class="w num">${ctx.esc(ctx.rel(item.since))}</span>` : '';
    return `<span class="stripe"></span><span class="t ${title === 'untitled session' ? 'untitled' : ''}">${ctx.esc(title)}</span>
      ${recentTime}
      <span class="p">${ctx.projectHTML(project)}${item.taskId ? `<span class="card">${ctx.esc(item.taskId)}</span>` : ''}${ctx.tagsHTML(task)}</span>
      <span class="s">${shell ? '<span class="kind shell">shell</span>' : ''}<span class="kind state ${ctx.esc(session?.state || item.state || '')}">${ctx.esc(sessionState)}</span></span>`;
  }
  const waited = waitText(item.since);
  return `<span class="stripe"></span><span class="t ${title === 'untitled session' ? 'untitled' : ''}">${ctx.esc(title)}</span>
    <span class="w num ${waited.includes('d') ? 'long' : ''}">${ctx.esc(waited)}</span>
    <span class="p">${ctx.projectHTML(project)}${item.taskId ? `<span class="card">${ctx.esc(item.taskId)}</span>` : ''}${ctx.tagsHTML(task)}</span>
    <span class="s"><span class="kind ${ctx.esc(item.kind)}">${ctx.esc(ctx.kindLabel(item.kind))}</span>${ctx.esc(itemSummary(item, session))}</span>`;
}

function renderQueue(ctx, waiting, running, pinned, recent, dismissed) {
  const list = document.querySelector('#qlist');
  const scrollTop = list.scrollTop;
  const shownRunning = ctx.state.showRunning ? running : [];
  const shownPinned = ctx.state.showPinned ? pinned : [];
  const active = [...waiting, ...shownRunning, ...shownPinned, ...(ctx.state.showRecent ? recent : [])];
  const retainedSelection = ctx.state.focusMode ? [] : retainSelection(active, ctx.state.currentItem, ctx.state.selectedKey, ctx.itemKey, ctx.triageKey,
    ctx.retainedSelectionItem);
  active.push(...retainedSelection);
  const collapsed = ctx.state.collapsed.queue;
  const queue = document.querySelector('#triage .queue');
  const strip = document.querySelector('#triage .queue-strip');
  queue.classList.toggle('collapsed', collapsed);
  strip.classList.toggle('on', collapsed);
  const head = queue.querySelector('.qhead');
  head.classList.add('focus-head');
  ctx.patchHTML(head, `<button type="button" class="qfocus" aria-pressed="${ctx.state.focusMode}" title="Toggle Focus (Shift+F)"><b id="qn">${ctx.esc(waiting.length)}</b> waiting on you ${ctx.state.focusMode ? '<span class="focus-pill">focus</span>' : ''}<span class="order">oldest first</span></button><button class="collapse" aria-expanded="true" title="Collapse (⌘\\)">‹</button>`);
  head.querySelector('.qfocus').onclick = () => ctx.toggleFocus();
  head.querySelector('.collapse').onclick = () => ctx.toggleCollapsed('queue');
  strip.innerHTML = `<button class="collapse" aria-expanded="false" title="Expand (⌘\\)">›</button><span class="strip-label"><b class="${waiting.length ? 'hot' : ''}">${ctx.esc(waiting.length)}</b> waiting</span>`;
  strip.querySelector('.collapse').addEventListener('click', () => ctx.toggleCollapsed('queue'));
  if (!ctx.state.focusMode) {
    ctx.state.selected = selectionIndex(active, ctx.state.selectedKey, ctx.state.currentItem, ctx.state.selected, ctx.itemKey, ctx.triageKey);
    ctx.state.selectedKey = active[ctx.state.selected] ? ctx.triageKey(active[ctx.state.selected]) : null;
  }
  const existing = new Map([...list.querySelectorAll(':scope > .qitem')].map((row) => [row.dataset.key, row]));
  const retained = new Set();
  let cursor = list.firstElementChild;
  const place = (element) => {
    retained.add(element);
    if (element !== cursor) list.insertBefore(element, cursor);
    cursor = element.nextElementSibling;
  };
  const addGroup = (html, className = 'qhead qgroup', tagName = 'div') => {
    const group = document.createElement(tagName);
    if (tagName === 'button') group.type = 'button';
    group.className = className;
    group.innerHTML = html;
    place(group);
    return group;
  };
  const addRows = (rows, offset) => rows.forEach((item, localIndex) => {
    const index = offset + localIndex;
    const key = ctx.triageKey(item);
    let row = existing.get(key);
    if (!row) {
      row = document.createElement('div');
      row.className = 'qitem';
      row.tabIndex = 0;
      row.dataset.key = key;
      row.addEventListener('click', () => {
        ctx.setSelected(row.dataset.key, true);
        ctx.state.focused = false;
        ctx.refresh();
      });
    }
    const html = queueRow(ctx, item);
    ctx.patchHTML(row, html);
    row.className = `qitem k-${item.kind}${index === ctx.state.selected ? ' sel' : ''}`;
    row.dataset.index = index;
    place(row);
  });
  addRows(waiting, 0);
  const runningHead = addGroup(`${ctx.state.showRunning ? '▾' : '▸'} Running & waiting · ${ctx.esc(running.length)}`, 'qhead qgroup qtoggle', 'button');
  runningHead.addEventListener('click', () => ctx.toggleRunning());
  if (ctx.state.showRunning) addRows(running, waiting.length);
  const pinnedHead = addGroup(`${ctx.state.showPinned ? '▾' : '▸'} Pinned · ${ctx.esc(pinned.length)}`, 'qhead qgroup qtoggle', 'button');
  pinnedHead.addEventListener('click', () => togglePinned(ctx));
  if (ctx.state.showPinned) addRows(pinned, waiting.length + shownRunning.length);
  const recentHead = addGroup(`${ctx.state.showRecent ? '▾' : '▸'} Recent · ${ctx.esc(recent.length)}`, 'qhead qgroup qtoggle', 'button');
  recentHead.addEventListener('click', () => ctx.toggleRecent());
  if (ctx.state.showRecent) addRows(recent, waiting.length + shownRunning.length + shownPinned.length);
  if (retainedSelection.length) {
    addGroup('Selected session');
    addRows(retainedSelection, active.length - retainedSelection.length);
  }
  if (!active.length && !dismissed.length) addGroup('<div class="qempty"><b>Nothing waiting on you</b>Expand Running, Pinned, or Recent to browse sessions, or open Watch for live panes.</div>', '');
  if (dismissed.length) {
    const wrap = document.createElement('div');
    wrap.className = 'qdis-wrap';
    wrap.innerHTML = `<button class="qdis-head" data-dismiss-toggle>${ctx.state.showDismissed ? '▾' : '▸'} dismissed · ${ctx.esc(dismissed.length)}</button>${ctx.state.showDismissed ? dismissed.map((item) => {
      const entry = ctx.setAsideFor(item);
      const minutes = entry?.kind === 'snooze' ? Math.max(1, Math.ceil((entry.until - Date.now()) / 60e3)) : null;
      const status = minutes === null ? 'dismissed' : `snoozed · ${minutes}m left`;
      return `<div class="qdis" style="--h:${ctx.esc(ctx.projectOf(item.project).h)}"><span class="stripe"></span><span class="t">${ctx.esc(item.title || 'untitled session')} <small>${ctx.esc(status)}</small></span><button class="btn" data-restore="${ctx.esc(ctx.itemKey(item))}">Restore</button><span class="p">${ctx.projectHTML(item.project)}</span></div>`;
    }).join('') : ''}`;
    place(wrap);
    wrap.querySelector('[data-dismiss-toggle]').addEventListener('click', () => { ctx.state.showDismissed = !ctx.state.showDismissed; ctx.refresh(); });
    wrap.querySelectorAll('[data-restore]').forEach((button) => button.addEventListener('click', () => ctx.restore(button.dataset.restore)));
  }
  for (const child of [...list.children]) if (!retained.has(child)) child.remove();
  list.scrollTop = scrollTop;
  if (ctx.state.ensureSelectedVisible) {
    [...list.querySelectorAll(':scope > .qitem')].find((row) => row.dataset.key === ctx.state.selectedKey)?.scrollIntoView({ block: 'nearest' });
    ctx.state.ensureSelectedVisible = false;
  }
  return active;
}

function briefHTML(ctx, item, session) {
  if (item.sessionId) fetchSessionSummary(ctx, item, session);
  const summary = item.sessionId
    ? summaryCache.get(item.sessionId)?.text || 'Summarizing recent work…'
    : item.detail || 'No session transcript available.';
  const cached = summaryCache.get(item.sessionId);
  const updating = cached?.text && (cached.fresh === false || cached.mtime !== session?.mtime);
  let actions = '';
  if (item.kind === 'question') {
    const options = Array.isArray(item.options) ? item.options : [];
    actions = `<div class="opts">${options.map((option, index) => `<button class="opt ${option?.recommended || option?.rec ? 'rec' : ''}" data-option="${index + 1}"><span class="n">${index + 1}</span><span>${ctx.esc(optionLabel(option))}${option?.recommended || option?.rec ? ' <span class="d">· recommended</span>' : ''}</span></button>`).join('')}</div>`;
  }
  if (item.kind === 'rateLimit') {
    actions = '<div class="opts"><button class="opt" data-continue><span class="n">1</span><span>Continue</span></button><button class="opt" data-leave><span class="n">2</span><span>Leave parked</span></button></div>';
  }
  return `<div class="summary">${ctx.esc(summary)}</div>${updating ? '<div class="summary-updating" role="status">Updating summary…</div>' : ''}${actions}`;
}

async function sendReply(ctx, item, text) {
  if (!text) return;
  const brief = document.querySelector('#stage .brief');
  if (brief) ctx.patchHTML(brief, `<div class="sent"><span class="spin"></span>Sent “${ctx.esc(text)}” · moving to the next item.</div>`);
  try {
    await api.send(item.sessionId, text);
    ctx.state.sent.add(ctx.eventKey(item));
    setTimeout(() => { ctx.state.selected += 1; ctx.state.focused = false; ctx.refresh(); }, 500);
  } catch (error) { ctx.toast(error.message); ctx.refresh(); }
}

async function chooseOption(ctx, item, number) {
  const option = item.options?.[number - 1];
  if (!option) return;
  const label = optionLabel(option);
  try {
    await api.answer(item.sessionId, number, label);
    ctx.state.sent.add(ctx.eventKey(item));
    ctx.state.selected += 1;
    ctx.state.focused = false;
    ctx.toast(`Answered “${label}”`);
    ctx.refresh();
  } catch (error) { ctx.toast(error.message); }
}

function renderStage(ctx, active, focusItem, running, pinned) {
  const item = ctx.state.focusMode ? focusItem : active[ctx.state.selected];
  const stage = document.querySelector('#stage');
  // Check before replacing the stage: its find bar may be about to detach.
  const focusedElement = document.activeElement;
  const editing = focusedElement instanceof Element && (focusedElement.closest('.findbar')
    || (!focusedElement.closest('.xterm') && (focusedElement.matches('input, select, textarea') || focusedElement.isContentEditable)));
  if (!ctx.state.focusMode) stage.dataset.focusKey = '';
  ctx.state.currentActions = {};
  if (!item) {
    ctx.state.currentItem = null;
    // No terminal is on the stage, so plain keys (w, t, f, ?) must reach the app again.
    ctx.state.focused = false;
    ctx.patchHTML(stage, ctx.state.focusMode
      ? `<div class="qempty stage-empty focus-waiting" role="status"><span class="focus-pulse" aria-hidden="true"></span><b>Nothing needs you</b><div>${ctx.esc(running.length)} running · ${ctx.esc(pinned.length)} pinned</div><p>Waiting for the next session…</p></div>`
      : '<div class="qempty stage-empty"><b>Queue clear</b><span>Press <kbd>w</kbd> to watch what is running.</span></div>');
    stage.dataset.itemKey = '';
    stage.dataset.pane = '';
    stage.dataset.focusKey = '';
    return;
  }
  ctx.state.currentItem = item;
  const session = ctx.sessionFor(item);
  const task = ctx.taskFor(item);
  const title = item.title || session?.title || 'untitled session';
  const waitingItem = item.kind !== 'running' && item.kind !== 'pinned' && item.kind !== 'recent';
  const key = ctx.itemKey(item);
  const pane = item.pane ? ctx.paneMap().get(item.pane) : null;
  const hasLivePane = Boolean(pane?.alive);
  if (stage.dataset.itemKey !== key || stage.dataset.pane !== (item.pane || '')) {
    ctx.focusDebug?.('stage-replace', { reason: 'selection-or-pane-change', session: item.sessionId || '', pane: item.pane || '', related: stage.dataset.pane || '' });
    ctx.clearElement(stage);
    ctx.patchHTML(stage, '<div class="shead"></div><div class="brief"></div><div class="stage-terminal"></div>');
    stage.dataset.itemKey = key;
    stage.dataset.pane = item.pane || '';
    stage.dataset.focusKey = '';
  }
  const pinLabel = ctx.isPanePinned(item.pane) ? 'Unpin from Watch' : 'Pin to Watch';
  const closable = hasLivePane && item.sessionId && ['claude', 'codex'].includes(pane.meta?.agent);
  const reopen = hasLivePane ? '' : '<button class="btn" data-reopen>Reopen</button>';
  ctx.patchHTML(stage.querySelector('.shead'), `<div class="session-heading"><h2>${ctx.esc(title)}</h2><div class="meta mono">${ctx.projectHTML(item.project || session?.project || '', true)}${item.taskId ? `<a href="#" data-card>${ctx.esc(item.taskId)}</a>${ctx.tagsHTML(task)}` : ''}</div></div><div class="acts"><button class="btn" data-pin ${item.pane ? '' : 'disabled'}><kbd>p</kbd> ${ctx.esc(pinLabel)}</button>${reopen}<button class="btn" data-card><kbd>o</kbd> Card</button>${item.sessionId || waitingItem ? '<button class="btn" data-snooze>Snooze 1h</button><button class="btn" data-dismiss><kbd>x</kbd> Dismiss</button>' : ''}${closable ? '<button class="btn" data-close-session>Close</button>' : ''}</div>`);
  const brief = stage.querySelector('.brief');
  const briefChanged = ctx.patchHTML(brief, briefHTML(ctx, item, session));
  const terminalHost = stage.querySelector('.stage-terminal');
  if (hasLivePane) {
    const focusKey = `${ctx.eventKey(item)}:${item.pane}`;
    const autoFocus = ctx.state.focusMode && stage.dataset.focusKey !== focusKey && !editing && !ctx.state.pendingFocus;
    const focus = (ctx.state.focusPane === item.pane || autoFocus) && !editing;
    ctx.mount(terminalHost, item.pane, { slot: 'triage', focus });
    if (focus) ctx.state.focusPane = null;
    if (autoFocus) {
      ctx.focusTerminal();
      stage.dataset.focusKey = focusKey;
    }
  } else {
    let legacy = terminalHost.querySelector('.legacy');
    if (!legacy) {
      terminalHost.innerHTML = '<div class="legacy"><pre></pre><p class="muted">no host pane</p></div>';
      legacy = terminalHost.querySelector('.legacy');
    }
    const transcript = session?.lastAssistantFull || item.detail || 'No transcript tail available.';
    const pre = legacy.querySelector('pre');
    if (pre.textContent !== transcript) pre.textContent = transcript;
  }
  if (briefChanged) {
    brief.querySelectorAll('[data-option]').forEach((button) => button.addEventListener('click', () => chooseOption(ctx, item, Number(button.dataset.option))));
    brief.querySelector('[data-continue]')?.addEventListener('click', () => sendReply(ctx, item, 'continue'));
    brief.querySelector('[data-leave]')?.addEventListener('click', () => dismiss());
  }
  const pin = () => ctx.pinPane(item.pane, title);
  const dismiss = () => ctx.dismiss(item);
  const snooze = () => ctx.setAside(item, 'snooze', 60);
  const open = () => ctx.toast(`would open keep show ${item.taskId || '(no card)'}`);
  stage.querySelector('[data-pin]').onclick = pin;
  const reopenButton = stage.querySelector('[data-reopen]');
  if (reopenButton) reopenButton.onclick = async () => {
    if (reopenButton.disabled) return;
    reopenButton.disabled = true;
    try {
      await ctx.reopenSession({
        sessionId: item.sessionId, taskId: !item.sessionId ? item.taskId : undefined,
        agent: session?.kind, title, stalePane: item.pane || undefined,
      });
    } finally { reopenButton.disabled = false; }
  };
  const dismissButton = stage.querySelector('[data-dismiss]');
  const closeButton = stage.querySelector('[data-close-session]');
  if (closeButton) closeButton.onclick = () => closeSession(ctx, item.sessionId, item.pane, closeButton);
  if (dismissButton) dismissButton.onclick = dismiss;
  const snoozeButton = stage.querySelector('[data-snooze]');
  if (snoozeButton) snoozeButton.onclick = snooze;
  stage.querySelectorAll('[data-card]').forEach((button) => { button.onclick = (event) => { event.preventDefault(); open(); }; });
  ctx.state.currentActions = {
    pin, dismiss: item.sessionId || waitingItem ? dismiss : undefined, open,
    number(number) {
      if (item.kind === 'question') chooseOption(ctx, item, number);
      else if (item.kind === 'rateLimit') { if (number === 1) sendReply(ctx, item, 'continue'); else if (number === 2) dismiss(); }
    },
  };
}

export function installTriageControls() {}

export function renderTriage(ctx) {
  ensurePinnedState(ctx);
  const items = ctx.queueItems();
  const matchesFilter = (item) => !ctx.state.filter || ctx.projectOf(item.project).key === ctx.state.filter;
  const visible = items.filter(matchesFilter);
  const waiting = visible.filter((item) => !ctx.state.dismissed.has(ctx.itemKey(item)));
  const sessions = [...ctx.runningItems(), ...ctx.pinnedItems(), ...ctx.recentItems(),
    ...(ctx.data.sessions || []).filter((session) => !session.reviewer).map((session) => ({
      kind: 'recent', sessionId: session.id, pane: session.pane, project: session.project,
      title: session.title, taskId: session.taskId, since: session.mtime, state: session.state,
    }))];
  const notDismissed = (item) => matchesFilter(item) && !ctx.state.dismissed.has(ctx.itemKey(item));
  const running = ctx.runningItems().filter(notDismissed);
  const pinned = ctx.pinnedItems().filter(notDismissed);
  const recent = ctx.recentItems().filter(notDismissed);
  const dismissed = [...new Map([...visible, ...sessions.filter(matchesFilter)].filter((item) => ctx.state.dismissed.has(ctx.itemKey(item))).map((item) => [ctx.itemKey(item), item])).values()];
  const focusItem = ctx.state.focusMode ? waiting[0] : null;
  if (ctx.state.focusMode) {
    const key = focusItem ? ctx.triageKey(focusItem) : null;
    if (ctx.state.selectedKey !== key) ctx.state.ensureSelectedVisible = true;
    ctx.state.selected = focusItem ? 0 : -1;
    ctx.state.selectedKey = key;
  }
  renderRail(ctx, items);
  const active = renderQueue(ctx, waiting, running, pinned, recent, dismissed);
  renderStage(ctx, active, focusItem, running, pinned);
}
