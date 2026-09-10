import './shared/scope-rules.js';
import { PROJECTS } from './project-catalog.js';
import { projectIcon } from './project-icons.js';
import { installAttentionSound, soundEventKey } from './attention-sound.js';
import { installNotifications } from './notifications.js';
import { PALETTES, paletteById, swatches } from './palettes.js';
import { applyTheme, getPalette, getPreference, onThemeChange, resolvedTheme, setPalette, setPreference, xtermTheme } from './theme.js';
import * as api from './api.js';
import { humanAttention, sessionLabel } from './status.js';
import { createClosingSessions } from './closing-sessions.js';
import { installInteractionGuard } from './interaction-guard.js';
import { captureFocusIntent } from './focus-intent.js';
import { mountTerminal } from './terminal.js';
import { installFocusDebug } from './focus-debug.js';
import { retainSelection, stableSessionOrder } from './selection.js';
import { createSessionHistory, installSessionHistory } from './session-history.js';
import { installTriageControls, renderTriage } from './triage.js';
import { renderWatch, installWatchControls } from './watch.js';
import { renderFleet } from './fleet.js';
import { closeReviewerPopover, markReviewerSeen, renderDock, renderReviewer, renderReviewerTop } from './reviewer.js';
import { acknowledgeNotificationClick, installNotificationClicks, notificationPermission, notify, requestPermission, setBadge } from './shell.js';

applyTheme();

export { PROJECTS } from './project-catalog.js';
let projectChoices = Object.create(null);

