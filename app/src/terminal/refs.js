'use strict';

// What an agent prints about other Keep work, found in a terminal row so the native
// terminal can make it tappable: sessions by number (`#453`), cards by id, holds by id
// or bracketed scope, and commit SHAs. The console's xterm does the same on hover
// (web/app/terminal-refs.js); a phone has no hover, so a tap on the reference opens
// the same card as a sheet.
//
// The rules are copies of the console's, because Metro only bundles app/. refs.test.js
// runs both over one set of lines, so a change to either that the other lacks fails.

// `#453`, not `repo#12`, `&#39;`, `##4`, `#12-top`, `PR #12` or `color: #123`
// (web/app/shared/session-mentions.js).
const SESSION_REF = /#(\d{1,6})(?![\w-])/g;
const NOT_SESSION = /(?:\b(?:prs?|pull(?:\s+requests?)?|pulls|issues?|mrs?|bugs?|tickets?|colou?r|fill|stroke|background|bg)[\s:=("'`]*$|[\w#&/=]$)/i;
// A slug of two words or more, not inside a path or file name.
const CARD_REF = /(?<![\w./@:-])[a-z0-9]+(?:-[a-z0-9]+)+(?![\w/@-]|\.\w)/g;
const HOLD_ID = /(?<![\w-])hold-[a-z0-9]+(?![\w-])/g;
const SCOPE_LIST = /\[([a-z0-9][a-z0-9:-]*(?:, [a-z0-9][a-z0-9:-]*)*)\]/g;
// 7-40 hex with a digit and a letter, outside uuids, paths and longer hashes.
const SHA_REF = /(?<![\w/.:#@-])[0-9a-f]{7,40}(?![\w-])/g;

const spans = (text, pattern, key = (match) => match[0]) => [...String(text || '').matchAll(pattern)]
  .map((match) => ({ key: key(match), start: match.index, end: match.index + match[0].length }));

function findSessionRefs(text) {
  const source = String(text || '');
  return spans(source, SESSION_REF, (match) => Number(match[1]))
    .filter((ref) => ref.key >= 1 && !NOT_SESSION.test(source.slice(Math.max(0, ref.start - 24), ref.start)));
}
const findCardRefs = (text) => spans(text, CARD_REF);
const findHoldRefs = (text) => [...spans(text, HOLD_ID), ...spans(text, SCOPE_LIST, (match) => `scope:${match[1]}`)];
const findShaRefs = (text) => spans(text, SHA_REF).filter((ref) => /[0-9]/.test(ref.key) && /[a-f]/.test(ref.key));

function holdsFor(key, holds = []) {
  if (key.startsWith('hold-')) return holds.filter((hold) => hold?.id === key);
  const scopes = new Set(key.slice('scope:'.length).split(', '));
  return holds.filter((hold) => (hold?.scopes || []).some((scope) => scopes.has(scope)));
}

// The references in one row the phone knows about, first come first served, as
// {kind, key, start, end}. `known` is { sessions: Map<num>, cards: Map<id>, holds: [] };
// a SHA is always offered, since only a lookup can say whether a repo has it.
function findRefs(text, known = {}) {
  const kinds = [
    ['session', findSessionRefs, (key) => Boolean(known.sessions?.has(key))],
    ['card', findCardRefs, (key) => Boolean(known.cards?.has(key))],
    ['hold', findHoldRefs, (key) => holdsFor(key, known.holds || []).length > 0],
    ['sha', findShaRefs, (key) => !known.unknownShas?.has(key)],
  ];
  const all = [];
  for (const [kind, find, has] of kinds) {
    for (const ref of find(text)) all.push({ ...ref, kind, has });
  }
  all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept = [];
  let reach = 0;
  for (const ref of all) {
    if (ref.start < reach || !ref.has(ref.key)) continue;
    kept.push({ kind: ref.kind, key: ref.key, start: ref.start, end: ref.end });
    reach = ref.end;
  }
  return kept;
}

// rowSegments' pieces (row.js), cut again wherever a reference starts or ends, the
// pieces inside one carrying it as `ref`. The pieces cover the row's text from 0 in
// order, so their string offsets are the reference spans'.
function splitSegments(segments, refs) {
  if (!refs?.length) return segments;
  const out = [];
  let offset = 0;
  for (const segment of segments) {
    const start = offset;
    const end = start + segment.text.length;
    offset = end;
    let at = start;
    for (const ref of refs) {
      if (ref.end <= at || ref.start >= end) continue;
      if (ref.start > at) out.push({ ...segment, text: segment.text.slice(at - start, ref.start - start) });
      const to = Math.min(ref.end, end);
      out.push({ ...segment, text: segment.text.slice(Math.max(ref.start, at) - start, to - start), ref });
      at = to;
    }
    if (at < end) out.push({ ...segment, text: segment.text.slice(at - start) });
  }
  return out;
}

// A card body's latest check-in (card-log.js recentLogEntries, narrowed to one): its
// kind, stamp, prose and `next:` line. Reviewer entries and Keep's own bookkeeping
// are skipped.
const HEADING = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) — (.+)$/gm;
const SHOWN_KIND = /^(?:check-in|created|done|closed|reopened|plan|needs|state note|check result|probe result)\b/;
function latestLogEntry(body) {
  const text = String(body || '');
  const marks = [...text.matchAll(HEADING)];
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    const [heading, at, rawKind] = marks[index];
    if (!SHOWN_KIND.test(rawKind) || /\(reviewer\b/.test(rawKind)) continue;
    const from = marks[index].index + heading.length;
    const to = index + 1 < marks.length ? marks[index + 1].index : text.length;
    let next = '';
    const prose = [];
    for (const line of text.slice(from, to).trim().split('\n')) {
      const found = line.match(/^next:\s*(.*)$/);
      if (found) next = found[1].trim();
      else if (!/^commits:\s/.test(line)) prose.push(line.trim());
    }
    return { at, kind: rawKind.replace(/\s*\((?:by|reviewer)\b[^)]*\)/g, '').trim(), text: prose.filter(Boolean).join(' '), next };
  }
  return null;
}

const clip = (text, max) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const projectName = (path) => String(path || '').split('/').filter(Boolean).pop() || '';
function ago(ms, now = Date.now()) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const age = Math.max(0, now - ms);
  if (age < 60e3) return 'just now';
  if (age < 3600e3) return `${Math.floor(age / 60e3)}m ago`;
  if (age < 86400e3) return `${Math.floor(age / 3600e3)}h ago`;
  return `${Math.floor(age / 86400e3)}d ago`;
}
function timeLeft(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 3600e3) return `${Math.max(1, Math.round(ms / 60e3))}m left`;
  return `${Math.floor(ms / 3600e3)}h ${Math.round((ms % 3600e3) / 60e3)}m left`;
}

// The sheet a tapped reference opens: { badge, title, meta, rows, quote, sections,
// pending, open }, where `open` is the session id the Open button goes to. `known` is
// what findRefs had, plus `loaded` (what has come back for this reference: `detail`
// for a card's body, `mentions` for a session, `commit` for a SHA, each
// { status, value }).
function describeRef(ref, known = {}, loaded = {}, now = Date.now()) {
  const sessionsById = new Map([...(known.sessions?.values() || [])].map((session) => [session.id, session]));
  const cardSession = (id) => [...(known.sessions?.values() || [])]
    .filter((session) => session.taskId === id && !session.reviewer).sort((a, b) => (b.mtime || 0) - (a.mtime || 0))[0] || null;
  const numLabel = (session) => (session?.num ? `#${session.num}` : '');
  const status = (entry, what) => (!entry || entry.status === 'loading' ? `loading ${what}…` : entry.status === 'error' ? `could not load ${what}` : '');

  if (ref.kind === 'session') {
    const session = known.sessions?.get(ref.key);
    if (!session) return null;
    const task = session.taskId ? known.cards?.get(session.taskId) : null;
    const mentions = loaded.mentions;
    const items = mentions?.status === 'ready' && mentions.value ? [
      ...mentions.value.sessions.map((hit) => `${hit.num ? `#${hit.num}` : String(hit.sessionId).slice(0, 8)} ${hit.title || hit.card || ''}`.trim()),
      ...mentions.value.cards.map((card) => `card ${card.title}${card.status ? ` (${card.status})` : ''}`),
    ] : [];
    return {
      badge: numLabel(session), title: session.title || String(session.id).slice(0, 8),
      meta: [projectName(session.project), session.state].filter(Boolean).join(' · '),
      rows: [
        ['card', task ? `${task.title}${task.status ? ` (${task.status})` : ''}` : session.taskId || ''],
        ['agent', [session.kind, session.accountLabel].filter(Boolean).join(' · ')],
        ['active', ago(session.mtime, now)],
      ].filter(([, value]) => value),
      sections: [{ label: 'mentioned by', items: mentions?.status === 'ready' && !items.length ? ['no other session or card'] : items,
        pending: status(mentions, 'mentions') }],
      open: session.id,
    };
  }
  if (ref.kind === 'card') {
    const task = known.cards?.get(ref.key);
    if (!task) return null;
    const session = cardSession(task.id);
    const entry = loaded.detail?.status === 'ready' ? latestLogEntry(loaded.detail.value?.body) : null;
    return {
      badge: task.status, title: task.title, meta: [projectName(task.project), task.id].filter(Boolean).join(' · '),
      rows: [
        ['session', session ? `${numLabel(session)} ${session.state || ''}`.trim() : ''],
        ['next', entry?.next ? clip(entry.next, 160) : ''],
        ['latest', entry ? `${entry.kind} · ${entry.at}` : ''],
      ].filter(([, value]) => value),
      quote: entry?.text ? clip(entry.text, 320) : '',
      pending: status(loaded.detail, 'the latest check-in'),
      open: session?.id || null,
    };
  }
  if (ref.kind === 'hold') {
    const holds = holdsFor(ref.key, known.holds || []);
    if (!holds.length) return null;
    const holder = (hold) => (hold.num ? `#${hold.num}` : numLabel(sessionsById.get(hold.sessionId)) || String(hold.sessionId || hold.agent || 'manual').slice(0, 8));
    return {
      badge: holds.length > 1 ? `${holds.length} holds` : 'hold',
      title: ref.key.startsWith('scope:') ? ref.key.slice('scope:'.length) : holds[0].scopes.join(', ') || holds[0].project,
      meta: holds.length === 1 ? [holds[0].id, holds[0].project].filter(Boolean).join(' · ') : '',
      rows: holds.map((hold) => [holder(hold), `until ${String(hold.until || '').replace('T', ' ')}`
        + `${timeLeft(hold.untilMs - now) ? ` (${timeLeft(hold.untilMs - now)})` : ''}${hold.reason ? ` · ${clip(hold.reason, 120)}` : ''}`]),
      open: holds[0].sessionId || null,
    };
  }
  if (ref.kind === 'sha') {
    const entry = loaded.commit;
    if (!entry || entry.status !== 'ready') return { badge: ref.key.slice(0, 9), title: 'commit', rows: [], pending: status(entry, 'the commit') };
    if (!entry.value) return { badge: ref.key.slice(0, 9), title: 'commit', rows: [], pending: 'no repo or card knows this commit' };
    const { commit, cards = [], review } = entry.value;
    const branch = commit?.branch ? commit.branch.replace(/^origin\//, '') : '';
    return {
      badge: (commit?.sha || ref.key).slice(0, 9),
      title: commit?.subject || `cited by ${cards.length} card${cards.length === 1 ? '' : 's'}`,
      meta: [projectName(commit?.repo), commit?.author, ago(commit?.at, now)].filter(Boolean).join(' · '),
      rows: [
        ['landed', commit?.landed === true ? `on ${branch}` : commit?.landed === false ? `not on ${branch}` : ''],
        ['review', review ? `${review.verdict}${review.by ? ` · ${review.by}` : ''}` : ''],
        ...cards.slice(0, 3).map((card, index) => [index ? '' : 'card', `${card.title}${card.status ? ` (${card.status})` : ''}`]),
      ].filter(([, value]) => value),
    };
  }
  return null;
}

const PATTERNS = { SESSION_REF, NOT_SESSION, CARD_REF, HOLD_ID, SCOPE_LIST, SHA_REF };

module.exports = {
  PATTERNS,
  findSessionRefs, findCardRefs, findHoldRefs, findShaRefs, findRefs, holdsFor, splitSegments, latestLogEntry, describeRef,
};
