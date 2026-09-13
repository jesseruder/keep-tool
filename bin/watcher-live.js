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
// A reservation is taken, then the send happens. If the daemon dies in between,
// the row is left claiming a slot nothing will ever fill. Past this age an unsent
// reservation is abandoned: it stops blocking its turn, stops counting toward
// either rate window, and the next tick deletes it.
const RESERVATION_TTL_MS = 5 * 60e3;
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

function allOff(reason) {
  if (reason) debug(`delivery disabled: ${reason}`);
  return { live: Object.fromEntries(TYPES.map((type) => [type, false])), ...DEFAULTS, invalid: Boolean(reason) };
}

// Fails closed, all of it. A file this decides "may I type into a live session"
// from must not be partially honoured: one bad field and the whole config reads
// as off, rather than leaving a stale `live` flag standing beside a threshold
// that could not be parsed.
const CONFIG_KEYS = new Set(['live', 'maxPerSessionPer10m', 'maxPerHour', 'minConfidence']);

function normalizeConfig(value) {
  if (value === null || value === undefined) return allOff();
  if (typeof value !== 'object' || Array.isArray(value)) return allOff('config is not an object');
  const raw = value;
  // A misspelled key is not a key this file gets to ignore. `maxPerHoru: 1` read
  // as "no opinion, use the default 12" would silently raise the cap the author
  // was trying to lower, so an unrecognised setting turns everything off.
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) return allOff(`${key} is not a setting this file understands`);
  }
  if (raw.live !== undefined) {
    if (!raw.live || typeof raw.live !== 'object' || Array.isArray(raw.live)) return allOff('live is not an object');
    for (const [key, flag] of Object.entries(raw.live)) {
      if (typeof flag !== 'boolean') return allOff(`live.${key} is not a boolean`);
      if (!TYPES.includes(key)) return allOff(`live.${key} is not a verdict type`);
    }
  }
  const live = {};
  for (const type of TYPES) live[type] = raw.live ? raw.live[type] === true : false;

  const limit = (name, fallback) => {
    if (raw[name] === undefined) return fallback;
    const candidate = raw[name];
    if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 0) return null;
    return candidate;
  };
  const perSession = limit('maxPerSessionPer10m', DEFAULTS.maxPerSessionPer10m);
  if (perSession === null) return allOff('maxPerSessionPer10m is not a non-negative integer');
  const perHour = limit('maxPerHour', DEFAULTS.maxPerHour);
  if (perHour === null) return allOff('maxPerHour is not a non-negative integer');

  let minConfidence = DEFAULTS.minConfidence;
  if (raw.minConfidence !== undefined) {
    if (typeof raw.minConfidence !== 'number' || !Number.isFinite(raw.minConfidence)
        || raw.minConfidence <= 0 || raw.minConfidence > 1) {
      return allOff('minConfidence is not a number in (0, 1]');
    }
    minConfidence = raw.minConfidence;
  }
  return { live, maxPerSessionPer10m: perSession, maxPerHour: perHour, minConfidence, invalid: false };
}

function loadConfig(root) {
  try { return normalizeConfig(JSON.parse(fs.readFileSync(configFile(root), 'utf8'))); }
  catch { return normalizeConfig(null); }
}

function saveConfig(config, root) {
  const file = configFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // `invalid` is this module's report on a config it read, not a setting, so a
  // caller round-tripping loadConfig() through saveConfig() must not trip the
  // unknown-key check with it.
  const input = config && typeof config === 'object' && !Array.isArray(config)
    ? Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'invalid'))
    : config;
  const { invalid: _invalid, ...value } = normalizeConfig(input);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return loadConfig(root);
}

function debug(message) {
  if (process.env.KEEP_DEBUG) process.stderr.write(`keep watcher-live: ${message}\n`);
}

// ---------- the delivered text ----------

// Everything here ends up typed into somebody's terminal. A carriage return in
// the middle of a message erases the `[keep watcher] ` prefix and submits
// whatever follows it; an escape sequence can do considerably worse. So the text
// is not sanitised, it is *validated*: anything outside plain printable text is
// refused outright and nothing is delivered, because a message that needed
// rewriting is not the message Owner graded.
const UNSAFE_TEXT_RE = new RegExp('[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]');
// Anything Unicode itself calls a control, a format character, or a line or
// paragraph separator, plus every space that is not a plain one. Checked against
// the compatibility form too, so a lookalike cannot smuggle one in.
const UNSAFE_CLASS_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const ODD_SPACE_RE = new RegExp('[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]');

