'use strict';

const stop = new Set('the and for with from that this into after before keep card task review reviewer check status done active work project implementation fix fixed source latest evidence production staging'.split(' '));
const tokens = text => new Set((String(text || '').toLowerCase().match(/[a-z][a-z0-9]+/g) || []).filter(w => w.length >= 3 && !stop.has(w)));
const clip = (s, n) => String(s || '').slice(0, n);
function workEntries(body) {
  return String(body || '').split(/(?=^## \d{4}-)/m).filter(b => /^## \d{4}-/.test(b) && !/^## [^\n]*— (?:review \(|project changed|landed)/.test(b));
}

// Retrieval candidates, never proof of resolution. Explicit links cross projects;
// topical matches must share a project and two distinctive title terms.
function relatedCards(task, cards, outcomes = [], limit = 4) {
  const source = `${task.fm.title || ''}\n${task.fm.check || ''}\n${workEntries(task.body).slice(0, 6).join('\n').slice(0, 16000)}`;
  const seed = tokens(source);
  const titles = cards.map(c => tokens(c.fm.title));
  const frequencies = new Map();
  for (const set of titles) for (const token of set) frequencies.set(token, (frequencies.get(token) || 0) + 1);
  const dependencies = (Array.isArray(task.fm.depends_on) ? task.fm.depends_on : []).map(entry => require('./keep.js').parseDependency(entry).id);
  return cards.flatMap((card, index) => {
    if (card.id === task.id || card.fm.kind === 'idea') return [];
    const explicit = dependencies.includes(card.id) || source.includes(card.id)
      || workEntries(card.body).slice(0, 2).some(entry => entry.includes(task.id));
    const matching = [...titles[index]].filter(t => seed.has(t) && (frequencies.get(t) || 0) <= Math.max(3, cards.length / 12));
    if (!explicit && (!task.fm.project || card.fm.project !== task.fm.project || matching.length < 2)) return [];
    const entry = workEntries(card.body)[0] || '';
    const latestOutcomes = outcomes.filter(o => o.card === card.id && o.outcome.status !== 'unresolved').slice(0, 2);
    return [{ id: card.id, title: card.fm.title, status: card.fm.status,
      reason: explicit ? 'explicit link/successor reference' : 'shared topic: ' + matching.join(', '),
      evidence: clip(entry, 1100), outcomes: latestOutcomes.map(o => ({ key: o.key, ...o.outcome })),
      score: (explicit ? 100 : 0) + matching.length * 3 + (['done', 'landing'].includes(card.fm.status) ? 1 : 0) }];
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
module.exports = { relatedCards, workEntries };
