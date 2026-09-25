// The brief panel: the card's last few Keep check-ins, and optionally a picture of
// the work drawn by a cheap model from those same check-ins.
//
// This replaced two earlier attempts. A Haiku summary of the transcript read as
// generic, and the turn watcher's state line came with a verdict chip and grading
// buttons that `keep watcher score` made unnecessary. The check-ins are written by
// the session itself for Owner to read, so they need no model to be useful.

import { getCardPicture } from './api.js';

// Only a stamped heading starts an entry, as in bin/review.js logEntries: older
// cards carry check-in bodies that begin with their own `## ` heading.
const HEADING_RE = /^## (Plan|\d{4}-\d{2}-\d{2} \d{2}:\d{2} — .+)$/gm;

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
      kind: rest.join(' — ').replace(/\s*\((?:by|reviewer)\b[^)]*\)/g, '').trim(),
      text: prose.filter(Boolean).join(' '),
      next,
    });
  }
  return entries.slice(-limit).reverse();
}

export function ageText(stamp, now = Date.now()) {
  const at = Date.parse(String(stamp || '').replace(' ', 'T'));
  if (!Number.isFinite(at)) return '';
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function clip(text, limit) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

// `task` is the card with its body once the detail has loaded; before that only
// the summary's lastLog is known, which is still the newest check-in.
export function checkinsHTML(ctx, task, fallbackText, now = Date.now()) {
  const esc = ctx.esc;
  const entries = typeof task?.body === 'string' ? recentLogEntries(task.body) : [];
  if (!entries.length) {
    const text = task?.lastLog ? clip(task.lastLog, 280) : fallbackText;
    return `<div class="summary card-log"><p class="card-log-empty">${esc(text)}</p></div>`;
  }
  const items = entries.map((entry, index) => {
    const age = ageText(entry.at, now);
    return `<li><span class="card-log-when mono faint" title="${esc(entry.at)}">${esc(age || entry.at)}</span>`
      + `${entry.kind ? `<span class="card-log-kind faint">${esc(entry.kind)}</span>` : ''}`
      + `<span class="card-log-text">${esc(clip(entry.text, 280))}</span>`
      + `${index === 0 && entry.next ? `<span class="card-log-next faint">next: ${esc(clip(entry.next, 160))}</span>` : ''}</li>`;
  }).join('');
  return `<div class="summary card-log"><ol>${items}</ol></div>`;
}

// ---------- picture (experiment) ----------

const PICTURE_KEY = 'keep.console.cardPictures';
const pictures = new Map(); // card id -> { svg, fresh, version, fetchedAt, retryAt }
const inflight = new Set();

export function picturesEnabled() {
  try { return localStorage.getItem(PICTURE_KEY) === 'on'; } catch { return false; }
}

export function setPicturesEnabled(on) {
  try { localStorage.setItem(PICTURE_KEY, on ? 'on' : 'off'); } catch {}
}

export function pictureToggleHTML() {
  const on = picturesEnabled();
  return `<div class="session-actions-label">Card picture (experiment)</div><button class="btn" type="button" data-card-picture aria-pressed="${on}" title="A small picture Sonnet draws from the card's recent check-ins, redrawn when they change">${on ? 'Hide picture' : 'Show picture'}</button>`;
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
      pictures.set(id, {
        svg: typeof result?.svg === 'string' ? result.svg : cached?.svg || '',
        fresh: result?.fresh !== false,
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
  if (!picture?.svg) return `<div class="card-picture pending faint">${picture && picture.fresh ? 'No picture' : 'Drawing…'}</div>`;
  return `<figure class="card-picture"><img alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(picture.svg)}"></figure>`;
}
