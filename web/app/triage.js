import { modelUsageHTML } from './model-usage.js';
import * as api from './api.js';
import { closeSession } from './close-session.js';
import { restartControls, installRestartControls } from './restart-session.js';
import { accountLabelHTML, handoffControls, installHandoffControls, hasPendingHandoff } from './account-controls.js';
import { portableTransferControls, installPortableTransferControls } from './portable-transfer.js';
import { relayControlsHTML, installRelayControls } from './session-relay.js';
import { sessionLabel, sessionExplanation, backgroundLabel, hostOutage, hostOutageText } from './status.js';
import { retainSelection, selectionIndex } from './selection.js';
import { actionsMenuHTML, installActionsMenu, installKeepRunningControl, keepRunningControlHTML,
  patchActionsMenu, rendererControlsHTML } from './session-actions.js';
import { stateLineHTML, installGrading } from './state-line.js';
import { numBadgeHTML } from './session-number.js';
import { installHeadingRename, installRenameControls, isEditing, renameButtonsHTML, titleAttrsHTML } from './session-rename.js';
import { installMarkControls, markControlsHTML, markHTML } from './session-mark.js';
import { providerIconHTML } from './provider-icon.js';

const summaryCache = new Map(); // session id -> { text, fetchedAt, mtime, fresh }
const summaryInflight = new Map();
// Agent name -> `{ events, seq, at, read, readAt, misses }`: the last page read for an
// agent and what that read did. Only an agent that has been opened has one;
// /api/state carries the badge and the last event for every row, so a listed
// agent nobody is watching costs no request. A read that fails keeps the page in
// hand - an empty log is a lie about an agent that has events - and `misses`
// counts the reads that brought nothing new, so an unreadable feed backs off
// instead of being asked for on every poll.
const agentFeeds = new Map();
const agentFeedInflight = new Set();
// Reads are numbered so a slow answer can be recognised as one: the page from a
// read a later one has already overtaken is dropped, whatever it holds.
let agentFeedReads = 0;
const LOG_EVENTS = 20;
const FEED_RETRY_MS = 5e3;
const FEED_RETRY_MAX_MS = 60e3;

// An agent's session is not a working session. It keeps the same four controls
// off that the reviewer's does: transferring, handing off, restarting or
// relaying into it would put Owner's words where the agent's recipe belongs.
//
// `agentName`, never `agent`: on a session and on pane meta, `agent` is the
// provider — claude, codex, or pi.
export function sessionControlsAllowed(session) {
  return !session?.reviewer && !session?.agentName;
}

// Running & waiting lists the fleet's working sessions. An agent's session is
// listed under Agents instead, exactly as the reviewer's is listed nowhere.
// app.js's runningItems() repeats this test rather than calling it; see the note
// there.
export function hiddenFromRunning(session) {
  return Boolean(session?.reviewer || session?.agentName);
}

export function itemProvider(ctx, item) {
  const session = ctx.sessionFor(item);
  const pane = item?.pane ? ctx.paneMap().get(item.pane) : null;
  const kind = session?.kind || pane?.meta?.agent || '';
  return ['claude', 'codex', 'pi'].includes(kind) ? kind : '';
}

export function matchesTriageFilters(ctx, item) {
  return (!ctx.state.filter || ctx.projectOf(item.project).key === ctx.state.filter)
    && (!ctx.state.providerFilter || itemProvider(ctx, item) === ctx.state.providerFilter);
}

// /api/state stamps the sessions an agent currently owns. Its record can still
// point at an old session after a restart, so only use that pointer if there is
// no stamped session. Match the daemon's live-first ranking when several are
// stamped during a handoff.
export function agentSession(ctx, agent) {
  const sessions = ctx.data?.sessions || [];
  const stamped = agent?.name ? sessions.filter((session) => session.agentName === agent.name && !session.reviewer) : [];
  if (!stamped.length) return sessions.find((session) => session.id === agent?.session?.id)
    || sessions.find((session) => session.pane && session.pane === agent?.session?.pane) || null;
  const panes = ctx.paneMap();
  const rank = (session) => {
    const paneId = session.pane || session.runtime?.paneId || '';
    const live = session.exited !== true && session.state !== 'exited' && panes.get(paneId)?.alive !== false;
    return [Number(live), Number(Boolean(agent?.session?.pane && paneId === agent.session.pane)),
      Number(Boolean(agent?.session?.id && session.id === agent.session.id)), Number(session.mtime) || 0];
  };
  return stamped.reduce((best, session) => {
    const left = rank(session);
    const right = rank(best);
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return left[index] > right[index] ? session : best;
    }
    return best;
  });
}

export function agentPane(ctx, agent) {
  const session = agentSession(ctx, agent);
  const paneId = session?.pane || session?.runtime?.paneId || agent?.session?.pane || '';
  return paneId ? ctx.paneMap().get(paneId) : null;
}

export function agentProject(ctx, agent) {
  const session = agentSession(ctx, agent);
  const pane = agentPane(ctx, agent);
  return session?.project || pane?.meta?.project || pane?.cwd || agent?.project || '';
}

// Unresolved agents still appear under All; a selected client requires a
// provider from their current session or pane.
export function matchesAgentTriageFilters(ctx, agent, includeProject = true) {
  const session = agentSession(ctx, agent);
  const pane = agentPane(ctx, agent);
  const project = session?.project || pane?.meta?.project || pane?.cwd || agent?.project || '';
  const provider = session?.kind || pane?.meta?.agent || '';
  return (!includeProject || !ctx.state.filter || (Boolean(project) && ctx.projectOf(project).key === ctx.state.filter))
    && (!ctx.state.providerFilter || provider === ctx.state.providerFilter);
}

export function agentLifecycleLabel(agent) {
  if (agent?.lifecycle === 'needs-you') return 'needs you';
  if (agent?.lifecycle === 'stopped') return 'stopped';
  // The agent's session is listed nowhere but this row, so a question or a
  // permission prompt has to read off it. `needsInput` is the daemon's view of that
  // session, beside the lifecycle it records rather than instead of it: an agent
  // waiting on an answer is not working, whatever its last event said.
  if (agent?.needsInput) return agent.card ? `needs input · ${agent.card}` : 'needs input';
  if (agent?.lifecycle === 'working') return agent.card ? `on ${agent.card}` : 'working';
  return 'idle';
}

// Red when any unseen event asked for Owner, grey when they are only news, and
// absent at zero: a badge that is always there says nothing.
export function agentBadge(agent) {
  const count = Number(agent?.unseen?.count || 0);
  if (!(count > 0)) return null;
  return { count, tone: agent?.unseen?.needsYou ? 'hot' : 'grey' };
}

export function agentEventText(event) {
  return event ? String(event.text || event.title || event.kind || '') : '';
}

export function agentRowHTML(ctx, agent) {
  const badge = agentBadge(agent);
  const last = agent?.lastEvent || null;
  return `<span class="stripe"></span><span class="t">${ctx.esc(agent.name)}</span>
    <span class="w">${badge ? `<span class="abadge ${badge.tone}">${ctx.esc(badge.count)}</span>` : ''}</span>
    <span class="p"><span class="kind agent-life">${ctx.esc(agentLifecycleLabel(agent))}</span>${ctx.esc(agent.role || '')}</span>
    <span class="s">${last ? `${ctx.esc(agentEventText(last))} <span class="w num">${ctx.esc(ctx.rel(last.at))}</span>` : 'no events yet'}</span>`;
}

