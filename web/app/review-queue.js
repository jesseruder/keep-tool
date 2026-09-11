import { write } from './api.js';

const STATUSES = ['needs-decision', 'in-progress', 'resolved'];
const LABELS = { 'needs-decision': 'Needs decision', 'in-progress': 'In progress', resolved: 'Resolved' };
let status = 'needs-decision';
let selectedId = null;
let showLater = false;
let query = '';
let form = null;
let suppressAutoSelect = false;
const pending = new Map();

const newRequestId = () => globalThis.crypto?.randomUUID?.() || `review-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const allItems = (ctx) => ctx.data.reviewQueue?.items || [];
const isLater = (item) => Number.isFinite(Date.parse(item.deferredUntil)) && Date.parse(item.deferredUntil) > Date.now();
const text = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

function outcomeHTML(ctx, outcome) {
  if (!outcome) return '';
  if (typeof outcome === 'string') return `<section><h3>Outcome</h3><p>${ctx.esc(outcome)}</p></section>`;
  const status = String(outcome.status || 'resolved').replace(/-/g, ' ');
  const details = [outcome.reason, outcome.message, outcome.evidence].filter(Boolean);
  return `<section class="review-outcome"><h3>Outcome</h3><strong>${ctx.esc(status)}</strong>${details.map((value) => `<p>${ctx.esc(value)}</p>`).join('')}</section>`;
}

function launchStateHTML(ctx, item) {
  const launch = item.launchState;
  const error = item.launchError;
  if (!launch && !error) return '';
  const needsAttention = launch?.state === 'needs-attention' || Boolean(error);
  const message = launch?.message || error?.message || (launch?.state === 'opening'
    ? 'Opening conversation…' : launch?.state === 'delivered' ? 'Conversation delivered.' : 'Opening was interrupted.');
  const sessionId = launch?.sessionId || error?.sessionId;
  return `<div class="${needsAttention ? 'review-action-error' : 'review-action-pending'}" role="${needsAttention ? 'alert' : 'status'}">${ctx.esc(message)}${sessionId ? ` <button class="btn" data-review-session="${ctx.esc(sessionId)}">Open conversation</button>` : ''}${launch?.recoverable && launch.action && launch.requestId ? ' <button class="btn" data-review-recover>Retry opening</button>' : ''}</div>`;
}

function visibleItems(ctx) {
  const needle = query.trim().toLowerCase();
  return allItems(ctx).filter((item) => item.status === status && (status !== 'needs-decision' || showLater || !isLater(item))
    && (!needle || [item.title, item.card, item.project, item.body].some((value) => String(value || '').toLowerCase().includes(needle))))
    .sort((a, b) => (Date.parse(b.at) || Number(b.at) || 0) - (Date.parse(a.at) || Number(a.at) || 0));
}

function selected(ctx) {
  const visible = visibleItems(ctx);
  if (!visible.some((item) => item.id === selectedId)) selectedId = suppressAutoSelect ? null : visible[0]?.id || null;
  return visible.find((item) => item.id === selectedId) || null;
}

function count(ctx, value) {
  const supplied = Number(ctx.data.reviewQueue?.counts?.[value]);
  return Number.isFinite(supplied) ? supplied : allItems(ctx).filter((item) => item.status === value).length;
}

function itemList(ctx, current) {
  const visible = visibleItems(ctx);
  if (!visible.length) return `<div class="qempty"><b>No matching items</b>${query ? 'Try another title, card, project, or phrase.' : 'Reviewer ideas and findings will appear here.'}</div>`;
  return visible.map((item) => `<button class="review-queue-item ${item.id === current?.id ? 'selected' : ''}" data-review-item="${ctx.esc(item.id)}">
    <span class="review-queue-item-meta"><span class="review-kind ${ctx.esc(item.type)}">${ctx.esc(item.type)}</span>${item.severity ? `<span class="review-severity">${ctx.esc(item.severity)}</span>` : ''}<time>${ctx.esc(ctx.rel(item.at))}</time></span>
    <strong>${ctx.esc(item.title || item.id)}</strong><span>${ctx.esc(item.project || item.card || '')}</span>
    ${isLater(item) ? `<em>Later · ${ctx.esc(new Date(item.deferredUntil).toLocaleString())}</em>` : ''}
    ${item.launchState?.state === 'opening' ? '<em>Opening conversation…</em>' : item.launchState?.state === 'needs-attention' ? '<em>Opening needs attention</em>' : ''}
  </button>`).join('');
}

function formHTML(ctx, item) {
  if (form?.id !== item.id) return '';
  if (form.action === 'defer') return `<form class="review-action-form" data-review-form="defer"><label>Bring this back<input type="datetime-local" name="until" required value="${ctx.esc(form.value)}"></label>${form.error ? `<p role="alert">${ctx.esc(form.error)}</p>` : ''}<div><button class="btn primary" type="submit">Save for later</button><button class="btn" type="button" data-review-cancel>Cancel</button></div></form>`;
  return `<form class="review-action-form" data-review-form="dismiss"><label>Why dismiss this?<textarea name="reason" rows="3" required>${ctx.esc(form.value)}</textarea></label>${form.error ? `<p role="alert">${ctx.esc(form.error)}</p>` : ''}<div><button class="btn primary" type="submit">Dismiss</button><button class="btn" type="button" data-review-cancel>Cancel</button></div></form>`;
}

function detail(ctx, item) {
  if (!item) return '<div class="qempty"><b>Select a review item</b>Choose an idea or finding to read it and decide what happens next.</div>';
  const work = pending.get(item.id);
  const disabled = work && !work.error ? 'disabled' : '';
  const launchBlocked = ['opening', 'needs-attention'].includes(item.launchState?.state);
  const sessions = item.sessions || [];
  return `<article class="review-queue-detail" data-review-detail="${ctx.esc(item.id)}">
    <header><div><span class="review-kind ${ctx.esc(item.type)}">${ctx.esc(item.type)}</span>${item.severity ? `<span class="review-severity">${ctx.esc(item.severity)}</span>` : ''}</div><span class="review-status">${ctx.esc(LABELS[item.status] || item.status)}</span></header>
    <h2>${ctx.esc(item.title || item.id)}</h2>
    <div class="review-context">${item.project ? ctx.projectHTML(item.project) : ''}${item.card ? `<button data-review-card="${ctx.esc(item.card)}">${ctx.esc(item.card)}</button>` : ''}<time>${ctx.esc(new Date(item.at).toLocaleString())}</time></div>
    <div class="review-body">${ctx.esc(item.body || 'No review notes were provided.')}</div>
    ${item.evidence ? `<section><h3>Evidence</h3><pre>${ctx.esc(text(item.evidence))}</pre></section>` : ''}
    ${outcomeHTML(ctx, item.outcome)}
    ${isLater(item) ? `<p class="review-later">Deferred until ${ctx.esc(new Date(item.deferredUntil).toLocaleString())}</p>` : ''}
    ${sessions.length ? `<section class="review-conversations"><h3>Conversations</h3>${sessions.map((session) => `<button class="btn" data-review-session="${ctx.esc(session.id)}">${session.action === 'start' ? 'Work' : 'Discussion'} · ${ctx.esc(ctx.rel(session.at))}</button>`).join('')}</section>` : ''}
    ${launchStateHTML(ctx, item)}
    ${launchBlocked ? '' : item.status === 'needs-decision' ? `<div class="review-actions"><button class="btn primary" data-review-action="start" ${disabled}>Start work</button><button class="btn" data-review-action="discuss" ${disabled}>Discuss</button><button class="btn" data-review-action="defer" ${disabled}>Later</button><button class="btn" data-review-action="dismiss" ${disabled}>Dismiss</button></div>` : item.status === 'in-progress' ? `<div class="review-actions"><button class="btn" data-review-action="discuss" ${disabled}>Discuss</button><button class="btn" data-review-action="dismiss" ${disabled}>Dismiss</button></div>` : ''}
    ${work?.error ? `<div class="review-action-error" role="alert">${ctx.esc(work.error)} <button class="btn" data-review-retry>Retry</button></div>` : work ? `<div class="review-action-pending" role="status">${['discuss', 'start'].includes(work.action) ? 'Opening a fresh conversation…' : 'Saving…'}</div>` : ''}
    ${formHTML(ctx, item)}
  </article>`;
}

async function submit(ctx, item, action, fields = {}, retry = false, requestIdOverride = null, recovery = false) {
  const existing = pending.get(item.id);
  if (existing && !existing.error) return;
  const request = !retry && existing?.action === action
    ? existing : { action, fields, requestId: requestIdOverride || newRequestId(), recovery, error: '' };
  request.fields = fields;
  request.error = '';
  pending.set(item.id, request);
  form = null;
  renderReviewQueue(ctx);
  try {
    const result = await write('/api/review-queue', { id: item.id, action, requestId: request.requestId, ...fields });
    pending.delete(item.id);
    await ctx.reload();
    if (result?.sessionId) ctx.openReviewSession(result.sessionId);
  } catch (error) {
    request.error = error.message;
    request.httpResponse = Number.isFinite(error.status);
    pending.set(item.id, request);
    if (error.body?.item) {
      const index = allItems(ctx).findIndex((candidate) => candidate.id === item.id);
      if (index >= 0) ctx.data.reviewQueue.items[index] = error.body.item;
      status = error.body.item.status;
      selectedId = error.body.item.id;
      query = '';
      suppressAutoSelect = false;
      if (error.body.item.launchState || request.recovery && !error.body.item.launchState) pending.delete(item.id);
    }
    renderReviewQueue(ctx);
  }
}

function bind(ctx, root, current) {
  root.querySelectorAll('[data-review-filter]').forEach((button) => button.addEventListener('click', () => { status = button.dataset.reviewFilter; selectedId = null; suppressAutoSelect = false; form = null; renderReviewQueue(ctx); }));
  root.querySelector('[data-review-search]')?.addEventListener('input', (event) => { query = event.target.value; suppressAutoSelect = false; renderReviewQueue(ctx); });
  root.querySelector('[data-review-later]')?.addEventListener('click', (event) => { showLater = event.currentTarget.getAttribute('aria-pressed') !== 'true'; selectedId = null; renderReviewQueue(ctx); });
  root.querySelectorAll('[data-review-item]').forEach((button) => button.addEventListener('click', () => { selectedId = button.dataset.reviewItem; suppressAutoSelect = false; form = null; renderReviewQueue(ctx); }));
  root.querySelectorAll('[data-review-session]').forEach((button) => button.addEventListener('click', () => ctx.openReviewSession(button.dataset.reviewSession)));
  root.querySelector('[data-review-recover]')?.addEventListener('click', () => {
    const launch = current.launchState;
    if (launch?.recoverable && launch.action && launch.requestId) void submit(ctx, current, launch.action, {}, false, launch.requestId, true);
  });
  root.querySelector('[data-review-card]')?.addEventListener('click', (event) => ctx.openReviewCard(event.currentTarget.dataset.reviewCard));
  root.querySelectorAll('[data-review-action]').forEach((button) => button.addEventListener('click', () => {
    const action = button.dataset.reviewAction;
    if (action === 'defer' || action === 'dismiss') {
      form = { id: current.id, action, value: '' };
      renderReviewQueue(ctx);
      requestAnimationFrame(() => root.querySelector(`[data-review-form=${action}] ${action === 'defer' ? 'input' : 'textarea'}`)?.focus());
    } else void submit(ctx, current, action);
  }));
  root.querySelector('[data-review-cancel]')?.addEventListener('click', () => { form = null; renderReviewQueue(ctx); });
  const actionForm = root.querySelector('[data-review-form]');
  actionForm?.addEventListener('input', (event) => { if (form) form.value = event.target.value; });
  actionForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const action = event.currentTarget.dataset.reviewForm;
    const values = new FormData(event.currentTarget);
    const chosen = action === 'defer' ? new Date(values.get('until')) : null;
    if (action === 'defer' && (!Number.isFinite(chosen.getTime()) || chosen.getTime() <= Date.now())) {
      form.error = 'Choose a future date and time.';
      renderReviewQueue(ctx);
      return;
    }
    const fields = action === 'defer' ? { until: chosen.toISOString() } : { reason: String(values.get('reason') || '').trim() };
    if (action === 'dismiss' && !fields.reason) return;
    void submit(ctx, current, action, fields);
  });
  root.querySelector('[data-review-retry]')?.addEventListener('click', () => {
    const request = pending.get(current.id);
    if (request) void submit(ctx, current, request.action, request.fields, request.httpResponse && !request.recovery, request.requestId, request.recovery);
  });
}

export function renderReviewQueue(ctx) {
  const root = document.querySelector('#review-queue');
  const current = selected(ctx);
  const later = allItems(ctx).filter((item) => item.status === 'needs-decision' && isLater(item)).length;
  const activeNode = root.contains(document.activeElement) ? document.activeElement : null;
  const active = activeNode ? {
    name: activeNode.getAttribute('name'), search: activeNode.hasAttribute('data-review-search'), start: activeNode.selectionStart, end: activeNode.selectionEnd,
    attr: ['reviewItem', 'reviewFilter', 'reviewAction', 'reviewSession', 'reviewRecover', 'reviewRetry', 'reviewLater', 'reviewCancel'].find((key) => activeNode.dataset[key] !== undefined),
  } : null;
  if (active?.attr) active.value = activeNode.dataset[active.attr];
  const listScroll = root.querySelector('.review-queue-items')?.scrollTop || 0;
  const mainScroll = root.querySelector('.review-queue-main')?.scrollTop || 0;
  const html = `<aside class="review-queue-list"><div class="review-queue-heading"><h1>Review queue</h1><p>Ideas and findings waiting for a decision.</p></div><nav class="review-queue-filters">${STATUSES.map((value) => `<button class="btn ${status === value ? 'on' : ''}" data-review-filter="${value}" aria-pressed="${status === value}">${LABELS[value]} <span>${count(ctx, value)}</span></button>`).join('')}</nav><input type="search" data-review-search aria-label="Search review queue" placeholder="Search title, card, project, or notes" value="${ctx.esc(query)}">${status === 'needs-decision' && later ? `<button class="review-later-toggle" data-review-later aria-pressed="${showLater}">${showLater ? 'Hide' : 'Show'} ${later} saved for later</button>` : ''}<div class="review-queue-items">${itemList(ctx, current)}</div></aside><div class="review-queue-main">${detail(ctx, current)}</div>`;
  const changed = ctx.patchHTML(root, html);
  if (changed) bind(ctx, root, current);
  root.querySelector('.review-queue-items').scrollTop = listScroll;
  root.querySelector('.review-queue-main').scrollTop = mainScroll;
  if (active) {
    const replacement = active.search ? root.querySelector('[data-review-search]') : active.name ? root.querySelector(`[name="${active.name}"]`)
      : active.attr ? [...root.querySelectorAll(`[data-${active.attr.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}]`)].find((node) => node.dataset[active.attr] === active.value) : null;
    replacement?.focus({ preventScroll: true });
    if (replacement && Number.isInteger(active.start)) replacement.setSelectionRange(active.start, active.end);
  }
}

export function openReviewQueueItem(ctx, id) {
  const item = allItems(ctx).find((candidate) => candidate.id === id);
  if (!item) return false;
  status = item.status;
  if (isLater(item)) showLater = true;
  query = '';
  selectedId = id;
  suppressAutoSelect = false;
  form = null;
  ctx.setMode('review-queue');
  return true;
}

export function reviewQueueIdForNotification(ctx, entry) {
  const explicit = entry?.reviewQueueId || entry?.reviewItemId || entry?.queueItemId;
  if (explicit && allItems(ctx).some((item) => item.id === explicit)) return explicit;
  const idea = entry?.caller === 'reviewer-idea' && entry.card ? `idea:${entry.card}` : null;
  if (idea && allItems(ctx).some((item) => item.id === idea)) return idea;
  const key = entry?.findingKey || entry?.reviewFindingKey || entry?.key;
  const finding = entry?.card && key ? `finding:${entry.card}:${key}` : null;
  return finding && allItems(ctx).some((item) => item.id === finding) ? finding : null;
}

export function openReviewQueueNotification(ctx, entry) {
  const id = reviewQueueIdForNotification(ctx, entry);
  if (id) return openReviewQueueItem(ctx, id);
  if (!entry?.card) return false;
  status = 'needs-decision';
  showLater = true;
  query = entry.card;
  selectedId = null;
  suppressAutoSelect = true;
  form = null;
  ctx.setMode('review-queue');
  return true;
}
