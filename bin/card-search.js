'use strict';
// Words in cards: `keep search` answers "where did we decide X" from the registry
// as well as from conversations. Every card is read (969 of them, 7 MB, on
// 2026-09-25 — tens of milliseconds through the parse cache), so there is no index
// to keep in step with the files.

const SNIPPET_BEFORE = 60;
const SNIPPET_LENGTH = 200;

function words(query) {
  return String(query || '').toLowerCase().replace(/[\u0000-\u001f\u007f]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 8);
}

// The passage around the first word found in the body, with each word bracketed
// the way `keep turns search` brackets its matches.
function snippet(body, terms) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return '';
  const start = Math.max(0, at - SNIPPET_BEFORE);
  let passage = text.slice(start, start + SNIPPET_LENGTH);
  const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  passage = passage.replace(pattern, '[$1]');
  return `${start > 0 ? '…' : ''}${passage}${start + SNIPPET_LENGTH < text.length ? '…' : ''}`;
}

const updatedAt = (task) => Date.parse(task.fm?.updated || task.fm?.created || '') || 0;

// Every word must appear in the card's id, title, tags or text. A card whose title
// holds every word leads, then one whose title holds some; within each, the most
// recently updated first.
function searchCards(tasks, query, options = {}) {
  const terms = words(query);
  if (!terms.length || terms.join(' ').length < 2) return [];
  const results = [];
  for (const task of tasks || []) {
    if (!task?.id) continue;
    if (options.project && task.fm?.project !== options.project) continue;
    const title = String(task.fm?.title || '').toLowerCase();
    const tags = (Array.isArray(task.fm?.tags) ? task.fm.tags : []).join(' ').toLowerCase();
    const haystack = `${task.id}\n${title}\n${tags}\n${String(task.body || '').toLowerCase()}`;
    if (!terms.every((term) => haystack.includes(term))) continue;
    const inTitle = terms.filter((term) => title.includes(term) || task.id.includes(term)).length;
    results.push({
      id: task.id, title: task.fm?.title || task.id, status: task.fm?.status || '', project: task.fm?.project || '',
      updated: task.fm?.updated || task.fm?.created || '',
      snippet: inTitle === terms.length ? '' : snippet(task.body, terms),
      rank: inTitle === terms.length ? 2 : inTitle ? 1 : 0, at: updatedAt(task),
    });
  }
  return results.sort((a, b) => b.rank - a.rank || b.at - a.at)
    .slice(0, options.limit || 20)
    .map(({ rank: _rank, at: _at, ...card }) => card);
}

module.exports = { searchCards, snippet, words };