const HOME = ''; 
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
export function rel(ms) {
  const at = typeof ms === 'number' ? ms : Date.parse(ms);
  if (!Number.isFinite(at)) return '—';
  const age = Math.max(0, Date.now() - at);
  if (age < 60e3) return 'now';
  if (age < 3600e3) return `${Math.floor(age / 60e3)}m`;
  if (age < 86400e3) return `${Math.floor(age / 3600e3)}h`;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (new Date(at).toDateString() === yesterday.toDateString()) return 'yesterday';
  return `${Math.floor(age / 86400e3)}d`;
}
const hashHue = (value) => {
  let hash = 2166136261;
  for (const character of String(value)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return Math.abs(hash) % 360;
};

function projectOf(projectPath = '') {
  const clean = String(projectPath || 'unknown').replace(/\/$/, '');
  const choice = projectChoices[clean];
  const canonical = choice?.path || clean;
  const relative = canonical.replace(/^\/Users\/[^/]+\/|^\/home\/[^/]+\/|^~\//, '');
  const worktree = clean.replace(/^\/Users\/[^/]+\/|^\/home\/[^/]+\/|^~\//, '').match(/^wt\/([^/]+)\/([^/]+)/);
  let key = relative;
  if (worktree && !choice) key = Object.keys({ ...PROJECTS, ...data.projectCatalog }).find((candidate) => candidate.split('/').pop() === worktree[1]) || worktree[1];
  const known = data.projectCatalog?.[key] || (Object.hasOwn(PROJECTS, key) ? PROJECTS[key] : null);
  const name = known?.name || relative.split('/').filter(Boolean).pop() || 'Unknown';
  const settings = data.scopes || globalThis.KeepScopeRules.defaults;
  const scope = globalThis.KeepScopeRules.scopeForProject(choice ? canonical : (worktree && known ? '~/' + key : clean), settings, settings.home) || settings.default;
  return { key, path: clean, name, scope, h: known?.h ?? choice?.h ?? hashHue(canonical), icon: known?.icon || choice?.icon, wt: worktree?.[2] || null };
}

let restoredRunning = true;
try { restoredRunning = sessionStorage.getItem('keep-running-expanded') !== '0'; } catch {}
let restoredRecent = false;
try { restoredRecent = sessionStorage.getItem('keep-recent-expanded') === '1'; } catch {}
let restoredMode = 'triage';
let restoredDock = false;
let restoredFocus = false;
let restoredCollapsed = { rail: false, queue: false, rside: false };
try {
  const savedMode = localStorage.getItem('keep-mode');
  if (['triage', 'watch', 'reviewer', 'fleet'].includes(savedMode)) restoredMode = savedMode;
  restoredDock = localStorage.getItem('keep-dock') === '1';
  restoredFocus = localStorage.getItem('keep.console.focus') === '1';
  const savedCollapsed = JSON.parse(localStorage.getItem('keep.console.collapsed') || 'null');
  if (savedCollapsed && typeof savedCollapsed === 'object') {
    restoredCollapsed = {
      rail: savedCollapsed.rail === true,
      queue: savedCollapsed.queue === true,
      rside: savedCollapsed.rside === true,
    };
  }
} catch {}
const state = {
  mode: restoredMode, selected: 0, selectedKey: null, filter: null, focused: false, dock: restoredDock, collapsed: restoredCollapsed,
  dismissed: new Set(), showDismissed: false, showRunning: restoredRunning, showRecent: restoredRecent, sent: new Set(),
  layouts: [{ name: 'Pinned', ids: [], cols: 0, role: 'pinned' }], layout: 0, editing: false, pickFilter: '', currentActions: {},
  ensureSelectedVisible: true, focusPane: null, pendingFocus: false, currentItem: null,
  focusMode: restoredFocus,
  historyTarget: null,
};
let historyStorage;
try { historyStorage = localStorage; } catch {}
const sessionHistory = createSessionHistory(historyStorage);
let historyControls;
let historyRestored = false;
let data = { tasks: [], sessions: [], attention: [], setAside: {}, panes: [], health: {}, usage: {}, reviewUsage: null, review: { events: [], stats: {} }, limitResume: {} };
const terminals = new Map();
const THEME_LABELS = { system: 'Auto', light: 'Light', dark: 'Dark' };
function renderPalettePicker({ mode, palette }) {
  const picker = document.querySelector('#themePicker');
  const active = paletteById(palette);
  const preference = getPreference();
  picker.querySelector('#themebtn').textContent = `${active.name} · ${THEME_LABELS[preference]}`;
  picker.querySelector('.theme-pop').innerHTML = `
    <div class="theme-label">${esc('Appearance')}</div>
    <div class="appearance" role="group" aria-label="${esc('Appearance')}">
      ${Object.entries(THEME_LABELS).map(([value, label]) => `<button class="${preference === value ? 'on' : ''}" data-theme-preference="${esc(value)}" aria-pressed="${preference === value}">${esc(label)}</button>`).join('')}
    </div>
    <div class="theme-label">${esc('Palette')}</div>
    <div class="palette-options">
      ${PALETTES.map((option) => `<button class="palette-option ${option.id === active.id ? 'on' : ''}" data-pick-palette="${esc(option.id)}" aria-pressed="${option.id === active.id}"><span class="palette-swatches">${swatches(option, mode).map((color) => `<i style="background:${esc(color)}"></i>`).join('')}</span><span class="palette-name">${esc(option.name)}</span><span class="palette-note">${esc(option.note)}</span><span class="palette-check">${option.id === active.id ? '✓' : ''}</span></button>`).join('')}
    </div>`;
}
function closePalettePopover() {
  const picker = document.querySelector('#themePicker');
  picker.classList.remove('open');
  picker.querySelector('#themebtn').setAttribute('aria-expanded', 'false');
}
onThemeChange((appearance) => {
  renderPalettePicker(appearance);
  const theme = xtermTheme(appearance.mode, appearance.palette);
  for (const mounts of terminals.values()) {
    for (const entry of mounts.values()) entry.mounted.setTheme(theme);
  }
});
const droppedPanes = new Set();
const closingSessions = createClosingSessions();
const interactionGuard = installInteractionGuard(refresh);
function isClosingSession(sessionId, pane) { return closingSessions.has(sessionId, pane); }
function beginClose(sessionId, pane) {
  if (!closingSessions.begin(sessionId, pane, paneMap().get(pane)?.pid)) return false;
  if (state.currentItem?.sessionId === sessionId || state.currentItem?.pane === pane) {
    state.currentItem = null; state.selectedKey = null; state.focused = false; state.focusPane = null;
  }
  if (state.historyTarget?.sessionId === sessionId) state.historyTarget = null;
  refresh();
  return true;
}
const renderedHTML = new WeakMap();
let terminalRender = 0;
let visibleTerminals = [];
let focusFrame = 0;
let fitFrame = 0;
let reloadGeneration = 0;
let appliedReloadGeneration = 0;
let layoutSaveChain = Promise.resolve();
let layoutRevision = 0;
let layoutSavesPending = 0;
let attentionKeys = new Set();
let attentionSeeded = false;
const optimisticSetAside = new Map();
const focusDebug = installFocusDebug(() => ({ mode: state.mode, selected: state.selectedKey || '', session: state.currentItem?.sessionId || '', pane: state.currentItem?.pane || '' }));
const reopeningSessions = new Map();
const runningOrder = new Map();

function itemKey(item) { return item?.key || item?.sessionId || item?.taskId || item?.pane || `${item?.kind}:${item?.title}:${item?.since}`; }
function triageKey(item) {
  const section = ['running', 'pinned', 'recent'].includes(item.kind) ? item.kind : 'waiting';
  return `${section}:${itemKey(item)}`;
}
function eventKey(item) { return `${itemKey(item)}:${item.since || ''}`; }
function attentionKey(item) { return item.key || eventKey(item); }
// Null-safe like taskFor below: renderRail runs before renderQueue reconciles
// state.selected, so shellProject hands us undefined whenever the triage queue
// is empty or the index is stale. Throwing there aborts the whole reload and
// toasts "State refresh failed" on every poll.
function sessionFor(item) { const id = item?.sessionId; return id ? (data.sessions || []).find((session) => session.id === id) : undefined; }
function taskFor(item) { const id = item?.taskId; return id ? data.tasks.find((task) => task.id === id) : null; }
function paneMap() { return new Map((data.panes || []).map((pane) => [pane.id, pane])); }
function entityForPane(id) {
  const pane = paneMap().get(id) || { id, meta: {} };
  const session = data.sessions.find((candidate) => candidate.pane === id || candidate.id === pane.meta?.sessionId);
  return {
    pane, session, project: session?.project || pane.meta?.project || pane.cwd || '',
    title: session?.title || pane.meta?.title || pane.title || 'shell', state: pane.alive === false ? 'exited' : session?.state || (pane.alive ? 'running' : 'exited'),
    stateLabel: pane.alive === false ? 'Exited' : session ? sessionLabel(session) : pane.alive ? 'Running' : 'Exited',
    reviewer: Boolean(session?.reviewer), taskId: session?.taskId || null,
  };
}
function queueItems() {
  return humanAttention(data).filter((item) => !isClosingSession(item.sessionId, item.pane) && !state.sent.has(eventKey(item)))
    .sort((a, b) => Number(a.pri || 0) - Number(b.pri || 0)
      || (typeof a.since === 'number' ? a.since : Date.parse(a.since) || 0) - (typeof b.since === 'number' ? b.since : Date.parse(b.since) || 0));
}
function sessionItem(kind, session, pane = session.pane) {
  return {
    kind,
    sessionId: session.id,
    pane: pane || null,
    project: session.project,
    title: session.title,
    taskId: session.taskId || undefined,
    since: kind === 'recent' ? recentSessionTime(session) : session.mtime,
    state: session.state,
  };
}
function runningItems() {
  const sessions = (data.sessions || [])
    .filter((session) => ['running', 'waiting'].includes(session.state) && !session.reviewer && !isClosingSession(session.id, session.pane))
    .sort((a, b) => (typeof b.mtime === 'number' ? b.mtime : Date.parse(b.mtime) || 0)
      - (typeof a.mtime === 'number' ? a.mtime : Date.parse(a.mtime) || 0));
  return stableSessionOrder(sessions, runningOrder, new Set((data.sessions || []).map((session) => session.id)))
    .map((session) => sessionItem('running', session));
}
function pinnedItems() {
  return (pinnedLayout()?.ids || []).flatMap((paneId) => {
    const pane = paneMap().get(paneId);
    if (!pane || isClosingSession(pane.meta?.sessionId, paneId)) return [];
    const entity = entityForPane(paneId);
    if (!entity.session) return [{
      kind: 'pinned', pane: paneId, project: entity.project, title: entity.title, state: entity.state,
    }];
    return [sessionItem('pinned', entity.session, paneId)];
  });
}
function recentSessionTime(session) {
  const lastUserAt = typeof session.lastUserAt === 'number' ? session.lastUserAt : Date.parse(session.lastUserAt);
  return Number.isFinite(lastUserAt) ? lastUserAt
    : (typeof session.mtime === 'number' ? session.mtime : Date.parse(session.mtime) || 0);
}
function recentItems() {
  return (data.sessions || [])
    .filter((session) => !session.reviewer && !isClosingSession(session.id, session.pane) && session.state !== 'running'
      && (Number.isFinite(typeof session.lastUserAt === 'number' ? session.lastUserAt : Date.parse(session.lastUserAt)) || session.exited))
    .sort((a, b) => recentSessionTime(b) - recentSessionTime(a))
    .slice(0, 6)
    .map((session) => sessionItem('recent', session));
}
function matchesTriageFilter(item) {
  return !state.filter || projectOf(item.project).key === state.filter;
}
function triageVisible(item) { return (item.kind === 'pinned' || !state.dismissed.has(itemKey(item))) && matchesTriageFilter(item); }
function retainedSelectionItem(item) {
  if (isClosingSession(item?.sessionId, item?.pane)) return null;
  const session = sessionFor(item);
  if (state.historyTarget?.sessionId === item?.sessionId && matchesTriageFilter(item)) return session
    ? sessionItem('recent', session) : { ...state.historyTarget, kind: 'recent', pane: null, state: 'exited' };
  return session && triageVisible(item) ? sessionItem('recent', session) : null;
}
function triageItems() {
  const items = [
    ...queueItems().filter(triageVisible),
    ...(state.showRunning ? runningItems().filter(triageVisible) : []),
    ...(state.showPinned !== false ? pinnedItems().filter(triageVisible) : []),
    ...(state.showRecent ? recentItems().filter(triageVisible) : []),
  ];
  return [...items, ...retainSelection(items, state.currentItem, state.selectedKey, itemKey, triageKey,
    retainedSelectionItem)];
}
function knownProjects() {
  const values = new Map();
  const add = (projectPath) => {
    if (!projectPath) return;
    const project = projectOf(projectPath);
    if (!values.has(project.key) || !values.get(project.key).path.startsWith('/')) values.set(project.key, project);
  };
  for (const session of data.sessions || []) add(session.project);
  for (const pane of data.panes || []) add(pane.meta?.project || pane.cwd);
  return [...values.values()].sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
}
function projectHTML(projectPath, large = false) {
  const project = projectOf(projectPath);
  return `<span class="pj ${large ? 'lg' : ''}" style="--h:${project.h}">${projectIcon(project)}${esc(project.name)}${project.wt ? `<span class="wt">${esc(project.wt)}</span>` : ''}</span>`;
}
function tagsHTML(task) {
  return (task?.fm?.tags || []).map((tag) => `<span class="tagc ${(data.scopes || globalThis.KeepScopeRules.defaults).names.includes(tag) ? 'scope-tag' : ''}">${esc(tag)}</span>`).join('');
}
function kindLabel(kind) { return ({ question: 'question', permission: 'permission', rateLimit: 'limit', complete: 'done', input: 'input', plan: 'plan', running: 'running', pinned: 'pinned', recent: 'recent' })[kind] || kind; }
function limitResumeFor(sessionId) {
  return [...(data.limitResume?.waiting || []), ...(data.limitResume?.stalled || [])].find((row) => row.id === sessionId);
}
function toast(message, action) {
  toast.cancel?.();
  const container = document.querySelector('#toast');
  const element = document.createElement('div');
  element.className = 'toast-body';
  element.append(document.createTextNode(message));
  let hideTimer;
  let removeTimer;
  const remove = () => {
    clearTimeout(removeTimer);
    if (element.parentElement === container) element.remove();
  };
  const hide = () => {
    clearTimeout(hideTimer);
    element.classList.remove('show');
    element.addEventListener('transitionend', remove, { once: true });
    clearTimeout(removeTimer);
    removeTimer = setTimeout(remove, 200);
  };
  if (action) {
    const button = document.createElement('button');
    button.textContent = action.label;
    button.addEventListener('click', () => { hide(); action.run(); });
    element.append(button);
  }
  container.replaceChildren(element);
  void element.offsetHeight;
  element.classList.add('show');
  hideTimer = setTimeout(hide, action ? 6000 : 2000);
  toast.cancel = () => {
    clearTimeout(hideTimer);
    clearTimeout(removeTimer);
    element.remove();
  };
}
function deriveDismissed() {
  state.dismissed = new Set(Object.keys(data.setAside || {}));
  for (const [key, entry] of optimisticSetAside) {
    if (entry) state.dismissed.add(key);
    else state.dismissed.delete(key);
  }
}
function setAsideFor(item) {
  const key = itemKey(item);
  return optimisticSetAside.has(key) ? optimisticSetAside.get(key) : data.setAside?.[key] || null;
}
async function setAside(item, kind = 'dismiss', minutes) {
  if (state.historyTarget?.sessionId === item.sessionId) state.historyTarget = null;
  const key = itemKey(item);
  const now = Date.now();
  optimisticSetAside.set(key, {
    kind, until: kind === 'snooze' ? now + (minutes || 60) * 60e3 : null, at: now, since: item.since,
  });
  state.dismissed.add(key);
  state.focused = false;
  refresh();
  try {
    await api.setAside(key, kind, minutes);
    toast(kind === 'dependency' ? 'Waiting for dependency. New messages or changed dependencies bring it back.' : kind === 'snooze' ? 'Snoozed for 1 hour.' : 'Dismissed. Restore it from the collapsed row.', { label: 'Undo', run: () => restore(key) });
  } catch (error) {
    optimisticSetAside.delete(key);
    deriveDismissed();
    refresh();
    toast(`Could not set aside: ${error.message}`);
  }
}
function dismiss(item) { return setAside(item, 'dismiss'); }
async function restore(key) {
  optimisticSetAside.set(key, null);
  state.dismissed.delete(key);
  state.showDismissed = false;
  refresh();
  try {
    await api.setAside(key, 'clear');
    toast('Back in the queue.');
  } catch (error) {
    optimisticSetAside.delete(key);
    deriveDismissed();
    refresh();
    toast(`Could not restore: ${error.message}`);
  }
}
function toggleRunning() {
  state.showRunning = !state.showRunning;
  try { sessionStorage.setItem('keep-running-expanded', state.showRunning ? '1' : '0'); } catch {}
  refresh();
}
function toggleRecent() {
  state.showRecent = !state.showRecent;
  try { sessionStorage.setItem('keep-recent-expanded', state.showRecent ? '1' : '0'); } catch {}
  refresh();
}
function toggleFocus(value = !state.focusMode, render = true) {
  state.focusMode = value;
  state.focusItemKey = null;
  try { localStorage.setItem('keep.console.focus', value ? '1' : '0'); } catch {}
  state.ensureSelectedVisible = true;
  toast(value ? 'Focus on' : 'Focus off');
  if (render) refresh();
}
function pinnedLayout() { return state.layouts.find((layout) => layout.role === 'pinned'); }
function isPanePinned(pane) { return Boolean(pane && pinnedLayout()?.ids.includes(pane)); }
function knownPaneCount(layout) {
  const known = paneMap();
  return layout.ids.filter((id) => known.has(id)).length;
}
function applyLayouts(value) {
  if (!Array.isArray(value?.layouts)) return;
  const layouts = value.layouts.length ? value.layouts : [{ name: 'Pinned', ids: [], cols: 0, role: 'pinned' }];
  const next = layouts.map((layout) => ({ ...layout, ids: [...layout.ids] }));
  if (!next.some((layout) => layout.role === 'pinned')) {
    const legacy = next.find((layout) => layout.name === 'Pinned');
    if (legacy) legacy.role = 'pinned';
  }
  for (let index = 0; index < next.length; index += 1) {
    if (state.layouts[index]) {
      if (!next[index].role) delete state.layouts[index].role;
      Object.assign(state.layouts[index], next[index]);
    }
    else state.layouts.push(next[index]);
  }
  state.layouts.length = next.length;
  if (state.layout >= state.layouts.length) state.layout = 0;
}
async function saveLayouts() {
  const revision = ++layoutRevision;
  const known = paneMap();
  const snapshot = state.layouts.map((layout) => ({
    ...layout,
    ids: layout.ids.filter((id) => known.has(id)),
  }));
  applyLayouts({ layouts: snapshot });
  layoutSavesPending += 1;
  try {
    const saved = await (layoutSaveChain = layoutSaveChain.catch(() => {}).then(() => api.putLayouts(snapshot)));
    if (revision === layoutRevision) applyLayouts(saved);
    return saved;
  } finally {
    layoutSavesPending -= 1;
  }
}
async function dropPane(pane) {
  droppedPanes.add(pane);
  const mounts = terminals.get(pane);
  if (mounts) {
    for (const entry of mounts.values()) entry.mounted.dispose();
    terminals.delete(pane);
  }
  data.panes = (data.panes || []).filter((candidate) => candidate.id !== pane);
  if (state.focusPane === pane) state.focusPane = null;
  let changed = false;
  for (const layout of state.layouts) {
    const ids = layout.ids.filter((id) => id !== pane);
    if (ids.length !== layout.ids.length) changed = true;
    layout.ids = ids;
  }
  refresh();
  if (!changed) return;
  await saveLayouts();
}
async function pinPane(pane, title) {
  if (!pane) { toast('No host pane; reopen the session with keep open.'); return; }
  let pinned = pinnedLayout();
  if (!pinned) { pinned = { name: 'Pinned', ids: [], cols: 0, role: 'pinned' }; state.layouts.push(pinned); }
  const wasPinned = pinned.ids.includes(pane);
  if (wasPinned) pinned.ids = pinned.ids.filter((id) => id !== pane);
  else pinned.ids.push(pane);
  try {
    await saveLayouts();
    toast(wasPinned ? `Unpinned “${title}” from Watch` : `Pinned “${title}” to Watch › ${pinned.name}`);
    refresh();
    return true;
  } catch (error) {
    // Undo the optimistic edit so the client does not believe a pin the server never stored.
    if (wasPinned) pinned.ids.push(pane); else pinned.ids = pinned.ids.filter((id) => id !== pane);
    toast(error.message);
    return false;
  }
}
async function startShell(cwd, name) {
  const result = await api.spawnPane(cwd, name);
  const known = data.panes.find((pane) => pane.id === result.pane.id);
  if (known) Object.assign(known, result.pane);
  else data.panes.push(result.pane);
  return result.pane;
}
async function reopenSession({ sessionId, taskId, agent, title, stalePane }) {
  const key = taskId ? `task:${taskId}` : `session:${sessionId}`;
  if (reopeningSessions.has(key)) return reopeningSessions.get(key);
  const operation = (async () => {
    toast(`Reopening “${title || taskId || sessionId}”…`);
    try {
      const result = await api.openSession(taskId ? { taskId } : { sessionId, agent });
      // The old exited pane has nothing left to show once the session lives elsewhere.
      if (stalePane && stalePane !== result.pane && paneMap().get(stalePane)?.alive === false) {
        try { await api.removePane(stalePane); await dropPane(stalePane); } catch {}
      }
      await reload();
      toast(`Reopened "${title}" in pane ${result.pane}`, {
        label: 'Pin', run: () => pinPane(result.pane, title),
      });
      return result;
    } catch (error) {
      toast(`Could not reopen: ${error.message}`);
      return null;
    }
  })();
  reopeningSessions.set(key, operation);
  try { return await operation; }
  finally { reopeningSessions.delete(key); }
}
async function removePane(pane) {
  await api.removePane(pane);
  await dropPane(pane);
}
function mount(container, pane, options = {}) {
  // Triage and Watch are mutually exclusive views of the same local terminal.
  // Reuse its viewer/control ownership when moving it between pages; a second
  // mount would remain an observer of the now-hidden page's PTY dimensions.
  const slot = options.slot === 'triage' || options.slot === `watch:${pane}` ? 'console' : options.slot || pane;
  let mounts = terminals.get(pane);
  if (!mounts) { mounts = new Map(); terminals.set(pane, mounts); }
  let entry = mounts.get(slot);
  const currentPane = paneMap().get(pane);
  const pid = currentPane?.pid;
  const agentSession = Boolean(currentPane?.meta?.sessionId || data.sessions.some((session) => session.pane === pane));
  // SessionEnd may demote an agent pane to shell before its restart exits.
  // Preserve its identity across that transient observation, not across PIDs.
  if (entry && agentSession) entry.agentSession = true;
  if (entry && pid && entry.pid && entry.pid !== pid) {
    options = { ...options, focus: options.focus || entry.mounted.element.contains(document.activeElement) };
    entry.mounted.dispose();
    mounts.delete(slot);
    entry = null;
  }
  if (!entry) {
    entry = { options, pid, agentSession };
    entry.mounted = mountTerminal(container, pane, {
      ...options,
      slot,
      onFocus(terminal, element) {
        state.focused = true;
        document.querySelectorAll('.term.focused').forEach((term) => term.classList.remove('focused'));
        element.classList.add('focused');
        entry.options.onFocus?.(terminal, element);
      },
      onExit() {
        const agent = paneMap().get(pane)?.meta?.agent;
        if (!entry.agentSession && (!agent || agent === 'shell')) {
          dropPane(pane).catch((error) => toast(`Pane cleanup failed: ${error.message}`));
        } else refresh();
        entry.options.onExit?.();
      },
    });
    mounts.set(slot, entry);
    if (options.focus) entry.mounted.focus();
  } else {
    entry.options = options;
    if (entry.mounted.element.parentElement !== container) container.replaceChildren(entry.mounted.element);
    entry.mounted.show(Boolean(options.focus));
    if (options.focus && !entry.mounted.element.contains(document.activeElement)) {
      scheduleFocus(entry.mounted);
    }
  }
  entry.render = terminalRender;
  visibleTerminals.push(entry.mounted);
  return entry.mounted;
}
function disposeUnusedTerminals(focused) {
  const known = paneMap();
  const hidden = [];
  for (const [pane, mounts] of terminals) {
    for (const [slot, entry] of mounts) {
      if (entry.render === terminalRender) { entry.hiddenSince = null; continue; }
      entry.mounted.hide();
      entry.hiddenSince ??= Date.now();
      if (!known.has(pane) || Date.now() - entry.hiddenSince > 5 * 60e3) {
        setTimeout(() => entry.mounted.dispose(), 0);
        mounts.delete(slot);
      } else hidden.push({ pane, slot, entry, mounts });
    }
    if (!mounts.size) terminals.delete(pane);
  }
  hidden.sort((a, b) => b.entry.hiddenSince - a.entry.hiddenSince);
  for (const { pane, slot, entry, mounts } of hidden.slice(8)) {
    entry.mounted.dispose();
    mounts.delete(slot);
    if (!mounts.size) terminals.delete(pane);
  }
  if (focused && focused.render === terminalRender && state.focused
      && !focused.mounted.element.contains(document.activeElement)) {
    scheduleFocus(focused.mounted);
  }
}
function scheduleFocus(mounted) {
  cancelAnimationFrame(focusFrame);
  const stillWanted = captureFocusIntent();
  const container = mounted.element.parentElement;
  focusFrame = requestAnimationFrame(() => {
    if (mounted.element.parentElement !== container || !visibleTerminals.includes(mounted)
        || !mounted.element.isConnected || !mounted.element.getClientRects().length) return;
    // A click or keyboard action after scheduling owns focus now.
    if (!stillWanted()) return;
    mounted.focus();
  });
}
function scheduleTerminalFit() {
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    for (const mounted of new Set(visibleTerminals)) mounted.fit();
  });
}
function patchHTML(element, html) {
  if (renderedHTML.get(element) === html) return false;
  element.innerHTML = html;
  renderedHTML.set(element, html);
  return true;
}
function clearElement(element) {
  element.replaceChildren();
  renderedHTML.delete(element);
}

function renderMeters() {
  const meters = [
    ...(data.usage?.claude?.limits || []).map((limit) => ({ ...limit, source: 'claude' })),
    ...(data.usage?.codex?.windows || []).map((window) => ({ ...window, label: `Codex ${window.label}`, source: 'codex' })),
  ];
  document.querySelector('#meters').innerHTML = meters.map((meter) => {
    const percent = Math.max(0, Math.min(100, Number(meter.percent) || 0));
    return `<span class="meter" title="${meter.resetsAt ? `resets ${esc(new Date(meter.resetsAt).toLocaleString())}` : ''}"><span class="meter-label">${esc(meter.label)}</span><i><b class="${percent >= 75 ? 'warn' : ''}" style="width:${percent}%"></b></i><span>${Math.round(percent)}%</span></span>`;
  }).join('') || '<span class="meter">usage unavailable</span>';
}
function renderHealth() {
  const health = data.health || {};
  const unhealthy = (health.schedulers || []).filter((row) => ['failing', 'silent', 'never'].includes(row.state));
  const button = document.querySelector('#health');
  button.classList.toggle('bad', !health.daemon?.running || unhealthy.length > 0);
  button.querySelector(':scope > span').textContent = !health.daemon?.running ? 'daemon: offline' : unhealthy.length ? `daemon: ${unhealthy[0].name} ${unhealthy[0].state}` : 'daemon: healthy';
  const enable = notificationPermission() === 'default' ? '<button class="btn notify-enable">Enable notifications</button>' : '';
  button.querySelector('.pop').innerHTML = `<b>keep serve</b> · pid ${esc(health.daemon?.pid || '—')}${enable}<dl>${(health.schedulers || []).map((row) => `<dt>${esc(row.name)}</dt><dd class="${['failing', 'silent', 'never'].includes(row.state) ? 'bad' : ''}">${esc(row.state)}${row.detail ? ` · ${esc(row.detail)}` : ''}${row.lastError ? ` · ${esc(row.lastError)}` : ''}</dd>`).join('')}</dl>`;
  button.querySelector('.notify-enable')?.addEventListener('click', async (event) => {
    event.stopPropagation();
    const permission = await requestPermission();
    toast(permission === 'granted' ? 'Notifications enabled.' : 'Notifications were not enabled.');
    renderHealth();
  });
}
function renderTop() {
  renderMeters();
  renderHealth();
  const count = queueItems().filter((item) => !state.dismissed.has(itemKey(item))).length;
  setBadge(count + (data.notifications || []).filter((entry) => !entry.read).length);
  if (attentionSeeded) attentionSound.update(queueItems()
    .filter((item) => !state.dismissed.has(itemKey(item))).map(soundEventKey));
  document.querySelector('#qcount').textContent = count;
  document.querySelector('#qcount').classList.toggle('zero', count === 0);
  const sessionCount = data.sessions?.length || 0;
  const paneCount = data.panes?.length || 0;
  document.querySelector('#connection').textContent = `${sessionCount} session${sessionCount === 1 ? '' : 's'} · ${paneCount} pane${paneCount === 1 ? '' : 's'}`;
  updateDockButton();
  renderReviewerTop(ctx);
}

function dockAvailable() { return window.innerWidth >= 1100; }
function updateDockButton() {
  const button = document.querySelector('#dockbtn');
  const available = dockAvailable();
  button.disabled = !available;
  button.classList.toggle('on', available && state.dock);
  button.classList.toggle('unavailable', !available);
  button.querySelector('span').textContent = available ? 'Reviewer pane' : 'Reviewer pane unavailable';
  button.title = available ? 'show the reviewer beside any mode' : 'reviewer pane unavailable below 1100px';
}

function refresh() {
  if (interactionGuard.defer()) return;
  terminalRender += 1;
  visibleTerminals = [];
  let focused;
  for (const mounts of terminals.values()) {
    focused = [...mounts.values()].find((entry) => entry.mounted.element.contains(document.activeElement)) || focused;
  }
  document.querySelectorAll('.mode').forEach((element) => element.classList.toggle('on', element.id === state.mode));
  document.querySelectorAll('.modes [data-mode]').forEach((button) => button.classList.toggle('on', button.dataset.mode === state.mode));
  renderTop();
  notificationPanel.update(data);
  historyControls?.update();
  if (state.mode === 'triage') renderTriage(ctx);
  else if (state.mode === 'watch') renderWatch(ctx);
  else if (state.mode === 'reviewer') renderReviewer(ctx);
  else renderFleet(ctx);
  renderDock(ctx);
  disposeUnusedTerminals(focused);
  scheduleTerminalFit();
}
function setMode(mode) {
  historyControls?.close();
  state.mode = mode;
  state.focused = false;
  try { localStorage.setItem('keep-mode', mode); } catch {}
  refresh();
}
function setDock(value) {
  if (value && !dockAvailable()) return;
  state.dock = value;
  try { localStorage.setItem('keep-dock', value ? '1' : '0'); } catch {}
  refresh();
}
function toggleCollapsed(panel) {
  state.collapsed[panel] = !state.collapsed[panel];
  try { localStorage.setItem('keep.console.collapsed', JSON.stringify(state.collapsed)); } catch {}
  refresh();
  scheduleTerminalFit();
}
let projectChoicesBusy = false;
let projectChoicesCheckedAt = 0;
async function refreshProjectChoices() {
  if (projectChoicesBusy || Date.now() - projectChoicesCheckedAt < 10000) return;
  projectChoicesBusy = true;
  projectChoicesCheckedAt = Date.now();
  try {
    const paths = [...new Set([
      ...(data.sessions || []).map((session) => session.project),
      ...(data.panes || []).map((pane) => pane.meta?.project || pane.cwd),
      ...(data.tasks || []).map((task) => task.fm?.project),
    ].filter(Boolean))];
    const result = { projects: Object.create(null) };
    for (let offset = 0; offset < paths.length; offset += 200) {
      const batch = await api.write('/api/project-icons', { projects: paths.slice(offset, offset + 200) });
      if (!batch?.projects || typeof batch.projects !== 'object' || Array.isArray(batch.projects)) return;
      Object.assign(result.projects, batch.projects);
    }
    if (JSON.stringify(result.projects) !== JSON.stringify(projectChoices)) {
      const filteredProject = state.filter && knownProjects().find((project) => project.key === state.filter);
      projectChoices = result.projects;
      // Canonicalizing a newly discovered worktree must preserve the active filter.
      if (filteredProject) state.filter = projectOf(filteredProject.path).key;
      refresh();
    }
  } catch { /* Older/offline daemons keep the immediate folder fallback. */ }
  finally { projectChoicesBusy = false; }
}

let reloadRetry;
let pendingNotificationKey = null;
async function reload() {
  clearTimeout(reloadRetry);
  const generation = ++reloadGeneration;
  const revision = layoutRevision;
  try {
    const [nextData, nextLayouts] = await Promise.all([
      api.getState(),
      layoutSavesPending ? null : api.getLayouts(),
    ]);
    if (generation < appliedReloadGeneration) return;
    appliedReloadGeneration = generation;
    data = nextData;
    closingSessions.reconcile(data);
    void refreshProjectChoices();
    optimisticSetAside.clear();
    deriveDismissed();
    for (const pane of [...droppedPanes]) {
      if ((data.panes || []).some((candidate) => candidate.id === pane)) {
        data.panes = data.panes.filter((candidate) => candidate.id !== pane);
      } else droppedPanes.delete(pane);
    }
    if (nextLayouts && revision === layoutRevision) applyLayouts(nextLayouts);
    applyStateEffects();
    if (!historyRestored) {
      historyRestored = true;
      if (sessionHistory.current && ['triage', 'watch'].includes(state.mode) && !state.focusMode && !pendingNotificationKey) navigateHistory(sessionHistory.current, false);
    }
    refresh();
    if (pendingNotificationKey) {
      const key = pendingNotificationKey;
      if (key.startsWith('alert:')) notificationPanel.open(key.slice(6));
      else selectAttention(key);
      pendingNotificationKey = null;
      acknowledgeNotificationClick(key);
    }
  } catch (error) {
    if (generation >= appliedReloadGeneration) {
      toast(`State refresh failed: ${error.message}`);
      reloadRetry = setTimeout(reload, 1500);
    }
  }
}

function rememberSession(sessionId, view = state.mode) {
  if (!sessionId || !['triage', 'watch'].includes(view)) return;
  const session = data.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  sessionHistory.visit({ sessionId, view, title: session.title, project: session.project,
    layout: view === 'watch' ? state.layouts[state.layout]?.name : '', at: Date.now() });
  historyControls?.update();
}

// Navigation never opens a process, changes pin layouts, or clears dismissal.
// A removed Watch layout/pane falls back to a read-only Triage selection.
function navigateHistory(entry, focus = true) {
  const session = data.sessions.find((s) => s.id === entry.sessionId);
  const pane = session?.pane && paneMap().get(session.pane);
  let layout = state.layouts.findIndex((l) => l.name === entry.layout && l.ids.includes(pane?.id));
  if (layout < 0) layout = state.layouts.findIndex((l) => l.ids.includes(pane?.id));
  const watch = entry.view === 'watch' && pane?.alive && layout >= 0;
  state.mode = watch ? 'watch' : 'triage';
  if (watch) { state.layout = layout; state.editing = false; }
  state.filter = null;
  if (state.focusMode) toggleFocus(false, false);
  state.historyTarget = { ...entry, kind: 'recent', state: 'exited', pane: null };
  state.currentItem = session ? sessionItem('recent', session) : state.historyTarget;
  state.selectedKey = triageKey(state.currentItem);
  state.ensureSelectedVisible = true;
  state.focused = false;
  state.focusPane = focus && pane?.alive ? pane.id : null;
  try { localStorage.setItem('keep-mode', state.mode); } catch {}
}

const ctx = {
  state, get data() { return data; }, closingSessions, isClosingSession, beginClose, esc, rel, projectOf, projectIcon, projectHTML, tagsHTML, knownProjects,
  queueItems, runningItems, pinnedItems, recentItems, triageItems, toggleCollapsed, toggleRunning, toggleRecent, setSelected,
  itemKey, triageKey, eventKey, sessionFor, taskFor, paneMap, entityForPane, kindLabel, limitResumeFor, toast, dismiss, restore, setAside, setAsideFor,
  pinPane, startShell, reopenSession, removePane, isPanePinned, knownPaneCount, saveLayouts, dropPane, mount, patchHTML, clearElement, refresh, reload,
  scheduleTerminalFit, setMode, setDock, toggleFocus, focusTerminal, focusDebug, retainedSelectionItem,
};

historyControls = installSessionHistory({ history: sessionHistory, esc,
  describe: (entry) => {
    const session = data.sessions.find((s) => s.id === entry.sessionId);
    const pane = session?.pane && paneMap().get(session.pane);
    return { title: session?.title || entry.title || entry.sessionId,
      project: projectOf(session?.project || entry.project).name,
      status: pane?.alive === false ? 'Closed' : session ? sessionLabel(session) : 'Not in fleet' };
  },
  navigate: (entry) => { navigateHistory(entry); refresh(); },
});
function rememberPaneEvent(event) {
  if (!(event.target instanceof Element) || event.target.closest('button, a, input, select') && !event.target.closest('.xterm')) return;
  if (state.mode === 'watch') {
    const paneId = event.target.closest('.wpane')?.dataset.pane;
    if (paneId) rememberSession(paneMap().get(paneId)?.meta?.sessionId);
  } else if (state.mode === 'triage' && event.target.closest('#stage .term')) rememberSession(state.currentItem?.sessionId);
}
document.addEventListener('pointerdown', rememberPaneEvent);
let historyTabAt = 0;
document.addEventListener('keydown', function trackHistoryTab(event) { historyTabAt = event.key === 'Tab' ? Date.now() : 0; }, true);
document.addEventListener('focusin', (event) => {
  if (historyTabAt && Date.now() - historyTabAt < 500) { historyTabAt = 0; rememberPaneEvent(event); }
});

// The daemon relays 'Open on Mac' from the phone as a focus event; jump to that session.
function focusSession(sessionId) {
  if (!sessionId) return;
  const item = (data.attention || []).find((candidate) => candidate.sessionId === sessionId);
  window.focus();
  if (item) { selectAttention(attentionKey(item)); return; }
  const session = (data.sessions || []).find((candidate) => candidate.id === sessionId);
  toast(session ? `${session.title || sessionId.slice(0, 8)} is not waiting on you` : `Session ${sessionId.slice(0, 8)} is not in the fleet list`);
}
function selectAttention(key) {
  state.filter = null;
  const active = queueItems().filter((candidate) => !state.dismissed.has(itemKey(candidate)));
  const index = active.findIndex((candidate) => attentionKey(candidate) === key);
  if (index < 0) { toast('This item is no longer waiting on you.'); return; }
  setSelected(index);
  state.ensureSelectedVisible = true;
  setMode('triage');
}

function applyStateEffects() {
  const current = new Set((data.attention || []).map(attentionKey));
  const count = queueItems().filter((item) => !state.dismissed.has(itemKey(item))).length;
  setBadge(count + (data.notifications || []).filter((entry) => !entry.read).length);
  if (!attentionSeeded) {
    attentionKeys = current;
    attentionSeeded = true;
    return;
  }
  for (const key of [...attentionKeys]) if (!current.has(key)) attentionKeys.delete(key);
  for (const item of data.attention || []) {
    const key = attentionKey(item);
    if (!attentionKeys.has(key) && !state.dismissed.has(itemKey(item)) && Number(item.pri) === 0 && ['question', 'permission', 'plan', 'input'].includes(item.kind)
        && !(document.hasFocus() && state.mode === 'triage')) {
      const project = projectOf(item.project);
      notify({
        title: `${project.name} · ${item.title || 'Session needs you'}`,
        body: item.question || item.detail || 'Waiting for your input.',
        tag: key,
        onClick: () => selectAttention(key),
      });
    }
    attentionKeys.add(key);
  }
}

function installBootControls() {
  const help = document.querySelector('#help');
  const health = document.querySelector('#health');
  const openHelp = () => help.classList.add('on');
  document.querySelectorAll('.modes [data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
  const themePicker = document.querySelector('#themePicker');
  const themeButton = document.querySelector('#themebtn');
  renderPalettePicker({ mode: resolvedTheme(), palette: getPalette() });
  themePicker.addEventListener('click', (event) => {
    event.stopPropagation();
    const preferenceButton = event.target.closest('[data-theme-preference]');
    if (preferenceButton) {
      setPreference(preferenceButton.dataset.themePreference);
      applyTheme();
      return;
    }
    const paletteButton = event.target.closest('[data-pick-palette]');
    if (paletteButton) {
      setPalette(paletteButton.dataset.pickPalette);
      applyTheme();
      return;
    }
    if (!event.target.closest('#themebtn')) return;
    const opening = !themePicker.classList.contains('open');
    health.classList.remove('open');
    closeReviewerPopover();
    themePicker.classList.toggle('open', opening);
    themeButton.setAttribute('aria-expanded', String(opening));
  });
  document.querySelector('#dockbtn').addEventListener('click', () => setDock(!state.dock));
  // A collapsed strip is one big affordance: clicking anywhere on it expands, except the
  // rail's project dots, which keep filtering while collapsed.
  document.addEventListener('click', (event) => {
    if (event.target.closest('.collapse')) return;
    const strip = event.target.closest('.queue-strip.on, .rside-strip.on');
    if (strip) { toggleCollapsed(strip.classList.contains('queue-strip') ? 'queue' : 'rside'); return; }
    if (event.target.closest('.rail.collapsed') && !event.target.closest('.rail-dot')) toggleCollapsed('rail');
  });
  health.addEventListener('click', (event) => { event.stopPropagation(); closePalettePopover(); closeReviewerPopover(); health.classList.toggle('open'); });
  // The chip is a div (its popover holds a button), so give it the button's keyboard behaviour.
  health.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); health.click(); } });
  document.addEventListener('click', () => { health.classList.remove('open'); closePalettePopover(); closeReviewerPopover(); });
  help.addEventListener('click', () => help.classList.remove('on'));
  const helpKey = [...document.querySelectorAll('.keys span')].find((element) => element.textContent.includes('all keys'));
  helpKey?.classList.add('help-key');
  helpKey?.addEventListener('click', openHelp);
  installWatchControls(ctx);
  installTriageControls(ctx);
}

