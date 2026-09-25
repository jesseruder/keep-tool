import './shared/scope-rules.js';
import { PROJECTS } from './project-catalog.js';
import { projectIcon } from './project-icons.js';
import { installAttentionSound, soundEventKey } from './attention-sound.js';
import { installNotifications } from './notifications.js';
import { PALETTES, paletteById, swatches } from './palettes.js';
import { applyTheme, getPalette, getPreference, onThemeChange, resolvedTheme, setPalette, setPreference, xtermTheme } from './theme.js';
import * as api from './api.js';
import { installActionFeedback } from './action.js';
import { statusChipState } from './status-chip.js';
import { humanAttention, countsTowardBadge, sessionLabel, hostOutage, hostOutageText } from './status.js';
import { createClosingSessions } from './closing-sessions.js';
import { installInteractionGuard } from './interaction-guard.js';
import { captureFocusIntent } from './focus-intent.js';
import { mountTerminal } from './terminal.js';
import { setTerminalRendererPreference } from './terminal-renderer.js';
import { setPredictTypingPreference } from './predict-typing.js';
import { installFocusDebug } from './focus-debug.js';
import { retainSelection, stableSessionOrder } from './selection.js';
import { createSessionHistory, installSessionHistory } from './session-history.js';
import { cardRows, installSessionSearch, sessionRows } from './session-search.js';
import { installTriageControls, matchesTriageFilters, renderTriage, sessionNode } from './triage.js';
import { renderWatch, installWatchControls } from './watch.js';
import { renderFleet } from './fleet.js';
import { nodeStripHTML, nodeStatsHealthRowsHTML } from './node-stats.js';
import { numLabel } from './session-number.js';
import { openReviewQueueNotification, renderReviewQueue, reviewQueueIdForNotification } from './review-queue.js';
import { openSessionChooser, defaultModels } from './session-launcher.js';
import { providerIconHTML } from './provider-icon.js';
import { openPortableTransfer } from './portable-transfer.js';
import { closeReviewerPopover, markReviewerSeen, renderDock, renderReviewer, renderReviewerTop } from './reviewer.js';
import { createDetailStore } from './details.js';
import { handleGradeKey } from './state-line.js';
import { focusQueueItem, handleLeaveTerminalKey } from './leave-terminal.js';
import { acknowledgeNotificationClick, installNotificationClicks, notificationPermission, notify, requestPermission, setBadge, shellReady } from './shell.js';
import { installMobile, mobileActive, openMobileStage, syncMobile } from './mobile.js';

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
  // The checkout a new session opens in: a worktree's own repo, never the worktree.
  const home = clean.match(/^\/(?:Users|home)\/[^/]+\//)?.[0];
  // Without the daemon's answer only a catalog key names the repo's own directory.
  const root = !worktree ? canonical : choice?.path || (!known ? clean : home ? home + key : `~/${key}`);
  return { key, path: clean, root, name, scope, h: known?.h ?? choice?.h ?? hashHue(canonical), icon: known?.icon || choice?.icon, wt: worktree?.[2] || null };
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
  if (['triage', 'watch', 'reviewer', 'review-queue', 'fleet'].includes(savedMode)) restoredMode = savedMode;
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
  mode: restoredMode, selected: 0, selectedKey: null, filter: null, providerFilter: null, nodeFilter: null, focused: false, dock: restoredDock, collapsed: restoredCollapsed,
  dismissed: new Set(), markedRunning: new Set(), showDismissed: false, showRunning: restoredRunning, showRecent: restoredRecent, sent: new Set(),
  layouts: [{ name: 'Pinned', ids: [], cols: 0, role: 'pinned' }], layout: 0, editing: false, pickFilter: '', currentActions: {},
  ensureSelectedVisible: true, focusPane: null, pendingFocus: false, currentItem: null,
  focusMode: restoredFocus,
  historyTarget: null, paneTarget: null, replyDrafts: new Map(), replyPendingSends: new Set(),
};
const topBar = document.querySelector('.bar');
const syncTopBarHeight = () => document.documentElement.style.setProperty('--top-bar-height', `${topBar.getBoundingClientRect().height}px`);
new ResizeObserver(syncTopBarHeight).observe(topBar);
let historyStorage;
try { historyStorage = localStorage; } catch {}
const sessionHistory = createSessionHistory(historyStorage);
let historyControls;
let historyRestored = false;
let data = { tasks: [], sessions: [], attention: [], setAside: {}, panes: [], portableTransfers: [], health: {}, usage: {}, reviewUsage: null, review: { events: [], stats: {} }, reviewQueue: { items: [], counts: {} }, limitResume: {} };
const detailStore = createDetailStore(api.getDashboardDetail, () => refresh());
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
const spawnedPanes = new Map();
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
// Set-aside writes for one key go out in click order, so a quick Mark running then
// Unmark (or Undo) cannot land server-side as clear-before-set.
const setAsideWrites = new Map();
// A reload whose state request went out before a set-aside write returned can carry a
// snapshot without it, so a key keeps its optimistic entry while any of its writes is in
// flight and until a reload that started after the last one returned. Writes for a key
// finish in click order (queueSetAsideWrite), so one record per key sees every result.
const setAsideKeys = new Map(); // key -> { pending, committed: { entry } | null, settledAt }
function beginSetAsideWrite(key, entry) {
  const record = setAsideKeys.get(key) || { pending: 0, committed: null, settledAt: null };
  record.pending += 1;
  record.settledAt = null;
  setAsideKeys.set(key, record);
  optimisticSetAside.set(key, entry);
  return record;
}
function finishSetAsideWrite(key, record, entry, ok) {
  if (setAsideKeys.get(key) !== record) return;
  record.pending -= 1;
  if (ok) record.committed = { entry, at: reloadGeneration };
  if (record.pending > 0) return; // a newer click is still in flight and stays shown
  record.settledAt = reloadGeneration;
  if (ok) return;
  // The newest click failed: show what the server last accepted for this key unless a
  // reload that started after that acceptance already applied newer state (which may
  // have cleared it, e.g. a new message), then fetch authoritative state right away.
  if (record.committed && appliedReloadGeneration <= record.committed.at) optimisticSetAside.set(key, record.committed.entry);
  else {
    setAsideKeys.delete(key);
    optimisticSetAside.delete(key);
  }
  void reload();
}
function pruneSetAsideOverrides(generation) {
  for (const [key, record] of [...setAsideKeys]) {
    if (record.pending > 0 || record.settledAt === null || record.settledAt >= generation) continue;
    setAsideKeys.delete(key);
    optimisticSetAside.delete(key);
  }
  for (const key of [...optimisticSetAside.keys()]) if (!setAsideKeys.has(key)) optimisticSetAside.delete(key);
}
function queueSetAsideWrite(key, write) {
  const next = (setAsideWrites.get(key) || Promise.resolve()).catch(() => {}).then(write);
  setAsideWrites.set(key, next);
  next.catch(() => {}).finally(() => { if (setAsideWrites.get(key) === next) setAsideWrites.delete(key); });
  return next;
}
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
    stateLabel: pane.alive === false && session?.retirement?.automatic !== true
      ? 'Exited' : session ? sessionLabel(session) : pane.alive ? 'Running' : 'Exited',
    reviewer: Boolean(session?.reviewer), taskId: session?.taskId || null, num: session?.num,
    renamed: Boolean(session?.renamed), mark: session?.mark,
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
    num: session.num,
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
    // The reviewer and every other standing agent are listed under Agents, not
    // here — the same test triage.js's hiddenFromRunning() makes. It is spelled
    // out rather than called because bin/ui-focus.test.js evaluates this
    // function's source text in a bare context: a bare identifier from another
    // module is not defined there.
    .filter((session) => (['running', 'waiting'].includes(session.state) || state.markedRunning.has(session.id))
      && !session.reviewer && !session.agentName && !isClosingSession(session.id, session.pane));
  const tasks = new Map((data.tasks || []).map((task) => [task.id, task]));
  const panes = paneMap();
  const createdAt = (session) => {
    const task = tasks.get(session.taskId);
    return Date.parse(task?.createdAt) || Date.parse(task?.fm?.created)
      || Date.parse(panes.get(session.pane)?.createdAt) || 0;
  };
  const items = stableSessionOrder(sessions, runningOrder, new Set((data.sessions || []).map((session) => session.id)), createdAt)
    .map((session) => sessionItem('running', session));
  // A pane opened from the rail is not pinned, so Running & waiting is the only
  // listing a sessionless shell or Pi pane has. Pi can be live before its
  // transcript appears in the session scan.
  const shells = (data.panes || [])
    .filter((pane) => pane.alive && (!pane.meta?.agent || ['shell', 'pi'].includes(pane.meta.agent))
      && !isPanePinned(pane.id) && !entityForPane(pane.id).session && !isClosingSession(pane.meta?.sessionId, pane.id))
    .map((pane) => {
      const entity = entityForPane(pane.id);
      return { kind: 'running', pane: pane.id, sessionId: undefined, project: entity.project, title: entity.title,
        state: 'running', since: Date.parse(pane.createdAt) || 0 };
    })
    .sort((a, b) => a.since - b.since);
  return [...items, ...shells];
}
function pinnedItems() {
  return (pinnedLayout()?.ids || []).flatMap((paneId) => {
    const pane = paneMap().get(paneId);
    if (!pane || isClosingSession(pane.meta?.sessionId, paneId)) return [];
    const entity = entityForPane(paneId);
    if (!entity.session) return [{
      kind: 'pinned', pane: paneId, project: entity.project, title: entity.title, state: entity.state,
    }];
    // An agent's pane is listed once, by its row under Agents — the same test
    // triage.js's hiddenFromRunning() makes, spelled out like the other sites. A pin
    // it picked up before the agent adopted it must not list the pane twice.
    if (entity.session.reviewer || entity.session.agentName) return [];
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
    // The reviewer and every other standing agent are listed under Agents, not here
    // — the same test triage.js's hiddenFromRunning() makes, spelled out for the same
    // reason runningItems() spells it out. An agent that is not running would
    // otherwise appear a second time as its own Recent row.
    .filter((session) => !session.reviewer && !session.agentName
      && !isClosingSession(session.id, session.pane) && session.state !== 'running'
      && (Number.isFinite(typeof session.lastUserAt === 'number' ? session.lastUserAt : Date.parse(session.lastUserAt)) || session.exited)
      && (!state.filter || projectOf(session.project).key === state.filter)
      && (!state.providerFilter || session.kind === state.providerFilter)
      && (!state.nodeFilter || sessionNode(ctx, session) === state.nodeFilter))
    .sort((a, b) => recentSessionTime(b) - recentSessionTime(a))
    .slice(0, 6)
    .map((session) => sessionItem('recent', session));
}
function matchesTriageFilter(item) {
  return matchesTriageFilters(ctx, item);
}
function triageVisible(item) {
  return (item.kind === 'pinned' || (item.kind === 'running' && isMarkedRunning(item)) || !state.dismissed.has(itemKey(item))) && matchesTriageFilter(item);
}
function retainedSelectionItem(item) {
  if (isClosingSession(item?.sessionId, item?.pane)) return null;
  if (state.paneTarget && state.paneTarget.pane === item?.pane) {
    const pane = paneMap().get(item.pane);
    if (!pane?.alive || !matchesTriageFilter(state.paneTarget)) { state.paneTarget = null; return null; }
    const entity = entityForPane(item.pane);
    if (!entity.session) return { ...state.paneTarget, project: entity.project, title: entity.title, state: entity.state };
    // The pane's session is recorded: the stand-in has done its job. Hand over to
    // the session so its own row, or the session-backed retained row when that row
    // is collapsed or dismissed, carries the selection with its summary and actions.
    // The target itself is only spent once the selection is the session's own.
    if (item.sessionId === entity.session.id) state.paneTarget = null;
    item = sessionItem('running', entity.session, item.pane);
  }
  const session = sessionFor(item);
  // An agent's session is listed once, by its row under Agents: triage marks that
  // row as the selection instead, so a retained row here would be a second
  // listing of the same pane - and an invisible last queue item for j/k and the
  // number keys to land on. The pane stand-in that brought us here has nothing
  // left to hand over to, so it is spent.
  //
  // This is triage.js's hiddenFromRunning() test, spelled out for the same reason
  // runningItems() spells it out: bin/session-history.test.js evaluates this
  // function's source text in a bare vm context, where a bare identifier from
  // another module is not defined.
  if (session?.reviewer || session?.agentName) {
    if (state.paneTarget && state.paneTarget.pane === item?.pane) state.paneTarget = null;
    return null;
  }
  if (!state.historyTarget?.sessionId && state.historyTarget?.paneId
      && state.historyTarget.paneId === (item?.pane || item?.paneId)
      && matchesTriageFilter(item)) {
    const pane = paneMap().get(state.historyTarget.paneId);
    return { ...state.historyTarget, kind: 'recent', pane: pane ? pane.id : null, state: 'exited' };
  }
  if (state.historyTarget?.sessionId && state.historyTarget.sessionId === item?.sessionId && matchesTriageFilter(item)) return session
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
    const found = projectOf(projectPath);
    const project = { ...found, source: found.path, path: found.root };
    if (!values.has(project.key) || !values.get(project.key).path.startsWith('/')) values.set(project.key, project);
  };
  for (const session of data.sessions || []) add(session.project);
  for (const pane of data.panes || []) add(pane.meta?.project || pane.cwd);
  // A project whose only open work is an inbox card still has to resolve — the
  // active filter is canonicalized through here, and Watch lists these projects.
  // The rail does not list it: only live sessions and agents earn an icon.
  for (const task of data.tasks || []) if (task.fm?.status === 'inbox') add(task.fm.project);
  return [...values.values()].sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
}
function projectHTML(projectPath, large = false) {
  const project = projectOf(projectPath);
  return `<span class="pj ${large ? 'lg' : ''}" style="--h:${project.h}">${projectIcon(project)}${esc(project.name)}${project.wt ? `<span class="wt">${esc(project.wt)}</span>` : ''}</span>`;
}
function tagsHTML(task) {
  return (task?.fm?.tags || []).map((tag) => `<span class="tagc ${(data.scopes || globalThis.KeepScopeRules.defaults).names.includes(tag) ? 'scope-tag' : ''}">${esc(tag)}</span>`).join('');
}
function kindLabel(kind) { return ({ question: 'question', permission: 'permission', rateLimit: 'limit', complete: 'done', input: 'input', finished: 'finished', plan: 'plan', running: 'running', pinned: 'pinned', recent: 'recent' })[kind] || kind; }
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
// state.dismissed hides an item from Waiting on you; state.markedRunning is the
// subset set aside with "Mark running", which still lists under Running & waiting.
function deriveDismissed() {
  state.dismissed = new Set(Object.keys(data.setAside || {}));
  state.markedRunning = new Set(Object.entries(data.setAside || {}).filter(([, entry]) => entry?.kind === 'running').map(([key]) => key));
  for (const [key, entry] of optimisticSetAside) {
    if (entry) state.dismissed.add(key);
    else state.dismissed.delete(key);
    if (entry?.kind === 'running') state.markedRunning.add(key);
    else state.markedRunning.delete(key);
  }
}
function isMarkedRunning(item) { return state.markedRunning.has(itemKey(item)); }
function setAsideFor(item) {
  const key = itemKey(item);
  return optimisticSetAside.has(key) ? optimisticSetAside.get(key) : data.setAside?.[key] || null;
}
async function setAside(item, kind = 'dismiss', minutes) {
  if (state.historyTarget?.sessionId === item.sessionId) state.historyTarget = null;
  const key = itemKey(item);
  const now = Date.now();
  const entry = { kind, until: kind === 'snooze' ? now + (minutes || 60) * 60e3 : null, at: now, since: item.since };
  const record = beginSetAsideWrite(key, entry);
  state.dismissed.add(key);
  if (kind === 'running') state.markedRunning.add(key);
  state.focused = false;
  refresh();
  try {
    await queueSetAsideWrite(key, () => api.setAside(key, kind, minutes));
    finishSetAsideWrite(key, record, entry, true);
    toast(kind === 'dependency' ? 'Waiting for dependency. New messages or changed dependencies bring it back.'
      : kind === 'running' ? 'Moved to Running & waiting. A new message or a new turn brings it back.'
      : kind === 'snooze' ? `Snoozed for ${minutes === 1440 ? '24 hours' : '1 hour'}.` : 'Dismissed. Restore it from the collapsed row.', { label: 'Undo', run: () => restore(key) });
  } catch (error) {
    finishSetAsideWrite(key, record, entry, false);
    deriveDismissed();
    refresh();
    error.actionMessage = `The item was not set aside; it is back in the list. ${error.message}`;
    api.reportWriteFailure(error, { message: error.actionMessage, retry: () => setAside(item, kind, minutes) });
  }
}
function dismiss(item) { return setAside(item, 'dismiss'); }
async function restore(key) {
  const record = beginSetAsideWrite(key, null);
  state.dismissed.delete(key);
  state.markedRunning.delete(key);
  state.showDismissed = false;
  refresh();
  try {
    await queueSetAsideWrite(key, () => api.setAside(key, 'clear'));
    finishSetAsideWrite(key, record, null, true);
    toast('Back in the queue.');
  } catch (error) {
    finishSetAsideWrite(key, record, null, false);
    deriveDismissed();
    refresh();
    error.actionMessage = `The item was not restored; it is back under set aside. ${error.message}`;
    api.reportWriteFailure(error, { message: error.actionMessage, retry: () => restore(key) });
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
  spawnedPanes.delete(pane);
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
    error.actionMessage = `The Watch pin was not changed; the previous layout is restored. ${error.message}`;
    api.reportWriteFailure(error, { message: error.actionMessage, retry: () => pinPane(pane, title) });
    return false;
  }
}
async function startShell(cwd, name) {
  const result = await api.spawnPane(cwd, name);
  const known = data.panes.find((pane) => pane.id === result.pane.id);
  if (known) Object.assign(known, result.pane);
  else data.panes.push(result.pane);
  // State requests already underway can have captured their pane list before
  // this spawn and finish afterwards. Keep the successful spawn authoritative
  // through those reloads; a later reload may confirm or remove it normally.
  spawnedPanes.set(result.pane.id, { pane: result.pane, throughGeneration: reloadGeneration });
  return result.pane;
}
async function startChosenSession(cwd, name, selection, requestId) {
  if (selection.kind === 'shell') return startShell(cwd, name);
  const result = await api.openSession({ fresh: true, cwd, agent: selection.agent, accountId: selection.accountId, requestId,
    ...(selection.model ? { model: selection.model } : {}), ...(selection.node ? { node: selection.node } : {}) });
  await reload();
  // A fresh Codex on another node with no opening message has no session id until
  // its first turn: started, not failed.
  if (result.pendingRegistration) toast(pendingRegistrationText(selection, result));
  return paneMap().get(result.pane) || { id: result.pane,
    meta: { agent: selection.agent, accountId: selection.accountId, project: cwd } };
}
function pendingRegistrationText(selection, result) {
  return `Started ${selection.agent} on ${result.node || selection.node || 'its machine'}; it registers at its first turn`;
}
async function newSession(cwd, name, onOpened) {
  const requestId = globalThis.crypto?.randomUUID?.() || `open-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let boundPane = null;
  let openedPane = null;
  await openSessionChooser(ctx, {
    title: 'New session', description: 'Choose what to open and where.', project: cwd,
    directory: cwd, editableDirectory: true,
    kinds: ['shell', 'claude', 'codex', 'pi'], initialKind: 'claude', confirmLabel: 'Open session', chooseNode: true,
    models: defaultModels(), defaultModels: true,
    async onSubmit(selection) {
      state.pendingFocus = true;
      try {
        let pane;
        const launchCwd = selection.cwd;
        const launchName = projectOf(launchCwd).name || name;
        try { pane = await startChosenSession(launchCwd, launchName, selection, requestId); }
        catch (error) {
          const launch = error?.body?.code === 'OPEN_EXISTING_PANE' ? error.body.launch : null;
          if (!launch?.pane) throw error;
          await reload();
          pane = paneMap().get(launch.pane) || { id: launch.pane,
            meta: { agent: launch.agent, accountId: launch.accountId, project: launchCwd } };
          if (boundPane !== pane.id) { await onOpened(pane, selection); boundPane = pane.id; openedPane = pane.id; }
          const boundError = new Error(`${error.message} The existing pane is open for inspection; retry resumes setup without creating another.`);
          boundError.body = error.body;
          throw boundError;
        }
        if (boundPane !== pane.id) { await onOpened(pane, selection); openedPane = pane.id; }
      } finally { state.pendingFocus = false; }
    },
  });
  if (openedPane && paneMap().get(openedPane)?.alive) {
    state.focusPane = openedPane;
    refresh();
  }
}
async function reopenSession({ sessionId, taskId, agent, title, stalePane, project, fromInbox = false }) {
  const session = sessionId ? data.sessions.find((candidate) => candidate.id === sessionId) : null;
  const pane = stalePane ? paneMap().get(stalePane) : null;
  const provider = agent || session?.kind || pane?.meta?.agent;
  const currentAccountId = session?.accountId || pane?.meta?.accountId || null;
  const launchProject = project || session?.project || pane?.meta?.project || pane?.cwd || taskFor({ taskId })?.fm?.project || '';
  const freshCard = !sessionId && Boolean(taskId);
  const requestId = globalThis.crypto?.randomUUID?.() || `open-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let openedPane = null;
  await openSessionChooser(ctx, {
    eyebrow: freshCard ? 'Card' : 'Conversation', title: `Reopen ${title || taskId || sessionId || 'session'}`,
    description: freshCard ? 'Start the first conversation for this card.' : 'Resume this conversation without sending a new instruction. Large conversations compact automatically.',
    project: launchProject, kinds: freshCard ? ['claude', 'codex', 'pi'] : [provider], initialKind: freshCard ? 'claude' : provider,
    accountId: currentAccountId, requireRecordedAccount: !freshCard, showModel: freshCard, confirmLabel: freshCard ? 'Start conversation' : 'Reopen',
    // Only a card's first conversation picks a machine: an existing one resumes where it runs.
    chooseNode: freshCard,
    models: freshCard ? defaultModels() : undefined, defaultModels: freshCard,
    onTransfer: sessionId ? () => openPortableTransfer(ctx, sessionId) : null,
    async onSubmit(selection) {
      const key = taskId ? `task:${taskId}` : `session:${sessionId}`;
      if (reopeningSessions.has(key)) return reopeningSessions.get(key);
      const operation = (async () => {
        const request = freshCard
          ? { taskId, fresh: true, agent: selection.agent, accountId: selection.accountId, requestId,
            ...(selection.model ? { model: selection.model } : {}),
            ...(selection.node ? { node: selection.node } : {}),
            // From the Queue's Inbox: refused unless the card is still in the
            // inbox, and moved to active once the session launches.
            ...(fromInbox ? { fromInbox: true } : {}) }
          : { sessionId, agent: provider, accountId: selection.accountId };
        let result;
        try {
          result = !freshCard && selection.accountId !== currentAccountId
            ? await api.reopenSession({ sessionId, accountId: selection.accountId })
            : await api.openSession(request);
        } catch (error) {
          const launch = error?.body?.code === 'OPEN_EXISTING_PANE' ? error.body.launch : null;
          if (!launch?.pane) throw error;
          await reload();
          openedPane = launch.pane;
          ctx.openReviewPane(launch.pane);
          const boundError = new Error(`${error.message} The existing pane is open for inspection.`);
          boundError.body = error.body;
          throw boundError;
        }
        // The old exited pane has nothing left to show once the session lives elsewhere.
        if (stalePane && stalePane !== result.pane && paneMap().get(stalePane)?.alive === false) {
          try { await api.removePane(stalePane); await dropPane(stalePane); } catch {}
        }
        await reload();
        openedPane = result.pane;
        const account = (data.accounts || []).find((entry) => entry.id === selection.accountId);
        // An inbox Open that launched but could not move its card says so: the
        // session is running either way.
        toast(result.pendingRegistration ? pendingRegistrationText(selection, result)
          : `${freshCard ? 'Started' : 'Reopened'} "${title || taskId || sessionId}"${account ? ` on ${account.label || account.id}` : ''}${result.statusWarning ? `; ${result.statusWarning}` : ''}`, {
          label: 'Pin', run: () => pinPane(result.pane, title),
        });
        return result;
      })();
      reopeningSessions.set(key, operation);
      try { return await operation; }
      finally { reopeningSessions.delete(key); }
    },
  });
  if (openedPane && paneMap().get(openedPane)?.alive) ctx.openReviewPane(openedPane);
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
    const entity = entityForPane(pane);
    entry.mounted = mountTerminal(container, pane, {
      ...options,
      slot,
      // The mobile shell hands the pane to a native terminal screen instead of
      // mounting xterm, so it needs the names this pane is known by.
      session: entity.session?.id || currentPane?.meta?.sessionId || '',
      title: entity.title,
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
function setTerminalRenderer(pane, renderer) {
  if (!setTerminalRendererPreference(pane, renderer)) return;
  for (const entry of terminals.get(pane)?.values() || []) entry.mounted.setRenderer(renderer);
  refresh();
}
// Each terminal reads the setting on every keystroke, so only the menus need redrawing.
function setPredictTyping(mode) {
  if (setPredictTypingPreference(mode)) refresh();
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
  const accountUsage = Object.values(data.usage?.accounts || {});
  const groups = new Map();
  for (const agent of ['claude', 'codex']) {
    const configured = accountUsage.filter((account) => account.agent === agent);
    const sources = configured.length ? configured : [{
      id: agent,
      label: agent === 'claude' ? 'Claude' : 'Codex',
      agent,
      ...(data.usage?.[agent] || {}),
    }];
    for (const account of sources) {
      const values = agent === 'claude' ? account.limits || [] : account.windows || [];
      for (const value of values) {
        const window = value.label || 'usage';
        const key = `${agent}:${window}`;
        const group = groups.get(key) || {
          agent,
          label: `${agent === 'claude' ? 'Claude' : 'Codex'} ${window}`,
          // The provider icon names the agent once, so each window shows only its own name.
          short: window.replace(/\bweek$/, 'wk'),
          readings: [],
        };
        group.readings.push({ account: account.label || account.id, ...value });
        groups.set(key, group);
      }
    }
  }
  const groupHTML = (group) => {
    const details = group.readings.map((reading) => {
      const percent = Math.max(0, Math.min(100, Number(reading.percent) || 0));
      const resetAt = reading.resetsAt == null || reading.resetsAt === '' ? NaN : new Date(reading.resetsAt).getTime();
      const reset = Number.isFinite(resetAt) ? ` · resets ${new Date(resetAt).toLocaleString()}` : '';
      const windowMs = Number(reading.windowMs);
      // A reset already in the past means the reading is stale, not that the window is used up.
      const elapsed = Number.isFinite(resetAt) && resetAt > Date.now() && windowMs > 0 ?Math.max(0, Math.min(100, 100 * (1 - (resetAt - Date.now()) / windowMs))) : null;
      const elapsedText = elapsed == null ? '' : ` · ${Math.round(elapsed)}% of window elapsed`;
      return { ...reading, percent, elapsed, detail: `${reading.account}: ${Math.round(percent)}%${elapsedText}${reset}` };
    });
    const description = `${group.label}. ${details.map((reading) => reading.detail).join('. ')}`;
    return `<span class="meter-group" tabindex="0" role="group" aria-label="${esc(description)}"><span class="meter-label">${esc(group.short)}</span><span class="meter-readings">${details.map((reading) => `<span class="meter"><i><b class="${reading.percent >= 75 ? 'warn' : ''}" style="width:${reading.percent}%"></b>${reading.elapsed == null ? '' : `<u class="${reading.elapsed < reading.percent ? 'over' : ''}" style="left:${reading.elapsed}%"></u>`}</i><span>${Math.round(reading.percent)}%</span></span>`).join('')}</span><span class="meter-details" role="tooltip"><b>${esc(group.label)}</b>${details.map((reading) => `<span>${esc(reading.detail)}</span>`).join('')}</span></span>`;
  };
  const agents = ['claude', 'codex'].map((agent) => [agent, [...groups.values()].filter((group) => group.agent === agent)]).filter(([, list]) => list.length);
  document.querySelector('#meters').innerHTML = agents.map(([agent, list]) =>
    `<span class="meter-agent">${providerIconHTML(agent, esc)}${list.map(groupHTML).join('')}</span>`).join('')
    || '<span class="meter unavailable">usage unavailable</span>';
}
function renderHealth() {
  const health = data.health || {};
  const presentation = (row) => {
    const unresolved = row.state !== 'disabled' && Number(row.consecutiveFailures || 0) > 0 && new Date(row.lastErrorAt || 0).getTime() > new Date(row.lastOkAt || 0).getTime();
    const displayState = row.displayState || (unresolved && Number(row.consecutiveFailures) < 3 && ['ok', 'skipped'].includes(row.state) ? 'warning' : row.state);
    const displayDetail = row.displayDetail ?? (unresolved ? row.lastError : row.detail || '');
    return { displayState, displayDetail };
  };
  const rows = (health.schedulers || []).map((row) => ({ ...row, ...presentation(row) }));
  const unhealthy = rows.filter((row) => ['failing', 'silent', 'never'].includes(row.displayState));
  // Amber: a streak whose fault still stands but has not reached failing, and a streak
  // the scheduler has run cleanly past since (recovered, bin/health.js stateOf). The
  // daemon sends a recovered row as displayState 'warning' so older console JS colors
  // it amber too; this one names it by its state (bin/health.js labelOf).
  const amber = (row) => row.displayState === 'warning' || row.displayState === 'recovered';
  const label = (row) => row.state === 'recovered' ? 'recovered' : row.displayState;
  const warnings = rows.filter(amber);
  const button = document.querySelector('#health');
  // A silent terminal host is not a scheduler failure, but it is the reason every
  // pane looks gone, so it belongs in the one always-visible health indicator.
  const outage = hostOutage(data);
  button.classList.toggle('bad', !health.daemon?.running || unhealthy.length > 0);
  button.classList.toggle('warning', health.daemon?.running && unhealthy.length === 0 && (warnings.length > 0 || Boolean(outage)));
  const status = !health.daemon?.running ? 'offline' : unhealthy.length ? unhealthy[0].displayState : warnings.length ? 'warning' : 'healthy';
  const summary = `Daemon ${status}${outage ? `; ${hostOutageText(outage)}` : ''}; show health details`;
  button.querySelector(':scope > span').textContent = 'daemon';
  button.title = summary;
  button.setAttribute('aria-label', summary);
  const enable = notificationPermission() === 'default' ? '<button class="btn notify-enable">Enable notifications</button>' : '';
  const hostRow = outage
    ? `<dt>terminal host</dt><dd class="bad">${esc(hostOutageText(outage))}${outage.stale && outage.panesAt ? ` · panes last listed ${esc(rel(outage.panesAt))}` : ' · no pane list'}</dd>`
    : '';
  // Each machine's numbers, a single-node install's one included: this is where a
  // lone machine shows them, since the header strip is a fleet's.
  const nodeRows = nodeStatsHealthRowsHTML(esc, data);
  button.querySelector('.pop').innerHTML = `<b>keep serve</b> · pid ${esc(health.daemon?.pid || '—')}${enable}<dl>${hostRow}${nodeRows}${rows.map((row) => `<dt>${esc(row.name)}</dt><dd class="${['failing', 'silent', 'never'].includes(row.displayState) ? 'bad' : amber(row) ? 'warning' : ''}">${esc(label(row))}${row.displayDetail ? ` · ${esc(row.displayDetail)}` : ''}</dd>`).join('')}</dl>`;
  button.querySelector('.notify-enable')?.addEventListener('click', async (event) => {
    event.stopPropagation();
    const permission = await requestPermission();
    toast(permission === 'granted' ? 'Notifications enabled.' : 'Notifications were not enabled.');
    renderHealth();
  });
}
// Memory, CPU, load and disk per machine, beside the daemon health. Only a fleet of
// two or more nodes shows it; everything else leaves the header as it was.
function renderNodeStrip() {
  const strip = document.querySelector('#nodeStrip');
  if (!strip) return;
  const html = nodeStripHTML(esc, data);
  strip.hidden = !html;
  patchHTML(strip, html);
}
function renderTop() {
  renderMeters();
  renderNodeStrip();
  renderHealth();
  const count = queueItems().filter((item) => !state.dismissed.has(itemKey(item)) && countsTowardBadge(item)).length;
  setBadge(count + (data.notifications || []).filter((entry) => !entry.read).length);
  if (attentionSeeded) attentionSound.update(queueItems()
    .filter((item) => !state.dismissed.has(itemKey(item)) && countsTowardBadge(item)).map((item) => soundEventKey(item, sessionFor(item))));
  document.querySelector('#qcount').textContent = count;
  document.querySelector('#qcount').classList.toggle('zero', count === 0);
  renderConnectionStatus();
  updateDockButton();
  renderReviewerTop(ctx);
  syncMobile();
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
  else if (state.mode === 'review-queue') renderReviewQueue(ctx);
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
      const batch = await api.write('/api/project-icons', { projects: paths.slice(offset, offset + 200) }, 'POST', { label: 'Loading project icons', background: true });
      if (!batch?.projects || typeof batch.projects !== 'object' || Array.isArray(batch.projects)) return;
      Object.assign(result.projects, batch.projects);
    }
    if (JSON.stringify(result.projects) !== JSON.stringify(projectChoices)) {
      const filteredProject = state.filter && knownProjects().find((project) => project.key === state.filter);
      projectChoices = result.projects;
      // Canonicalizing a newly discovered worktree must preserve the active filter.
      if (filteredProject) state.filter = projectOf(filteredProject.source).key;
      refresh();
    }
  } catch { /* Older/offline daemons keep the immediate folder fallback. */ }
  finally { projectChoicesBusy = false; }
}

let reloadRetry;
// A daemon restart refuses connections, then answers "still loading" until its first
// build: roughly 10-30s. The console keeps showing the last good state and the header
// says "reconnecting", so only a fetch failure that outlasts that window is toasted.
// Anything thrown while applying fetched state is a real bug and still toasts at once.
const REFRESH_FAILURE_TOAST_MS = 60e3;
let refreshFailingSince = 0;
let refreshFailures = 0;
let refreshFailureToasted = false;
let refreshMarkedReconnecting = false;
let connectionTimer = 0;
// What the event stream last reported; a fetch recovery must not claim "live" for it.
let eventStreamStatus = null;
let eventReconnectingSince = 0;
// api.js marks the failures a restart produces: an unreachable daemon, the refresh
// timeout, and the starting daemon's 503s. Anything else (a full action queue, a bug in
// the API layer) is not a restart and toasts at once.
function transientRefreshError(error) {
  return error?.transient === true;
}
function refreshRecovered() {
  clearTimeout(reloadRetry);
  refreshFailingSince = 0;
  refreshFailures = 0;
  refreshFailureToasted = false;
  if (refreshMarkedReconnecting) {
    refreshMarkedReconnecting = false;
    const label = document.querySelector('#connection');
    if (label?.dataset.status === 'reconnecting') label.dataset.status = eventStreamStatus || 'live';
  }
  renderConnectionStatus();
}
function renderConnectionStatus() {
  const connection = document.querySelector('#connection');
  const view = statusChipState({
    pending: api.pendingWrites(), generatedAt: data.generatedAt,
    reconnectingSince: refreshFailingSince || eventReconnectingSince, hostStatus: data.hostStatus,
  });
  connection.textContent = view.text;
  connection.title = view.text;
  connection.hidden = !view.text;
  connection.dataset.status = view.status;
  clearTimeout(connectionTimer);
  connectionTimer = view.ticking ? setTimeout(() => { renderConnectionStatus(); syncMobile(); }, 1000) : 0;
}
api.onPendingChange(renderConnectionStatus);
let pendingNotificationKey = null;
let pendingReviewNavigation = null;
async function reload() {
  clearTimeout(reloadRetry);
  const generation = ++reloadGeneration;
  const revision = layoutRevision;
  let fetched = false;
  try {
    const layoutsRequest = layoutSavesPending ? Promise.resolve(null) : api.getLayouts();
    // State carries the post-mutation publication fence. Fetch portable metadata
    // after it so one reload cannot combine a newer state with an older transfer cache.
    const nextData = await api.getState();
    const [nextLayouts, portable] = await Promise.all([layoutsRequest, api.getPortableTransfers()]);
    fetched = true;
    refreshRecovered();
    if (generation < appliedReloadGeneration) return;
    appliedReloadGeneration = generation;
    data = { ...nextData, portableTransfers: portable?.transfers || [] };
    detailStore.reconcile(data);
    for (const [id, pending] of spawnedPanes) {
      if ((data.panes || []).some((candidate) => candidate.id === id)) spawnedPanes.delete(id);
      else if (generation <= pending.throughGeneration) data.panes = [...(data.panes || []), pending.pane];
      else spawnedPanes.delete(id);
    }
    for (const pane of data.panes || []) {
      const session = data.sessions.find((candidate) => candidate.pane === pane.id || candidate.id === pane.meta?.sessionId);
      if (session) sessionHistory.bindPane(pane.id, session.id, {
        title: session.title, num: session.num, project: session.project, at: Date.now(),
      });
    }
    closingSessions.reconcile(data);
    void refreshProjectChoices();
    // Drop an optimistic set-aside only once this reload started after its last write
    // returned; the fenced state then already reflects it.
    pruneSetAsideOverrides(generation);
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
    if (pendingReviewNavigation) {
      const target = pendingReviewNavigation;
      const session = data.sessions.find((candidate) => candidate.id === target.id);
      if (session) {
        pendingReviewNavigation = null;
        navigateHistory({ sessionId: session.id, view: 'triage' });
        refresh();
      } else if (++target.attempts < 15) setTimeout(reload, 350);
      else {
        pendingReviewNavigation = null;
        toast('The conversation was created but has not appeared in the session list yet. Its link remains on the review item.');
      }
    }
    if (pendingNotificationKey) {
      const key = pendingNotificationKey;
      if (key.startsWith('alert:')) notificationPanel.open(key.slice(6), true);
      else selectAttention(key);
      pendingNotificationKey = null;
      acknowledgeNotificationClick(key);
    }
  } catch (error) {
    if (generation >= appliedReloadGeneration) {
      const now = Date.now();
      if (!fetched && transientRefreshError(error)) {
        if (!refreshFailingSince) refreshFailingSince = now;
        refreshFailures += 1;
        const label = document.querySelector('#connection');
        if (label && label.dataset.status !== 'reconnecting') {
          label.dataset.status = 'reconnecting';
          refreshMarkedReconnecting = true;
        }
        // The chip's own timer stops on a healthy render; a refresh that starts
        // failing afterwards has to restart it or the chip stays blank.
        renderConnectionStatus();
        if (!refreshFailureToasted && now - refreshFailingSince >= REFRESH_FAILURE_TOAST_MS) {
          refreshFailureToasted = true;
          toast(`State refresh failed: ${error.message}`);
        }
        // One retry loop, however many reloads were in flight when the daemon went away.
        clearTimeout(reloadRetry);
        reloadRetry = setTimeout(reload, Math.min(5000, 1500 * refreshFailures));
      } else {
        toast(`State refresh failed: ${error.message}`);
        clearTimeout(reloadRetry);
        reloadRetry = setTimeout(reload, 1500);
      }
    }
  }
}

function rememberSession(sessionId, view = state.mode) {
  if (!sessionId || !['triage', 'watch'].includes(view)) return;
  const session = data.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  sessionHistory.visit({ sessionId, view, title: session.title, num: session.num, project: session.project,
    layout: view === 'watch' ? state.layouts[state.layout]?.name : '', at: Date.now() });
  historyControls?.update();
}

function rememberItem(item, view = state.mode) {
  if (!item || !['triage', 'watch'].includes(view)) return;
  const pane = item.pane && paneMap().get(item.pane);
  const session = item.sessionId
    ? data.sessions.find((candidate) => candidate.id === item.sessionId)
    : item.pane ? entityForPane(item.pane).session : null;
  if (session) {
    if (item.pane) sessionHistory.bindPane(item.pane, session.id, {
      title: session.title, num: session.num, project: session.project, at: Date.now(),
    });
    rememberSession(session.id, view);
    return;
  }
  if (!pane?.alive) return;
  const entity = entityForPane(pane.id);
  sessionHistory.visit({ paneId: pane.id, view, title: entity.title, project: entity.project,
    layout: view === 'watch' ? state.layouts[state.layout]?.name : '', at: Date.now() });
  historyControls?.update();
}

// Navigation never opens a process, changes pin layouts, or clears dismissal.
// A removed Watch layout/pane falls back to a read-only Triage selection.
function navigateHistory(entry, focus = true) {
  let session = entry.sessionId ? data.sessions.find((candidate) => candidate.id === entry.sessionId) : null;
  let pane = session?.pane ? paneMap().get(session.pane)
    : !entry.sessionId && entry.paneId ? paneMap().get(entry.paneId) : null;
  if (!session && pane) session = entityForPane(pane.id).session;
  if (session && entry.paneId) sessionHistory.bindPane(entry.paneId, session.id, {
    title: session.title, num: session.num, project: session.project, at: entry.at,
  });
  let layout = state.layouts.findIndex((l) => l.name === entry.layout && l.ids.includes(pane?.id));
  if (layout < 0) layout = state.layouts.findIndex((l) => l.ids.includes(pane?.id));
  const watch = entry.view === 'watch' && pane?.alive && layout >= 0;
  state.mode = watch ? 'watch' : 'triage';
  if (watch) { state.layout = layout; state.editing = false; }
  state.filter = null;
  state.providerFilter = null;
  state.nodeFilter = null;
  if (state.focusMode) toggleFocus(false, false);
  const paneItem = !session && pane ? { kind: 'running', pane: pane.id, project: entry.project || entityForPane(pane.id).project,
    title: entry.title || entityForPane(pane.id).title, state: pane.alive ? 'running' : 'exited' } : null;
  state.paneTarget = !session && pane?.alive ? paneItem : null;
  state.historyTarget = { ...entry, ...(session ? { sessionId: session.id } : {}),
    kind: 'recent', state: 'exited', pane: null };
  state.currentItem = session ? sessionItem('recent', session) : paneItem || state.historyTarget;
  state.selectedKey = triageKey(state.currentItem);
  state.ensureSelectedVisible = true;
  state.focused = false;
  state.focusPane = focus && pane?.alive ? pane.id : null;
  try { localStorage.setItem('keep-mode', state.mode); } catch {}
}

const ctx = {
  state, get data() { return data; }, closingSessions, isClosingSession, beginClose, esc, rel, projectOf, projectIcon, projectHTML, tagsHTML, knownProjects,
  queueItems, runningItems, pinnedItems, recentItems, triageItems, toggleCollapsed, toggleRunning, toggleRecent, setSelected,
  itemKey, triageKey, eventKey, sessionFor, taskFor, paneMap, entityForPane, kindLabel, limitResumeFor, toast, dismiss, restore, setAside, setAsideFor, isMarkedRunning,
  pinPane, startShell, newSession, reopenSession, removePane, isPanePinned, knownPaneCount, saveLayouts, dropPane, mount, patchHTML, clearElement, refresh, reload,
  scheduleTerminalFit, setTerminalRenderer, setPredictTyping, setMode, setDock, toggleFocus, focusTerminal, focusDebug, retainedSelectionItem,
  detail(kind, item) { return item ? detailStore.peek(kind, item.id, item._detailVersion) : { status: 'idle', value: null, error: '' }; },
  ensureDetail(kind, item) { return item && item._detailVersion ? detailStore.ensure(kind, item.id, item._detailVersion) : Promise.resolve(item || null); },
  retryDetail(kind, item) { return item && item._detailVersion ? detailStore.retry(kind, item.id, item._detailVersion) : Promise.resolve(item || null); },
  openReviewSession(sessionId) {
    const session = data.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      pendingReviewNavigation = { id: sessionId, attempts: 0 };
      toast('Opening the new conversation…');
      setTimeout(reload, 100);
      return;
    }
    navigateHistory({ sessionId, view: 'triage' });
    refresh();
  },
  openReviewPane(paneId) {
    const pane = paneMap().get(paneId);
    if (!pane?.alive) { toast('The saved successor pane is no longer available'); return false; }
    const entity = entityForPane(paneId);
    const item = { kind: 'running', pane: paneId, project: entity.project, title: entity.title, state: entity.state };
    state.mode = 'triage'; state.filter = null; state.providerFilter = null; state.nodeFilter = null;
    if (state.focusMode) toggleFocus(false, false);
    state.paneTarget = item; state.currentItem = item; state.selectedKey = triageKey(item);
    state.ensureSelectedVisible = true; state.focused = false; state.focusPane = paneId;
    try { localStorage.setItem('keep-mode', state.mode); } catch {}
    rememberItem(item, 'triage');
    refresh();
    return true;
  },
  openReviewCard(cardId) {
    const session = data.sessions.find((candidate) => candidate.taskId === cardId && !candidate.reviewer);
    if (session) { navigateHistory({ sessionId: session.id, view: 'triage' }); refresh(); }
    else toast(data.tasks.find((task) => task.id === cardId)?.fm?.title || cardId);
  },
};

historyControls = installSessionHistory({ history: sessionHistory, esc,
  describe: (entry) => {
    const session = entry.sessionId && data.sessions.find((candidate) => candidate.id === entry.sessionId);
    const pane = session?.pane ? paneMap().get(session.pane)
      : !entry.sessionId && entry.paneId ? paneMap().get(entry.paneId) : null;
    return { title: session?.title || entry.title || entry.sessionId || entry.paneId, num: session?.num ?? entry.num,
      project: projectOf(session?.project || pane?.meta?.project || pane?.cwd || entry.project).name,
      status: pane?.alive === false ? 'Closed' : session ? sessionLabel(session) : pane?.alive ? 'Ready for next instruction' : 'Not in fleet' };
  },
  navigate: (entry) => { navigateHistory(entry); refresh(); },
});
const searchListing = {
  projectName: (path) => projectOf(path).name,
  hidden: (session) => isClosingSession(session.id, session.pane),
  liveOf: (session) => Boolean(session.pane && paneMap().get(session.pane)?.alive),
};
const sessionSearch = installSessionSearch({ esc, searchText: api.searchSessionText,
  rows: () => sessionRows(data.sessions, { ...searchListing, tasks: data.tasks, statusOf: sessionLabel }),
  cards: () => cardRows(data.tasks, data.sessions, searchListing),
  recentIds: () => sessionHistory.recent.map((entry) => entry.sessionId).filter(Boolean),
  open: (sessionId) => {
    rememberSession(sessionId, 'triage');
    navigateHistory({ sessionId, view: 'triage' });
    refresh();
  },
  // The chooser the Reopen buttons open, for the session the finder picked.
  reopen: (sessionId) => {
    const session = data.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) { toast('That conversation is no longer listed'); return; }
    reopenSession({ sessionId, agent: session.kind, title: session.title, project: session.project, stalePane: session.pane || undefined })
      .catch((error) => toast(`Could not reopen: ${error.message || error}`));
  },
  start: (card) => {
    reopenSession({ taskId: card.id, title: card.title, project: card.projectPath })
      .catch((error) => toast(`Could not start: ${error.message || error}`));
  },
});
function rememberPaneEvent(event) {
  if (!(event.target instanceof Element) || event.target.closest('button, a, input, select') && !event.target.closest('.xterm')) return;
  if (state.mode === 'watch') {
    const paneId = event.target.closest('.wpane')?.dataset.pane;
    if (paneId) rememberItem({ pane: paneId }, 'watch');
  } else if (state.mode === 'triage' && event.target.closest('#stage .term')) rememberItem(state.currentItem, 'triage');
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
  // A session Owner can name by number should be named that way, not by uuid stub.
  const named = session?.num ? numLabel(session.num) : sessionId.slice(0, 8);
  toast(session ? `${session.title || named} is not waiting on you` : `Session ${named} is not in the fleet list`);
}
function selectAttention(key) {
  state.filter = null;
  state.providerFilter = null;
  state.nodeFilter = null;
  const active = queueItems().filter((candidate) => !state.dismissed.has(itemKey(candidate)));
  const index = active.findIndex((candidate) => attentionKey(candidate) === key);
  if (index < 0) { toast('This item is no longer waiting on you.'); return; }
  // Explicit, the way clicking the row is: a notification names one row, and a
  // programmatic selection is overruled on the next render by whatever the stage
  // is already holding. Focus mode is the case that bit — it re-selects its own
  // item every render, so the tap landed back on the first row waiting.
  setSelected(index, true);
  state.ensureSelectedVisible = true;
  setMode('triage');
  // The render above put the row on the stage; on the phone the stage is a
  // screen of its own, which the tap has to push the way the row's tap does.
  openMobileStage();
}

