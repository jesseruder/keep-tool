// keep turns — the turn index: the hook-side ingest every agent turn runs
// through, and the show, search, stats, backfill and prune subcommands over it.

'use strict';

const {
  relativeDurationMs, parseWhen, die, loadTaskAnywhere, loadAll, parseArgs, canonicalProjectPath, getKeepApi,
} = require('../keep-core.js');
const path = require('path');

const commands = {};

// Bookkeeping must never fail an agent's turn, and must never make it wait:
// every error here is swallowed (only KEEP_DEBUG makes it visible), the write
// lock is given a quarter second rather than five, and a cold read of a session
// with no prior index state is capped so the agent is not held behind a
// hundred-megabyte transcript. Whatever the cap leaves is the daemon's problem.
// Measured on a synthetic 31 MB transcript with no prior index state: 512 KiB is
// ~22 ms typical and ~74 ms worst case, while a normal turn's delta is a few KiB
// and costs under 2 ms. A session with a real backlog is drained by the daemon.
const HOOK_INGEST_BUSY_MS = 250;
const HOOK_INGEST_MAX_BYTES = 512 * 1024;

function indexTurns(input, agent) {
  try {
    require('../turn-index.js').ingestFile(input && input.transcript_path, {
      agent, busyTimeoutMs: HOOK_INGEST_BUSY_MS, maxBytes: HOOK_INGEST_MAX_BYTES,
    });
  } catch (error) {
    if (process.env.KEEP_DEBUG) process.stderr.write(`keep: turn index failed: ${(error && error.message) || error}\n`);
  }
}

// `when` is keep's forward-looking grammar, but a window is backward-looking:
// `--since +7d` reads as "the last 7 days", a date reads as "from that date".
function turnsSince(value, fallbackDays = 14) {
  if (!value) return Date.now() - fallbackDays * 86400e3;
  const relative = relativeDurationMs(value);
  if (relative != null) return Date.now() - relative;
  const parsed = Date.parse(parseWhen(value));
  if (!Number.isFinite(parsed)) die(`can't parse --since "${value}"`);
  return parsed;
}

function turnsClip(value, limit) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function turnsStamp(ms) {
  if (!Number.isFinite(ms)) return '     -     ';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function turnsIndexNumber(value, flag) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) die(`${flag} needs a positive integer`);
  return n;
}

// A card names its sessions; a session names itself. Cards win the tie because a
// card id is the shorter, likelier thing to type.
function turnsSessionsFor(id) {
  const turnIndex = require('../turn-index.js');
  let task = null;
  try { task = loadTaskAnywhere(id); } catch {}
  if (task) {
    const linked = (task.fm.sessions || []).map((entry) => entry && entry.id).filter(Boolean);
    if (!linked.length) die(`card ${id} has no linked sessions`);
    return linked;
  }
  if (!turnIndex.sessionRow(id)) die(`no card or indexed session "${id}" — run keep turns backfill first?`);
  return [id];
}

function turnsShow(argv) {
  const turnIndex = require('../turn-index.js');
  const o = parseArgs(argv, { last: 'str', json: 'bool' });
  const id = o._[0];
  if (!id) die('usage: keep turns show <session-id|card-id> [--last N] [--json]');
  const last = turnsIndexNumber(o.last, '--last') || 20;
  const out = [];
  for (const sessionId of turnsSessionsFor(id)) {
    const session = turnIndex.sessionRow(sessionId);
    const turns = turnIndex.turnsForSession(sessionId, { last });
    out.push({ session: session || { id: sessionId }, turns });
  }
  if (o.json) return console.log(JSON.stringify(out, null, 2));
  for (const entry of out) {
    const session = entry.session;
    console.log(`${session.id} — ${session.agent || '?'}/${session.kind || '?'} ${session.project || session.cwd || ''}`);
    if (!entry.turns.length) console.log('  (no indexed turns)');
    for (const turn of entry.turns) {
      console.log(`  ${String(turn.n).padStart(4)}  ${turnsStamp(turn.started_at)}  ${String(turn.opener_kind || '?').padEnd(7)}`
        + ` t=${String(turn.tool_count || 0).padStart(3)}  ${turn.ended ? 'ended' : 'open '}  `
        + `${turnsClip(turn.opener_text, 80).padEnd(80)} | ${turnsClip(turn.last_assistant, 120)}`);
    }
  }
}

// The console's own name for each session, by id: a name Owner typed, else the AI
// title, as the console shows it. The turn index stores none, so this asks the
// daemon's console projection; with no daemon answering, rows keep what the
// index has and search still works.
async function consoleSessions(deps = {}) {
  try {
    const response = await (deps.getKeepApi || getKeepApi)('/api/state?console=1', 3000);
    if (response.status !== 200) return new Map();
    const sessions = JSON.parse(response.data)?.sessions;
    return new Map((Array.isArray(sessions) ? sessions : []).filter((session) => session?.id)
      .map((session) => [session.id, { title: session.title || '', num: session.num, state: session.state || '' }]));
  } catch { return new Map(); }
}

