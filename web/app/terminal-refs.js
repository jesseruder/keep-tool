// Keep names things in plain text that agents print into their terminals: sessions
// by number (`#453`), cards by id (`keep-compact-is-refused-on-a-node`), holds by id
// (`hold-mfq2x1ab`) and by the scopes they cover (`[device:android-box]`). This
// makes each one the console knows a link: hovering shows what it is right now, and
// ⌘/Ctrl-click opens it. A plain click still goes to the pane, since the agent in it
// may be taking the mouse, and a selection drag must not navigate.
//
// Each kind of reference is a `kind`: `find(text)` returns its spans, `has(key)`
// says whether the console knows that key (asked for every reference on every row
// the pointer crosses, so it must be cheap), `describe(key, update)` builds the
// hover card only on hover, and `open(key)` is optional. A describe that loads more
// (a card's last check-in) returns what it has and calls `update()` when the rest
// arrives.

import { numLabel } from './session-number.js';

// `#` then digits, standing alone: not `repo#12`, `&#39;`, `a/#3` or `##4`, and not
// a hex colour or anchor like `#123abc`. A GitHub reference reads the same, so a
// number right after PR/issue/pull request/MR (`PR #12`, `PR: #12`, `issue (#12)`)
// is left alone even when a session has it, and so is an all-digit colour after
// color/fill/background (`color: #123456`).
const SESSION_REF = /#(\d{1,6})(?![\w-])/g;
const NOT_SESSION = /(?:\b(?:prs?|pull(?:\s+requests?)?|pulls|issues?|mrs?|bugs?|tickets?|colou?r|fill|stroke|background|bg)[\s:=("'`]*$|[\w#&/=]$)/i;

export function findSessionRefs(text) {
  const refs = [];
  for (const match of String(text || '').matchAll(SESSION_REF)) {
    const before = text.slice(Math.max(0, match.index - 24), match.index);
    if (NOT_SESSION.test(before)) continue;
    const num = Number(match[1]);
    if (num >= 1) refs.push({ key: num, start: match.index, end: match.index + match[0].length });
  }
  return refs;
}

// A card id is a slug (bin/keep-core.js slugify): lowercase words joined by single
// hyphens. Three words at least, so `in-flight` or `re-run` never reach the lookup,
// and not part of a path or file name (`web/app/card-log.js`, `a.b-c-d`).
const CARD_REF = /(?<![\w./@:-])[a-z0-9]+(?:-[a-z0-9]+){2,}(?![\w/@-]|\.\w)/g;

export function findCardRefs(text) {
  return [...String(text || '').matchAll(CARD_REF)].map((match) => ({ key: match[0], start: match.index, end: match.index + match[0].length }));
}

// `hold-<base36>` as `keep hold`, `keep holds` and `keep who` print it, and the
// bracketed scope list the hold banner prints (`~/keep-tool [device:android-box]`).
// A scope reference's key is its first scope: the card lists every live hold that
// covers any scope in the brackets.
const HOLD_ID = /(?<![\w-])hold-[a-z0-9]+(?![\w-])/g;
const SCOPE_LIST = /\[([a-z0-9][a-z0-9:-]*(?:, [a-z0-9][a-z0-9:-]*)*)\]/g;

export function findHoldRefs(text) {
  const source = String(text || '');
  const refs = [...source.matchAll(HOLD_ID)].map((match) => ({ key: match[0], start: match.index, end: match.index + match[0].length }));
  for (const match of source.matchAll(SCOPE_LIST)) {
    refs.push({ key: `scope:${match[1]}`, start: match.index, end: match.index + match[0].length });
  }
  return refs;
}

export function holdsFor(key, holds = []) {
  if (key.startsWith('hold-')) return holds.filter((hold) => hold?.id === key);
  const scopes = new Set(key.slice('scope:'.length).split(', '));
  return holds.filter((hold) => (hold?.scopes || []).some((scope) => scopes.has(scope)));
}

// Every kind's spans on one line, first come first served: a span that overlaps an
// earlier one is dropped, and at the same start the longer span wins.
export function findRefs(text, kinds) {
  const all = [];
  for (const kind of kinds) {
    for (const ref of kind.find(text)) all.push({ ...ref, kind });
  }
  all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept = [];
  let reach = 0;
  for (const ref of all) {
    if (ref.start < reach) continue;
    if (!ref.kind.has(ref.key)) continue;
    kept.push(ref);
    reach = ref.end;
  }
  return kept;
}

// One buffer line as text plus the cell each character sits in. Wide characters
// take two cells and a string index is not a column, so links would drift right of
// the text after an emoji or CJK without this map.
export function lineCells(line, cols) {
  let text = '';
  const columns = [];
  if (!line) return { text, columns };
  for (let x = 0; x < cols; x += 1) {
    const cell = line.getCell(x);
    if (!cell) break;
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars() || ' ';
    for (let i = 0; i < chars.length; i += 1) columns.push(x);
    text += chars;
  }
  return { text, columns };
}

const ago = (rel, at) => (at && rel ? `${rel(at)} ago`.replace(/^now ago$/, 'just now') : '');
const clip = (text, max) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const timeLeft = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 3600e3) return `${Math.max(1, Math.round(ms / 60e3))}m left`;
  return `${Math.floor(ms / 3600e3)}h ${Math.round((ms % 3600e3) / 60e3)}m left`;
};

// Every card has the same shape: a badge and title, a muted line, labelled rows,
// an optional quoted passage, and a loading note. Every field is optional.
export function describeSession(session, { tasks = [], projectName = (p) => p, statusOf = (s) => s?.state || '', nodeOf = () => '', rel } = {}) {
  if (!session) return null;
  const task = session.taskId ? tasks.find((candidate) => candidate?.id === session.taskId) : null;
  return {
    badge: numLabel(session.num),
    title: session.title || session.id?.slice(0, 8) || '',
    meta: [session.project ? projectName(session.project) : '', statusOf(session) || ''],
    rows: [
      ['card', task ? `${task.fm?.title || task.id}${task.fm?.status ? ` (${task.fm.status})` : ''}` : session.taskId || ''],
      ['agent', [session.kind, session.accountLabel].filter(Boolean).join(' · ')],
      ['node', nodeOf(session) || ''],
      ['active', ago(rel, session.mtime || session.lastUserAt || 0)],
    ],
  };
}

// A card from its console row, plus its latest log entry once the detail (the card's
// body) has loaded: `detail` is { status, entry } where entry is card-log.js's
// recentLogEntries(body, 1)[0].
export function describeCard(task, { session, projectName = (p) => p, statusOf = (s) => s?.state || '', rel, detail } = {}) {
  if (!task) return null;
  const fm = task.fm || {};
  const needs = Array.isArray(fm.needs) ? fm.needs.map((need) => need?.text).filter(Boolean) : [];
  const entry = detail?.entry;
  return {
    badge: fm.status || '',
    title: fm.title || task.id,
    meta: [fm.project ? projectName(fm.project) : '', task.id],
    rows: [
      ['session', session ? `${numLabel(session.num) || session.id?.slice(0, 8)} ${statusOf(session) || ''}`.trim() : ''],
      ['needs', needs.join('; ')],
      ['check', fm.check_after ? String(fm.check_after) : ''],
      ['next', entry?.next ? clip(entry.next, 160) : ''],
      ['latest', entry ? [entry.kind, ago(rel, Date.parse(entry.at))].filter(Boolean).join(' · ') : ''],
    ],
    quote: entry?.text ? clip(entry.text, 320) : '',
    pending: detail?.status === 'loading' ? 'loading the latest check-in…' : detail?.status === 'error' ? 'could not load the latest check-in' : '',
  };
}

export function describeHolds(key, holds, { sessionFor = () => null, now = Date.now() } = {}) {
  if (!holds?.length) return null;
  const scopeKey = key.startsWith('scope:') ? key.slice('scope:'.length) : '';
  return {
    badge: holds.length > 1 ? `${holds.length} holds` : 'hold',
    title: scopeKey || holds[0].scopes?.join(', ') || holds[0].project || key,
    meta: [holds.length === 1 ? holds[0].id : '', holds.length === 1 ? holds[0].project : ''],
    rows: holds.map((hold) => {
      const session = sessionFor(hold);
      const who = hold.num ? `#${hold.num}` : session ? numLabel(session.num) : hold.sessionId?.slice(0, 8) || hold.agent || 'manual';
      const until = String(hold.until || '').replace('T', ' ');
      const left = timeLeft(Date.parse(hold.until) - now);
      return [who, `until ${until}${left ? ` (${left})` : ''}${hold.reason ? ` · ${clip(hold.reason, 120)}` : ''}${holds.length > 1 ? ` · ${hold.scopes.join(', ')}` : ''}`];
    }),
  };
}

export function refCardHTML(esc, info, { openHint = true } = {}) {
  if (!info) return '';
  const meta = (info.meta || []).filter(Boolean).map(esc).join(' · ');
  const rows = (info.rows || []).filter(([, value]) => value)
    .map(([label, value]) => `<div class="sl-row"><span class="sl-key">${esc(label)}</span><span>${esc(value)}</span></div>`).join('');
  return `<div class="sl-head">${info.badge ? `<span class="num-id">${esc(info.badge)}</span> ` : ''}<strong>${esc(info.title)}</strong></div>`
    + (meta ? `<div class="sl-meta">${meta}</div>` : '')
    + rows
    + (info.quote ? `<div class="sl-quote">${esc(info.quote)}</div>` : '')
    + (info.pending ? `<div class="sl-hint">${esc(info.pending)}</div>` : '')
    + (openHint ? `<div class="sl-hint">${/Mac/.test(globalThis.navigator?.platform || '') ? '⌘' : 'Ctrl'}-click to open</div>` : '');
}

// Registers one provider on an xterm for every kind.
export function installTerminalRefs(terminal, { kinds = [], esc, doc = globalThis.document } = {}) {
  let pop = null;
  let current = null;
  const hide = () => { pop?.remove(); pop = null; current = null; };
  const place = (event) => {
    const view = doc.defaultView || globalThis;
    const { width, height } = pop.getBoundingClientRect();
    const left = Math.min(event.clientX + 12, view.innerWidth - width - 8);
    const below = event.clientY + 18;
    const top = below + height > view.innerHeight - 8 ? event.clientY - height - 10 : below;
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${Math.max(8, top)}px`;
  };
  const show = (event, kind, key) => {
    hide();
    const token = {};
    current = token;
    // Re-rendered in place when a describe that was still loading calls back, unless
    // the pointer has moved on to another link or off it.
    const render = () => {
      if (current !== token) return;
      const info = kind.describe(key, render);
      if (!info) { hide(); return; }
      if (!pop) {
        pop = doc.createElement('div');
        pop.className = 'session-link-pop xterm-hover';
        doc.body.append(pop);
      }
      pop.innerHTML = refCardHTML(esc, info, { openHint: Boolean(kind.open) });
      place(event);
    };
    render();
  };
  const provider = terminal.registerLinkProvider({
    provideLinks(y, callback) {
      const { text, columns } = lineCells(terminal.buffer.active.getLine(y - 1), terminal.cols);
      const links = findRefs(text, kinds).map((ref) => ({
        range: { start: { x: columns[ref.start] + 1, y }, end: { x: columns[ref.end - 1] + 1, y } },
        text: text.slice(ref.start, ref.end),
        decorations: { underline: true, pointerCursor: Boolean(ref.kind.open) },
        activate(event) {
          if (!ref.kind.open || !(event.metaKey || event.ctrlKey)) return;
          hide();
          ref.kind.open(ref.key);
        },
        // Described at hover time: what a reference names moves on while the same
        // line sits on screen.
        hover(event) { show(event, ref.kind, ref.key); },
        leave: hide,
      }));
      callback(links.length ? links : undefined);
    },
  });
  const scroll = terminal.onScroll(hide);
  const key = terminal.onKey(hide);
  // hide() is for the terminal going out of view: a detached xterm sends no
  // mouseleave, and the card lives on document.body, outside it.
  return { hide, dispose() { hide(); provider.dispose(); scroll.dispose(); key.dispose(); } };
}
