// Session numbers written in a terminal (`#453`) name other sessions: agents cite
// each other that way in check-ins, holds and handoffs. This makes each one that
// names a session the console knows a link: hovering shows who that session is,
// and ⌘/Ctrl-click opens it. A plain click still goes to the pane, since the agent
// in it may be taking the mouse, and a selection drag must not navigate.

import { numLabel } from './session-number.js';

// `#` then digits, standing alone: not `repo#12`, `&#39;`, `a/#3` or `##4`, and not
// a hex colour or anchor like `#123abc`. A GitHub reference reads the same, so a
// number right after PR/issue/pull/MR is left alone even when a session has it.
const REF = /#(\d{1,6})(?![\w-])/g;
const NOT_SESSION = /(?:\b(?:prs?|pull|pulls|issues?|mr|bug|ticket)\s*$|[\w#&/]$)/i;

export function findSessionRefs(text) {
  const refs = [];
  for (const match of String(text || '').matchAll(REF)) {
    const before = text.slice(Math.max(0, match.index - 12), match.index);
    if (NOT_SESSION.test(before)) continue;
    const num = Number(match[1]);
    if (num >= 1) refs.push({ num, start: match.index, end: match.index + match[0].length });
  }
  return refs;
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

// What the hover card shows, from the console's own session and card rows. Every
// field is optional: an exited session has no pane, a shell session no card.
export function describeSession(session, { tasks = [], projectName = (p) => p, statusOf = (s) => s?.state || '', nodeOf = () => '', rel } = {}) {
  if (!session) return null;
  const task = session.taskId ? tasks.find((candidate) => candidate?.id === session.taskId) : null;
  const touched = session.mtime || session.lastUserAt || 0;
  return {
    num: session.num,
    title: session.title || session.id?.slice(0, 8) || '',
    project: session.project ? projectName(session.project) : '',
    status: statusOf(session) || '',
    agent: [session.kind, session.accountLabel].filter(Boolean).join(' · '),
    node: nodeOf(session) || '',
    card: task ? (task.fm?.title || task.id) : session.taskId || '',
    cardStatus: task?.fm?.status || '',
    ago: touched && rel ? `${rel(touched)} ago`.replace(/^now ago$/, 'just now') : '',
  };
}

export function sessionCardHTML(esc, info, { openHint = true } = {}) {
  if (!info) return '';
  const row = (label, value) => value ? `<div class="sl-row"><span class="sl-key">${label}</span><span>${esc(value)}</span></div>` : '';
  const meta = [info.project, info.status].filter(Boolean).map(esc).join(' · ');
  return `<div class="sl-head"><span class="num-id">${esc(numLabel(info.num))}</span> <strong>${esc(info.title)}</strong></div>`
    + (meta ? `<div class="sl-meta">${meta}</div>` : '')
    + row('card', info.card + (info.cardStatus ? ` (${info.cardStatus})` : ''))
    + row('agent', info.agent)
    + row('node', info.node)
    + row('active', info.ago)
    + (openHint ? `<div class="sl-hint">${/Mac/.test(globalThis.navigator?.platform || '') ? '⌘' : 'Ctrl'}-click to open</div>` : '');
}

// Registers the provider on one xterm. `lookup(num)` answers the hover card's
// fields for a known session or null; a number no session has is left as text, so
// ordinary `#3` in prose does not light up.
export function installSessionLinks(terminal, { lookup, open, esc, doc = globalThis.document } = {}) {
  let pop = null;
  const hide = () => { pop?.remove(); pop = null; };
  const show = (event, info) => {
    hide();
    pop = doc.createElement('div');
    pop.className = 'session-link-pop xterm-hover';
    pop.innerHTML = sessionCardHTML(esc, info);
    doc.body.append(pop);
    const view = doc.defaultView || globalThis;
    const { width, height } = pop.getBoundingClientRect();
    const left = Math.min(event.clientX + 12, view.innerWidth - width - 8);
    const below = event.clientY + 18;
    const top = below + height > view.innerHeight - 8 ? event.clientY - height - 10 : below;
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${Math.max(8, top)}px`;
  };
  const provider = terminal.registerLinkProvider({
    provideLinks(y, callback) {
      const buffer = terminal.buffer.active;
      const { text, columns } = lineCells(buffer.getLine(y - 1), terminal.cols);
      const links = [];
      for (const ref of findSessionRefs(text)) {
        const info = lookup(ref.num);
        if (!info) continue;
        links.push({
          range: { start: { x: columns[ref.start] + 1, y }, end: { x: columns[ref.end - 1] + 1, y } },
          text: text.slice(ref.start, ref.end),
          decorations: { underline: true, pointerCursor: true },
          activate(event) {
            if (!(event.metaKey || event.ctrlKey)) return;
            hide();
            open(ref.num);
          },
          // Read the row again at hover time: a session's status moves on while the
          // same line sits on screen.
          hover(event) { show(event, lookup(ref.num) || info); },
          leave: hide,
        });
      }
      callback(links.length ? links : undefined);
    },
  });
  const scroll = terminal.onScroll(hide);
  const key = terminal.onKey(hide);
  return { dispose() { hide(); provider.dispose(); scroll.dispose(); key.dispose(); } };
}
