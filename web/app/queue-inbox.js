// The Queue's Inbox section: cards nobody has started, listed under Recent so a
// new card or a reviewer idea is reachable without `keep list --status inbox`.
//
// Collapsed to a count by default, remembered per viewer. A row is a card, not a
// session: it never takes the Triage selection or j/k, and it is not a `.qitem`,
// so the phone does not push the stage for it. Clicking a row opens the card's
// notes in place through the same /api/dashboard-detail path the stage and the
// inbox dialog use; the notes carry Open (the console's open-card chooser, which
// starts a session through /api/open and moves the card to active), Done and
// Dismiss.
import { closeInboxCard } from './api.js';
import { runAction } from './action.js';
import { cardArtifactsHTML } from './card-artifacts.js';

const EXPANDED_KEY = 'keep.console.inbox.expanded';
let expanded = null;
let openCard = null;
// Cards a Done or Dismiss has been sent for: hidden until a state without them
// in the inbox arrives, or shown again if the write fails.
const closing = new Set();

export function inboxExpanded() {
  if (expanded === null) {
    expanded = false;
    try { expanded = localStorage.getItem(EXPANDED_KEY) === '1'; } catch {}
  }
  return expanded;
}

function toggleInbox(ctx) {
  expanded = !inboxExpanded();
  try { localStorage.setItem(EXPANDED_KEY, expanded ? '1' : '0'); } catch {}
  ctx.refresh();
}

function updatedAt(task) {
  return Date.parse(task.fm?.updated) || Date.parse(task.createdAt) || Date.parse(task.fm?.created) || 0;
}

// Newest first. The rail's project filter narrows the inbox as it does every
// other section; a card has no provider, so the client filter leaves it alone.
export function inboxCards(ctx) {
  const tasks = ctx.data.tasks || [];
  const inbox = new Set(tasks.filter((task) => task.fm?.status === 'inbox').map((task) => task.id));
  for (const id of closing) if (!inbox.has(id)) closing.delete(id);
  return tasks.filter((task) => inbox.has(task.id) && !closing.has(task.id)
    && (!ctx.state.filter || ctx.projectOf(task.fm.project || '').key === ctx.state.filter))
    .sort((a, b) => updatedAt(b) - updatedAt(a) || a.id.localeCompare(b.id));
}

function notesHTML(ctx, task) {
  const detail = ctx.detail('task', task);
  if (detail.status === 'error') {
    return `<p role="alert">Could not load card notes: ${ctx.esc(detail.error)} <button class="btn" data-inbox-retry>Retry</button></p>`;
  }
  if (detail.status !== 'ready' && task._detailVersion) return '<p class="muted" role="status">Loading card notes…</p>';
  const body = String((detail.value || task).body || '').trim();
  return `<pre>${ctx.esc(body || 'No card notes yet.')}</pre>`;
}

export function inboxRowHTML(ctx, task) {
  const fm = task.fm || {};
  const open = openCard === task.id;
  const kind = fm.kind || 'task';
  return `<button type="button" class="qinbox-main" data-inbox-toggle aria-expanded="${open}"><span class="t">${ctx.esc(fm.title || task.id)}</span>`
    + `<span class="w num">${ctx.esc(ctx.rel(updatedAt(task) || NaN))}</span>`
    + `<span class="p"><span class="kind card-kind ${ctx.esc(kind)}">${ctx.esc(kind)}</span>${fm.project ? ctx.projectHTML(fm.project) : ''}</span></button>`
    + (open ? `<div class="qinbox-detail"><div class="qinbox-id mono">${ctx.esc(task.id)}</div>${notesHTML(ctx, task)}${cardArtifactsHTML(ctx, task)}`
      + '<div class="qinbox-acts"><button class="btn primary" data-inbox-open title="Start a session on this card">Open</button>'
      + '<button class="btn" data-inbox-action="done" title="Close the card as done">Done</button>'
      + '<button class="btn" data-inbox-action="dismiss" title="Close the card as not wanted">Dismiss</button></div></div>' : '');
}

async function act(ctx, task, button) {
  const action = button.dataset.inboxAction;
  closing.add(task.id);
  if (openCard === task.id) openCard = null;
  ctx.refresh();
  try {
    await closeInboxCard(task.id, action);
    ctx.toast(`${action === 'done' ? 'Done' : 'Dismissed'}: ${task.fm?.title || task.id}`);
  } catch (error) {
    error.actionMessage = `The inbox card was not changed; it is back in the list. ${error.message}`;
    throw error;
  } finally {
    // Whatever happened, the next state says where the card stands; until then a
    // failed write shows the row again.
    closing.delete(task.id);
    await ctx.reload();
  }
}

function install(ctx, row) {
  row.addEventListener('click', async (event) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    const id = row.dataset.card;
    const task = (ctx.data.tasks || []).find((candidate) => candidate.id === id);
    if (!button || !task) return;
    if (button.hasAttribute('data-inbox-toggle')) {
      openCard = openCard === id ? null : id;
      if (openCard && task._detailVersion) void ctx.ensureDetail('task', task);
      ctx.refresh();
    } else if (button.hasAttribute('data-inbox-retry')) {
      void ctx.retryDetail('task', task);
    } else if (button.hasAttribute('data-inbox-open')) {
      await runAction(button, () => ctx.reopenSession({ taskId: id, title: task.fm?.title || id, project: task.fm?.project, fromInbox: true }),
        { label: 'Opening…', ctx, retry: () => button.click() }).catch(() => {});
      await ctx.reload();
    } else if (button.dataset.inboxAction) {
      await runAction(button, () => act(ctx, task, button),
        { label: 'Updating…', ctx, retry: () => button.click() }).catch(() => {});
    }
  });
}

// Called from renderQueue with its own row placement, so the section's rows are
// recycled like the queue's and an open row keeps its scroll and focus.
export function placeInbox(ctx, list, addGroup, place) {
  const cards = inboxCards(ctx);
  if (openCard && !cards.some((task) => task.id === openCard)) openCard = null;
  const shown = inboxExpanded();
  const head = addGroup(`${shown ? '▾' : '▸'} Inbox · ${ctx.esc(cards.length)}`, 'qhead qgroup qtoggle qinbox-head', 'button');
  head.setAttribute('aria-expanded', String(shown));
  head.addEventListener('click', () => toggleInbox(ctx));
  if (!shown) return;
  const existing = new Map([...list.querySelectorAll(':scope > .qinbox')].map((row) => [row.dataset.card, row]));
  for (const task of cards) {
    let row = existing.get(task.id);
    if (!row) {
      row = document.createElement('div');
      row.className = 'qinbox';
      row.dataset.card = task.id;
      install(ctx, row);
    }
    row.classList.toggle('open', openCard === task.id);
    row.style.setProperty('--h', ctx.projectOf(task.fm?.project || '').h);
    ctx.patchHTML(row, inboxRowHTML(ctx, task));
    place(row);
  }
}
