'use strict';
// keep allow — pre-authorization granted at planning time.
//
// A week of transcripts (2026-08-31..09-06) had 1,389 messages Owner typed and
// 202 of them (16%) were a bare "yes": the agent had already decided what to do,
// written it out, and stopped for one word. 326 handbacks (26%) were approval
// requests. That is the tax this module removes.
//
// The grant lives on the card, written while Owner is in the planning
// conversation where he wants to be. An agent asks `keep allow <card> push` and
// gets an exit code instead of asking Owner. Anything not granted still stops.

const ACTION_RE = /^[a-z][a-z0-9-]*$/;
const SCOPE_RE = /^[a-z0-9][a-z0-9._\/-]*$/i;

// Not a closed set — a card may grant any action an agent thinks to ask about —
// but these are the ones the Stop hook knows how to recognise in prose, so they
// are what `keep allow --list-actions` advertises and what the skill documents.
const KNOWN_ACTIONS = [
  'push',        // push an existing branch to its remote (includes wt land)
  'land',        // rebase + push to the default branch
  'deploy',      // any deploy; scope it (deploy:staging, deploy:prod) to narrow
  'review',      // spend a Codex review
  'publish',     // npm/registry publish
  'migrate',     // run a database migration
  'restart',     // restart a daemon or service
  'terraform',   // terraform apply
  'install',     // install a build on a device
  'spend',       // spend:<dollars> — a ceiling, checked with --amount
];

class AllowError extends Error {}

function fail(message) { throw new AllowError(message); }

// ---------- tokens ----------

// A grant or a request: `action` or `action:scope`. Scope is compared
// case-insensitively but stored as written, so `deploy:Prod` and `deploy:prod`
// are the same grant.
function parseToken(input, label = 'action') {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) fail(`${label} cannot be empty`);
  const at = raw.indexOf(':');
  const action = (at === -1 ? raw : raw.slice(0, at)).toLowerCase();
  const scope = at === -1 ? '' : raw.slice(at + 1).trim();
  if (!ACTION_RE.test(action)) {
    fail(`${label} "${raw}" is not a valid action — use lowercase letters, digits and dashes, optionally followed by :scope`);
  }
  if (at !== -1 && !scope) fail(`${label} "${raw}" has a colon but no scope`);
  if (scope && !SCOPE_RE.test(scope)) {
    fail(`${label} scope "${scope}" may only contain letters, digits, dot, dash, slash and underscore`);
  }
  // A spend *grant* is the ceiling and must carry one. A spend *request* is
  // bare and carries its dollars in --amount, so it is checked in decide().
  if (action === 'spend') {
    if (label === 'grant' && !scope) fail('spend needs a ceiling — grant it as spend:<dollars>, e.g. spend:25');
    if (scope && !/^\d+(\.\d+)?$/.test(scope)) fail(`spend ceiling "${scope}" must be a number of dollars, e.g. spend:25`);
  }
  return { action, scope, token: scope ? `${action}:${scope}` : action };
}

function formatToken(token) { return token.scope ? `${token.action}:${token.scope}` : token.action; }

// Identity for deduplication and revocation. `decide` compares scopes without
// case, so storage has to as well — otherwise `deploy:Prod` and `deploy:prod`
// are one grant when granting authority and two when taking it away.
function tokenKey(token) {
  return token.scope ? `${token.action}:${token.scope.toLowerCase()}` : token.action;
}

function parseGrants(values) {
  const seen = new Map();
  for (const value of values || []) {
    for (const part of String(value).split(',')) {
      if (!part.trim()) continue;
      const token = parseToken(part, 'grant');
      // A bare grant subsumes every scoped grant of the same action, and a
      // second spend ceiling replaces the first rather than stacking.
      if (token.action === 'spend') {
        const prior = [...seen.values()].find((t) => t.action === 'spend');
        if (prior && prior.scope !== token.scope) seen.delete(tokenKey(prior));
      }
      seen.set(tokenKey(token), token);
    }
  }
  const tokens = [...seen.values()];
  const bare = new Set(tokens.filter((t) => !t.scope).map((t) => t.action));
  return tokens.filter((t) => !t.scope || !bare.has(t.action)).sort((a, b) => formatToken(a).localeCompare(formatToken(b)));
}

function readGrants(task) {
  const raw = (task && task.fm && task.fm.allow) || [];
  const values = Array.isArray(raw) ? raw : String(raw).split(',');
  const tokens = [];
  for (const value of values) {
    if (!String(value).trim()) continue;
    try { tokens.push(parseToken(value, 'grant')); }
    catch { /* a hand-edited card should not break every read */ }
  }
  return tokens;
}

// ---------- the decision ----------