// One row per session, newest match first, with the session's number and title so
// an agent can name it (#12) or open it. By default it reads only what people typed
// and the agents' prose in interactive sessions; --all adds tool calls and output,
// headless runs and subagents, for an error message or a command.
async function conversationHits(query, o, deps = {}) {
  const turnIndex = require('../turn-index.js');
  const { searchDatabase, OPEN, CLOSE } = require('../session-text-search.js');
  const numbers = require('../session-numbers.js');
  const hits = searchDatabase(turnIndex.open(turnIndex.databaseFile()), query, {
    all: o.all === true,
    since: o.since ? turnsSince(o.since) : null,
    project: o.project ? turnIndex.normalizeProject(canonicalProjectPath(o.project)) : null,
    agent: o.agent || null,
    sessionLimit: Math.min(turnsIndexNumber(o.limit, '--limit') || 20, 200),
  });
  const known = hits.length ? await consoleSessions(deps) : new Map();
  for (const hit of hits) {
    const listed = known.get(hit.sessionId);
    hit.num = listed?.num ?? numbers.numberFor(hit.sessionId);
    hit.title = listed?.title || hit.title;
    if (listed?.state) hit.state = listed.state;
    hit.snippet = hit.snippet.split(OPEN).join('[').split(CLOSE).join(']');
  }
  return hits;
}

function printConversations(hits) {
  const numbers = require('../session-numbers.js');
  // `user` rows also carry Keep's own messages, hook prompts and slash commands.
  const said = (hit) => (hit.kind === 'human' ? 'you' : hit.role === 'user' ? `${hit.kind || 'user'}` : hit.role === 'tool' ? 'tool' : 'agent');
  for (const hit of hits) {
    const head = [hit.num ? `${numbers.label(hit.num)} (${hit.sessionId})` : hit.sessionId, hit.title && turnsClip(hit.title, 80), hit.state, hit.card,
      hit.project && path.basename(hit.project), turnsStamp(hit.ts), hit.hits > 1 ? `${hit.hits} matches` : ''].filter(Boolean);
    console.log(head.join('  ·  '));
    console.log(`    ${said(hit)}: ${turnsClip(hit.snippet, 200)}`);
  }
}

async function turnsSearch(argv, deps = {}) {
  const { ftsMatch } = require('../session-text-search.js');
  const o = parseArgs(argv, { since: 'str', project: 'str', limit: 'str', agent: 'str', json: 'bool', all: 'bool' });
  const query = o._.join(' ').trim();
  if (!query) die('usage: keep turns search "<query>" [--all] [--since when] [--project p] [--agent claude|codex] [--limit n] [--json]');
  if (!ftsMatch(query)) die('keep turns search: the query needs at least three characters');
  const hits = await conversationHits(query, o, deps);
  if (o.json) return console.log(JSON.stringify(hits, null, 2));
  if (!hits.length) return console.log('no matches');
  printConversations(hits);
}

// keep search: cards and conversations in one answer to "where did we decide X".
// Cards first (every word in the card's title, tags or text), then the sessions
// `keep turns search` finds. --cards or --conversations keeps one side.
async function search(argv, deps = {}) {
  const { ftsMatch } = require('../session-text-search.js');
  const { searchCards } = require('../card-search.js');
  const o = parseArgs(argv, { since: 'str', project: 'str', limit: 'str', agent: 'str', json: 'bool', all: 'bool', cards: 'bool', conversations: 'bool' });
  const query = o._.join(' ').trim();
  if (!query) die('usage: keep search "<words>" [--cards|--conversations] [--all] [--since when] [--project p] [--agent claude|codex] [--limit n] [--json]');
  const cardsOnly = o.cards === true && o.conversations !== true;
  const conversationsOnly = o.conversations === true && o.cards !== true;
  const limit = Math.min(turnsIndexNumber(o.limit, '--limit') || 10, 200);
  const cards = conversationsOnly ? [] : searchCards((deps.loadAll || loadAll)(true), query, {
    limit, project: o.project ? canonicalProjectPath(o.project) : null,
  });
  const conversations = cardsOnly || !ftsMatch(query) ? []
    : await conversationHits(query, { ...o, limit: String(limit) }, deps);
  if (o.json) return console.log(JSON.stringify({ cards, conversations }, null, 2));
  if (!cards.length && !conversations.length) return console.log('no matches');
  if (cards.length) {
    console.log('Cards');
    for (const card of cards) {
      console.log([card.id, turnsClip(card.title, 80), card.status, card.project && path.basename(card.project), card.updated]
        .filter(Boolean).join('  ·  '));
      if (card.snippet) console.log(`    ${turnsClip(card.snippet, 200)}`);
    }
  }
  if (conversations.length) {
    if (cards.length) console.log('');
    console.log('Conversations');
    printConversations(conversations);
  }
}
commands.search = search;

