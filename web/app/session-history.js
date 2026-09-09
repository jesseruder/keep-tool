const KEY = 'keep.console.session-history.v1';
const LIMIT = 50;
const valid = (entry) => entry && typeof entry.sessionId === 'string' && /^[A-Za-z0-9_-]+$/.test(entry.sessionId)
  && ['triage', 'watch'].includes(entry.view);
const clean = (entry) => ({ sessionId: entry.sessionId, view: entry.view,
  title: String(entry.title || '').slice(0, 300), project: String(entry.project || '').slice(0, 1000),
  layout: String(entry.layout || '').slice(0, 200), at: Number(entry.at) || 0 });
const same = (a, b) => a?.sessionId === b?.sessionId && a?.view === b?.view && a?.layout === b?.layout;

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
      recent = [entry, ...recent.filter((old) => old.sessionId !== entry.sessionId)].slice(0, LIMIT);
      save();
    },
    move(delta) {
      const next = index + delta;
      if (!Number.isInteger(delta) || next < 0 || next >= entries.length) return null;
      index = next;
      const entry = entries[index];
      recent = [{ ...entry, at: Date.now() }, ...recent.filter((old) => old.sessionId !== entry.sessionId)].slice(0, LIMIT);
      save(); return entry;
    },
  };
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
      const info = describe(entry);
      return `<button data-history-entry="${index}"><b>${esc(info.title)}</b><span>${esc(info.project)} · ${esc(info.status)} · ${entry.view === 'watch' ? 'Watch' : 'Triage'}</span></button>`;
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