function safeDeliveryText(text) {
  // NFC first, and the same canonical form is what gets sent, so a receipt hash
  // of the delivered text matches the text this approved.
  let value = String(text == null ? '' : text);
  try { value = value.normalize('NFC'); } catch {}
  if (!value) return null;
  const folded = (() => { try { return value.normalize('NFKC'); } catch { return value; } })();
  for (const candidate of [value, folded]) {
    if (UNSAFE_TEXT_RE.test(candidate)) return null;
    if (UNSAFE_CLASS_RE.test(candidate)) return null;
    if (ODD_SPACE_RE.test(candidate)) return null;
  }
  // Runs of spaces are the one thing worth repairing: they change nothing about
  // what the message says or where it ends.
  const collapsed = value.replace(/ {2,}/g, ' ').trim();
  if (!collapsed || collapsed.length > 1000) return null;
  return collapsed;
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
// The pre-signals read only the last 600 characters, because how a turn *ended*
// is what they are for. A carve-out is a different question — did anything in
// this turn mean Owner has to see it — so these read the whole turn.
function turnText(turn) {
  const parts = [turn.assistant_text, turn.last_assistant, ...(turn.assistantMessages || [])];
  return [...new Set(parts.filter((part) => typeof part === 'string' && part))].join('\n\n');
}

function pausedCarveOut(turnOrText, watcher) {
  const text = typeof turnOrText === 'string' ? turnOrText : turnText(turnOrText);
  // Whole text, not a tail and not a sentence at a time: `explicitPause` clips to
  // the last 600 characters of whatever it is handed, so a 700-character sentence
  // would hide its own opening.
  return watcher.explicitPauseAnywhere(text) ? 'the session paused itself and is waiting on Owner' : null;
}

function riskyQuestionCarveOut(turnOrText, watcher) {
  const text = watcher.withoutQuoted(typeof turnOrText === 'string' ? turnOrText : turnText(turnOrText));
  // A risky word anywhere in a sentence that is asking is enough, wherever in the
  // turn that sentence sits. "Should I deploy to production? Next, I can run the
  // checks." ends looking like a plan and is still a production question.
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (!sentence.trim()) continue;
    if (!watcher.askedAnywhere(sentence)) continue;
    // Folded first: a fullwidth ｄｅｐｌｏｙ is the same question as `deploy`.
    if (RISKY_QUESTION_RE.test(watcher.normalizeForMatch(sentence))) {
      return 'the turn asks about something irreversible, production-facing, or a secret';
    }
  }
  return null;
}

// Live delivery requires a card that is actually active. `taskForSession` hides
// done cards, so a session whose only card had just closed used to resolve to
// "no card" and sail past this gate — the exact moment a stray "continue" is
// least wanted. Shadow verdicts are unaffected; they record for any session.
function cardCarveOut(card) {
  if (!card) return 'live delivery needs an active card, and this session has none';
  const status = card.fm?.status || 'unknown';
  if (status !== 'active') return `card ${card.id} is ${status}, not active`;
  if (String(card.fm?.autocontinue || '').toLowerCase() === 'off') return `card ${card.id} sets autocontinue: off`;
  return null;
}

// A session that just pushed or deployed inside this turn gets Owner, not an
// automated nudge: the next thing after a release is a decision, every time.
// Parsed the way keep.js's own deploy provenance parses it, so `env git push`,
// `git "push"`, a chained `npm test && git push` and `sudo` are all seen.
function releaseCarveOut(commands, keepApi, turn) {
  if (turn) {
    let commits = [];
    try { commits = JSON.parse(turn.commits || '[]'); } catch {}
    if (Array.isArray(commits) && commits.length) return 'the turn produced a commit';
  }
  const steps = requireSteps();
  for (const command of commands || []) {
    if (!command) continue;
    if (command === UNREADABLE_COMMAND) return 'the turn ran a command too long for the index to record in full';
    if (keepApi.looksLikeGitWrite(command)) return 'the turn ran a git commit or push';
    if (steps) {
      // The normalizer sees `/usr/bin/git push`, `git pu\sh`, `env -i git push`,
      // `sudo -u root git push` and `bash -lc "git push"` as the same push.
      try { if (steps.runsGitWrite(command)) return 'the turn ran a git commit or push'; } catch {}
      try {
        for (const normalized of steps.normalizedCommands(command)) {
          if (keepApi.deployCommand(normalized)) return 'the turn ran a deploy';
        }
      } catch {}
    }
    try { if (keepApi.deployCommand(command)) return 'the turn ran a deploy'; } catch {}
  }
  return null;
}

