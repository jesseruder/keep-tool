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

// `resource` is not a verdict the judge can return: it is the deterministic
// observation that a turn touched a declared shared resource and said nothing
// about it. It shares this file because it shares every gate — the switch, the
// session check, the carve-outs, the per-turn reservation and the rate windows.
const TYPES = ['continue', 'needs-input', 'drift', 'resource'];
const OBSERVATION_TYPE = 'resource';
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
// nobody can tell whether the Enter landed — so an unconfirmed row past this age
// is *not* reclaimed: it keeps counting toward both rate windows, because
// freeing capacity for a message that may well have been delivered is the one
// mistake here that types twice into a live session. What expiry does change is
// ownership: past it, the attempt that took the row is presumed gone, and a
// later attempt at the same turn may replace it.
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
  // The message is delivered as written. Rewriting it — even into an equivalent
  // canonical form — would type something other than the bytes Owner graded, and
  // a decomposed filename pasted out of a transcript has to arrive as itself.
  // NFC belongs to comparison (the receipt hash), not to what is typed.
  const value = String(text == null ? '' : text);
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
  if (verdictType === OBSERVATION_TYPE) return OBSERVATION_TYPE;
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
// Every command the turn ran, each judged on the shape it was recorded in: a
// string as a shell string, an argv array as an argv array. bin/steps.js decides
// what any of them actually runs, so `env -u FOO git push`, `nice -n 5 git push`
// and `bash -lc "git push" label` are the same push, while
// `["printf","%s","example; git push"]` is not one.
function releaseCarveOut(commands, keepApi, turn) {
  if (turn) {
    let commits = [];
    try { commits = JSON.parse(turn.commits || '[]'); } catch {}
    if (Array.isArray(commits) && commits.length) return 'the turn produced a commit';
  }
  const steps = requireSteps();
  for (const command of commands || []) {
    if (command === UNREADABLE_COMMAND) return UNREADABLE_REASON;
    if (!command || (Array.isArray(command) && !command.length)) continue;
    if (steps) {
      let found = null;
      try { found = steps.releaseOf(command); } catch {}
      if (found && (found.push || found.commit)) return 'the turn ran a git commit or push';
      for (const normalized of (found && found.commands) || []) {
        try { if (keepApi.deployCommand(normalized)) return 'the turn ran a deploy'; } catch {}
      }
      continue;
    }
    // No parser at all: fall back to the blunt line test rather than clearing it.
    if (typeof command === 'string') {
      try { if (keepApi.looksLikeGitWrite(command)) return 'the turn ran a git commit or push'; } catch {}
      try { if (keepApi.deployCommand(command)) return 'the turn ran a deploy'; } catch {}
    }
  }
  return null;
}

// Not a command anything runs: a marker `turnCommands` emits when a tool input
// was too long for the index to keep, so the carve-out refuses rather than
// clearing a turn on a command it only half saw — or on a joined copy of an argv,
// which is not what ran.
const UNREADABLE_COMMAND = '\u0000keep-watcher-unreadable-command';
const UNREADABLE_REASON = 'the turn ran a command the index could not record in full';

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
  // Every row counts, sent or not, however old. A reservation whose send was
  // never confirmed is an attempt that may have reached the session anyway, and
  // an unconfirmed row is the only record of it.
  if (turn.delivered_at) return 'this turn has already been delivered';
  if (handle.prepare('SELECT 1 AS hit FROM deliveries WHERE turn_id = ?').get(turn.id)) {
    return 'this turn has already been delivered';
  }
  const perSession = handle.prepare(
    'SELECT COUNT(*) AS n FROM deliveries WHERE session_id = ? AND reserved_at >= ?',
  ).get(turn.session_id, now - SESSION_WINDOW_MS).n;
  if (perSession >= config.maxPerSessionPer10m) {
    return `this session already had ${perSession} in the last 10 minutes`;
  }
  const perHour = handle.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE reserved_at >= ?')
    .get(now - HOUR_MS).n;
  if (perHour >= config.maxPerHour) return `the fleet already had ${perHour} in the last hour`;
  return null;
}

