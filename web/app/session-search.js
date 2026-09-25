import { numBadgeHTML, numHaystack } from './session-number.js';

// ⌘F: a quick switcher over every conversation the daemon knows, live or not.
// Typing narrows by title, #number, project, card id or card title; Enter jumps
// there the same way the history menu does. It never opens a process.

const LIMIT = 40;
const LIVE = new Set(['waiting', 'running']);

const time = (value) => (typeof value === 'number' ? value : Date.parse(value) || 0);
const lastTouched = (session) => Math.max(time(session.lastUserAt), time(session.mtime));

// Every whitespace-separated word must appear somewhere in the row. A bare number
// or `#n` that is the session's own number wins outright, so `384` then Enter
// always lands on #384 however many titles mention 384.
export function rankSessions(rows, query, recentIds = []) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const recency = new Map(recentIds.map((id, at) => [id, at]));
  const scored = [];
  for (const row of rows) {
    const title = String(row.title || '').toLowerCase();
    const haystack = [title, ...numHaystack(row.num), row.project, row.card, row.cardTitle, row.agent]
      .filter(Boolean).join('\n').toLowerCase();
    if (!words.every((word) => haystack.includes(word))) continue;
    let score = 0;
    if (words.length === 1 && /^#?\d+$/.test(words[0]) && Number(words[0].replace('#', '')) === row.num) score += 1000;
    if (words.length && title.startsWith(words[0])) score += 20;
    if (words.length && words.every((word) => title.includes(word))) score += 10;
    if (LIVE.has(row.state)) score += 5;
    // With nothing typed, the recently focused list leads, newest first.
    if (!words.length && recency.has(row.id)) score += 100 - recency.get(row.id);
    scored.push({ row, score });
  }
  return scored.sort((a, b) => b.score - a.score || b.row.touched - a.row.touched)
    .slice(0, LIMIT).map(({ row }) => row);
}

export function sessionRows(sessions, { tasks = [], projectName = (path) => path, statusOf = () => '', hidden = () => false } = {}) {
  const cards = new Map(tasks.map((task) => [task.id, task]));
  return (sessions || []).filter((session) => session?.id && !session.reviewer && !session.agentName && !hidden(session))
    .map((session) => ({
      id: session.id, num: session.num, title: session.title || session.id, state: session.state,
      project: projectName(session.project), agent: session.kind || '', card: session.taskId || '',
      cardTitle: cards.get(session.taskId)?.fm?.title || '', status: statusOf(session), touched: lastTouched(session),
    }));
}

export function sessionRowHTML(row, index, selected, esc) {
  const meta = [row.project, row.status, row.card].filter(Boolean).map(esc).join(' · ');
  return `<li role="option" id="session-search-${index}" data-index="${index}" aria-selected="${selected}"${selected ? ' class="sel"' : ''}>`
    + `<b>${numBadgeHTML(esc, row.num, row.id)}${esc(row.title)}</b><span>${meta}</span></li>`;
}

export function installSessionSearch({ rows, recentIds, open, esc }) {
  let dialog, input, list, results = [], selected = 0;
  const render = () => {
    list.innerHTML = results.map((row, index) => sessionRowHTML(row, index, index === selected, esc)).join('')
      || '<li class="empty">No matching sessions</li>';
    input.setAttribute('aria-activedescendant', results.length ? `session-search-${selected}` : '');
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };
  const search = () => { results = rankSessions(rows(), input.value, recentIds()); selected = 0; render(); };
  const choose = (row) => { if (!row) return; dialog.close(); open(row.id); };
  const build = () => {
    dialog = document.createElement('dialog');
    dialog.className = 'session-search-dialog';
    dialog.innerHTML = '<input type="search" placeholder="Find a session: title, #number, project or card" aria-label="Find a session" role="combobox" aria-controls="session-search-list" aria-expanded="true" autocomplete="off" spellcheck="false">'
      + '<ul id="session-search-list" role="listbox"></ul>';
    input = dialog.querySelector('input');
    list = dialog.querySelector('ul');
    input.addEventListener('input', search);
    input.addEventListener('keydown', (event) => {
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
        ?? (event.ctrlKey && { n: 1, p: -1, j: 1, k: -1 }[event.key]);
      if (step) {
        event.preventDefault();
        if (results.length) { selected = (selected + step + results.length) % results.length; render(); }
      } else if (event.key === 'Enter') {
        event.preventDefault();
        choose(results[selected]);
      } else if (event.metaKey && event.key.toLowerCase() === 'f') {
        // ⌘F again selects the query, like a browser's find field.
        event.preventDefault();
        input.select();
      }
    });
    list.addEventListener('click', (event) => choose(results[Number(event.target.closest('[data-index]')?.dataset.index)]));
    // A click on the backdrop lands on the dialog itself.
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    document.body.append(dialog);
  };
  return {
    get open() { return Boolean(dialog?.open); },
    show() {
      if (!dialog?.isConnected) build();
      if (!dialog.open) dialog.showModal();
      input.select();
      search();
    },
  };
}
