'use strict';
// Auto-continue v2 — the live path for turn-watcher verdicts.
//
// Everything before this step recorded what Owner would have typed and sent
// nothing. This is the first code in the watcher that can actually reach a
// running agent, so the shape is: off by default, on per verdict type, and only
// after that type's shadow decisions have earned it (30 marks at 90%). Every
// gate below is a separate reason to stay quiet, and a message is delivered only
// when all of them agree.
//
// Delivery is daemon-only. A hook runs inside the agent's own process at the
// moment it is trying to stop; sending it a message from there is a different
// and much sharper edge than the daemon noticing a finished turn a few seconds
// later, with the whole session snapshot in hand.

const fs = require('node:fs');
const path = require('node:path');

const TYPES = ['continue', 'needs-input', 'drift'];
const DEFAULTS = Object.freeze({
  maxPerSessionPer10m: 1,
  maxPerHour: 12,
  minConfidence: 0.7,
});
const SESSION_WINDOW_MS = 10 * 60e3;
const HOUR_MS = 3600e3;
// The transcript can be written a moment after the turn's last timestamp; only a
// write past this grace means the session has moved on since the turn ended.
const FRESHNESS_GRACE_MS = 2000;
// Delivered messages are prefixed so the indexer files them as `keep` openers.
// A watcher message must never be counted as one of Owner's nudges: the nudge
// rate is the number this whole project is trying to move.
const DELIVERY_PREFIX = '[keep watcher] ';

// Words that make a question one Owner answers himself, whatever the model
// thought. Deliberately broad: the cost of a false carve-out is one nudge Owner
// types anyway, and the cost of a false delivery is a production write nobody
// asked for.
const RISKY_QUESTION_RE = /\b(?:production|prod|live users|deploy|deployment|rollout|roll out|canary|delete|drop|drops|rotate|rotating|secret|secrets|token|tokens|credential|credentials|first time|first-time|irreversible|refund|charge|charges|invoice|billing|spend|money|payment)\b/i;

function registryRoot(root) {
  return root || process.env.KEEP_DIR || path.join(require('node:os').homedir(), 'keep');
}

function configFile(root) {
  return path.join(registryRoot(root), 'watch', 'watcher.json');
}

function normalizeConfig(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const live = {};
  for (const type of TYPES) live[type] = Boolean(raw.live && raw.live[type] === true);
  const positive = (candidate, fallback) => (Number.isFinite(candidate) && candidate >= 0 ? candidate : fallback);
  return {
    live,
    maxPerSessionPer10m: positive(Number(raw.maxPerSessionPer10m), DEFAULTS.maxPerSessionPer10m),
    maxPerHour: positive(Number(raw.maxPerHour), DEFAULTS.maxPerHour),
    // A malformed or missing threshold must not widen delivery, so it falls back
    // to the default rather than to zero.
    minConfidence: Number.isFinite(Number(raw.minConfidence)) && Number(raw.minConfidence) > 0
      ? Number(raw.minConfidence) : DEFAULTS.minConfidence,
  };
}

function loadConfig(root) {
  try { return normalizeConfig(JSON.parse(fs.readFileSync(configFile(root), 'utf8'))); }
  catch { return normalizeConfig(null); }
}

function saveConfig(config, root) {
  const file = configFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const value = normalizeConfig(config);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return value;
}

function liveTypes(config) {
  return TYPES.filter((type) => config.live[type]);
}

function describeConfig(config) {
  const on = liveTypes(config);
  if (!on.length) return 'shadow only — nothing is delivered';
  return `live for ${on.join(', ')} at confidence >= ${config.minConfidence}`
    + ` (max ${config.maxPerSessionPer10m}/session/10m, ${config.maxPerHour}/hour)`;
}

// A type graduates on its own record, not on a promise. The refusal says exactly
// what is missing so the answer is never "try again later and hope".
function graduationCheck(type, stats) {
  const row = (stats && stats.rows || []).find((candidate) => candidate.type === decisionTypeFor(type));
  const graduation = (stats && stats.graduation) || { min: 30, rate: 0.9 };
  if (!row || !row.judged) {
    return { ok: false, reason: `${type} has no graded decisions yet; it needs ${graduation.min} at ${Math.round(graduation.rate * 100)}%` };
  }
  if (row.ready) return { ok: true, row };
  const missing = [];
  if (row.judged < graduation.min) missing.push(`${graduation.min - row.judged} more graded (${row.judged}/${graduation.min})`);
  const rate = row.rate === null ? 0 : row.rate;
  if (rate < graduation.rate) {
    missing.push(`agreement ${Math.round(rate * 100)}% below ${Math.round(graduation.rate * 100)}%`);
  }
  return { ok: false, row, reason: `${type} is not ready: ${missing.join(', ')}` };
}