// Counting and then sending is two steps, and two daemon workers racing at the
// last slot both counted room. The count and the claim happen in one immediate
// transaction instead, so exactly one of them gets it.
function reserve(turn, config, type, deps = {}) {
  const handle = (deps.turnIndex || require('./turn-index.js')).open(deps.db);
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  // Whose reservation this is. Only the attempt holding the token may give the
  // row back, so a slow abort from a previous attempt cannot delete the row a
  // later one is currently sending under.
  const token = reservationToken();
  handle.exec('BEGIN IMMEDIATE');
  try {
    const blocked = rateLimit(turn, config, { ...deps, now });
    if (blocked) { handle.exec('ROLLBACK'); return { ok: false, reason: blocked }; }
    handle.prepare('INSERT INTO deliveries (turn_id, session_id, type, reserved_at, token) VALUES (?, ?, ?, ?, ?)')
      .run(turn.id, turn.session_id, type, now, token);
    handle.exec('COMMIT');
    return { ok: true, at: now, token };
  } catch (error) {
    try { handle.exec('ROLLBACK'); } catch {}
    // A UNIQUE violation is another worker holding this exact turn.
    if (/UNIQUE/i.test(String(error && error.message))) return { ok: false, reason: 'this turn has already been delivered' };
    return { ok: false, reason: `could not reserve: ${error.message}` };
  }
}

function reservationToken() {
  return require('node:crypto').randomBytes(16).toString('hex');
}

// A reservation that never became a send gives its slot back — but only its own.
// Without the token an attempt that aborted minutes ago would delete the row a
// live attempt at the same turn is holding, and two messages could be typed
// under one slot.
function releaseReservation(turn, deps = {}) {
  const token = deps.token;
  if (!token) return 0;
  try {
    const result = (deps.turnIndex || require('./turn-index.js')).open(deps.db)
      .prepare('DELETE FROM deliveries WHERE turn_id = ? AND token = ? AND sent_at IS NULL')
      .run(turn.id, token);
    return Number(result && result.changes) || 0;
  } catch { return 0; }
}