Object.defineProperty(window, 'keepConsole', {
  value: Object.freeze({
    get terminals() {
      const visible = new Map();
      for (const [pane, mounts] of terminals) {
        const entry = [...mounts.values()].find((candidate) => candidate.render === terminalRender) || mounts.values().next().value;
        if (!entry) continue;
        visible.set(pane, Object.freeze({
          terminal: entry.mounted.terminal,
          get socket() { return entry.mounted.socket; },
        }));
      }
      return visible;
    },
    version: 1,
  }),
});

installBootControls();

// Selection is remembered by section and item key so a row appearing or leaving
// above the selection cannot silently move it onto a different session or copy.
function setSelected(index, explicit = false) {
  focusDebug('select-request', { reason: explicit ? 'user' : 'programmatic' });
  const items = triageItems();
  if (typeof index === 'string') {
    const key = index;
    index = items.findIndex((item) => triageKey(item) === key);
    // A session can change section while its pressed row is held on screen.
    if (index < 0) index = items.findIndex((item) => itemKey(item) === key.slice(key.indexOf(':') + 1));
    // A disappearing row is not permission to select its new neighbour.
    if (index < 0) return;
  }
  state.selected = Math.max(0, Math.min(items.length - 1, index));
  state.selectedKey = items[state.selected] ? triageKey(items[state.selected]) : null;
  focusDebug('select-resolved', { reason: explicit ? 'user' : 'programmatic',
    selected: state.selectedKey || '', session: items[state.selected]?.sessionId || '', pane: items[state.selected]?.pane || '' });
  if (explicit && state.focusMode && items[state.selected]
      && (state.selected !== 0 || !state.selectedKey.startsWith('waiting:'))) toggleFocus(false, false);
  if (explicit) {
    const item = items[state.selected];
    if (state.focusMode) state.focusItemKey = item ? itemKey(item) : null;
    if (item?.sessionId !== state.historyTarget?.sessionId) state.historyTarget = null;
    rememberSession(item?.sessionId, 'triage');
    if (item?.pane && paneMap().get(item.pane)?.alive) state.focusPane = item.pane;
  }
}
function moveQueue(direction, defer = false) {
  setSelected(state.selected + direction, true);
  state.focused = false;
  state.ensureSelectedVisible = true;
  if (defer) setTimeout(refresh, 0);
  else refresh();
}
function focusTerminal(explicit = false) {
  const terminal = visibleTerminals[0];
  if (!terminal) return;
  if (explicit) rememberSession(state.mode === 'triage' ? state.currentItem?.sessionId
    : paneMap().get(terminal.element.closest('.wpane')?.dataset.pane)?.meta?.sessionId);
  state.focused = true;
  terminal.element.classList.add('focused');
  terminal.focus();
}
function focusQueue() {
  state.focused = false;
  document.querySelector('#qlist .qitem.sel')?.focus();
  document.querySelectorAll('.term.focused').forEach((element) => element.classList.remove('focused'));
}

