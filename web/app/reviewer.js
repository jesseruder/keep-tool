import * as api from './api.js';
import { restartControls, installRestartControls } from './restart-session.js';

const ACTIONS_KEY = 'keep.console.reviewer.actionsOnly';
const SEEN_KEY = 'keep.console.reviewer.seenAt';
const ICONS = { ack: '✓', finding: '!', idea: '◇', nudge: '→', dismiss: '✕', compact: '↓', tick: '·', outcome: '✓', status: '⇄' };
const expandedDays = new Set();
let actionsOnly = true;
let seenAt = 0;

try {
  const saved = localStorage.getItem(ACTIONS_KEY);
  actionsOnly = saved == null ? true : saved === '1';
  seenAt = Number(localStorage.getItem(SEEN_KEY) || 0) || 0;
} catch {}

function events(ctx) {
  return [...(ctx.data.review?.events || [])].sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
}

function localDay(ms) {
  const date = new Date(Number(ms));
  if (!Number.isFinite(date.getTime())) return 'unknown';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function today() { return localDay(Date.now()); }

function yesterday() { return localDay(Date.now() - 86400e3); }

export function eventHeading(event) {
  if (event.kind === 'nudge') return `nudged session ${String(event.sessionId || '').slice(0, 8)}`.trim();
  if (event.kind === 'finding' && event.title === 'verification question') return event.title;
  return ({ ack: 'acked', finding: 'finding', idea: 'idea filed', dismiss: 'dismissed', compact: 'compacted', tick: 'tick' })[event.kind]
    || event.title || event.kind || 'event';
}

function eventHTML(ctx, event, cursor = seenAt, compact = false) {
  const date = new Date(Number(event.at));
  const time = Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
  const card = event.card ? `<button class="card" data-review-card="${ctx.esc(event.card)}">${ctx.esc(event.card)}</button>` : '';
  return `<div class="fe ${ctx.esc(event.kind || '')} ${Number(event.at || 0) > cursor ? 'new' : ''}"><span class="tm">${ctx.esc(time)}</span><span class="ic">${ctx.esc(ICONS[event.kind] || '·')}</span><div class="b"><div class="h"><b>${ctx.esc(eventHeading(event))}</b>${event.severity ? `<span class="sev">${ctx.esc(event.severity)}</span>` : ''}${card}</div>${compact ? '' : `<div class="d">${ctx.esc(event.detail || '')}</div>`}</div></div>`;
}

function countSummary(dayEvents) {
  const counts = new Map();
  for (const event of dayEvents) counts.set(event.kind, (counts.get(event.kind) || 0) + 1);
  const labels = { tick: 'ticks', ack: 'acks', finding: 'findings', idea: 'ideas', dismiss: 'dismissals', status: 'status changes', outcome: 'outcomes', nudge: 'nudges', compact: 'compacts' };
  return ['tick', 'ack', 'finding', 'idea', 'dismiss', 'status', 'outcome', 'nudge', 'compact']
    .filter((kind) => counts.has(kind)).map((kind) => `${counts.get(kind)} ${labels[kind]}`).join(', ');
}

function bindCardButtons(ctx, root) {
  root.querySelectorAll('[data-review-card]').forEach((button) => button.addEventListener('click', () => {
    const task = (ctx.data.tasks || []).find((candidate) => candidate.id === button.dataset.reviewCard);
    ctx.toast(task?.fm?.title || button.dataset.reviewCard);
  }));
}

function feedHTML(ctx, cursor) {
  const groups = new Map();
  for (const event of events(ctx)) {
    const day = localDay(event.at);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(event);
  }
  if (!groups.size) return '<div class="feed-placeholder"><b>No reviewer events yet</b><span>The next tick or landed review action will appear here.</span></div>';
  return [...groups].map(([day, dayEvents]) => {
    const old = day !== today();
    const collapsed = old && !expandedDays.has(day);
    const label = day === today() ? `Today · ${day}` : day === yesterday() ? `Yesterday · ${day}` : day;
    const summary = old ? ` · ${countSummary(dayEvents)}` : '';
    return `<button class="rday" data-review-day="${ctx.esc(day)}">${collapsed ? '▸' : old ? '▾' : ''} ${ctx.esc(label + summary)}</button>${collapsed ? '' : dayEvents.map((event) => eventHTML(ctx, event, cursor)).join('')}`;
  }).join('');
}

function stats(ctx) { return ctx.data.review?.stats || {}; }

function liveReviewer(ctx) {
  const marker = stats(ctx).reviewer;
  const session = (ctx.data.sessions || []).find((candidate) => candidate.reviewer && (!marker || candidate.id === marker.id));
  return { marker, session };
}

function tickPhrase(ctx) {
  const value = stats(ctx);
  const tick = Number(value.lastTickAt || 0);
  const skip = value.lastSkip;
  if (skip && Number(skip.at || 0) > tick) return `skipped: ${skip.why || 'not sent'}`;
  if (!tick) return 'no tick yet';
  const suffix = ctx.rel(tick) === 'yesterday' ? 'last tick yesterday' : `last tick ${ctx.rel(tick)} ago`;
  if (!Number(value.tickIntervalMs)) return suffix;
  const next = Math.max(0, Math.ceil((tick + Number(value.tickIntervalMs) - Date.now()) / 60000));
  return `${suffix} · next in ${next} min`;
}

export function weeklyText(value) {
  const model = Number.isFinite(value?.pointsOfModelWeek);
  const points = model ? value.pointsOfModelWeek : value?.pointsOfWeek;
  const label = model ? String(value.modelLabel || 'Claude').replace(/ wk$/, '') : 'Claude';
  if (!Number.isFinite(points)) return { usage: '—', label: 'weekly usage unavailable', title: 'Weekly usage estimate is not available yet.' };
  const total = model ? value.modelPercent : value.weekPercent;
  return {
    usage: `~${points.toFixed(1)}%${value.warming ? '…' : ''}`,
    label: `of ${label} weekly limit`,
    title: `Estimated reviewer usage: ${points.toFixed(1)}% of the ${label} weekly limit (${total}% used in total). Usage on other devices is not visible locally, so the estimate may read high.${value.warming ? ' Still processing history; the estimate will settle.' : ''}`,
  };
}

function atText(value) {
  const at = Number(value || 0);
  return at ? new Date(at).toLocaleString() : '—';
}

function statsPopover(ctx) {
  const value = stats(ctx);
  const weekly = weeklyText(value.weekly);
  return `<div class="review-pop"><b>Reviewer stats</b><dl><dt>last tick</dt><dd>${ctx.esc(atText(value.lastTickAt))}</dd><dt>last skip</dt><dd>${ctx.esc(value.lastSkip ? `${atText(value.lastSkip.at)} · ${value.lastSkip.why || ''}` : '—')}</dd><dt>compactions</dt><dd>${ctx.esc(value.compactionsToday ?? 0)} today</dd><dt>median ctx</dt><dd>${value.medianContextTokens == null ? '—' : `${Math.round(Number(value.medianContextTokens) / 1000)}k`}</dd><dt>weekly</dt><dd>${ctx.esc(`${weekly.usage} · ${weekly.label}`)}</dd><dt>findings</dt><dd>${ctx.esc(value.findingsTotal ?? '—')} total · ${ctx.esc(value.dismissed ?? '—')} dismissed</dd><dt>outcomes</dt><dd>${ctx.esc(outcomeSummary(value.outcomes))}</dd></dl></div>`;
}

export function outcomeSummary(outcomes) {
  const labels = { fixed: 'fixed', 'confirmed-deferred': 'confirmed, deferred', incorrect: 'incorrect', superseded: 'superseded', unresolved: 'unresolved' };
  return Object.entries(labels).map(([key, label]) => `${Number(outcomes?.[key] || 0)} ${label}`).join(' · ');
}

export function reviewerNewCount(ctx) {
  return events(ctx).filter((event) => Number(event.at || 0) > seenAt).length;
}

export function markReviewerSeen(ctx) {
  // A visible Reviewer screen is being looked at even when the terminal, not the console
  // window, holds keyboard focus — requiring focus left the badge lit while it was read.
  const visibleReviewer = ctx.state.mode === 'reviewer' && document.visibilityState !== 'hidden';
  const visibleDock = ctx.state.dock && window.innerWidth >= 1100 && ctx.state.mode !== 'reviewer'
    && document.hasFocus() && document.visibilityState !== 'hidden';
  if (!visibleReviewer && !visibleDock) return false;
  const newest = Number(events(ctx)[0]?.at || 0);
  if (!newest || newest <= seenAt) return false;
  seenAt = newest;
  try { localStorage.setItem(SEEN_KEY, String(seenAt)); } catch {}
  return true;
}

export function renderReviewerTop(ctx) {
  const count = reviewerNewCount(ctx);
  const modeButton = document.querySelector('.modes [data-mode="reviewer"]');
  const dockButton = document.querySelector('#dockbtn');
  for (const node of [modeButton?.querySelector('.nw'), dockButton?.querySelector('.nw')]) {
    if (!node) continue;
    node.textContent = count ? `${count} new` : '';
    node.hidden = !count;
  }
  const dot = modeButton?.querySelector('.dot');
  if (!dot) return;
  const value = stats(ctx);
  const marker = value.reviewer;
  const live = marker && marker.state !== 'gone';
  const fresh = Number(value.lastTickAt || 0) && Date.now() - Number(value.lastTickAt) <= 90 * 60e3;
  // A running reviewer cannot tick mid-turn, so a long turn must not read as stale.
  const healthy = live && (marker.state === 'running' || (marker.state === 'idle' && fresh));
  dot.style.background = healthy ? 'var(--ok)' : live ? 'var(--warn)' : 'var(--faint)';
  modeButton.title = !live ? 'No live reviewer session'
    : marker.state === 'running' ? `${marker.state}; reviewer is mid-turn`
      : healthy ? `${marker.state}; reviewer ticked within 90 minutes`
        : fresh ? `${marker.state}; reviewer is not currently running or idle`
          : `${marker.state}; no reviewer tick in the last 90 minutes`;
}

// The reviewer is the one session with no pane header of its own, so its restart
// lives here. Same endpoint, same modes and the same queued/restarting/failed states
// as a pinned pane in Watch: the guarded `idle` restart, cancellable while it waits.
export function reviewerRestartHTML(ctx) {
  const { session } = liveReviewer(ctx);
  // A pending restart already renders its own state and Cancel through restartControls.
  const pending = (ctx.data.restarts || []).some((entry) => entry.sessionId === session?.id
    && ['queued', 'restarting', 'recovery-needed'].includes(entry.status));
  if (pending) return '';
  return session?.id && session?.pane
    ? '<button class="btn" data-restart="idle" title="Restart the reviewer once its prompt is idle and the pane is not being viewed; the conversation is resumed">Restart</button>'
    : '<button class="btn" disabled title="No live reviewer pane to restart">Restart</button>';
}

export function renderReviewer(ctx) {
  const { marker, session } = liveReviewer(ctx);
  const terminal = document.querySelector('#rterm');
  const status = `${marker?.state || session?.state || 'offline'} · ${tickPhrase(ctx)}`;
  const structure = `<div class="shead"><h2>Fleet reviewer</h2><div class="meta mono">${ctx.projectHTML(session?.project || '~/keep')}<span>${ctx.esc(marker?.id || session?.id || '—')}</span><span>${ctx.esc(marker?.model || '—')}</span><span class="reviewer-state">${ctx.esc(status)}</span></div><div class="acts"><button class="btn" data-review-tick>Tick now</button><button class="btn" data-review-stats>Stats</button>${statsPopover(ctx)}<span class="restart-controls"></span></div></div><div class="review-terminal"></div>`;
  const changed = ctx.patchHTML(terminal, structure);
  if (session?.pane) ctx.mount(terminal.querySelector('.review-terminal'), session.pane, { slot: 'reviewer' });
  else terminal.querySelector('.review-terminal').innerHTML = '<div class="placeholder">The reviewer is not currently attached to a host pane.</div>';
  if (changed) {
    terminal.querySelector('[data-review-tick]').addEventListener('click', async () => {
      try {
        const result = await api.reviewTick();
        ctx.toast(result.sent ? 'Reviewer tick sent.' : `Reviewer tick skipped: ${result.why || 'not sent'}`);
        ctx.reload();
      } catch (error) { ctx.toast(error.message); }
    });
    terminal.querySelector('[data-review-stats]').addEventListener('click', (event) => {
      event.stopPropagation();
      terminal.querySelector('.acts').classList.toggle('open');
    });
  }

  // Re-rendered every refresh, not only on a structural change: the button has to
  // follow the reviewer's pane appearing and going away, and the queued/failed state.
  const restart = terminal.querySelector('.restart-controls');
  ctx.patchHTML(restart, `${restartControls(ctx, session?.id)}${reviewerRestartHTML(ctx)}`);
  // Cancel has to keep working even if the pane has gone out from under a queued
  // restart, so fall back to the pane the entry was queued against.
  const queued = (ctx.data.restarts || []).find((entry) => entry.sessionId === session?.id
    && ['queued', 'restarting'].includes(entry.status));
  const restartPane = session?.pane || queued?.pane || '';
  if (session?.id && restartPane) installRestartControls(restart, ctx, session.id, restartPane);

  const value = stats(ctx);
  const day = value.days?.[today()] || {};
  const actionCount = ['acks', 'notes', 'ideas', 'dismisses', 'statuses', 'nudges'].reduce((sum, key) => sum + Number(day[key] || 0), 0);
  const weekly = weeklyText(value.weekly);
  const median = value.medianContextTokens == null ? '—' : `${Math.round(Number(value.medianContextTokens) / 1000)}<small>k</small>`;
  ctx.patchHTML(document.querySelector('#reviewStats'), `<div class="rstat"><div class="v">${Number(day.ticks || 0)}</div><div class="l">ticks today</div></div><div class="rstat hot"><div class="v">${actionCount}</div><div class="l">actions today</div></div><div class="rstat"><div class="v">${median}</div><div class="l">median ctx</div></div><div class="rstat" title="${ctx.esc(weekly.title)}"><div class="v">${ctx.esc(weekly.usage)}</div><div class="l">${ctx.esc(weekly.label)}</div></div>`);

  const cursor = seenAt;
  const count = reviewerNewCount(ctx);
  const side = document.querySelector('#reviewer .rside');
  const strip = document.querySelector('#reviewer .rside-strip');
  const collapsed = ctx.state.collapsed.rside;
  side.classList.toggle('collapsed', collapsed);
  strip.classList.toggle('on', collapsed);
  ctx.patchHTML(strip, `<button class="collapse" aria-expanded="false" title="Expand (⌘⇧B)">‹</button><span class="strip-label">actions · <b class="${count ? 'hot' : ''}">${count} new</b></span>`);
  strip.querySelector('.collapse').onclick = () => ctx.toggleCollapsed('rside');
  const head = document.querySelector('#reviewer .rhead');
  const headChanged = ctx.patchHTML(head, `<span class="lbl">Did anything · <b>${count} new</b> since you last looked</span><button class="toggle ${actionsOnly ? 'on' : ''}" data-actions-only><span>actions only</span><i></i></button><button class="collapse" aria-expanded="true" title="Collapse (⌘⇧B)">›</button>`);
  if (headChanged) {
    head.querySelector('[data-actions-only]').addEventListener('click', () => {
      actionsOnly = !actionsOnly;
      try { localStorage.setItem(ACTIONS_KEY, actionsOnly ? '1' : '0'); } catch {}
      ctx.refresh();
    });
    head.querySelector('.collapse').addEventListener('click', () => ctx.toggleCollapsed('rside'));
  }
  const feed = document.querySelector('#feed');
  feed.classList.toggle('actions-only', actionsOnly);
  const feedChanged = ctx.patchHTML(feed, feedHTML(ctx, cursor));
  if (feedChanged) {
    bindCardButtons(ctx, feed);
    feed.querySelectorAll('[data-review-day]').forEach((button) => button.addEventListener('click', () => {
      const dayKey = button.dataset.reviewDay;
      if (expandedDays.has(dayKey)) expandedDays.delete(dayKey); else expandedDays.add(dayKey);
      ctx.refresh();
    }));
  }
  if (markReviewerSeen(ctx)) renderReviewerTop(ctx);
}

export function renderDock(ctx) {
  const dock = document.querySelector('#dock');
  const visible = ctx.state.dock && ctx.state.mode !== 'reviewer' && window.innerWidth >= 1100; // same floor as setDock; a shrink must hide an open dock
  dock.classList.toggle('on', visible);
  if (!visible) { ctx.clearElement(dock); return; }
  const { marker, session } = liveReviewer(ctx);
  const cursor = seenAt;
  const count = reviewerNewCount(ctx);
  const shown = events(ctx).filter((event) => !actionsOnly || !['tick', 'compact'].includes(event.kind)).slice(0, 12);
  const structure = `<div class="dh"><b>Reviewer</b><span class="st">${ctx.esc(marker?.state || session?.state || 'offline')} · tick ${ctx.esc(stats(ctx).lastTickAt ? ctx.rel(stats(ctx).lastTickAt) : '—')}</span><span class="nw">${count ? `${count} new` : ''}</span><button data-close title="hide (R)">✕</button></div><div class="dock-terminal"></div><div class="feed">${shown.map((event) => eventHTML(ctx, event, cursor, true)).join('') || '<div class="feed-placeholder">No reviewer actions yet.</div>'}</div><div class="dfoot"><button data-full>full console ›</button></div>`;
  const changed = ctx.patchHTML(dock, structure);
  if (session?.pane) ctx.mount(dock.querySelector('.dock-terminal'), session.pane, { slot: 'dock' });
  else dock.querySelector('.dock-terminal').innerHTML = '<div class="placeholder">No reviewer pane</div>';
  if (changed) {
    dock.querySelector('[data-close]').addEventListener('click', () => ctx.setDock(false));
    dock.querySelector('[data-full]').addEventListener('click', () => ctx.setMode('reviewer'));
    bindCardButtons(ctx, dock);
  }
  if (markReviewerSeen(ctx)) renderReviewerTop(ctx);
}

export function closeReviewerPopover() {
  document.querySelector('#rterm .acts')?.classList.remove('open');
}