// The pane an agent can be watched in, or '' when it has none the host still
// lists as alive. A dead or unlisted pane is not one a terminal can attach to, so
// opening the row falls back to the session's own transcript on the stage.
export function agentLivePane(ctx, agent) {
  const pane = agentPane(ctx, agent);
  return pane?.alive ? pane.id : '';
}

// The agent's own log: the feed page fetched when it was opened, newest first,
// headed so it reads as a log beside the terminal it sits next to.
export function agentLogHTML(ctx, events) {
  const rows = (events || []).slice(0, LOG_EVENTS).map((event) => `<div class="aevent${event.needsYou ? ' needs' : ''}">
    <span class="w num">${ctx.esc(ctx.rel(event.at))}</span><span class="kind">${ctx.esc(event.kind)}</span>${event.card ? `<span class="card">${ctx.esc(event.card)}</span>` : ''}<span class="at">${ctx.esc(agentEventText(event))}</span>
  </div>`).join('');
  return `<div class="alog-head">Log</div>${rows || '<div class="aevent muted">No events yet.</div>'}`;
}

// The agent whose work the stage is showing, or null. The pane is asked first,
// across every agent, because it is the terminal actually on screen: a record
// that still names a session an in-place restart has moved on from must not beat
// the agent that owns the pane. Only then does the session id answer, for an
// agent whose pane is gone and whose transcript the stage is showing instead.
export function agentForStage(ctx, item, session) {
  if (!item) return null;
  const agents = ctx.data?.agents || [];
  const pane = item.pane || '';
  const sessionId = item.sessionId || session?.id || '';
  const sessions = ctx.data?.sessions || [];
  const stamped = (pane && sessions.find((candidate) => candidate.pane === pane || candidate.runtime?.paneId === pane))
    || (sessionId && sessions.find((candidate) => candidate.id === sessionId));
  const stampedName = stamped?.agentName || (pane && ctx.paneMap().get(pane)?.meta?.agentName);
  const owner = stampedName && agents.find((agent) => agent.name === stampedName);
  if (owner) return owner;
  const live = pane && agents.find((agent) => {
    const candidate = agentSession(ctx, agent);
    return candidate && (candidate.pane === pane || candidate.runtime?.paneId === pane);
  });
  if (live) return live;
  return (pane && agents.find((agent) => agent.session?.pane === pane))
    || (sessionId && agents.find((agent) => agent.session?.id === sessionId))
    || null;
}

// The item the stage renders for an agent: its own session, rebuilt from
// /api/state on every render the way a queue row is, so the heading, the brief
// and the actions stay the session's own instead of the pane stand-in
// openReviewPane left behind. An agent whose session /api/state does not carry
// keeps that stand-in, which is all there is to show.
export function agentStageItem(ctx, agent, current = null) {
  const session = agentSession(ctx, agent);
  if (!session) return current;
  const pane = session.pane || session.runtime?.paneId || agent.session?.pane || current?.pane || null;
  return {
    kind: pane && ctx.paneMap?.().get(pane)?.alive ? 'running' : 'recent',
    sessionId: session.id, num: session.num, pane, project: session.project, title: session.title,
    taskId: session.taskId || undefined, since: session.mtime, state: session.state,
  };
}

// The row an explicit selection names, or null when no group lists it. A key that
// names nothing is a row that has left, never a licence to select its neighbour.
export function selectedRowItem(ctx, items, selectedKey) {
  return (selectedKey && items.find((item) => ctx.triageKey(item) === selectedKey)) || null;
}

// Where the queue's selection sits and what the stage renders for it.
//
// An agent is selected by its Agents row and by nothing else. Its session is not
// a queue item: app.js's retainedSelectionItem refuses to rebuild a retained row
// for one, so `items` never holds the pane stand-in openReviewPane leaves behind,
// and the index is cleared here so no ordinary row can claim the selection at the
// same time. With no index, j/k start again from the top of the queue and the
// number keys have nothing invisible to land on.
//
// A key that names a listed row is asked first, because it is the newer fact: the
// stage's item stays the agent's until renderStage replaces it, so j/k and a
// click - which move the key and nothing else - would otherwise be read as the
// agent still being selected, and Owner could never leave it. That also settles
// the case of an agent's session listed under Recent as well: the Agents row
// carries it until Owner selects that row by name, and then that row does.
export function queueSelection(ctx, items, { current, selectedKey, fallback = 0, focusMode = false } = {}) {
  const chosen = selectedRowItem(ctx, items, selectedKey);
  const candidate = focusMode || chosen ? null : agentForStage(ctx, current, ctx.sessionFor(current));
  const agent = candidate && matchesAgentTriageFilters(ctx, candidate) ? candidate : null;
  if (agent) return { agent, selected: -1, selectedKey: null, stageItem: agentStageItem(ctx, agent, current) };
  if (focusMode && !current) return { agent: null, selected: -1, selectedKey: null, stageItem: null };
  const selected = selectionIndex(items, selectedKey, current, fallback, ctx.itemKey, ctx.triageKey);
  return {
    agent: null, selected,
    selectedKey: items[selected] ? ctx.triageKey(items[selected]) : null,
    stageItem: items[selected] || null,
  };
}

// The log column beside the stage terminal: who is working, what the fleet last
// heard from them, and the feed under it. Collapsed, it keeps only the head's
// toggle, so the terminal takes the width back without the column leaving.
export function agentStageLogHTML(ctx, agent, events, collapsed = false) {
  const last = agent?.lastEvent || null;
  const toggle = `<button class="btn salog-toggle" data-agent-log-toggle aria-expanded="${collapsed ? 'false' : 'true'}"
    title="${collapsed ? 'Show the agent log' : 'Hide the agent log'}">${collapsed ? '‹' : '›'}</button>`;
  if (collapsed) return `<div class="salog-head">${toggle}</div>`;
  return `<div class="salog-head"><span class="t">${ctx.esc(agent.name)}</span><span class="kind agent-life">${ctx.esc(agentLifecycleLabel(agent))}</span>${toggle}</div>
    <div class="salog-last">${last ? `${ctx.esc(agentEventText(last))} <span class="w num">${ctx.esc(ctx.rel(last.at))}</span>` : 'no events yet'}</div>
    <div class="salog-body">${agentLogHTML(ctx, events)}</div>`;
}

const eventAt = (at) => (typeof at === 'number' ? at : Date.parse(at) || 0);
// 0 is what the daemon publishes for a feed written before seq existed, so it
// is no order at all: those feeds fall back to the clock.
const eventSeq = (event) => (event && Number(event.seq) > 0 ? Number(event.seq) : null);

// Whether the feed's own summary on /api/state has outrun the page in hand.
//
// The feed's order is its seq, never its clock: two events written in the same
// millisecond tie, and an incident event is stamped with the time Slack posted
// its message, so a backfilled firing is dated before a close somebody ran a
// minute ago. Comparing `at` would call both of those "nothing new" and leave the
// log a page behind for good. `at` answers only for a feed written before seq
// existed, where every event reads as seq 0.
export function agentFeedBehind(agent, feed) {
  const last = agent?.lastEvent;
  if (!last || !feed?.events) return false;
  const lastSeq = eventSeq(last);
  return lastSeq !== null && feed.seq !== null ? lastSeq > feed.seq : eventAt(last.at) > (feed.at || 0);
}