// The card's allow_until as a `YYYY-MM-DDTHH:MM` local stamp, or a bare date,
// which lasts to the end of that day.
//
// An unreadable value denies. Failing open there would turn a typo in a
// deliberately time-bounded grant into permanent authority, which is the one
// direction this module must never fail in.
function expiryState(task, now) {
  const until = String((task && task.fm && task.fm.allow_until) || '').trim();
  if (!until) return { state: 'none', until: '' };
  const at = new Date(until.length === 10 ? `${until}T23:59` : until);
  if (Number.isNaN(at.getTime())) return { state: 'invalid', until };
  return { state: at.getTime() < now ? 'expired' : 'live', until };
}

// Truthy when the grants may not be used: the stamp, so callers can name it.
function expired(task, now) {
  const { state, until } = expiryState(task, now);
  return state === 'expired' || state === 'invalid' ? until : null;
}

// Returns { ok, why, grant } — never throws for a plain "not granted", because
// the whole point is that an agent can branch on it.
function decide(task, request, { amount, now = Date.now() } = {}) {
  const want = parseToken(request, 'action');
  const grants = readGrants(task);
  if (!grants.length) {
    return { ok: false, why: `no grants on ${task.id} — ask Owner, or he can grant it with keep allow ${task.id} --grant ${formatToken(want)}` };
  }
  const expiry = expiryState(task, now);
  if (expiry.state === 'invalid') {
    return { ok: false, why: `allow_until on ${task.id} is "${expiry.until}", which is not a date Keep can read, so the grants are treated as expired — ask Owner to fix or clear it with keep allow ${task.id} --until <when>` };
  }
  if (expiry.state === 'expired') {
    return { ok: false, why: `the grants on ${task.id} expired at ${expiry.until} — ask Owner to renew with keep allow ${task.id} --until <when>` };
  }

  if (want.action === 'spend') {
    const ceiling = grants.find((g) => g.action === 'spend');
    if (!ceiling) return { ok: false, why: `${task.id} grants no spending — ask Owner` };
    // `keep allow <card> spend --amount 12` and `keep allow <card> spend:12`
    // are the same question.
    const asking = amount == null || amount === '' ? want.scope : String(amount).trim();
    if (!asking) {
      return { ok: false, why: `checking spend needs --amount <dollars> to compare against the $${ceiling.scope} ceiling` };
    }
    if (!/^\d+(\.\d+)?$/.test(asking)) fail(`--amount "${asking}" must be a number of dollars`);
    const asked = Number(asking);
    const cap = Number(ceiling.scope);
    if (asked > cap) {
      return { ok: false, why: `$${asked} is over the $${cap} ceiling on ${task.id} — ask Owner` };
    }
    return { ok: true, grant: formatToken(ceiling), why: `$${asked} is within the $${cap} ceiling on ${task.id}` };
  }

  // A bare grant (`deploy`) covers every scope; a scoped grant covers only its
  // own scope. Asking bare for a scoped-only grant is refused on purpose: an
  // agent that does not say where it is deploying does not get to deploy.
  const bare = grants.find((g) => g.action === want.action && !g.scope);
  if (bare) return { ok: true, grant: bare.action, why: `${task.id} grants ${bare.action}` };
  if (want.scope) {
    const scoped = grants.find((g) => g.action === want.action && g.scope.toLowerCase() === want.scope.toLowerCase());
    if (scoped) return { ok: true, grant: formatToken(scoped), why: `${task.id} grants ${formatToken(scoped)}` };
  }
  const sameAction = grants.filter((g) => g.action === want.action).map(formatToken);
  if (sameAction.length) {
    return {
      ok: false,
      why: want.scope
        ? `${task.id} grants ${sameAction.join(', ')} but not ${formatToken(want)}`
        : `${task.id} grants ${sameAction.join(', ')} — ask for the scope you mean, e.g. keep allow ${task.id} ${sameAction[0]}`,
    };
  }
  return { ok: false, why: `${task.id} does not grant ${formatToken(want)} — ask Owner, or he can grant it with keep allow ${task.id} --grant ${formatToken(want)}` };
}

// ---------- prose → actions, for the Stop hook ----------

// The Stop hook needs to know what an agent is stopping to ask about. These
// patterns are deliberately narrow: a miss means the agent stops and asks Owner,
// which is today's behaviour. A false positive would auto-continue something
// Owner never authorised, so each pattern wants an explicit verb in the tail.
const INTENT = [
  ['land', /\b(land it|land this|land that|wt land|land the (commit|change|fix|branch|work))\b/i],
  ['push', /\b(push (it|this|that|them|the (commit|branch|change|fix|work))|ready to push|shall i push|want me to push|push (and|then))\b/i],
  ['deploy:prod', /\b(deploy (it |this |that )?to prod(uction)?|prod(uction)? deploy|ship (it )?to prod(uction)?|promote to prod(uction)?)\b/i],
  ['deploy:staging', /\b(deploy (it |this |that )?to staging|staging deploy|promote to staging)\b/i],
  ['deploy', /\b(deploy (it|this|that|now|the (change|fix|build))|want me to deploy|shall i deploy|ready to deploy)\b/i],
  ['review', /\b((run|kick off|start) (a |the )?(codex )?(adversarial )?review|codex review)\b/i],
  ['publish', /\b(publish (it|this|that|the (package|version|cli|sdk))|npm publish|cut a release)\b/i],
  ['migrate', /\b(run the migration|apply the migration|migrate the (db|database))\b/i],
  ['restart', /\b(restart the (daemon|server|service|worker)|bounce the (daemon|service))\b/i],
  ['terraform', /\bterraform apply\b/i],
  ['install', /\b(install (it|this|the (build|apk))( on)?|sideload)\b/i],
];

