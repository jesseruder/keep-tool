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

// The daemon marks each matched word with \u0002…\u0003 (bin/session-text-search.js).
// Everything is escaped first, and a stray or unbalanced marker can only ever
// open or close one <mark>.
export function snippetHTML(snippet, esc) {
  let html = '', open = false;
  for (const part of String(snippet || '').split(/([\u0002\u0003])/)) {
    if (part === '\u0002') { if (!open) html += '<mark>'; open = true; }
    else if (part === '\u0003') { if (open) html += '</mark>'; open = false; }
    else html += esc(part);
  }
  return open ? `${html}</mark>` : html;
}

// Conversation hits for sessions the console lists, and not already matched by
// title: the index also holds sessions the console has long forgotten.
export function textRows(hits, rows, shown) {
  const known = new Map(rows.map((row) => [row.id, row]));
  const listed = new Set(shown.map((row) => row.id));
  return (hits || []).filter((hit) => known.has(hit.sessionId) && !listed.has(hit.sessionId))
    .map((hit) => ({ ...known.get(hit.sessionId), snippet: hit.snippet, said: hit.role === 'user' ? 'You' : 'Agent' }));
}

export function sessionRowHTML(row, index, selected, esc) {
  const meta = row.snippet != null ? `${esc(row.said)}: ${snippetHTML(row.snippet, esc)}`
    : [row.project, row.status, row.card].filter(Boolean).map(esc).join(' · ');
  const classes = [selected ? 'sel' : '', row.snippet != null ? 'said' : ''].filter(Boolean).join(' ');
  return `<li role="option" id="session-search-${index}" data-index="${index}" aria-selected="${selected}"${classes ? ` class="${classes}"` : ''}>`
    + `<b>${numBadgeHTML(esc, row.num, row.id)}${esc(row.title)}</b><span>${meta}</span></li>`;
}

const TEXT_DELAY_MS = 180;
const TEXT_MIN = 3;

export function installSessionSearch({ rows, recentIds, open, esc, searchText = null }) {
  let dialog, input, list, returnTo = null, all = [], titled = [], said = [], results = [], selected = 0;
  let textTimer = 0, textSequence = 0, searching = false;
  const render = () => {
    const firstSaid = titled.length;
    list.innerHTML = results.map((row, index) => (index === firstSaid ? '<li class="heading" role="presentation">In conversation</li>' : '')
      + sessionRowHTML(row, index, index === selected, esc)).join('')
      || `<li class="empty">${searching ? 'Searching conversations…' : 'No matching sessions'}</li>`;
    if (results.length) input.setAttribute('aria-activedescendant', `session-search-${selected}`);
    else input.removeAttribute('aria-activedescendant');
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };
  // Titles answer at once; what was said follows once typing pauses. A reply to an
  // older query, or one that arrives after the finder closed, is dropped.
  const searchSaid = (query, sequence) => {
    searchText(query).then((hits) => {
      if (sequence !== textSequence || !dialog.open) return;
      searching = false;
      // Superseded by another console's search: the daemon runs one at a time.
      if (!hits) { render(); return; }
      const current = results[selected]?.id;
      said = textRows(hits, all, titled);
      results = [...titled, ...said];
      selected = Math.max(0, results.findIndex((row) => row.id === current));
      render();
    }, () => {
      if (sequence !== textSequence) return;
      searching = false;
      render();
    });
  };
  const search = () => {
    const query = input.value;
    titled = rankSessions(all, query, recentIds());
    said = [];
    results = titled;
    selected = 0;
    clearTimeout(textTimer);
    const sequence = ++textSequence;
    searching = Boolean(searchText) && query.trim().length >= TEXT_MIN;
    if (searching) textTimer = setTimeout(() => searchSaid(query, sequence), TEXT_DELAY_MS);
    render();
  };
  // Choosing a session leaves focus to the navigation; handing it back to the
  // terminal being left would take control of that pane on its way out.
  const choose = (row) => { if (!row) return; returnTo = null; dialog.close(); open(row.id); };
  const stopSearching = () => { clearTimeout(textTimer); textSequence += 1; searching = false; };
  const build = () => {
    dialog = document.createElement('dialog');
    dialog.className = 'session-search-dialog';
    dialog.innerHTML = '<input type="text" placeholder="Find a session: title, #number, project, card or what was said" aria-label="Find a session" role="combobox" aria-controls="session-search-list" aria-expanded="true" autocomplete="off" spellcheck="false">'
      + '<ul id="session-search-list" role="listbox" aria-label="Sessions"></ul>';
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
    // Focus stays in the field: a click on a row, the padding or the empty note must
    // not drop it to <body>, where the console's bare-key shortcuts would act on the
    // page behind the finder.
    dialog.addEventListener('mousedown', (event) => { if (event.target !== input) event.preventDefault(); });
    // A click on the backdrop lands on the dialog itself.
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    // A modal dialog always refocuses whatever had focus before showModal(), so
    // show() blurs that first and a dismissal (Escape, the backdrop) restores it here.
    dialog.addEventListener('close', () => {
      stopSearching();
      const target = returnTo;
      returnTo = null;
      if (target?.isConnected) target.focus();
    });
    document.body.append(dialog);
  };
  return {
    get open() { return Boolean(dialog?.open); },
    show() {
      if (!dialog?.isConnected) build();
      if (!dialog.open) {
        returnTo = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
        returnTo?.blur();
        dialog.showModal();
      }
      all = rows();
      input.select();
      search();
    },
  };
}
