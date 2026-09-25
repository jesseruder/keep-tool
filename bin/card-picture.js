'use strict';
// A small picture of what a card is about, drawn by a cheap model from the card's
// title and its last few check-ins. An experiment behind a console toggle: the
// console asks for it only while Owner has pictures switched on.
//
// It rides the summarizer's queue and cache (summarize.js): the same isolated,
// tool-less headless Claude on an automation account, one cached result per card,
// redrawn only when its input — the title and those check-ins — changes. Sonnet
// cannot produce pixels, so the picture is an SVG, and the console draws it
// through an <img>, where it runs no script and loads nothing.

const summarize = require('./summarize.js');
const { logEntries } = require('./review.js');

const MODEL = process.env.KEEP_PICTURE_MODEL || 'claude-sonnet-5';
const ENTRIES = 3;
const ENTRY_LIMIT = 600;
const MAX_SVG_BYTES = 64 * 1024;

const INSTRUCTION = [
  'Draw one small illustration of what the work described in the source is about, as a single SVG.',
  'Pick a concrete visual metaphor for the subject of the work (the thing being built or fixed),',
  'not a diagram, chart, or screenshot of text. Flat shapes, a few colours, a clear focal object.',
  'Requirements: output only the <svg> element and nothing else, no code fence and no commentary;',
  'viewBox="0 0 320 200"; no text or at most three short words; no <script>, no event attributes,',
  'no <foreignObject>, no external links, images, or fonts; under 8 KB.',
].join(' ');

function pictureInput(task) {
  const title = String((task && task.fm && task.fm.title) || '').trim();
  const entries = logEntries(task && task.body).slice(-ENTRIES)
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
