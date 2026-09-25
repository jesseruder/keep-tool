'use strict';
// A small picture of what a card is about, drawn by a cheap model from the card's
// title and its last few check-ins. The console asks for it unless the viewer
// chose "Hide picture" in the session menu.
//
// It rides the summarizer's queue and cache (summarize.js): the same isolated,
// tool-less headless Claude on an automation account, one cached result per card,
// redrawn only when its input — the title and those check-ins — changes. Claude
// cannot produce pixels, so the picture is an SVG, and the console draws it
// through an <img>, where it runs no script and loads nothing.
//
// Opus, with a picture-book prompt: a bake-off over three live cards (Sonnet 5,
// Opus 5.5, Fable 5.1) found the prompt mattered most, and Opus drew the clearest
// visual jokes at about a minute and 8-11 KB a picture. The alias follows the
// newest Opus.

const summarize = require('./summarize.js');
const { logEntries } = require('./review.js');

const MODEL = process.env.KEEP_PICTURE_MODEL || 'opus';
const ENTRIES = 3;
const ENTRY_LIMIT = 600;
const MAX_SVG_BYTES = 64 * 1024;
// Only what a session or Owner wrote about the work: check-ins, creation and
// closing. Everything else on a card — probe and check results, code-review
// records, landed markers, alerts, the reviewer's entries — is written by Keep, and
// on a typical day it is more than half the log; letting it in would redraw a
// picture every time a probe ran.
const PICTURE_KIND_RE = /^(?:check-in|created|done|closed)\b/;
const REVIEWER_KIND_RE = /\(reviewer\b/;

const INSTRUCTION = [
  'Draw a small, delightful illustration of the work described in the source, as a single SVG.',
  'Make it a tiny scene with personality: a cute character or creature (a robot, animal, wizard, gremlin) doing',
  'something that is a visual joke or pun about what the work is about — the subject of the work, not software in general.',
  'Think picture-book or sticker art: bold outlines, a rich warm palette, a background with depth (sky, room, landscape),',
  'expressive faces, small details that reward a second look. Gradients and simple shading are welcome.',
  'Requirements: output only the <svg> element and nothing else, no code fence and no commentary;',
  'viewBox="0 0 320 200"; no text at all; no <script>, no event attributes, no <foreignObject>,',
  'no external links, images, or fonts; under 24 KB.',
].join(' ');

function pictureInput(task) {
  const title = String((task && task.fm && task.fm.title) || '').trim();
  const entries = logEntries(task && task.body)
    .filter((entry) => {
      const kind = entry.heading.split(' — ').slice(1).join(' — ');
      return PICTURE_KIND_RE.test(kind) && !REVIEWER_KIND_RE.test(kind);
    })
    .slice(-ENTRIES)
    .map((entry) => `${entry.heading.split(' — ')[0]}: ${String(entry.text || '').replace(/\s+/g, ' ').slice(0, ENTRY_LIMIT)}`);
  if (!title && !entries.length) return '';
  return [`Card: ${title}`, ...entries].join('\n');
}

// The model's answer is a candidate, not a picture: keep the one <svg> element and
// refuse anything oversized or carrying active content. The <img> rendering makes
// that content inert anyway; refusing it keeps the cache free of it too.
function extractSvg(text) {
  const match = String(text || '').match(/<svg\b[\s\S]*<\/svg>/i);
  if (!match) return null;
  const svg = match[0];
  if (Buffer.byteLength(svg) > MAX_SVG_BYTES) return null;
  if (/<script\b|<foreignObject\b|\son[a-z]+\s*=|javascript:/i.test(svg)) return null;
  return svg;
}

function cardPicture(task, deps = {}) {
  const input = pictureInput(task);
  if (!input) return { svg: null, fresh: true };
  const result = (deps.summarize || summarize).getSummary(`picture-${task.id}`, input, INSTRUCTION, undefined, { model: MODEL });
  return { svg: extractSvg(result && result.text), fresh: Boolean(result && result.fresh) };
}

module.exports = { MODEL, INSTRUCTION, pictureInput, extractSvg, cardPicture };