// What a finished read leaves behind.
//
// A refused read keeps the page in hand: an empty log is a lie about an agent
// that has events. A page that answers the newest read always replaces the one in
// hand, whatever its seq - a rotated or truncated feed is the log now, and
// refusing a lower seq for ever would freeze the column on a page that no longer
// exists. Ordering is settled by the read counter instead: an answer that a later
// read has already overtaken is dropped, so a slow response cannot roll the log
// back. `misses` counts the reads that brought nothing new, which is what the
// backoff is made of.
function recordAgentFeed(name, events, read) {
  const previous = agentFeeds.get(name) || null;
  if (previous && read <= previous.read) return;
  const newest = events ? events[0] || null : null;
  const seq = events ? eventSeq(newest) : previous?.seq ?? null;
  const at = events ? eventAt(newest?.at) : previous?.at ?? 0;
  const same = !events || (previous?.events && seq === previous.seq && at === previous.at);
  agentFeeds.set(name, {
    events: events || previous?.events || null,
    seq, at, read, readAt: Date.now(),
    misses: same ? (previous?.misses || 0) + 1 : 0,
  });
}

// Opening a row is the acknowledgement: the feed is marked seen and read. Neither
// failure is worth a toast storm on a background refresh, so a read that fails
// leaves the last page standing and is retried by `agentFeedDue` instead.
export async function openAgentFeed(ctx, name) {
  const read = ++agentFeedReads;
  try { await api.markAgentSeen(name); } catch {}
  let events = null;
  try { events = (await api.getAgentEvents(name, LOG_EVENTS))?.events || []; } catch {}
  recordAgentFeed(name, events, read);
  ctx.refresh();
  return agentFeed(name) || [];
}

export function agentFeed(name) { return agentFeeds.get(name)?.events || null; }

// Whether the agent on the stage needs its log read again: nothing in hand, every
// read so far refused, or a page the agent's own summary has outrun. A read that
// brings nothing new doubles the wait up to a minute, so a feed that cannot be
// read - or one whose file is gone while the record still remembers an event -
// costs one request now and then rather than one per poll.
export function agentFeedDue(agent, feed, now = Date.now()) {
  if (!feed) return true;
  const wait = Math.min(FEED_RETRY_MS * 2 ** Math.max(0, (feed.misses || 0) - 1), FEED_RETRY_MAX_MS);
  if (feed.events && !agentFeedBehind(agent, feed)) return false;
  return now - (feed.readAt || 0) >= wait;
}

// One read per agent at a time, and the only way in: a click and the render it
// causes must not each start their own seen/events round trip, and two reads in
// flight can land out of order. Whoever asks first owns the read; the rest get
// its result on the refresh it ends with, and are told so with a null.
export function readAgentFeed(ctx, name) {
  if (!name || agentFeedInflight.has(name)) return null;
  agentFeedInflight.add(name);
  return openAgentFeed(ctx, name).finally(() => agentFeedInflight.delete(name));
}

// The log beside the stage is not a one-off read: the agent keeps working while
// Owner watches its pane.
function ensureAgentFeed(ctx, agent) {
  if (agent?.name && agentFeedDue(agent, agentFeeds.get(agent.name))) void readAgentFeed(ctx, agent.name);
}

// Clicking an Agents row is "show me this agent": its live pane goes on the
// stage, in the one slot the stage terminal already owns, so there is never a
// second view of the same PTY. An agent whose pane is gone opens as its session
// instead, where the stage shows the transcript tail.
function openAgent(ctx, name) {
  const agent = (ctx.data.agents || []).find((candidate) => candidate.name === name);
  if (!agent) return;
  void readAgentFeed(ctx, name);
  const live = agentLivePane(ctx, agent);
  if (live) {
    // openReviewPane leaves a pane stand-in behind to hold the selection until
    // the pane grows a running row of its own. An agent's pane never does - its
    // Agents row is the listing - so the stand-in is spent the moment it is made,
    // rather than left to answer for a pane Owner has since navigated away from.
    if (ctx.openReviewPane(live)) ctx.state.paneTarget = null;
    return;
  }
  const session = agentSession(ctx, agent);
  if (session?.id || agent.session?.id) { ctx.openReviewSession?.(session?.id || agent.session.id); return; }
  ctx.toast?.(`${name} has no session to open`);
}

// Collapsing the log column is Owner's, and it outlives a reload: the same
// terminal and the same agent should come back the way they were left.
export function agentLogCollapsed() {
  try { return localStorage.getItem('keep-agent-log-collapsed') === '1'; } catch { return false; }
}

function setAgentLogCollapsed(value) {
  try { localStorage.setItem('keep-agent-log-collapsed', value ? '1' : '0'); } catch {}
}

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
  // The rail renders before the queue reconciles the numeric index, so it follows
  // queueSelection's order rather than the index, which is still the previous
  // selection's: the key when a row answers to it, then the stage's own item when
  // that is an agent - an agent has no row and no index - and only then the index.
  const items = ctx.triageItems();
  const current = ctx.state.currentItem;
  const agent = agentForStage(ctx, current, ctx.sessionFor(current));
  const item = selectedRowItem(ctx, items, ctx.state.selectedKey)
    || (agent && matchesAgentTriageFilters(ctx, agent) ? current : null)
    || items[ctx.state.selected] || (current && matchesTriageFilters(ctx, current) ? current : null);
  const projectPath = item?.project || ctx.sessionFor(item)?.project;
  if (!projectPath) return fallback;
  const selected = ctx.projectOf(projectPath);
  return projects.find((project) => project.key === selected.key) || (selected.path.startsWith('/') ? selected : fallback);
}