// The verdict a delivery would act on maps to the ledger type it was recorded
// under, which is where its agreement rate lives.
function decisionTypeFor(verdictType) {
  if (verdictType === 'continue') return 'continue';
  if (verdictType === 'drift') return 'drift';
  return 'answer'; // needs-input only ever delivers when it proposed an answer
}

// ---------- carve-outs ----------

// Each returns a short reason string, or null when it does not apply. Pure and
// exported so every one of them is a test rather than a hope.
function pausedCarveOut(lastAssistant, watcher) {
  return watcher.explicitPause(lastAssistant) ? 'the session paused itself and is waiting on Owner' : null;
}

function riskyQuestionCarveOut(lastAssistant, watcher) {
  if (!watcher.askedQuestion(lastAssistant) && !watcher.askedForAction(lastAssistant)) return null;
  const text = watcher.withoutQuoted(lastAssistant);
  return RISKY_QUESTION_RE.test(text)
    ? 'the turn asks about something irreversible, production-facing, or a secret' : null;
}

function cardCarveOut(card) {
  if (!card) return null; // no card is not by itself a reason to stay quiet
  if (card.fm?.status !== 'active') return `card ${card.id} is ${card.fm?.status || 'unknown'}, not active`;
  if (String(card.fm?.autocontinue || '').toLowerCase() === 'off') return `card ${card.id} sets autocontinue: off`;
  return null;
}

// A session that just pushed or deployed inside this turn gets Owner, not an
// automated nudge: the next thing after a release is a decision, every time.
function releaseCarveOut(commands, keepApi) {
  for (const command of commands || []) {
    if (!command) continue;
    if (keepApi.looksLikeGitWrite(command)) return 'the turn ran a git commit or push';
    try { if (keepApi.deployCommand(command)) return 'the turn ran a deploy'; } catch {}
  }
  return null;
}

// One automated message must be answered by a human before another can be sent.
// Without this, a `continue` delivered into a session produces another ended turn
// that the watcher judges and continues again, forever.
function chainCarveOut(openerKind) {
  return openerKind === 'keep' ? 'the turn was opened by an automated message; a human turn must come next' : null;
}

function carveOut({ turn, card, commands, watcher, keepApi }) {
  return pausedCarveOut(turn.last_assistant, watcher)
    || riskyQuestionCarveOut(turn.last_assistant, watcher)
    || cardCarveOut(card)
    || releaseCarveOut(commands, keepApi)
    || chainCarveOut(turn.opener_kind);
}

// ---------- freshness and limits ----------

// A verdict is about the turn as it ended. If anything has happened since — a new
// turn in the index, or bytes appended to the transcript past the grace — the
// message would be an answer to something the watcher never read.
function freshness(turn, deps = {}) {
  const handle = (deps.turnIndex || require('./turn-index.js')).open(deps.db);
  const newer = handle.prepare('SELECT n FROM turns WHERE session_id = ? AND n > ? LIMIT 1')
    .get(turn.session_id, turn.n);
  if (newer) return 'the session has already started another turn';
  const endedAt = Number(turn.ended_at || turn.started_at || 0);
  const row = handle.prepare('SELECT file FROM sessions WHERE id = ?').get(turn.session_id);
  const file = row && row.file;
  if (!file) return 'the session has no indexed transcript';
  let mtime = 0;
  try { mtime = (deps.statSync || fs.statSync)(file).mtimeMs; } catch { return 'the transcript is unreadable'; }
  if (endedAt && mtime > endedAt + FRESHNESS_GRACE_MS) return 'the transcript has been written since the turn ended';
  return null;
}

function sessionReady(session) {
  if (!session) return 'the daemon does not see this session';
  if (session.kind && session.kind !== 'claude' && session.kind !== 'codex') return 'not an agent session';
  if (session.exited || session.state === 'exited') return 'the session has exited';
  if (session.reviewer) return 'the reviewer is not auto-continued';
  if (!session.endedTurn) return 'the session is mid-turn';
  if (session.pendingQuestion) return 'a question is on screen';
  if (session.pendingPlan) return 'a plan is waiting for approval';
  if (session.notify?.type === 'permission') return 'a permission prompt is on screen';
  if (session.toolRunning) return 'a tool is still running';
  return null;
}