// A reservation that outlived its attempt keeps its slot and says why. The row
// is the only record that something may have been typed into that session.
function recordReservationError(turn, message, deps = {}) {
  if (!deps.token) return 0;
  try {
    const result = (deps.turnIndex || require('./turn-index.js')).open(deps.db)
      .prepare('UPDATE deliveries SET error = ? WHERE turn_id = ? AND token = ? AND sent_at IS NULL')
      .run(String(message || '').slice(0, 500), turn.id, deps.token);
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
  const index = deps.turnIndex || require('./turn-index.js');
  const out = [];
  let rows = [];
  try {
    rows = index.open(deps.db).prepare(
      "SELECT text, command FROM messages WHERE turn_id = ? AND kind = 'tool_use'",
    ).all(turn.id);
  } catch { return []; }
  for (const row of rows) {
    // The stored input, in the shape it was recorded in — a string or an argv
    // array. `undefined` means the JSON itself was truncated, which is not the
    // same as a tool that ran no command.
    const ran = index.toolInputCommand(row.text);
    if (ran !== undefined) {
      if (ran !== null && ran !== '') out.push(ran);
      continue;
    }
    // The JSON went. The command column is still there, but for an argv it is a
    // *joined* copy, and judging a joined argv is what turns an argument into a
    // command — the one thing this must never do. So a truncated input is not
    // read at all: it is the marker, and the marker carves the turn out.
    if (!row.command) continue;
    out.push(UNREADABLE_COMMAND);
  }
  return out;
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
  const owned = { ...deps, token: claim.token };

  try {
    // Everything above was decided from a snapshot taken before a model call that
    // takes minutes. Check it all again now, and once more inside the injection
    // lock, immediately before the characters are typed.
    const movedOn = await revalidate(turn, deps);
    if (movedOn) { releaseReservation(turn, owned); return skip(movedOn); }
    await send({
      sessionId: turn.session_id, pane: session.pane, text,
      precondition: () => revalidate(turn, deps),
    });
  } catch (error) {
    // A slot may only be given back when nothing was typed. Once characters have
    // gone to the pane nobody can prove the message did not arrive — an
    // unconfirmed send is still a send — and handing that capacity back is how a
    // session gets told the same thing twice.
    const typed = Boolean(error && error.typingStarted);
    if (typed) recordReservationError(turn, error.message, owned);
    else releaseReservation(turn, owned);
    return {
      delivered: false, reason: `delivery failed: ${error.message}`, error: error.message,
      typingStarted: typed, reservationKept: typed,
    };
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

// ---------- the resource observation ----------

// One resource per message. A turn that touched three of them has one thing to
// say about the first, and a message listing all three is a message nobody acts
// on; the rest are still in the decision's reason.
function observationMessage(turn, observation) {
  const row = (observation || [])[0];
  if (!row) return '';
  const project = path.basename(String((turn && turn.project) || '')) || 'this project';
  const evidence = String(row.evidence || '').slice(0, 80);
  return `${DELIVERY_PREFIX}this turn touched ${row.name} (${evidence}) and left no state note.`
    + ` If it changed how ${row.name} behaves for other sessions, run:`
    + ` keep note ${project} --scope ${row.name} -m "<what is true now>" --for ${row.noteFor || '+2h'}`;
}

// Recorded whether or not anything is delivered: shadow mode is how this type
// earns its way live, and Owner grades the exact text that would have been sent.
// A distinct turn key from the verdict's `<sid>#<n>`, so the observation sits
// beside the verdict's decision rather than deduplicating against it.
function recordObservationDecision(turn, observation, message, deps = {}) {
  const decisions = deps.decisions || require('./decisions.js');
  try {
    const entry = decisions.record({
      type: OBSERVATION_TYPE,
      card: '',
      session: turn.session_id,
      turn: `${turn.session_id}#${turn.n}#${OBSERVATION_TYPE}`,
      why: `the turn touched ${observation.map((row) => row.name).join(', ')} and wrote no state note`,
      message,
      reviewer: 'watcher',
    });
    return entry.id;
  } catch (error) {
    debug(`observation not recorded: ${error.message}`);
    return null;
  }
}

// Same gates as a verdict, minus the confidence one: there is no model here and
// nothing to be unsure about — either the declared matcher fired or it did not.
// The reservation is per turn across every type, so an observation on a turn
// another type already claimed is skipped and says so.
async function maybeDeliverObservation(turn, observation, deps = {}) {
  const skip = (reason, extra) => ({ delivered: false, reason, ...extra });
  if (!Array.isArray(observation) || !observation.length) return skip('no observation');
  const watcher = deps.watcher || require('./turn-watcher.js');
  const keepApi = deps.keep || require('./keep.js');
  const config = deps.config || loadConfig(deps.root);
  const text = safeDeliveryText(observationMessage(turn, observation));
  if (!text || !text.startsWith(DELIVERY_PREFIX)) return skip('unsafe-text');

  const decisionId = recordObservationDecision(turn, observation, text, deps);
  const shadow = { decisionId, text };
  if (!config.live[OBSERVATION_TYPE]) return skip(`${OBSERVATION_TYPE} is not live`, shadow);

  const session = deps.session;
  const notReady = sessionReady(session); // excludes the reviewer, among everything else
  if (notReady) return skip(notReady, shadow);

  const card = deps.card !== undefined ? deps.card : cardFor(turn, keepApi);
  const commands = deps.commands || turnCommands(turn, deps);
  const carved = carveOut({
    turn: { ...turn, assistantMessages: assistantMessages(turn, deps) },
    card, commands, watcher, keepApi,
  });
  if (carved) return skip(carved, shadow);

  const stale = freshness(turn, deps);
  if (stale) return skip(stale, shadow);

  const send = deps.send;
  if (typeof send !== 'function') return skip('no delivery transport', shadow);

  const owned = { ...deps, verdictType: OBSERVATION_TYPE, reloadConfig: deps.config ? false : undefined };
  const claim = reserve(turn, config, OBSERVATION_TYPE, owned);
  if (!claim.ok) {
    debug(`observation skipped: ${claim.reason}`);
    return skip(claim.reason, shadow);
  }
  const held = { ...owned, token: claim.token };
  try {
    const movedOn = await revalidate(turn, owned);
    if (movedOn) { releaseReservation(turn, held); return skip(movedOn, shadow); }
    await send({
      sessionId: turn.session_id, pane: session.pane, text,
      precondition: () => revalidate(turn, owned),
    });
  } catch (error) {
    const typed = Boolean(error && error.typingStarted);
    if (typed) recordReservationError(turn, error.message, held);
    else releaseReservation(turn, held);
    return { delivered: false, reason: `delivery failed: ${error.message}`, error: error.message,
      typingStarted: typed, reservationKept: typed, ...shadow };
  }
  const at = Number.isFinite(deps.now) ? deps.now : Date.now();
  markDelivered(turn, at, deps);
  confirmReservation(turn, at, deps);
  if (decisionId) {
    try { (deps.decisions || require('./decisions.js')).markDelivered(decisionId, at); } catch {}
  }
  return { delivered: true, text, at, sessionId: turn.session_id, decisionId };
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
  UNREADABLE_COMMAND, UNREADABLE_REASON, recordReservationError,
  pausedCarveOut, riskyQuestionCarveOut, cardCarveOut, releaseCarveOut, chainCarveOut, carveOut,
  freshness, sessionReady, rateLimit, reserve, releaseReservation, confirmReservation, revalidate,
  turnCommands, markDelivered, maybeDeliver,
  OBSERVATION_TYPE, observationMessage, recordObservationDecision, maybeDeliverObservation,
};