function applyStateEffects() {
  const current = new Set((data.attention || []).map(attentionKey));
  const count = queueItems().filter((item) => !state.dismissed.has(itemKey(item)) && countsTowardBadge(item)).length;
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
  installMobile(ctx);
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
    rememberItem(item, 'triage');
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
  if (explicit) rememberItem(state.mode === 'triage' ? state.currentItem
    : { pane: terminal.element.closest('.wpane')?.dataset.pane }, state.mode);
  state.focused = true;
  terminal.element.classList.add('focused');
  terminal.focus();
}
function focusQueue() { focusQueueItem(state, document); }

document.addEventListener('keydown', (event) => {
  // The session finder's own keys stay in it, even when a click left focus outside its field.
  if (document.querySelector('#notificationsPanel')?.open || document.querySelector('.session-search-dialog')?.open) return;
  // Plain keys inside the emoji picker (its search box and its cell buttons)
  // belong to the picker, whichever phase this listener runs in; the modified
  // shortcuts (Cmd+B, Cmd+1-5, Cmd+Enter, ...) stay global there as everywhere.
  if (event.target instanceof Element && (event.target.closest('dialog')
      || (!event.metaKey && !event.ctrlKey && !event.altKey
        && (event.target.closest('#sessionHistory') || event.target.closest('[data-emoji-picker]'))))) return;
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
    // The popover consumed the Escape; a focused terminal must not also get a
    // bare ESC (Claude Code reads it as interrupt).
    if (termFocus) event.stopPropagation();
    return;
  }
  // ⌘⎋ is the way back out of a terminal: Escape alone stays with it, and ⌘↵
  // below is deliberately left to it for multiline input. A popover closes first.
  if (termFocus && handleLeaveTerminalKey(event, state, document)) return;
  if (help.classList.contains('on')) {
    if (key === 'Escape' || !inInput) { document.querySelector('#help').classList.remove('on'); event.preventDefault(); }
    return;
  }
  if (key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey && !inInput && !mobileActive()) {
    help.classList.add('on');
    event.preventDefault();
    return;
  }
  if (event.metaKey && lower === 'r' && !event.shiftKey) { event.preventDefault(); location.reload(); return; } // no reload menu in the desktop shell
  // ⌘F finds a session, even from inside a terminal; ⌘⇧F is the terminal's own find.
  if (event.metaKey && lower === 'f' && !event.shiftKey && !event.ctrlKey && !event.altKey && !mobileActive()) {
    event.preventDefault();
    event.stopPropagation();
    sessionSearch.show();
    return;
  }
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
  if (event.metaKey && /^[1-5]$/.test(key)) {
    // Same order as the nav buttons: ⌘4 is Review queue, ⌘5 is Fleet.
    setMode(['triage', 'watch', 'reviewer', 'review-queue', 'fleet'][Number(key) - 1]);
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
  // Below here every shortcut is a bare key, and the phone has no hardware
  // keyboard to press one on purpose: a stray key that arrived when a field lost
  // focus switched the console to Watch, which the tab bar has no tab for, and
  // pinned whatever Triage had selected. Escape, the modified shortcuts and
  // anything typed into a field are untouched.
  if (mobileActive()) return;
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
  // Grading the selected session's shadow verdict. The guard above already
  // excluded inputs and a focused terminal; handleGradeKey re-checks both so it
  // can be reasoned about (and tested) on its own.
  else if ((key === 'a' || key === 'd') && handleGradeKey(ctx, key)) event.preventDefault();
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
  detail(task) { return ctx.detail('task', task); },
  ensureDetail(task) { return ctx.ensureDetail('task', task); },
  retryDetail(task) { return ctx.retryDetail('task', task); },
  openSession(sessionId) {
    rememberSession(sessionId, 'triage');
    navigateHistory({ sessionId, view: 'triage' });
    refresh();
  },
  openReviewer: () => setMode('reviewer'),
  isReviewItem(entry) { return Boolean(reviewQueueIdForNotification(ctx, entry)
      || (entry?.card && ['reviewer', 'reviewer-idea'].includes(entry.caller)
        && (data.reviewQueue?.items || []).some((item) => item.card === entry.card))); },
  openReviewItem(entry) { return openReviewQueueNotification(ctx, entry); },
});

installActionFeedback(document.querySelector('#writeFailure'));
document.querySelector('#connection').textContent = 'connecting';
installNotificationClicks((key) => { pendingNotificationKey = key; reload(); });
// Subscribe even when the first request fails. EventSource reconnects after a
// daemon restart; every successful connection refreshes the snapshot as well.
api.subscribe(reload, (status) => {
  eventStreamStatus = status;
  if (status === 'reconnecting' && !eventReconnectingSince) eventReconnectingSince = Date.now();
  if (status === 'live') eventReconnectingSince = 0;
  if (!refreshFailingSince) document.querySelector('#connection').dataset.status = status;
  renderConnectionStatus();
  if (status === 'live') reload();
}, focusSession);
reload();
shellReady();
