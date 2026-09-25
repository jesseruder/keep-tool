// The brief panel: where the session's work stands, beside a picture of the work
// drawn by a model from the card's check-ins.
//
// Three earlier attempts led here. A Haiku summary of the transcript read as
// generic; the turn watcher's state line came with a verdict chip and grading
// buttons that `keep watcher score` made unnecessary; and a list of the last few
// check-ins was accurate but slow to read. This answers "does it need me, and
// what is next?" from the card's own fields and log, with no model: what the
// session waits on, its next step, plan progress when there is a plan, and when
// it last checked in.

import { getCardPicture } from './api.js';

// Only a stamped heading starts an entry, as in bin/review.js logEntries: older
// cards carry check-in bodies that begin with their own `## ` heading.
const HEADING_RE = /^## (Plan|\d{4}-\d{2}-\d{2} \d{2}:\d{2} — .+)$/gm;
// What a session or Owner wrote about the work — check-ins, plan steps, needs,
// state notes, reopening — plus check and probe results, which on a check card
// are the work. Keep's other bookkeeping (code-review records, landed markers,
// alerts, agent runs, artifacts) and the fleet reviewer's entries are left out.
const SHOWN_KIND_RE = /^(?:check-in|created|done|closed|reopened|plan|needs|state note|check result|probe result)\b/;
const REVIEWER_KIND_RE = /\(reviewer\b/;

export function recentLogEntries(body, limit = 3) {
  const text = String(body || '');
  const marks = [];
  HEADING_RE.lastIndex = 0;
  let match;
  while ((match = HEADING_RE.exec(text)) !== null) marks.push({ heading: match[1], start: match.index, bodyStart: HEADING_RE.lastIndex });
  const entries = [];
  for (let index = 0; index < marks.length; index += 1) {
    if (marks[index].heading === 'Plan') continue;
    const end = index + 1 < marks.length ? marks[index + 1].start : text.length;
    const [stamp, ...rest] = marks[index].heading.split(' — ');
    const rawKind = rest.join(' — ');
    if (!SHOWN_KIND_RE.test(rawKind) || REVIEWER_KIND_RE.test(rawKind)) continue;
    const lines = text.slice(marks[index].bodyStart, end).trim().split('\n');
    let next = '';
    const prose = [];
    for (const line of lines) {
      const nextMatch = line.match(/^next:\s*(.*)$/);
      if (nextMatch) next = nextMatch[1].trim();
      else if (!/^commits:\s/.test(line)) prose.push(line.trim());
    }
    entries.push({
      at: stamp,
      // "check-in (by claude 1234-…) → done" reads as "check-in → done": the
      // session id is noise here, and the stage already names the session.
      kind: rawKind.replace(/\s*\((?:by|reviewer)\b[^)]*\)/g, '').trim(),
      text: prose.filter(Boolean).join(' '),
      next,
    });
  }
  return entries.slice(-limit).reverse();
}

// The card's `## Plan` block, as bin/keep-core.js parsePlan reads it: it must be
// the body's first section, one `- [ ]` / `- [~]` / `- [x]` line per step.
export function planSteps(body) {
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length && !lines[index].trim()) index += 1;
  if (!/^## Plan\s*$/.test(lines[index] || '')) return [];
  const steps = [];
  for (index += 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s+/.test(line)) break;
    if (!line.trim()) continue;
    const step = line.match(/^\s*- \[([ ~xX])\]\s+(.+?)\s*$/);
    // Anything else ends the plan there, as it does for keep-core, so the
    // console never counts steps `keep next` does not see.
    if (!step) break;
    steps.push({ text: step[2], state: step[1] === '~' ? 'doing' : /x/i.test(step[1]) ? 'done' : 'todo' });
    // A step's acceptance criterion sits on the line directly under it.
    if (/^\s+done-when:\s*\S/.test(lines[index + 1] || '')) index += 1;
  }
  return steps;
}

// Distinct shas cited on `commits:` lines anywhere in the log.
export function commitCount(body) {
  const shas = new Set();
  for (const match of String(body || '').matchAll(/^commits:\s*(.+)$/gm)) {
    for (const sha of match[1].split(',')) if (/^[0-9a-f]{7,40}$/i.test(sha.trim())) shas.add(sha.trim().slice(0, 7).toLowerCase());
  }
  return shas.size;
}

function stampTime(stamp) {
  return Date.parse(String(stamp || '').replace(' ', 'T'));
}