// Not a command anything runs: a marker `turnCommands` emits for a tool input
// the index could not record in full, so the release carve-out refuses instead
// of clearing a turn on a command it only half saw.
const UNREADABLE_COMMAND = '\u0000keep-watcher-unreadable-command';

function requireSteps() {
  try { return require('./steps.js'); } catch { return null; }
}

// One automated message must be answered by a human before another can be sent.
// Without this, a `continue` delivered into a session produces another ended turn
// that the watcher judges and continues again, forever.
function chainCarveOut(openerKind) {
  return openerKind === 'keep' ? 'the turn was opened by an automated message; a human turn must come next' : null;
}

function carveOut({ turn, card, commands, watcher, keepApi }) {
  return pausedCarveOut(turn, watcher)
    || riskyQuestionCarveOut(turn, watcher)
    || cardCarveOut(card)
    || releaseCarveOut(commands, keepApi, turn)
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

// Read-only view of the limits, for a caller that wants to know before it spends
// anything. `reserve` is what actually decides.
function rateLimit(turn, config, deps = {}) {
  const handle = (deps.turnIndex || require('./turn-index.js')).open(deps.db);
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  const live = now - RESERVATION_TTL_MS;
  // Counted rows are the ones that actually mean something: a send that happened,
  // or a reservation young enough that its send might still be happening.
  const COUNTS = '(sent_at IS NOT NULL OR reserved_at >= ?)';
  if (turn.delivered_at) return 'this turn has already been delivered';
  if (handle.prepare(`SELECT 1 AS hit FROM deliveries WHERE turn_id = ? AND ${COUNTS}`).get(turn.id, live)) {
    return 'this turn has already been delivered';
  }
  const perSession = handle.prepare(
    `SELECT COUNT(*) AS n FROM deliveries WHERE session_id = ? AND reserved_at >= ? AND ${COUNTS}`,
  ).get(turn.session_id, now - SESSION_WINDOW_MS, live).n;
  if (perSession >= config.maxPerSessionPer10m) {
    return `this session already had ${perSession} in the last 10 minutes`;
  }
  const perHour = handle.prepare(
    `SELECT COUNT(*) AS n FROM deliveries WHERE reserved_at >= ? AND ${COUNTS}`,
  ).get(now - HOUR_MS, live).n;
  if (perHour >= config.maxPerHour) return `the fleet already had ${perHour} in the last hour`;
  return null;
}

// Counting and then sending is two steps, and two daemon workers racing at the
// last slot both counted room. The count and the claim happen in one immediate
// transaction instead, so exactly one of them gets it.
function reserve(turn, config, type, deps = {}) {
  const handle = (deps.turnIndex || require('./turn-index.js')).open(deps.db);
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  handle.exec('BEGIN IMMEDIATE');
  try {
    const blocked = rateLimit(turn, config, { ...deps, now });
    if (blocked) { handle.exec('ROLLBACK'); return { ok: false, reason: blocked }; }
    // turn_id is the primary key, so an abandoned row for this turn has to go
    // before the new reservation can take its place.
    handle.prepare('DELETE FROM deliveries WHERE turn_id = ? AND sent_at IS NULL AND reserved_at < ?')
      .run(turn.id, now - RESERVATION_TTL_MS);
    handle.prepare('INSERT INTO deliveries (turn_id, session_id, type, reserved_at) VALUES (?, ?, ?, ?)')
      .run(turn.id, turn.session_id, type, now);
    handle.exec('COMMIT');
    return { ok: true, at: now };
  } catch (error) {
    try { handle.exec('ROLLBACK'); } catch {}
    // A UNIQUE violation is another worker holding this exact turn.
    if (/UNIQUE/i.test(String(error && error.message))) return { ok: false, reason: 'this turn has already been delivered' };
    return { ok: false, reason: `could not reserve: ${error.message}` };
  }
}

// A reservation that never became a send must not spend a slot.
function releaseReservation(turn, deps = {}) {
  try {
    (deps.turnIndex || require('./turn-index.js')).open(deps.db)
      .prepare('DELETE FROM deliveries WHERE turn_id = ? AND sent_at IS NULL').run(turn.id);
  } catch {}
}

// Called once per tick: the rate limits already ignore abandoned reservations,
// but leaving them in the table forever makes every later count read rows that
// can never matter.
function sweepReservations(deps = {}) {
  try {
    const handle = (deps.turnIndex || require('./turn-index.js')).open(deps.db);
    const now = Number.isFinite(deps.now) ? deps.now : Date.now();
    const result = handle.prepare('DELETE FROM deliveries WHERE sent_at IS NULL AND reserved_at < ?')
      .run(now - RESERVATION_TTL_MS);
    return Number(result && result.changes) || 0;
  } catch { return 0; }
}

function confirmReservation(turn, at, deps = {}) {
  try {
    (deps.turnIndex || require('./turn-index.js')).open(deps.db)
      .prepare('UPDATE deliveries SET sent_at = ? WHERE turn_id = ?').run(at, turn.id);
  } catch {}
}

// ---------- delivery ----------

// The `command` column is a 500-character display copy, so a long command with
// `&& git push` at the end loses exactly the part the release carve-out exists to
// see. The tool_use row's `text` is the full input, so parse that and normalize
// it; the column is only a fallback for a row too long even for `text`.
function turnCommands(turn, deps = {}) {
  const steps = requireSteps();
  const out = [];
  let rows = [];
  try {
    const handle = (deps.turnIndex || require('./turn-index.js')).open(deps.db);
    rows = handle.prepare(
      "SELECT text, command FROM messages WHERE turn_id = ? AND kind = 'tool_use'",
    ).all(turn.id);
  } catch { return []; }
  for (const row of rows) {
    const found = commandsFromToolInput(row.text, steps);
    if (found.length) { out.push(...found); continue; }
    // Parsed, but it runs nothing — a Read, an Edit, a Write.
    if (parsedToolInput(row.text)) continue;
    // Not a shell tool, so there is no command in it to judge either way.
    if (!row.command) continue;
    // A shell row whose JSON does not parse is a truncated one: the index kept
    // the first couple of kilobytes and dropped the rest — which is exactly
    // where a trailing `&& git push` sits. Neither copy can clear this turn, so
    // nothing does.
    out.push(row.command, UNREADABLE_COMMAND);
  }
  return out;
}

function parsedToolInput(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

// Codex spells a tool's arguments as a JSON string inside the call, and its shell
// tools spell the command itself as an argv array under `command` or `cmd`.
function commandsFromToolInput(text, steps) {
  let input = parsedToolInput(text);
  if (!input) return [];
  if (typeof input.arguments === 'string') input = parsedToolInput(input.arguments) || input;
  else if (input.arguments && typeof input.arguments === 'object') input = input.arguments;
  const value = input.command !== undefined ? input.command : input.cmd;
  if (value === undefined || value === null) return [];
  if (!steps) return typeof value === 'string' ? [value] : [];
  try {
    const found = steps.normalizedCommandsFromArgv(value);
    if (found.length) return found;
  } catch {}
  return typeof value === 'string' ? [value] : [];
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
  // In production nothing pins the config, so revalidate() re-reads the switch
  // from disk immediately before sending: turning it off has to take effect
  // between a verdict and its delivery, which is minutes apart.
  deps = {
    ...deps,
    verdictType: verdict && verdict.verdict,
    reloadConfig: deps.reloadConfig !== undefined ? deps.reloadConfig : (deps.config ? false : undefined),
  };

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
  const carved = carveOut({
    turn: { ...turn, assistantMessages: assistantMessages(turn, deps) },
    card, commands: turnCommands(turn, deps), watcher, keepApi,
  });
  if (carved) return skip(carved);

  const stale = freshness(turn, deps);
  if (stale) return skip(stale);

  // Refuse rather than rewrite. A carriage return in the message would erase the
  // `[keep watcher] ` prefix and submit whatever followed it, so the whole text
  // — prefix included — has to be plain printable characters or nothing is sent.
  const text = safeDeliveryText(`${DELIVERY_PREFIX}${message}`);
  if (!text) return skip('unsafe-text');
  if (!text.startsWith(DELIVERY_PREFIX)) return skip('unsafe-text');

  const send = deps.send;
  if (typeof send !== 'function') return skip('no delivery transport');

  const claim = reserve(turn, config, type, deps);
  if (!claim.ok) return skip(claim.reason);

  try {
    // Everything above was decided from a snapshot taken before a model call that
    // takes minutes. Check it all again now, and once more inside the injection
    // lock, immediately before the characters are typed.
    const movedOn = await revalidate(turn, deps);
    if (movedOn) { releaseReservation(turn, deps); return skip(movedOn); }
    await send({
      sessionId: turn.session_id, pane: session.pane, text,
      precondition: () => revalidate(turn, deps),
    });
  } catch (error) {
    releaseReservation(turn, deps);
    return { delivered: false, reason: `delivery failed: ${error.message}`, error: error.message };
  }
  const at = Number.isFinite(deps.now) ? deps.now : Date.now();
  markDelivered(turn, at, deps);
  confirmReservation(turn, at, deps);
  // The decision stays pending: Owner still grades what was sent, and that grade
  // is what keeps the type live.
  if (verdict.decisionId) {
    try { (deps.decisions || require('./decisions.js')).markDelivered(verdict.decisionId, at); } catch {}
  }
  return { delivered: true, text, at, sessionId: turn.session_id };
}

// The last-moment check, run twice: once before handing the text to the
// transport, and again by the transport inside the injection lock. Returns a
// reason when the world has moved since the verdict, or null when it has not.
async function revalidate(turn, deps = {}) {
  const config = deps.reloadConfig === false ? deps.config : loadConfig(deps.root);
  const type = deps.verdictType;
  if (config && type && !config.live[type]) return `moved-on: ${type} was switched off`;
  if (typeof deps.freshSession === 'function') {
    let session = null;
    try { session = await deps.freshSession(turn.session_id); }
    catch (error) { return `moved-on: could not re-read the session (${error.message})`; }
    const notReady = sessionReady(session);
    if (notReady) return `moved-on: ${notReady}`;
  }
  const stale = freshness(turn, deps);
  return stale ? `moved-on: ${stale}` : null;
}

// Every assistant message of the turn, so a carve-out sees what the turn said
// rather than only how it ended.
function assistantMessages(turn, deps = {}) {
  try {
    const handle = (deps.turnIndex || require('./turn-index.js')).open(deps.db);
    return handle.prepare(
      "SELECT text FROM messages WHERE turn_id = ? AND role = 'assistant' AND kind = 'text' AND text IS NOT NULL",
    ).all(turn.id).map((row) => row.text);
  } catch { return []; }
}

// Deliberately archive-aware: a session whose only card is done must resolve to
// that done card, so the inactive-card gate can refuse it. `taskForSession`
// filters done cards out, which turned "closed card" into "no card".
function cardFor(turn, keepApi) {
  try {
    for (const task of keepApi.loadAll(true)) {
      if ((task.fm.sessions || []).some((entry) => entry && entry.id === turn.session_id)) return task;
    }
  } catch {}
  return null;
}

module.exports = {
  TYPES, DEFAULTS, DELIVERY_PREFIX, RISKY_QUESTION_RE, SESSION_WINDOW_MS, HOUR_MS,
  configFile, loadConfig, saveConfig, normalizeConfig, liveTypes, describeConfig,
  graduationCheck, decisionTypeFor, safeDeliveryText, turnText, assistantMessages, cardFor,
  sweepReservations, RESERVATION_TTL_MS, UNREADABLE_COMMAND,
  pausedCarveOut, riskyQuestionCarveOut, cardCarveOut, releaseCarveOut, chainCarveOut, carveOut,
  freshness, sessionReady, rateLimit, reserve, releaseReservation, confirmReservation, revalidate,
  turnCommands, markDelivered, maybeDeliver,
};