function rateLimit(turn, config, deps = {}) {
  const handle = (deps.turnIndex || require('./turn-index.js')).open(deps.db);
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  if (turn.delivered_at) return 'this turn has already been delivered';
  const perSession = handle.prepare(
    'SELECT COUNT(*) AS n FROM turns WHERE session_id = ? AND delivered_at >= ?',
  ).get(turn.session_id, now - SESSION_WINDOW_MS).n;
  if (perSession >= config.maxPerSessionPer10m) {
    return `this session already had ${perSession} in the last 10 minutes`;
  }
  const perHour = handle.prepare('SELECT COUNT(*) AS n FROM turns WHERE delivered_at >= ?').get(now - HOUR_MS).n;
  if (perHour >= config.maxPerHour) return `the fleet already had ${perHour} in the last hour`;
  return null;
}

// ---------- delivery ----------

function turnCommands(turn, deps = {}) {
  try {
    const handle = (deps.turnIndex || require('./turn-index.js')).open(deps.db);
    return handle.prepare("SELECT command FROM messages WHERE turn_id = ? AND command IS NOT NULL AND command != ''")
      .all(turn.id).map((row) => row.command);
  } catch { return []; }
}

function markDelivered(turn, at, deps = {}) {
  const handle = (deps.turnIndex || require('./turn-index.js')).open(deps.db);
  handle.prepare('UPDATE turns SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL').run(at, turn.id);
}

// The one place a watcher verdict becomes a message in somebody's terminal.
// Returns why it did not, whenever it did not, because "nothing happened" is the
// normal outcome and it has to be explicable.
async function maybeDeliver(turn, verdict, deps = {}) {
  const watcher = deps.watcher || require('./turn-watcher.js');
  const keepApi = deps.keep || require('./keep.js');
  const config = deps.config || loadConfig(deps.root);
  const skip = (reason) => ({ delivered: false, reason });

  if (!verdict || verdict.skipped) return skip('no verdict');
  if (watcher.isReplayModel ? watcher.isReplayModel(verdict.model) : String(verdict.model || '').endsWith(':replay')) {
    return skip('replays are never delivered');
  }
  const type = verdict.verdict;
  if (!TYPES.includes(type)) return skip(`${type} is not deliverable`);
  if (!config.live[type]) return skip(`${type} is not live`);
  const message = String(verdict.message || '').trim();
  // needs-input with nothing proposed is an escalation: there is no message to
  // send, and inventing one is the opposite of what the verdict means.
  if (!message) return skip('the verdict proposed no message');
  if (!Number.isFinite(verdict.confidence) || verdict.confidence < config.minConfidence) {
    return skip(`confidence ${verdict.confidence ?? 'unknown'} is below ${config.minConfidence}`);
  }

  const session = deps.session;
  const notReady = sessionReady(session);
  if (notReady) return skip(notReady);

  const card = deps.card !== undefined ? deps.card : cardFor(turn, keepApi);
  const carved = carveOut({ turn, card, commands: turnCommands(turn, deps), watcher, keepApi });
  if (carved) return skip(carved);

  const stale = freshness(turn, deps);
  if (stale) return skip(stale);

  const limited = rateLimit(turn, config, deps);
  if (limited) return skip(limited);

  const text = `${DELIVERY_PREFIX}${message}`;
  const send = deps.send;
  if (typeof send !== 'function') return skip('no delivery transport');
  try {
    await send({ sessionId: turn.session_id, pane: session.pane, text });
  } catch (error) {
    return { delivered: false, reason: `delivery failed: ${error.message}`, error: error.message };
  }
  const at = Number.isFinite(deps.now) ? deps.now : Date.now();
  markDelivered(turn, at, deps);
  // The decision stays pending: Owner still grades what was sent, and that grade
  // is what keeps the type live.
  if (verdict.decisionId) {
    try { (deps.decisions || require('./decisions.js')).markDelivered(verdict.decisionId, at); } catch {}
  }
  return { delivered: true, text, at, sessionId: turn.session_id };
}

function cardFor(turn, keepApi) {
  try { return keepApi.taskForSession(turn.session_id) || null; } catch { return null; }
}

module.exports = {
  TYPES, DEFAULTS, DELIVERY_PREFIX, RISKY_QUESTION_RE, SESSION_WINDOW_MS, HOUR_MS,
  configFile, loadConfig, saveConfig, normalizeConfig, liveTypes, describeConfig,
  graduationCheck, decisionTypeFor,
  pausedCarveOut, riskyQuestionCarveOut, cardCarveOut, releaseCarveOut, chainCarveOut, carveOut,
  freshness, sessionReady, rateLimit, turnCommands, markDelivered, maybeDeliver,
};