export function ageText(stamp, now = Date.now()) {
  const at = stampTime(stamp);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function untilText(stamp, now = Date.now()) {
  const at = stampTime(stamp);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.round((at - now) / 60000);
  if (minutes < 60) return `in ${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

function clip(text, limit) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

// keep-core stores a dependency as a bare card id (optionally `id#step`) or, for
// a --status/--commit/--deployed wait, as an object whose `card` names it.
function dependencyName(entry) {
  if (typeof entry === 'string') return entry;
  const card = String(entry?.card || entry?.id || '');
  return card && entry?.step ? `${card}#${entry.step}` : card;
}

// The first line: what the work is waiting on, in the order Owner cares about.
// A need or a waiting queue item is his to act on. A card in `waiting` is the
// session waiting on its own — a scheduled check or another card. Otherwise it is
// the session's own state: a check scheduled for later on a card that is still
// being worked does not describe what is happening now, and a dependency entry
// stays on the card after it resolves, so neither is read outside `waiting`.
export function standing({ task, session, waiting, waitingText, sessionLabel }, now = Date.now()) {
  const fm = task?.fm || {};
  const needs = Array.isArray(fm.needs) ? fm.needs.filter((need) => need?.text) : [];
  if (needs.length) return { tone: 'warn', text: `Waiting on you: ${needs.map((need) => need.text).join('; ')}` };
  if (waiting) return { tone: 'warn', text: `Waiting on you${waitingText ? `: ${waitingText}` : ''}` };
  if (fm.status === 'review') return { tone: 'warn', text: 'Waiting for your review' };
  if (fm.status === 'done') return { tone: 'faint', text: 'Done' };
  if (fm.status === 'landing') return { tone: 'info', text: 'Landing' };
  const checkAt = fm.check_after ? stampTime(fm.check_after) : NaN;
  if (Number.isFinite(checkAt) && checkAt <= now) return { tone: 'warn', text: `Check overdue since ${ageText(fm.check_after, now)}` };
  if (fm.status === 'waiting') {
    if (Number.isFinite(checkAt)) return { tone: 'info', text: `Check scheduled ${untilText(fm.check_after, now)}` };
    const deps = (Array.isArray(fm.depends_on) ? fm.depends_on : []).map(dependencyName).filter(Boolean);
    if (deps.length) return { tone: 'info', text: `Waiting on ${deps.join(', ')}` };
  }
  if (session) return { tone: /running|working/i.test(sessionLabel || '') ? 'ok' : 'faint', text: sessionLabel || 'Idle' };
  return { tone: 'faint', text: fm.status ? fm.status[0].toUpperCase() + fm.status.slice(1) : 'No session' };
}

// The console's state carries no card bodies, and a new check-in changes the
// card's detail version, which idles its loaded detail until the refetch lands.
// The last body seen for each card stands in until then.
const lastBodies = new Map(); // card id -> body

export function whereHTML(ctx, { task, session, waiting = false, waitingText = '', sessionLabel = '', fallbackText = '' }, now = Date.now()) {
  const esc = ctx.esc;
  if (task?.id && typeof task.body === 'string') lastBodies.set(task.id, task.body);
  const body = typeof task?.body === 'string' ? task.body : task?.id ? lastBodies.get(task.id) : undefined;
  const state = standing({ task, session, waiting, waitingText: clip(waitingText, 160), sessionLabel }, now);
  const lines = [`<p class="where-state ${state.tone}"><span class="where-dot" aria-hidden="true">●</span>${esc(clip(state.text, 200))}</p>`];
  if (!task) {
    if (fallbackText) lines.push(`<p class="where-meta faint">${esc(fallbackText)}</p>`);
    return `<div class="summary where">${lines.join('')}</div>`;
  }
  const entries = typeof body === 'string' ? recentLogEntries(body, 20) : [];
  const steps = planSteps(body);
  const current = steps.find((step) => step.state === 'doing') || steps.find((step) => step.state === 'todo');
  // Only the latest check-in's "next" is current: an older one can name a step
  // finished days ago. Without one, the plan's current step stands in.
  const latest = entries.find((entry) => /^(?:check-in|done)\b/.test(entry.kind));
  const next = latest?.next && !/^nothing\.?$/i.test(latest.next) ? latest.next : '';
  const nextText = next || (current ? current.text : '');
  if (nextText) lines.push(`<p class="where-next"><span class="faint">Next:</span> ${esc(clip(nextText, 200))}</p>`);
  if (steps.length) {
    const done = steps.filter((step) => step.state === 'done').length;
    const bar = steps.map((step) => (step.state === 'done' ? '▰' : '▱')).join('');
    // Next already names the step when it is the plan's own text.
    const stepText = current && !nextText.startsWith(current.text.slice(0, 40)) ? `: ${clip(current.text, 80)}` : '';
    const position = current ? `step ${steps.indexOf(current) + 1} of ${steps.length}${stepText}` : `all ${steps.length} steps done`;
    lines.push(`<p class="where-plan"><span class="where-bar" aria-label="${done} of ${steps.length} plan steps done">${bar}</span> ${esc(position)}</p>`);
  }
  const meta = [];
  const last = latest;
  if (last) meta.push(`<span title="${esc(clip(`${last.kind}: ${last.text}`, 400))}">last check-in ${esc(ageText(last.at, now))}</span>`);
  const commits = commitCount(body);
  if (commits) meta.push(`${commits} commit${commits === 1 ? '' : 's'}`);
  if (meta.length) lines.push(`<p class="where-meta faint">${meta.join(' · ')}</p>`);
  else if (typeof body !== 'string') lines.push('<p class="where-meta faint">Loading the card…</p>');
  return `<div class="summary where">${lines.join('')}</div>`;
}

// ---------- picture (experiment) ----------

const PICTURE_KEY = 'keep.console.cardPictures';
const pictures = new Map(); // card id -> { svg, fresh, version, fetchedAt, retryAt }
const inflight = new Set();

// On unless this viewer chose "Hide picture".
export function picturesEnabled() {
  try { return localStorage.getItem(PICTURE_KEY) !== 'off'; } catch { return true; }
}

export function setPicturesEnabled(on) {
  try { localStorage.setItem(PICTURE_KEY, on ? 'on' : 'off'); } catch {}
}

export function pictureToggleHTML() {
  const on = picturesEnabled();
  return `<div class="session-actions-label">Card picture</div><button class="btn" type="button" data-card-picture aria-pressed="${on}" title="A small picture Opus draws from the card's recent check-ins, redrawn when they change">${on ? 'Hide picture' : 'Show picture'}</button>`;
}

export function installPictureToggle(menu, ctx) {
  const button = menu?.querySelector?.('[data-card-picture]');
  if (!button) return;
  button.onclick = () => {
    setPicturesEnabled(!picturesEnabled());
    ctx.refresh();
  };
}

// A new check-in changes the card's detail version, which is what asks the
// daemon for a new drawing; while one is being drawn the old one stays up.
function ensurePicture(ctx, task, now = Date.now()) {
  const id = task.id;
  if (inflight.has(id)) return;
  const cached = pictures.get(id);
  const version = task._detailVersion || '';
  if (cached) {
    if (cached.retryAt && now < cached.retryAt) return;
    const changed = cached.version !== version;
    if (!changed && cached.fresh) return;
    if (!changed && now - cached.fetchedAt < 20e3) return;
  }
  inflight.add(id);
  getCardPicture(id)
    .then((result) => {
      const fresh = result?.fresh !== false;
      pictures.set(id, {
        // While a redraw is pending the old picture stays up; once the answer for
        // this input is final, no picture means none, not the previous card state.
        svg: typeof result?.svg === 'string' ? result.svg : fresh ? '' : cached?.svg || '',
        fresh,
        version,
        fetchedAt: Date.now(),
      });
    })
    .catch(() => {
      pictures.set(id, { ...(cached || { svg: '', version }), fresh: false, fetchedAt: Date.now(), retryAt: Date.now() + 60e3 });
    })
    .finally(() => {
      inflight.delete(id);
      ctx.refresh();
    });
}

// Drawn as an <img>: an SVG loaded that way runs no script and fetches nothing,
// so model-written markup cannot reach the console.
export function pictureHTML(ctx, task) {
  if (!task?.id || !picturesEnabled()) return '';
  ensurePicture(ctx, task);
  const picture = pictures.get(task.id);
  if (!picture?.svg) return `<div class="card-picture pending faint"><span>${picture && picture.fresh ? 'No picture' : 'Drawing…'}</span></div>`;
  return `<figure class="card-picture"><img alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(picture.svg)}"></figure>`;
}
