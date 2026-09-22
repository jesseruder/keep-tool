import { numBadgeHTML } from './session-number.js';

const KEY = 'keep.console.session-history.v1';
const LIMIT = 50;
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
const valid = (entry) => entry && (id(entry.sessionId) || id(entry.paneId)) && ['triage', 'watch'].includes(entry.view);
const num = (value) => Number.isInteger(value) && value >= 1;
const clean = (entry) => ({ ...(id(entry.sessionId) ? { sessionId: entry.sessionId } : {}),
  ...(id(entry.paneId) ? { paneId: entry.paneId } : {}), ...(num(entry.num) ? { num: entry.num } : {}), view: entry.view,
  title: String(entry.title || '').slice(0, 300), project: String(entry.project || '').slice(0, 1000),
  layout: String(entry.layout || '').slice(0, 200), at: Number(entry.at) || 0 });
const identity = (entry) => entry?.sessionId ? `session:${entry.sessionId}` : entry?.paneId ? `pane:${entry.paneId}` : '';
const same = (a, b) => identity(a) === identity(b) && a?.view === b?.view && a?.layout === b?.layout;

export function createSessionHistory(storage) {
  let entries = [], recent = [], index = -1;
  try {
    const saved = JSON.parse(storage.getItem(KEY));
    if (saved && Array.isArray(saved.entries) && saved.entries.length <= LIMIT && saved.entries.every(valid)) {
      entries = saved.entries.map(clean);
      index = Math.max(entries.length ? 0 : -1, Math.min(entries.length - 1, Number.isInteger(saved.index) ? saved.index : entries.length - 1));
      recent = (Array.isArray(saved.recent) ? saved.recent : entries.slice().reverse()).filter(valid).slice(0, LIMIT).map(clean);
    }
  } catch {}
  const save = () => { try { storage.setItem(KEY, JSON.stringify({ entries, recent, index })); } catch {} };
  return {
    get current() { return entries[index]; },
    get recent() { return recent.slice(); },
    get canBack() { return index > 0; },
    get canForward() { return index >= 0 && index < entries.length - 1; },
    visit(value) {
      if (!valid(value)) return;
      const entry = clean(value);
      if (same(entries[index], entry)) entries[index] = entry;
      else { entries = [...entries.slice(0, index + 1), entry].slice(-LIMIT); index = entries.length - 1; }
      recent = [entry, ...recent.filter((old) => identity(old) !== identity(entry))].slice(0, LIMIT);
      save();
    },
    bindPane(paneId, sessionId, value = {}) {
      if (!id(paneId) || !id(sessionId)) return false;
      let changed = false;
      const bind = (entry) => {
        // Pane ids can be reused by in-place restart and handoff. They only supply
        // identity while a launch is unbound; never rewrite recorded conversation
        // history to whichever session owns that pane later.
        if (entry.paneId !== paneId || entry.sessionId) return entry;
        changed = true;
        return clean({ ...entry, ...value, paneId, sessionId });
      };
      entries = entries.map(bind);
      recent = recent.map(bind);
      if (changed) {
        // A session may have been visited after the pane entry was recorded. Keep the
        // newest recent card, while the chronological back/forward trail stays intact.
        recent = recent.filter((entry, at, all) => all.findIndex((candidate) => identity(candidate) === identity(entry)) === at);
        save();
      }
      return changed;
    },
    move(delta) {
      const next = index + delta;
      if (!Number.isInteger(delta) || next < 0 || next >= entries.length) return null;
      index = next;
      const entry = entries[index];
      recent = [{ ...entry, at: Date.now() }, ...recent.filter((old) => identity(old) !== identity(entry))].slice(0, LIMIT);
      save(); return entry;
    },
  };
}

// One row of the recently-focused list. The session's console number leads the
// title, as it does on queue rows, so a long title's ellipsis never hides it.
export function historyEntryHTML(entry, index, info, esc) {
  const badge = numBadgeHTML(esc, info.num, entry.sessionId);
  return `<button data-history-entry="${index}"><b>${badge}${esc(info.title)}</b><span>${esc(info.project)} · ${esc(info.status)} · ${entry.view === 'watch' ? 'Watch' : 'Triage'}</span></button>`;
}

export function installSessionHistory({ history, describe, navigate, esc }) {
  const root = document.querySelector('#sessionHistory');
  const back = root.querySelector('[data-history-back]');
  const forward = root.querySelector('[data-history-forward]');
  const toggle = root.querySelector('[data-history-toggle]');
  const pop = root.querySelector('.history-pop');
  const close = () => { pop.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };
  const update = () => { back.disabled = !history.canBack; forward.disabled = !history.canForward; };
  const go = (delta) => { const entry = history.move(delta); close(); if (entry) navigate(entry); update(); };
  back.onclick = () => go(-1);
  forward.onclick = () => go(1);
  toggle.onclick = () => {
    if (!pop.hidden) { close(); return; }
    const entries = history.recent;
    pop.innerHTML = '<div class="history-heading">Recently focused · saved on this device</div>' + (entries.map((entry, index) => {
      return historyEntryHTML(entry, index, describe(entry), esc);
    }).join('') || '<p>No sessions visited yet.</p>');
    pop.querySelectorAll('[data-history-entry]').forEach((button) => {
      const entry = entries[Number(button.dataset.historyEntry)];
      button.onclick = () => { close(); history.visit({ ...entry, at: Date.now() }); navigate(entry); update(); };
    });
    pop.hidden = false;
    pop.style.left = `${Math.max(8, Math.min(root.getBoundingClientRect().left, window.innerWidth - pop.offsetWidth - 8))}px`;
    toggle.setAttribute('aria-expanded', 'true');
  };
  document.addEventListener('pointerdown', (event) => { if (!root.contains(event.target)) close(); });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { close(); toggle.focus(); event.preventDefault(); }
    if (!event.metaKey && !event.ctrlKey && !event.altKey) event.stopPropagation();
  });
  update();
  return { update, close };
}