// Only the tail is scanned: an agent that mentioned a deploy three paragraphs
// ago and is now asking about something else must not read as a deploy ask.
function intents(text, tailChars = 600) {
  const tail = String(text || '').slice(-tailChars);
  const hits = [];
  for (const [action, re] of INTENT) {
    const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (let m = scan.exec(tail); m; m = scan.exec(tail)) {
      hits.push({ action, start: m.index, end: m.index + m[0].length });
      if (m.index === scan.lastIndex) scan.lastIndex += 1; // never spin on an empty match
    }
  }
  // `deploy:prod` and `deploy:staging` are more specific than `deploy`, but only
  // for the mention they cover. Dropping every bare `deploy` because a scoped
  // one appeared somewhere let "deploy to prod and then deploy this build to QA"
  // read as prod alone, so a card granting only deploy:prod authorised the QA
  // deploy too. Suppress a bare hit solely where it overlaps a scoped one.
  const scoped = hits.filter((hit) => hit.action.startsWith('deploy:'));
  const found = [];
  for (const hit of hits) {
    if (hit.action === 'deploy' && scoped.some((s) => hit.start < s.end && s.start < hit.end)) continue;
    if (!found.includes(hit.action)) found.push(hit.action);
  }
  return found;
}

// The sentence the agent is actually asking, not the paragraph around it.
//
// Replaying the INTENT table over a week of real handbacks, it fired on 106 of
// 1,260 — and several were the agent *narrating* an action ("I'll restart the
// server, verify the toggle, and commit") or offering to do one once a
// different question is answered ("Say the ratio and I'll land it"). Those must
// never authorize: the open question there is a number, and an agent told to
// proceed would land one it invented. Authorization reads the question itself.
// "Say the word and I'll push it" is an approval request with no question mark,
// so a sentence carrying one of these counts as an ask too.
const APPROVAL_PHRASE_RE = /\b(?:say the word|want me to|shall i|should i|do you want|ready to|ok to)\b/i;

function askSpan(text, tailChars = 600) {
  const tail = String(text || '').slice(-tailChars).replace(/\s+/g, ' ').trim();
  // Whole sentences, so an approval phrase is judged in the sentence it belongs
  // to. Splitting finer let "should I deploy it to first" escape its own
  // question — "Which environment should I deploy it to first?" — and read as a
  // request for permission rather than the choice it actually is.
  const sentences = tail.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  const spans = [];
  for (const sentence of sentences) {
    if (!sentence.endsWith('?') && !APPROVAL_PHRASE_RE.test(sentence)) continue;
    if (!spans.includes(sentence)) spans.push(sentence);
  }
  return spans;
}

// An ask that wants a value or a choice is not an ask for permission, even when
// it mentions an action. "Say the number and I'll land it" is a question about
// the number.
const INFORMATION_ASK_RE = /\b(?:what|which|how|why|who|where|when)\b|\bsay the (?!word\b)\w+|\b(?:a|the) (?:number|ratio|value|name|amount|price|threshold)\b/i;

// Every intent in the ask must be granted. One ungranted action in a compound
// ask ("push and then deploy to prod") sends the whole turn to Owner.
function coversStop(task, text, opts = {}) {
  const spans = askSpan(text, opts.tailChars);
  // An action mentioned nowhere in the ask itself is narration, not a request.
  const asking = spans.filter((span) => !INFORMATION_ASK_RE.test(span)).join(' … ');
  const wanted = asking ? intents(asking, asking.length) : [];
  if (!wanted.length) return { covered: false, wanted, granted: [], missing: [] };
  const granted = [];
  const missing = [];
  for (const action of wanted) {
    const verdict = decide(task, action, { now: opts.now });
    if (verdict.ok) granted.push(action);
    else missing.push(action);
  }
  return { covered: missing.length === 0, wanted, granted, missing };
}

module.exports = {
  AllowError, KNOWN_ACTIONS,
  parseToken, formatToken, tokenKey, parseGrants, readGrants, expiryState, expired, decide, askSpan,
  INTENT, intents, coversStop,
};