document.addEventListener('keydown', (event) => {
  if (document.querySelector('#notificationsPanel')?.open) return;
  if (event.target instanceof Element && (event.target.closest('dialog')
      || (!event.metaKey && !event.ctrlKey && !event.altKey && event.target.closest('#sessionHistory')))) return;
  const key = event.key;
  const lower = key.toLowerCase();
  const inInput = event.target instanceof Element && event.target.matches('input, select, textarea');
  const inTerminal = event.target instanceof Element && event.target.closest('.term');
  const terminalFocused = document.activeElement instanceof Element && document.activeElement.closest('.term');
  const help = document.querySelector('#help');
  const health = document.querySelector('#health');
  const paletteOpen = document.querySelector('#themePicker').classList.contains('open');
  const reviewerStatsOpen = document.querySelector('#rterm .acts')?.classList.contains('open');
  // Plain keys belong to a focused terminal; Escape only closes app popovers.
  const termFocus = Boolean(state.pendingFocus || inTerminal || terminalFocused);
  if (termFocus && !event.metaKey && key !== 'Escape') return;
  if (key === 'Escape' && (help.classList.contains('on') || health.classList.contains('open') || paletteOpen || reviewerStatsOpen)) {
    help.classList.remove('on');
    health.classList.remove('open');
    closePalettePopover();
    closeReviewerPopover();
    event.preventDefault();
    return;
  }
  if (help.classList.contains('on')) {
    if (key === 'Escape' || !inInput) { document.querySelector('#help').classList.remove('on'); event.preventDefault(); }
    return;
  }
  if (key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey && !inInput) {
    help.classList.add('on');
    event.preventDefault();
    return;
  }
  if (event.metaKey && lower === 'r' && !event.shiftKey) { event.preventDefault(); location.reload(); return; } // no reload menu in the desktop shell
  if (event.metaKey && ['v', 'q', 'w', 't', 'n'].includes(lower)) return;
  if (event.metaKey && lower === 'b') {
    event.preventDefault();
    if (event.shiftKey) {
      if (state.mode === 'reviewer') toggleCollapsed('rside');
      else toast('Reviewer panel is only in Reviewer mode');
    } else toggleCollapsed('rail');
    return;
  }
  if (event.metaKey && key === '\\') { event.preventDefault(); toggleCollapsed('queue'); return; }
  if (event.metaKey && /^[1-4]$/.test(key)) {
    setMode(['triage', 'watch', 'reviewer', 'fleet'][Number(key) - 1]);
    event.preventDefault();
    return;
  }
  if (event.metaKey && key === 'Enter') {
    // The terminal owns Cmd+Enter (multiline input); let its handler receive it.
    if (termFocus) return;
    if (state.focused || termFocus) focusQueue(); else focusTerminal(true);
    event.preventDefault();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey || inInput || state.focused || termFocus) return;
  if (key === 'R' && event.shiftKey) { setDock(!state.dock); event.preventDefault(); return; }
  if (key === 'F' && event.shiftKey) { toggleFocus(); event.preventDefault(); return; }
  if (key === 'r' && !event.shiftKey) { setMode('reviewer'); event.preventDefault(); return; }
  if ({ t: 'triage', w: 'watch', f: 'fleet' }[key]) { setMode({ t: 'triage', w: 'watch', f: 'fleet' }[key]); event.preventDefault(); return; }
  if (state.mode === 'watch' && key === 'e') { state.editing = !state.editing; refresh(); event.preventDefault(); return; }
  if (state.mode !== 'triage') return;
  if (key === 'j' || key === 'ArrowDown') { moveQueue(1); event.preventDefault(); }
  else if (key === 'k' || key === 'ArrowUp') { moveQueue(-1); event.preventDefault(); }
  else if (key === 'p') state.currentActions.pin?.();
  else if (key === 'x') state.currentActions.dismiss?.();
  else if (/^[1-9]$/.test(key)) state.currentActions.number?.(Number(key));
}, true);

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    updateDockButton();
    for (const mounts of terminals.values()) {
      for (const entry of mounts.values()) entry.mounted.syncVisibility();
    }
    scheduleTerminalFit();
  }, 100);
});
window.addEventListener('focus', () => { if (markReviewerSeen(ctx)) refresh(); });
document.addEventListener('visibilitychange', () => {
  for (const mounts of terminals.values()) {
    for (const entry of mounts.values()) entry.mounted.syncVisibility();
  }
  if (markReviewerSeen(ctx)) refresh();
});

const attentionSound = installAttentionSound({ onPlay: () => focusDebug('attention-sound', { reason: 'new-request-v2' }) });
focusDebug('attention-sound-ready', { reason: 'turn-request-v2' });
const notificationPanel = installNotifications({
  reload, toast,
  openSession(sessionId) {
    rememberSession(sessionId, 'triage');
    navigateHistory({ sessionId, view: 'triage' });
    refresh();
  },
  openReviewer: () => setMode('reviewer'),
});

document.querySelector('#connection').textContent = 'connecting';
installNotificationClicks((key) => { pendingNotificationKey = key; reload(); });
// Subscribe even when the first request fails. EventSource reconnects after a
// daemon restart; every successful connection refreshes the snapshot as well.
api.subscribe(reload, (status) => {
  document.querySelector('#connection').dataset.status = status;
  if (status === 'live') reload();
}, focusSession);
reload();