function turnsStats(argv) {
  const turnIndex = require('../turn-index.js');
  const o = parseArgs(argv, { since: 'str', json: 'bool' });
  const summary = turnIndex.stats({ since: turnsSince(o.since) });
  if (o.json) return console.log(JSON.stringify(summary, null, 2));
  console.log(`since ${new Date(summary.since).toISOString().slice(0, 16).replace('T', ' ')}`);
  console.log(`${'agent/kind'.padEnd(22)}${'sessions'.padStart(9)}${'turns'.padStart(8)}${'human'.padStart(8)}${'keep'.padStart(7)}${'nudges'.padStart(8)}`);
  for (const row of summary.rows) {
    console.log(`${`${row.agent}/${row.kind}`.padEnd(22)}${String(row.sessions).padStart(9)}${String(row.turns).padStart(8)}`
      + `${String(row.humanOpeners).padStart(8)}${String(row.keepOpeners).padStart(7)}${String(row.nudges).padStart(8)}`);
  }
  const t = summary.totals;
  console.log(`${'total'.padEnd(22)}${String(t.sessions).padStart(9)}${String(t.turns).padStart(8)}${String(t.humanOpeners).padStart(8)}${String(t.keepOpeners).padStart(7)}${String(t.nudges).padStart(8)}`);
  if (t.humanOpeners) console.log(`nudges are ${Math.round((t.nudges / t.humanOpeners) * 100)}% of human openers`);
}

function turnsIngest(argv) {
  const turnIndex = require('../turn-index.js');
  const o = parseArgs(argv, { agent: 'str', force: 'bool', json: 'bool' });
  const file = o._[0];
  if (!file) die('usage: keep turns ingest <file> [--agent claude|codex] [--force]');
  const result = turnIndex.ingestFile(path.resolve(file), { agent: o.agent, force: o.force === true });
  if (o.json) return console.log(JSON.stringify(result, null, 2));
  if (!result.ok) return die(`turn index: ${result.skipped}${result.error ? ` (${result.error})` : ''}`);
  console.log(`${result.sessionId || '(no session)'} ${result.agent || ''} ${result.kind || ''}: `
    + `${result.messages || 0} messages, ${result.turns || 0} turns, ${result.bytes || 0} bytes`);
}

function turnsBackfill(argv) {
  const turnIndex = require('../turn-index.js');
  const o = parseArgs(argv, { since: 'str', roots: 'str', force: 'bool', json: 'bool' });
  const summary = turnIndex.backfill({
    since: turnsSince(o.since),
    roots: o.roots ? String(o.roots).split(',').map((value) => value.trim()).filter(Boolean) : null,
    force: o.force === true,
    onProgress: o.json ? undefined : (progress) => {
      process.stderr.write(`  ${progress.files} files, ${progress.sessions} sessions, ${progress.turns} turns…\n`);
    },
  });
  if (o.json) return console.log(JSON.stringify(summary, null, 2));
  console.log(`${summary.files} files, ${summary.sessions} sessions, ${summary.messages} messages, `
    + `${summary.turns} turns, ${summary.skipped} skipped in ${summary.seconds}s`);
}

function turnsPrune(argv) {
  const turnIndex = require('../turn-index.js');
  const o = parseArgs(argv, { 'older-than': 'str', dry: 'bool', json: 'bool' });
  const cutoff = turnsSince(o['older-than'], turnIndex.DEFAULT_PRUNE_DAYS);
  const result = turnIndex.prune({ cutoff, dry: o.dry === true });
  if (o.json) return console.log(JSON.stringify(result, null, 2));
  console.log(`${o.dry ? 'would drop' : 'dropped'} ${result.sessions} sessions, ${result.messages} messages, `
    + `${result.turns} turns, ${result.files} ingest records last active before `
    + `${new Date(result.cutoff).toISOString().slice(0, 10)}`);
}

const TURNS_SUBCOMMANDS = {
  show: turnsShow, search: turnsSearch, stats: turnsStats,
  ingest: turnsIngest, backfill: turnsBackfill, prune: turnsPrune,
};

commands.turns = (argv) => {
  const sub = TURNS_SUBCOMMANDS[argv[0]];
  if (!sub) die('usage: keep turns show|search|stats|ingest|backfill|prune (see keep help turns)');
  return sub(argv.slice(1));
};

module.exports = { commands, consoleSessions, turnsSearch, search, indexTurns, turnsSince, turnsClip, turnsStamp, turnsIndexNumber };