export function renderRail(ctx, items) {
  const rail = document.querySelector('#rail');
  const counted = [...new Map(items.filter((item) => item.kind === 'pinned'
    || (item.kind === 'running' && ctx.isMarkedRunning(item))
    || !ctx.state.dismissed.has(ctx.itemKey(item))).map((item) => [ctx.itemKey(item), item])).values()];
  const counts = new Map();
  for (const item of counted) {
    const key = ctx.projectOf(item.project).key;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const agentProjects = new Set((ctx.data.agents || [])
    .filter((agent) => matchesAgentTriageFilters(ctx, agent, false))
    .map((agent) => agentProject(ctx, agent)).filter(Boolean).map((path) => ctx.projectOf(path).key));
  const projects = ctx.knownProjects().filter((project) => counts.has(project.key)
    || agentProjects.has(project.key) || project.key === ctx.state.filter);
  const collapsed = ctx.state.collapsed.rail;
  const row = (project) => `<button data-project="${ctx.esc(project.key)}" class="${ctx.state.filter === project.key ? 'on' : ''}" style="--h:${project.h}">${ctx.projectIcon(project)}<span>${ctx.esc(project.name)}</span><span class="c ${counts.get(project.key) ? 'hot' : ''}">${counts.get(project.key) || ''}</span></button>`;
  const dot = (project) => `<button data-project="${ctx.esc(project.key)}" class="rail-dot ${ctx.state.filter === project.key ? 'on' : ''}" style="--h:${project.h}" title="${ctx.esc(project.name)}">${ctx.projectIcon(project)}</button>`;
  const shell = shellProject(ctx);
  const shellButton = collapsed
    ? '<button class="rail-shell rail-dot" data-shell title="New session"><span class="rail-shell-mark">+</span></button>'
    : `<button class="rail-shell" data-shell title="New session in ${ctx.esc(shell.name)}"><span class="rail-shell-mark">+</span><span>session</span></button>`;
  const clientChoice = (kind, label) => collapsed
    ? `<button data-client="${kind}" class="rail-dot ${ctx.state.providerFilter === (kind || null) ? 'on' : ''}" title="${label}" aria-label="${label}" aria-pressed="${ctx.state.providerFilter === (kind || null)}">${kind ? providerIconHTML(kind, ctx.esc) : '<span class="rail-client-all">◎</span>'}</button>`
    : `<button data-client="${kind}" class="${ctx.state.providerFilter === (kind || null) ? 'on' : ''}" aria-label="${label}" aria-pressed="${ctx.state.providerFilter === (kind || null)}">${kind ? providerIconHTML(kind, ctx.esc) : '<span class="rail-client-all">◎</span>'}<span>${label}</span></button>`;
  const clients = `<div class="rail-clients" role="group" aria-label="Client">${collapsed ? '' : '<div class="rh">Client</div>'}${clientChoice('', 'All')}${clientChoice('claude', 'Claude Code')}${clientChoice('codex', 'Codex')}${clientChoice('pi', 'Pi')}</div>`;
  rail.classList.toggle('collapsed', collapsed);
  rail.innerHTML = collapsed
    ? `<div class="rh"><button class="collapse" aria-expanded="false" title="Expand (⌘B)">›</button></div><button data-project="" class="rail-dot all ${ctx.state.filter ? '' : 'on'}" title="All projects">${ctx.projectIcon({ key: 'all' })}</button>${projects.map(dot).join('')}${clients}${shellButton}`
    : `<div class="rh"><span>Projects</span><button class="collapse" aria-expanded="true" title="Collapse (⌘B)">‹</button></div><button data-project="" class="all ${ctx.state.filter ? '' : 'on'}">${ctx.projectIcon({ key: 'all' })}<span>All</span><span class="c hot">${counted.length}</span></button>`
      + (ctx.data.scopes || globalThis.KeepScopeRules.defaults).names.map((scope) => `<div class="scope">${ctx.esc(scope)}</div>${projects.filter((p) => p.scope === scope).map(row).join('')}`).join('') + clients + shellButton;
  rail.querySelector('.collapse').addEventListener('click', () => ctx.toggleCollapsed('rail'));
  rail.querySelectorAll('[data-project]').forEach((button) => button.addEventListener('click', () => {
    ctx.state.filter = button.dataset.project || null;
    ctx.setSelected(0);
    ctx.state.ensureSelectedVisible = true;
    ctx.refresh();
  }));
  rail.querySelectorAll('[data-client]').forEach((button) => button.addEventListener('click', () => {
    ctx.state.providerFilter = button.dataset.client || null;
    ctx.setSelected(0);
    ctx.state.ensureSelectedVisible = true;
    ctx.refresh();
  }));
  rail.querySelector('[data-shell]').addEventListener('click', async (event) => {
    if (ctx.state.pendingFocus) return;
    const button = event.currentTarget;
    button.disabled = true;
    button.blur();
    try {
      await ctx.newSession(shell.path, shell.name, async (pane, selection) => {
        const project = ctx.projectOf(selection.cwd);
        const title = ctx.entityForPane(pane.id).title;
        // A new pane is not pinned: it lists under Running & waiting, where a
        // shell stays until it exits and a session appears once it is recorded.
        // Creating one is explicit navigation, including from waiting-only Focus
        // mode or a collapsed Running & waiting group.
        if (ctx.state.focusMode) ctx.toggleFocus(false, false);
        ctx.state.showRunning = true;
        try { sessionStorage.setItem('keep-running-expanded', '1'); } catch {}
        ctx.state.filter = null;
        ctx.state.providerFilter = null;
        // openReviewPane keeps the pane selected until its own running row exists.
        if (ctx.paneMap().get(pane.id)?.alive) ctx.openReviewPane(pane.id);
        ctx.state.ensureSelectedVisible = true;
        ctx.state.focused = true;
        ctx.state.focusPane = pane.id;
        ctx.refresh();
        ctx.toast(`${({ shell: 'Shell', claude: 'Claude Code', codex: 'Codex', pi: 'Pi' })[selection.kind]} opened in ${project.name}`,
          { label: 'Pin', run: () => ctx.pinPane(pane.id, title) });
      });
    } finally { button.disabled = false; }
  });
}

export function queueRow(ctx, item) {
  const session = ctx.sessionFor(item);
  const provider = itemProvider(ctx, item);
  const title = item.title || session?.title || 'untitled session';
  const project = item.project || session?.project || '';
  const task = ctx.taskFor(item);
  // "#12" ahead of the title, with the hand-set mark between it and the title. A
  // row with no session of its own (a plain shell) has no number and shows none.
  // Both live inside .t because .qitem is a fixed three-column grid: another
  // top-level span would shift every cell after it.
  const badge = numBadgeHTML(ctx.esc, item.num ?? session?.num, item.sessionId || session?.id)
    + markHTML(ctx.esc, item.mark ?? session?.mark) + providerIconHTML(provider, ctx.esc);
  if (item.kind === 'running' || item.kind === 'pinned' || item.kind === 'recent') {
    const sessionState = session ? sessionLabel(session) : item.state || 'unknown';
    // Running rows without a session are plain shells; label them like pinned ones.
    const shell = (item.kind === 'pinned' || (item.kind === 'running' && !item.sessionId))
      && ctx.paneMap().get(item.pane)?.meta?.agent === 'shell';
    const recentTime = item.kind === 'recent' ? `<span class="w num">${ctx.esc(ctx.rel(item.since))}</span>` : '';
    return `<span class="stripe"></span><span class="t ${title === 'untitled session' ? 'untitled' : ''}">${badge}${ctx.esc(title)}</span>
      ${recentTime}
      <span class="p">${ctx.projectHTML(project)}${item.taskId ? `<span class="card">${ctx.esc(item.taskId)}</span>` : ''}${ctx.tagsHTML(task)}</span>
      <span class="s">${shell ? '<span class="kind shell">shell</span>' : ''}<span title="${ctx.esc(sessionExplanation(session))}" class="kind state ${ctx.esc(session?.state || item.state || '')}">${ctx.esc(sessionState)}</span>${item.kind === 'running' && ctx.isMarkedRunning(item) ? '<span class="kind marked-running">marked running</span>' : ''}${backgroundLabel(session) ? `<span class="kind">${ctx.esc(backgroundLabel(session))}</span>` : ''}</span>`;
  }
  const waited = waitText(item.since);
  return `<span class="stripe"></span><span class="t ${title === 'untitled session' ? 'untitled' : ''}">${badge}${ctx.esc(title)}</span>
    <span class="w num ${waited.includes('d') ? 'long' : ''}">${ctx.esc(waited)}</span>
    <span class="p">${ctx.projectHTML(project)}${item.taskId ? `<span class="card">${ctx.esc(item.taskId)}</span>` : ''}${ctx.tagsHTML(task)}</span>
    <span class="s"><span title="${ctx.esc(sessionExplanation(session))}" class="kind ${ctx.esc(item.kind)}">${ctx.esc(item.attentionLabel || ctx.kindLabel(item.kind))}</span>${backgroundLabel(session) ? `<span class="kind">${ctx.esc(backgroundLabel(session))}</span>` : ''}${ctx.esc(itemSummary(item, session))}</span>`;
}

function renderQueue(ctx, waiting, running, pinned, recent, dismissed) {
  const list = document.querySelector('#qlist');
  const scrollTop = list.scrollTop;
  const shownRunning = ctx.state.showRunning ? running : [];
  const shownPinned = ctx.state.showPinned ? pinned : [];
  const active = [...waiting, ...shownRunning, ...shownPinned, ...(ctx.state.showRecent ? recent : [])];
  const retainedSelection = retainSelection(active, ctx.state.currentItem, ctx.state.selectedKey, ctx.itemKey, ctx.triageKey,
    ctx.retainedSelectionItem);
  active.push(...retainedSelection);
  const collapsed = ctx.state.collapsed.queue;
  const queue = document.querySelector('#triage .queue');
  const strip = document.querySelector('#triage .queue-strip');
  queue.classList.toggle('collapsed', collapsed);
  strip.classList.toggle('on', collapsed);
  const head = queue.querySelector('.qhead');
  head.classList.add('focus-head');
  ctx.patchHTML(head, `<button type="button" class="qfocus" aria-pressed="${ctx.state.focusMode}" title="Toggle Focus (Shift+F)"><b id="qn">${ctx.esc(waiting.length)}</b> waiting on you ${ctx.state.focusMode ? '<span class="focus-pill">focus</span>' : ''}</button><button class="collapse" aria-expanded="true" title="Collapse (⌘\\)">‹</button>`);
  head.querySelector('.qfocus').onclick = () => ctx.toggleFocus();
  head.querySelector('.collapse').onclick = () => ctx.toggleCollapsed('queue');
  strip.innerHTML = `<button class="collapse" aria-expanded="false" title="Expand (⌘\\)">›</button><span class="strip-label"><b class="${waiting.length ? 'hot' : ''}">${ctx.esc(waiting.length)}</b> waiting</span>`;
  strip.querySelector('.collapse').addEventListener('click', () => ctx.toggleCollapsed('queue'));
  const selection = queueSelection(ctx, active, {
    current: ctx.state.currentItem, selectedKey: ctx.state.selectedKey,
    fallback: ctx.state.selected, focusMode: ctx.state.focusMode,
  });
  ctx.state.selected = selection.selected;
  ctx.state.selectedKey = selection.selectedKey;
  const selectedAgent = selection.agent;
  let selectedAgentRow = null;
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
  // Agents are the fleet's standing workers, not queue items: they are never
  // counted or dismissed, only read and opened. They sit under Running &
  // waiting, below the sessions doing a card's work, and the group is absent
  // entirely when there is no agent to list. Unlike Running, it is not gated on
  // `showRunning`: collapsing the sessions must not hide the fleet.
  const agentRows = (ctx.data.agents || []).filter((agent) => matchesAgentTriageFilters(ctx, agent));
  if (agentRows.length) {
    addGroup(`Agents · ${ctx.esc(agentRows.length)}`);
    for (const agent of agentRows) {
      const key = `agent:${agent.name}`;
      let row = existing.get(key);
      if (!row) {
        row = document.createElement('div');
        row.tabIndex = 0;
        row.dataset.key = key;
        row.addEventListener('click', () => openAgent(ctx, row.dataset.key.slice('agent:'.length)));
      }
      const selected = Boolean(selectedAgent) && selectedAgent.name === agent.name;
      row.className = `qitem k-agent${selected ? ' sel' : ''}`;
      ctx.patchHTML(row, agentRowHTML(ctx, agent));
      place(row);
      if (selected) selectedAgentRow = row;
    }
  }
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
  if (!active.length && !dismissed.length) addGroup(emptyQueueHTML(ctx.state), '');
  if (dismissed.length) {
    const wrap = document.createElement('div');
    wrap.className = 'qdis-wrap';
    wrap.innerHTML = `<button class="qdis-head" data-dismiss-toggle>${ctx.state.showDismissed ? '▾' : '▸'} dismissed · ${ctx.esc(dismissed.length)}</button>${ctx.state.showDismissed ? dismissed.map((item) => {
      const entry = ctx.setAsideFor(item);
      const minutes = entry?.kind === 'snooze' ? Math.max(1, Math.ceil((entry.until - Date.now()) / 60e3)) : null;
      const remaining = minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes}m`;
      const status = entry?.kind === 'dependency' ? 'waiting for dependency' : minutes === null ? 'dismissed' : `snoozed · ${remaining} left`;
      return `<div class="qdis" style="--h:${ctx.esc(ctx.projectOf(item.project).h)}"><span class="stripe"></span><span class="t">${ctx.esc(item.title || 'untitled session')} <small>${ctx.esc(status)}</small></span><button class="btn" data-restore="${ctx.esc(ctx.itemKey(item))}">Restore</button><span class="p">${ctx.projectHTML(item.project)}</span></div>`;
    }).join('') : ''}`;
    place(wrap);
    wrap.querySelector('[data-dismiss-toggle]').addEventListener('click', () => { ctx.state.showDismissed = !ctx.state.showDismissed; ctx.refresh(); });
    wrap.querySelectorAll('[data-restore]').forEach((button) => button.addEventListener('click', () => ctx.restore(button.dataset.restore)));
  }
  for (const child of [...list.children]) {
    if (retained.has(child)) continue;
    child.remove();
  }
  list.scrollTop = scrollTop;
  if (ctx.state.ensureSelectedVisible) {
    // An agent has no row under its own key: its Agents row is the selection.
    const selectedRow = [...list.querySelectorAll(':scope > .qitem')].find((row) => row.dataset.key === ctx.state.selectedKey);
    (selectedRow || selectedAgentRow)?.scrollIntoView({ block: 'nearest' });
    ctx.state.ensureSelectedVisible = false;
  }
  // The stage renders `stageItem`, not `active[selected]`: an agent has no row
  // of its own, so its session is handed over here the way focus mode hands over
  // the item it is holding.
  return { active, stageItem: selection.stageItem };
}

function briefHTML(ctx, item, session) {
  // The watcher's state line is the summary when there is one. Only fall back to
  // the Haiku summarizer for sessions it has not judged yet, and never spend a
  // model call on a session that already has a state line.
  const hasStateLine = typeof session?.stateLine === 'string' && session.stateLine.trim();
  if (item.sessionId && !hasStateLine) fetchSessionSummary(ctx, item, session);
  const cached = summaryCache.get(item.sessionId);
  const fallback = item.sessionId
    ? cached?.text || 'No state line yet'
    : item.detail || 'No session transcript available.';
  const updating = !hasStateLine && cached?.text && (cached.fresh === false || cached.mtime !== session?.mtime);
  let actions = '';
  if (item.kind === 'question') {
    const options = Array.isArray(item.options) ? item.options : [];
    actions = `<div class="opts">${options.map((option, index) => `<button class="opt ${option?.recommended || option?.rec ? 'rec' : ''}" data-option="${index + 1}"><span class="n">${index + 1}</span><span>${ctx.esc(optionLabel(option))}${option?.recommended || option?.rec ? ' <span class="d">· recommended</span>' : ''}</span></button>`).join('')}</div>`;
  }
  if (item.kind === 'rateLimit') {
    actions = '<div class="opts"><button class="opt" data-continue><span class="n">1</span><span>Continue</span></button><button class="opt" data-leave><span class="n">2</span><span>Leave parked</span></button></div>';
  }
  return `${stateLineHTML(ctx, session, fallback)}${updating ? '<div class="summary-updating" role="status">Updating summary…</div>' : ''}${actions}`;
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

// Free text on the phone, and on desktop when an automatically retired session
// has no terminal to type into. It stays on the item it answered rather than
// advancing the way an option or Continue does: the daemon's next state decides
// whether the wait ended, and a retired session resumes inside the same /api/send.
export function replyComposerHTML(item, provider) {
  if (!item.sessionId || provider === 'pi') return '';
  return '<form class="mobile-reply"><input type="text" name="reply" autocomplete="off" autocapitalize="sentences"'
    + ' placeholder="Reply to this session…" aria-label="Reply to this session">'
    + '<button class="btn primary" type="submit">Send</button></form>';
}

export function syncReplyComposer(stage, session) {
  const form = stage.querySelector('.mobile-reply');
  if (!form) return;
  const resumes = session?.retirement?.automatic === true;
  form.classList.toggle('desktop-retired-reply', resumes);
  const input = form.querySelector('input');
  const button = form.querySelector('button');
  const prompt = resumes ? 'Reply to resume this session…' : 'Reply to this session…';
  input.placeholder = prompt;
  input.setAttribute('aria-label', resumes ? 'Reply and resume this session' : 'Reply to this session');
  if (!button.disabled) button.textContent = resumes ? 'Send & resume' : 'Send';
}

function syncReplyPending(form, pending) {
  const input = form.querySelector('input');
  const button = form.querySelector('button');
  input.disabled = pending;
  button.disabled = pending;
  if (pending) {
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Sending…';
  } else {
    button.removeAttribute('aria-busy');
    button.textContent = form.classList.contains('desktop-retired-reply') ? 'Send & resume' : 'Send';
  }
}

export function installReplyComposer(stage, ctx, item, send = api.send) {
  const form = stage.querySelector('.mobile-reply');
  if (!form) return;
  const input = form.querySelector('input');
  const button = form.querySelector('button');
  const drafts = ctx.state.replyDrafts ||= new Map();
  const pendingSends = ctx.state.replyPendingSends ||= new Set();
  form.dataset.sessionId = item.sessionId;
  input.value = drafts.get(item.sessionId) || '';
  syncReplyPending(form, pendingSends.has(item.sessionId));
  input.addEventListener('input', () => {
    const sessionId = form.dataset.sessionId;
    if (sessionId) drafts.set(sessionId, input.value);
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    const target = ctx.state.currentItem?.sessionId ? ctx.state.currentItem : item;
    if (!text || !target.sessionId || pendingSends.has(target.sessionId)) return;
    const sessionId = target.sessionId;
    const resuming = form.classList.contains('desktop-retired-reply');
    pendingSends.add(sessionId);
    syncReplyPending(form, true);
    try {
      await send(sessionId, text);
      drafts.delete(sessionId);
      const current = stage.querySelector('.mobile-reply');
      if (current?.dataset.sessionId === sessionId) current.querySelector('input').value = '';
      // Deliberately not marked sent: free text may or may not end the wait, and
      // the daemon's next state is what decides. Owner stays on the session.
      ctx.toast(resuming ? 'Reply sent; session resuming' : 'Reply sent');
      ctx.refresh();
    } catch (error) { ctx.toast(error.message); }
    finally {
      pendingSends.delete(sessionId);
      const current = stage.querySelector('.mobile-reply');
      if (current?.dataset.sessionId === sessionId) syncReplyPending(current, false);
    }
  });
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

// "N running · N pinned", and the agents only when there are any: a standing
// zero teaches nothing.
export function emptyStateCounts(ctx, running, pinned) {
  const agentCount = (ctx.data.agents || []).filter((agent) => matchesAgentTriageFilters(ctx, agent)).length;
  return [`${running.length} running`, `${pinned.length} pinned`,
    ...(agentCount ? [`${agentCount} agent${agentCount === 1 ? '' : 's'}`] : [])].join(' · ');
}

export function emptyQueueHTML(state) {
  return state.filter || state.providerFilter
    ? '<div class="qempty"><b>No sessions shown for these filters</b>Change a filter or expand Running, Pinned, or Recent.</div>'
    : '<div class="qempty"><b>Nothing waiting on you</b>Expand Running, Pinned, or Recent to browse sessions, or open Watch for live panes.</div>';
}

// Attention rows are point-in-time notifications and may keep the pane that
// existed when the wait began. Resume updates the session row and pane list in
// one state publication, so the session's current pane wins whenever it exists.
export function stagePane(ctx, item, session) {
  const panes = ctx.paneMap();
  const sessionPane = session?.pane ? panes.get(session.pane) : null;
  if (sessionPane) return { id: session.pane, pane: sessionPane };
  const itemPane = item?.pane ? panes.get(item.pane) : null;
  return { id: itemPane ? item.pane : '', pane: itemPane || null };
}

function renderStage(ctx, queue, focusItem, running, pinned) {
  const item = ctx.state.focusMode
    ? queue.active.find((candidate) => focusItem && ctx.itemKey(candidate) === ctx.itemKey(focusItem)) || focusItem
    : queue.stageItem;
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
      ? `<div class="qempty stage-empty focus-waiting" role="status"><span class="focus-pulse" aria-hidden="true"></span><b>Nothing needs you</b><div>${ctx.esc(emptyStateCounts(ctx, running, pinned))}</div><p>Waiting for the next session…</p></div>`
      : '<div class="qempty stage-empty"><b>Queue clear</b><span>Press <kbd>w</kbd> to watch what is running.</span></div>');
    stage.dataset.itemKey = '';
    stage.dataset.pane = '';
    stage.dataset.focusKey = '';
    return;
  }
  ctx.state.currentItem = item;
  const session = ctx.sessionFor(item);
  const taskSummary = ctx.taskFor(item);
  const taskDetail = ctx.detail('task', taskSummary);
  if (taskSummary?._detailVersion && taskDetail.status === 'idle') void ctx.ensureDetail('task', taskSummary);
  const task = taskDetail.status === 'ready' ? { ...taskSummary, ...taskDetail.value } : taskSummary;
  const title = item.title || session?.title || 'untitled session';
  const waitingItem = item.kind !== 'running' && item.kind !== 'pinned' && item.kind !== 'recent';
  const key = ctx.itemKey(item);
  const { id: paneId, pane } = stagePane(ctx, item, session);
  const hasLivePane = Boolean(pane?.alive);
  const deferredSessionDetail = Boolean(!hasLivePane && session?._detailVersion
    && !Object.hasOwn(session, 'lastAssistantFull'));
  const sessionDetail = deferredSessionDetail
    ? ctx.detail('session', session)
    : { status: 'ready', value: session, error: '' };
  if (deferredSessionDetail && sessionDetail.status === 'idle') void ctx.ensureDetail('session', session);
  if (stage.dataset.itemKey !== key || stage.dataset.pane !== paneId) {
    ctx.focusDebug?.('stage-replace', { reason: 'selection-or-pane-change', session: item.sessionId || '', pane: paneId, related: stage.dataset.pane || '' });
    ctx.clearElement(stage);
    // `.stage-body` is a row: the terminal, and beside it the agent log when the
    // stage is showing an agent's work. The aside is part of the skeleton and is
    // only hidden, never added or removed, so appearing next to the terminal
    // cannot rebuild the host the terminal is mounted in.
    ctx.patchHTML(stage, `<div class="shead"><div class="session-heading"></div><div class="acts"><span class="quick-actions"></span>${actionsMenuHTML()}</div></div><div class="brief"></div>${replyComposerHTML(item, session?.kind || pane?.meta?.agent)}<div class="stage-body"><div class="stage-terminal"></div><aside class="stage-agent-log" hidden></aside></div>`);
    stage.dataset.itemKey = key;
    stage.dataset.pane = paneId;
    stage.dataset.focusKey = '';
    installReplyComposer(stage, ctx, item);
  }
  syncReplyComposer(stage, session);
  const pinLabel = ctx.isPanePinned(paneId) ? 'Unpin from Watch' : 'Pin to Watch';
  const closable = hasLivePane && item.sessionId && ['claude', 'codex', 'pi'].includes(pane.meta?.agent);
  const dependencyAcknowledged = ctx.setAsideFor(item)?.kind === 'dependency';
  const dependencyWait = session?.activity?.background?.dependencies?.length
    ? `<button class="btn" data-wait-dependency ${dependencyAcknowledged ? 'disabled' : ''}>${dependencyAcknowledged ? 'Waiting for dependency' : 'Wait for dependency'}</button>` : '';
  const pendingHandoff = hasPendingHandoff(ctx, item.sessionId, paneId);
  // A silent host says nothing about its panes, whether this one is missing from
  // the list or was carried over from an older one. Both are labelled: a reused
  // pane is shown but named as unconfirmed, and a missing pane is unknown rather
  // than gone, so Reopen - which would race a session that is still running -
  // waits for the host to speak again.
  const outage = hostOutage(ctx.data);
  const paneUnknown = Boolean(outage) && !hasLivePane;
  const outageNote = !outage ? ''
    : `<span class="host-outage">${ctx.esc(hostOutageText(outage))}${outage.stale && outage.panesAt
      ? ` · panes last listed ${ctx.esc(ctx.rel(outage.panesAt))}` : ''}</span>`;
  const reopen = hasLivePane || pendingHandoff ? ''
    : `<button class="btn" data-reopen ${paneUnknown ? 'disabled title="The terminal host is not answering; its panes cannot be listed."' : ''}>${session?.retirement?.automatic === true ? 'Resume' : 'Reopen'}</button>`;
  const heading = stage.querySelector('.shead .session-heading');
  // An open rename editor lives inside this heading; patching it would type over
  // Owner's input on the next refresh.
  if (!isEditing(heading)) {
    ctx.patchHTML(heading, `<h2${titleAttrsHTML(ctx.esc, item.sessionId, session?.renamed)}>${markHTML(ctx.esc, session?.mark)}${ctx.esc(title)}${numBadgeHTML(ctx.esc, item.num ?? session?.num, item.sessionId || session?.id)}</h2><div class="meta mono">${ctx.projectHTML(item.project || session?.project || '', true)}${item.taskId ? `<span>${ctx.esc(item.taskId)}</span>${ctx.tagsHTML(task)}` : ''}${accountLabelHTML(ctx, session, pane)}${outageNote}</div>${task ? modelUsageHTML(task.modelUsage, session?.modelUsage) : ''}`);
  }
  const brief = stage.querySelector('.brief');
  const ownControls = sessionControlsAllowed(session);
  const providerControls = ['claude', 'codex'].includes(session?.kind || pane?.meta?.agent);
  const portable = providerControls && item.sessionId && ownControls ? portableTransferControls(ctx, item.sessionId) : '';
  const handoff = providerControls && (closable || pendingHandoff) && ownControls ? handoffControls(ctx, item.sessionId, paneId) : '';
  const restart = providerControls && closable && !pendingHandoff && ownControls ? restartControls(ctx, item.sessionId) : '';
  // The reviewer and every other agent are not working sessions: relaying into
  // or out of one would put the agent's own words in a card's session, which is
  // what `keep nudge` exists for.
  const relay = providerControls && item.sessionId && ownControls ? relayControlsHTML(ctx, item.sessionId) : '';
  const keepRunning = hasLivePane && item.sessionId && ownControls && providerControls
    ? keepRunningControlHTML(session) : '';
  const markedRunning = Boolean(item.sessionId) && ctx.isMarkedRunning(item);
  const markRunning = !item.sessionId ? ''
    : markedRunning ? '<button class="btn" data-unmark-running title="Put this session back in Waiting on you">Unmark running</button>'
    : waitingItem ? '<button class="btn" data-mark-running title="This session still has background work: list it under Running &amp; waiting until its next message or turn">Mark running</button>' : '';
  ctx.patchHTML(stage.querySelector('.quick-actions'), `${markRunning}${item.sessionId || waitingItem ? '<button class="btn" data-snooze="60">Snooze 1h</button><button class="btn" data-snooze="1440">Snooze 24h</button><button class="btn" data-dismiss><kbd>x</kbd> Dismiss</button>' : ''}${closable ? '<button class="btn" data-close-session>Close</button>' : ''}`);
  const menu = stage.querySelector('.session-actions');
  patchActionsMenu(ctx, menu, `<button class="btn" data-pin ${paneId ? '' : 'disabled'}><kbd>p</kbd> ${ctx.esc(pinLabel)}</button>${reopen}${dependencyWait}${keepRunning}${renameButtonsHTML(item.sessionId, session?.renamed)}${markControlsHTML(ctx.esc, item.sessionId, session?.mark)}<span class="relay-controls">${relay}</span><div class="portable-transfer-controls">${portable}</div><div class="account-controls">${handoff}</div><span class="restart-controls">${restart}</span>${hasLivePane ? rendererControlsHTML(ctx, paneId, pane) : ''}`);
  installActionsMenu(menu, ctx, paneId);
  if (keepRunning) installKeepRunningControl(menu, ctx, session, api.setSessionKeepRunning);
  installRenameControls(menu, ctx, heading, item.sessionId, title, api.renameSession);
  installMarkControls(menu, ctx, item.sessionId, session?.mark, api.markSession);
  installHeadingRename(heading, ctx, item.sessionId, title, api.renameSession);
  if (relay) installRelayControls(menu.querySelector('.relay-controls'), ctx);
  if (portable) installPortableTransferControls(menu.querySelector('.portable-transfer-controls'), ctx);
  if (handoff) installHandoffControls(menu.querySelector('.account-controls'), ctx, item.sessionId, paneId);
  if (restart) installRestartControls(menu.querySelector('.restart-controls'), ctx, item.sessionId, paneId);
  const briefChanged = ctx.patchHTML(brief, briefHTML(ctx, item, session));
  installGrading(brief, ctx, session);
  // An agent's pane on the stage brings its log with it, in a column beside the
  // terminal. The aside is patched like the brief; the terminal host beside it is
  // never rebuilt, and xterm's own ResizeObserver refits it when the column
  // appears, collapses or goes away.
  const stageAgent = agentForStage(ctx, item, session);
  const logAside = stage.querySelector('.stage-agent-log');
  const logWasHidden = logAside.hidden;
  const logWasCollapsed = logAside.classList.contains('collapsed');
  if (stageAgent) {
    ensureAgentFeed(ctx, stageAgent);
    const collapsed = agentLogCollapsed();
    logAside.hidden = false;
    logAside.classList.toggle('collapsed', collapsed);
    ctx.patchHTML(logAside, agentStageLogHTML(ctx, stageAgent, agentFeed(stageAgent.name), collapsed));
    logAside.querySelector('[data-agent-log-toggle]').onclick = () => {
      setAgentLogCollapsed(!collapsed);
      ctx.refresh();
    };
  } else {
    logAside.hidden = true;
    ctx.patchHTML(logAside, '');
  }
  if (logWasHidden !== logAside.hidden || logWasCollapsed !== logAside.classList.contains('collapsed')) {
    ctx.scheduleTerminalFit();
  }
  const terminalHost = stage.querySelector('.stage-terminal');
  if (hasLivePane) {
    const focusKey = `${key}:${paneId}`;
    const autoFocus = ctx.state.focusMode && stage.dataset.focusKey !== focusKey && !editing && !ctx.state.pendingFocus;
    const focus = (ctx.state.focusPane === paneId || autoFocus) && !editing;
    ctx.mount(terminalHost, paneId, { slot: 'triage', focus });
    if (focus) ctx.state.focusPane = null;
    if (autoFocus) {
      ctx.focusTerminal();
      stage.dataset.focusKey = focusKey;
    }
  } else {
    const transcript = sessionDetail.status === 'ready'
      ? sessionDetail.value?.lastAssistantFull || session?.lastAssistant || item.detail || 'No transcript tail available.'
      : session?.lastAssistant || item.detail || 'No transcript tail available.';
    // A pane absent from a list the host never answered is unknown, not gone, and
    // that is worth saying even while the transcript tail is still loading.
    const paneStatus = paneUnknown
      ? `<p class="host-outage" role="status">${ctx.esc(hostOutageText(outage))} — its pane list is unavailable, so this session's pane is unknown${outage.stale && outage.panesAt ? `; panes shown were last listed ${ctx.esc(ctx.rel(outage.panesAt))}` : ''}.</p>`
      : '';
    const detailStatus = sessionDetail.status === 'loading'
      ? '<p class="muted" role="status">Loading recent conversation…</p>'
      : sessionDetail.status === 'error'
        ? `<p role="alert">Could not load recent conversation: ${ctx.esc(sessionDetail.error)} <button class="btn" data-retry-session-detail>Retry</button></p>`
        : paneUnknown ? '' : session?.retirement?.automatic === true
          ? '<p class="muted" role="status">Paused to save memory</p>'
          : '<p class="muted">no host pane</p>';
    let legacy = terminalHost.querySelector('.legacy');
    if (!legacy) {
      terminalHost.innerHTML = '<div class="legacy"></div>';
      legacy = terminalHost.querySelector('.legacy');
    }
    ctx.patchHTML(legacy, `<pre>${ctx.esc(transcript)}</pre>${paneStatus}${detailStatus}`);
    const retrySessionDetail = legacy.querySelector('[data-retry-session-detail]');
    if (retrySessionDetail) retrySessionDetail.onclick = () => ctx.retryDetail('session', session);
  }
  if (briefChanged) {
    brief.querySelectorAll('[data-option]').forEach((button) => button.addEventListener('click', () => chooseOption(ctx, item, Number(button.dataset.option))));
    brief.querySelector('[data-continue]')?.addEventListener('click', () => sendReply(ctx, item, 'continue'));
    brief.querySelector('[data-leave]')?.addEventListener('click', () => dismiss());
  }
  const pin = () => ctx.pinPane(paneId, title);
  const dismiss = () => ctx.dismiss(item);
  stage.querySelector('[data-pin]').onclick = pin;
  const reopenButton = stage.querySelector('[data-reopen]');
  if (reopenButton) reopenButton.onclick = async () => {
    if (reopenButton.disabled) return;
    reopenButton.disabled = true;
    try {
      await ctx.reopenSession({
        sessionId: item.sessionId, taskId: !item.sessionId ? item.taskId : undefined,
        agent: session?.kind, title, stalePane: paneId || undefined, project: item.project || session?.project,
      });
    } finally { reopenButton.disabled = false; }
  };
  const dismissButton = stage.querySelector('[data-dismiss]');
  const closeButton = stage.querySelector('[data-close-session]');
  if (closeButton) closeButton.onclick = () => closeSession(ctx, item.sessionId, paneId, closeButton);
  if (dismissButton) dismissButton.onclick = dismiss;
  const dependencyButton = stage.querySelector('[data-wait-dependency]');
  if (dependencyButton) dependencyButton.onclick = () => ctx.setAside(item, 'dependency');
  stage.querySelectorAll('[data-snooze]').forEach((button) => {
    button.onclick = () => ctx.setAside(item, 'snooze', Number(button.dataset.snooze));
  });
  const markRunningButton = stage.querySelector('[data-mark-running]');
  if (markRunningButton) markRunningButton.onclick = () => ctx.setAside(item, 'running');
  const unmarkRunningButton = stage.querySelector('[data-unmark-running]');
  if (unmarkRunningButton) unmarkRunningButton.onclick = () => ctx.restore(key);
  ctx.state.currentActions = {
    pin, dismiss: item.sessionId || waitingItem ? dismiss : undefined,
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
  const matchesFilter = (item) => matchesTriageFilters(ctx, item);
  const visible = items.filter(matchesFilter);
  const waiting = visible.filter((item) => !ctx.state.dismissed.has(ctx.itemKey(item)));
  const sessions = [...ctx.runningItems(), ...ctx.pinnedItems(), ...ctx.recentItems(),
    ...(ctx.data.sessions || []).filter((session) => !hiddenFromRunning(session) && !ctx.isClosingSession(session.id, session.pane)).map((session) => ({
      kind: 'recent', sessionId: session.id, pane: session.pane, project: session.project,
      title: session.title, taskId: session.taskId, since: session.mtime, state: session.state,
    }))];
  const notDismissed = (item) => matchesFilter(item) && !ctx.state.dismissed.has(ctx.itemKey(item));
  // "Mark running" hides a session from Waiting on you but keeps it listed here.
  const running = ctx.runningItems().filter((item) => notDismissed(item) || (matchesFilter(item) && ctx.isMarkedRunning(item)));
  // Pins are navigation, not attention. Snoozing/dismissing must not hide them.
  const pinned = ctx.pinnedItems().filter(matchesFilter);
  const recent = ctx.recentItems().filter(notDismissed);
  const dismissed = [...new Map([...visible, ...sessions.filter(matchesFilter)].filter((item) => ctx.state.dismissed.has(ctx.itemKey(item)) && !ctx.isMarkedRunning(item)).map((item) => [ctx.itemKey(item), item])).values()];
  // Focus starts with the oldest request, but background queue updates are not
  // navigation. Retain it only while it still needs input, never in other groups.
  const focusItem = ctx.state.focusMode
    ? waiting.find((item) => ctx.itemKey(item) === ctx.state.focusItemKey) || waiting[0]
    : null;
  if (ctx.state.focusMode) {
    ctx.state.focusItemKey = focusItem ? ctx.itemKey(focusItem) : null;
    const key = focusItem ? ctx.triageKey(focusItem) : null;
    if (ctx.state.selectedKey !== key) ctx.state.ensureSelectedVisible = true;
    ctx.state.selected = focusItem ? 0 : -1;
    ctx.state.selectedKey = key;
    ctx.state.currentItem = focusItem || null;
  }
  renderRail(ctx, [...items, ...ctx.runningItems(), ...ctx.pinnedItems()]
    .filter((item) => !ctx.state.providerFilter || itemProvider(ctx, item) === ctx.state.providerFilter));
  const queue = renderQueue(ctx, waiting, running, pinned, recent, dismissed);
  renderStage(ctx, queue, focusItem, running, pinned);
}
