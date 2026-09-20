'use strict';

// Offline evaluation of a candidate "handback" signal for the turn watcher.
//
// The question this answers, and the only one: how often does an agent end a
// turn by asking Owner to personally run an executable step it was already
// authorized to run itself, and can a deterministic rule find those turns
// without flagging the turns where asking him was right?
//
// NOTHING HERE IS WIRED INTO ANYTHING. This module is not required by
// `bin/turn-watcher.js`, it adds no signal to `signalsFor`, it does not appear
// in the rule chain, the daemon tick, or `bin/watcher-live.js`. It reads a
// frozen labeled suite and reports numbers. A detector that has not earned its
// false-positive rate must not be able to reach a running session, and the way
// to guarantee that is to keep it out of the paths that can.
//
// Run it:
//   node bin/handback-eval.js [--suite file] [--set dev|held-out] [--json]
//   node bin/handback-eval.js --ablate            # what each rule tier is worth
//   node bin/handback-eval.js --index --since 2026-09-01 --until 2026-09-13
// The last one re-runs the rules over the turn index, read-only, and prints
// redacted closings for a human to label. It never writes to the index.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_SUITE = path.join(__dirname, 'fixtures/handback-eval.json');
const LABELS = ['handback', 'ok'];
const SETS = ['dev', 'held-out'];
// How a turn *ended* is what this decides, so it reads the same tail the
// watcher's own pre-signals read. A request made 3 KB back is the work, not the
// hand-off.
const TAIL_CHARS = 600;

// ---------- the detector ----------

// Verbs that name work a session can do with its own tools. Deliberately not
// `review`, `decide`, `confirm` or `approve`: those name work only Owner can do,
// and a rule that flagged them would be arguing with the point of asking.
const ACTION_VERBS = 'run|rerun|re-run|pull|push|commit|restart|reboot|rebuild|reinstall|install|deploy'
  + '|land|apply|execute|start|stop|kill|remove|delete|clean|clear|sync|fetch|checkout|rebase'
  + '|launch|trigger|verify|test|regenerate|refresh|update|copy|move|rename|revert|stash|tail|cat|grep';

// A sentence is executable when it names a command line, not when it describes
// work in prose. The trailing forms catch `./scripts/x`, `bin/keep`, `npm run`.
// Two lists, because half of these words are also English. `keep` is the CLI
// this fleet runs and also the verb in "I'd keep it in source"; `make`, `node`,
// `test`, `kill` and `brew` have the same problem. Those only count inside a
// code span, where a word is a command by construction. The rest are unambiguous
// enough to read in plain prose.
const CLI_ANY = 'git|gh|keep|wt|npm|npx|pnpm|yarn|node|make|docker|adb|expo|eas|cargo'
  + '|python3?|psql|heroku|gcloud|aws|terraform|curl|pytest|playwright|launchctl|brew|kill|pkill|systemctl';
const CLI_UNAMBIGUOUS = 'git|gh|npm|npx|pnpm|yarn|adb|docker|terraform|launchctl|heroku|gcloud|psql|pytest|playwright|systemctl|eas|pkill';
const CODE_SPAN_RE = /`{1,3}[^`\n]+`{1,3}/g;
const CLI_ANY_RE = new RegExp(`\\b(?:${CLI_ANY})\\b`, 'i');
const COMMAND_RE = new RegExp(`\\b(?:${CLI_UNAMBIGUOUS})\\b`
  + '|(?:^|[\\s(`"\'])(?:\\./|bin/|scripts/|web/|desktop/)\\S+', 'i');

// Work with no command line in the sentence but an obvious mechanical referent.
// "please run the full suite" hands back exactly as much work as "please run
// `npm test`", and a detector that only reads backticks would miss the half of
// the corpus that writes in prose.
const WORK_RE = /\b(?:the (?:tests?|test suite|suite|full suite|build|linter|lint|benchmarks?|migration|script|daemon)|npm (?:test|run)|the deploy|worktrees?|the main checkout)\b/i;

// The executable referent of a segment, or null. A code span naming any CLI
// counts; in plain prose only the unambiguous binaries do.
function commandIn(part) {
  const spans = String(part).match(CODE_SPAN_RE) || [];
  const span = spans.find((text) => CLI_ANY_RE.test(text));
  if (span) return span;
  if (COMMAND_RE.test(part) || WORK_RE.test(part)) return part;
  return null;
}
// A first-person clause is the session naming its own next step. "Next, I'll
// run the suite" is the healthiest shape in the index and must never read as a
// hand-off, so it suppresses the bare-imperative rule in the same segment.
// First person singular only. "so we can see why" is the session including
// Owner in a shared purpose, not claiming the step, and suppressing on it hid a
// real hand-off in the first measured run.
const SELF_RE = /\bI(?:'|’)?(?:ll|m|ve|d)?\s+(?:will\s+|am\s+|have\s+|already\s+|just\s+|now\s+|then\s+)?\w+/i;
const SECOND_PERSON_RE = /\b(?:you|your|yours|please|go ahead|feel free)\b/i;
// A bare imperative, optionally behind one short scene-setting clause:
// "From the original directory, run `git …`". The clause is bounded so a whole
// narrative sentence cannot smuggle a verb into the imperative slot.
const IMPERATIVE_RE = new RegExp(`^(?:[^,\\n]{0,44},\\s*)?(?:then\\s+|next,?\\s+|finally,?\\s+|after that,?\\s+|once (?:that|it)(?:'|’)?s? \\w+,?\\s+)?(?:${ACTION_VERBS})\\b`, 'i');

// Second person, addressed to Owner. Each `please`/`you` form requires an
// explicit marker; the bare imperative is a separate, weaker rule so its
// precision can be measured on its own rather than hidden in a total.
const ASK_PATTERNS = [
  ['please', new RegExp(`\\bplease\\s+(?:just\\s+|then\\s+|also\\s+|first\\s+)?(?:${ACTION_VERBS})\\b`, 'i')],
  // The modal is required, not optional. Without it, "a session you start
  // yourself in a terminal" and "the three sessions you moved today" — prose
  // about what Owner did or has — read as instructions to him. Those were the
  // most common false positive in the first measured run.
  ['you-can', new RegExp(`\\byou(?:'|’)?(?:ll|d)?\\s+(?:can|could|may|should|will|would|need to|want to|have to|might want to|may want to|will need to|will want to)\\s+(?:just\\s+|then\\s+|also\\s+|now\\s+|still\\s+|manually\\s+|yourself\\s+)?(?:${ACTION_VERBS}|cmdspan)`, 'i')],
  ['go-ahead', new RegExp(`\\b(?:go ahead and|feel free to|when you get a chance,?|whenever you like,?|at your convenience,?)\\s+(?:${ACTION_VERBS}|cmdspan)`, 'i')],
  // "…, then `keep restart-daemon` from the original directory" — the command
  // is the object of a second-person clause that already named the first step.
  ['your-side', new RegExp('\\b(?:on your (?:side|end)|from your (?:side|end|shell|terminal)|in your (?:shell|terminal))\\b', 'i')],
  // The dominant hand-off shape in this fleet, and the one the first two rule
  // versions missed entirely: a second-person sentence ending in a colon, with
  // the command in the fenced block underneath. "When you're ready:", "that's
  // yours to run, since I can't touch the checkout from here:".
  ['invited', /\b(?:you|your|yours|please)\b[^\n]{0,80}:\s*(?:$|cmdspan)/i],
  // The command is already in the sentence and the ask trails it: "…can be
  // recycled with `wt rm` whenever you like". Six of the thirteen corroborated
  // hand-offs in the sampled week end exactly this way.
  ['at-leisure', /\b(?:whenever|when|if)\s+you\s+(?:like|want|feel like it|get a chance|have a moment|next .{0,20})\b|\bat your convenience\b|\bif you(?:'|’)?d rather not wait\b/i],
];

// The turn asked, and asking was right. Each of these is a class the card named
// as a negative: a genuine blocker, an action policy makes a human confirm every
// time, a tool the session does not have, or a mention that requests nothing.
const CARVE_OUTS = [
  ['credential', /\b(?:secret|secrets|token|tokens|api key|password|passphrase|credential|credentials|keychain|oauth|ssh key|2fa|otp|mfa|log in|login|sign in|signin|sign-in|authenticate|auth code|not logged in)\b/i],
  ['physical', /\b(?:unlock|physically|plug in|plugged|usb|cable|phones?|handset|tablet|speaker|the device|your device|on the device|tap |press the|screen|bluetooth|power cycle|in the browser|browser window|in chrome|in edge|the gui|desktop app|purchase|buy |pay )\b/i],
  // `npm publish` in this fleet means a one-time code typed by a human, which is
  // why the publish commands keep appearing beside an `<code>` placeholder.
  // `--force` cannot sit inside the `\b(?:…)\b` group: there is no word
  // boundary before a dash, so it would never match the flag it names.
  ['confirm-gated', /\b(?:force[- ]push|gh pr (?:create|merge|close)|pull request|open a pr|production|prod deploy|rotate|rotating|irreversible|destructive|drop (?:the )?(?:table|database)|wipe)\b|--force(?:-with-lease)?\b|npm[ _](?:run[ _])?(?:config_otp|publish)|publish-packages/i],
  // `I can` must not match `I can't`: the negation is the session explaining
  // why it is handing the step over, which is the opposite of offering to take
  // it. That one missing lookahead hid a corroborated hand-off.
  ['offer', /\bI (?:can|could)(?!(?:'|’)t|not\b)\b|\bI(?:'|’)ll\b|\bshall I\b|\bwant me to\b|\bwould you like me to\b|\bif you(?:'|’)?d (?:like|prefer|rather)\b|\bsay the word\b/i],
  ['informational', /\b(?:for reference|for future reference|if you ever|in case you (?:want|need)|the command is|fyi|documented|reference only|no action needed)\b/i],
];

// Offers, read across the whole tail. Only the unambiguous ones: each of these
// says the session will do the work once told, which is the opposite of the
// thing being detected, and none of them appeared in any corroborated hand-off
// in the sampled week.
const STRONG_OFFER_RE = /\b(?:say the word|want me to\b|shall I\b|may I\b|would you like me to\b|should I\b|say ["“]?land["”]?\b|tell me to and I will|and I(?:'|’)ll (?:run|do|land|handle) )|\bI (?:can|could)(?!(?:'|’)t|not\b)\s+(?:just\s+|also\s+)?(?:run|do|land|handle|take|remove|restart|push|pull)\b/i;

// There is deliberately no "the session said it could not" carve-out.
//
// The first version had one, and it was the single worst idea in this module:
// every corroborated hand-off in the sampled week came WITH such a sentence —
// "my permission guard won't let me pull the main checkout", "that's yours to
// run, since I can't touch the checkout from here", "two things only you can
// do" — and Owner answered three of them with "do it yourself", "you do it" and
// "you can't do that?". A detector that accepts the session's own account of
// being blocked cannot detect the thing it was built for, because the excuse and
// the hand-off are the same sentence. What the carve-outs below read instead is
// the *subject matter* — a credential, a physical device, a gated action — which
// is a fact about the world rather than a claim by the turn under test.

function tail(text, chars = TAIL_CHARS) {
  const value = String(text == null ? '' : text);
  return value.length > chars ? value.slice(-chars) : value;
}

// Relayed text is not this turn's ask. Lines the session quoted from another
// session, a README or a command's own output say nothing about what it wanted
// Owner to do; fenced blocks are kept, because a fenced command beside an ask is
// the evidence this whole detector is built on.
function stripRelayed(text) {
  return String(text == null ? '' : text).replace(/^\s*>.*$/gm, ' ');
}

// Sentence-ish units. Newlines and list bullets split as hard as periods do: a
// hand-off is usually a bullet list, and letting a bullet's carve-out suppress
// the bullet above it would hide the ask that mattered.
// The lookbehind is not decoration. `! git -C ~/repo pull --ff-only` is how a
// session hands Owner a command in this fleet, and splitting on that `!` tore
// the ask away from the command it was asking for — which is how the first
// version missed both of the hand-offs Owner corrected in writing.
function segments(text) {
  return stripRelayed(text)
    // The bullet alternative comes before `\n+` on purpose: alternation is
    // ordered, so with `\n+` first the newline matched alone and the `-` stayed
    // glued to the next segment, where an anchored imperative could never see it.
    .split(/(?:(?<=\w)!+\s+|(?<=[\w)\]`"'’”])[.?]+\s+|(?<=[\w)\]`"'’”])\.(?:\s+|$)|\n+\s*(?:[-*•]|\d+\.)\s+|\n+|^\s*(?:[-*•]|\d+\.)\s+)/)
    // A sentence ending in `.` before a bullet is split by the period rule,
    // which eats the newline and leaves the `-` glued to the next segment. The
    // imperative rule is anchored, so the marker has to come off here.
    .map((part) => part.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
}

// Fenced blocks travel with the sentence that introduced them: "run this:\n```\nkeep
// restart-daemon\n```" puts the ask and the command in different segments, so a
// segment with an ask and no command borrows the next one's command text.
const FENCE_ONLY_RE = /^`{3,}\w*$/;

// Returns the command text and the segment it was found in. Both matter: the
// text is the evidence, and the segment is where the reason for asking lives —
// a borrowed `yarn experiment rollout …` span carries no trace of the "if yes
// I'll run it" that made the sentence an offer rather than a hand-off.
function commandNear(parts, index) {
  const here = commandIn(parts[index]);
  if (here) return { text: here, segment: parts[index] };
  // A fenced command on the next line belongs to the sentence that introduced
  // it — but only when that sentence actually introduced one. Without the
  // invitation test, "Install referrer correctly does not" borrowed a command
  // out of an unrelated sentence below it and read as an instruction.
  const invites = /[:`—-]\s*$/.test(parts[index]);
  for (let i = index + 1; i < parts.length && i <= index + 2; i += 1) {
    if (FENCE_ONLY_RE.test(parts[i])) continue; // the fence marker is not the command
    if (!invites && !COMMAND_RE.test(parts[i].slice(0, 24))) return null;
    const found = commandIn(parts[i]);
    return found ? { text: found, segment: parts[i] } : null;
  }
  return null;
}

// Inline code is where a command lives, so it cannot simply be stripped — but an
// ask matched *inside* it is not this turn's ask. `keep sync` printing
// "error: Please commit or stash them" is a quoted tool result, and reading it
// as the session asking Owner to commit was a false positive in the first run.
// The span becomes the word `cmdspan` rather than a blank, because "you can
// `wt rm x` whenever you like" has no verb outside the span: the span *is* the
// verb, and the ask patterns match it by that name.
function withoutCode(text) {
  return String(text).replace(/```[\s\S]*?```/g, ' cmdspan ').replace(/`[^`\n]*`/g, ' cmdspan ');
}

// The shape a hand-off actually takes in this fleet: a short second-person
// heading — "**Left for you**", "Still yours to do", "…, your call:" — followed
// by bullets that start with a backticked command instead of a verb. Neither the
// imperative nor the `you can` rule can see those bullets, because the ask is in
// the heading and the instruction is in the bullet.
const OWNER_HEADING_RE = /\b(?:left (?:for|to) you|still yours|yours to do|your call|your turn|your queue|needs you|over to you|on yours|only you can|are yours|is yours|for you)\b/i;
const HEADING_SCOPE = 4; // bullets under one heading, before it stops being that list

function headingScope(parts) {
  // Index → the heading that put it in scope, because the heading is also where
  // the reason for asking usually sits: "Two things I need from you:" above a
  // bullet about a production secret is carved out by that bullet's neighbours,
  // not by the bullet itself.
  const scope = new Map();
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].length > 120 || !OWNER_HEADING_RE.test(parts[i])) continue;
    for (let j = i + 1; j < parts.length && j <= i + HEADING_SCOPE; j += 1) {
      if (OWNER_HEADING_RE.test(parts[j])) break;
      if (!scope.has(j)) scope.set(j, parts.slice(i, j + 1).join(' '));
    }
  }
  return scope;
}

// Which rule, if any, reads this segment as an ask aimed at Owner. The explicit
// second-person forms are tried first: when one of them fires, the weaker
// imperative rule adds nothing and would only confuse the per-rule table.
// `without` is applied here rather than to the result, so an ablation removes
// only that tier's own fires: a segment two rules both match still fires under
// the other one, which is what "what is this tier worth" means.
function askRuleFor(part, without = new Set()) {
  const prose = withoutCode(part);
  const explicit = ASK_PATTERNS.find(([name, re]) => !without.has(name) && re.test(prose));
  if (explicit) return explicit[0];
  if (without.has('imperative')) return null;
  // A bare imperative fires on any leading action verb the segment does not
  // claim for itself — no second-person marker is required, which is precisely
  // why this tier is the noisiest one and is reported separately. The suite
  // keeps its known false positives (`ng-15`, `ng-16`, `ng-24`) so the cost
  // stays visible rather than being tuned away into a total.
  if (IMPERATIVE_RE.test(prose) && !SELF_RE.test(prose)) return 'imperative';
  // With a first-person clause present, a second-person marker is what tells
  // "I'll land it; then run `keep restart-daemon`" from "I'll run it".
  if (SECOND_PERSON_RE.test(prose) && IMPERATIVE_RE.test(prose)) return 'imperative';
  return null;
}

/**
 * Decide whether one turn's closing text hands Owner executable work.
 * Pure: no registry, no index, no model. `options.preauthorized` is reserved for
 * the card-grant check the runtime version would make; it is not used to decide,
 * only reported, because the suite is text-only and a grant it cannot see must
 * not silently change a score.
 */
function detect(lastAssistant, options = {}) {
  const text = tail(lastAssistant, options.tailChars || TAIL_CHARS);
  const parts = segments(text);
  const without = new Set(options.without || []);
  const scope = without.has('heading') ? new Map() : headingScope(parts);
  const asks = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const rule = askRuleFor(part, without) || (scope.has(i) ? 'heading' : null);
    if (!rule) continue;
    const command = commandNear(parts, i);
    if (!command) { asks.push({ rule, skipped: 'no command', evidence: part }); continue; }
    const context = `${rule === 'heading' ? scope.get(i) : part}\n${command.segment}`;
    const carve = CARVE_OUTS.find(([, re]) => re.test(context));
    asks.push({ rule, carve: carve ? carve[0] : null, evidence: part, command: command.text });
  }
  // A turn that ends by offering to do the work itself — "say the word and I'll
  // run it", "want me to?" — is asking permission, not handing anything over.
  // Read of the whole tail, not one segment, because the offer usually comes a
  // sentence or two after the step it is offering to take.
  const offering = STRONG_OFFER_RE.test(text);
  const live = asks.filter((ask) => !ask.skipped && !ask.carve && !offering);
  if (!live.length) {
    const why = asks.find((ask) => ask.carve) ? `carved out: ${asks.find((ask) => ask.carve).carve}`
      : asks.length ? 'an ask with no command beside it'
      : 'no second-person ask in the closing text';
    return { handback: false, rule: null, reason: why, evidence: null, asks, preauthorized: Boolean(options.preauthorized) };
  }
  const hit = live[0];
  return {
    handback: true,
    rule: hit.rule,
    reason: `the turn asks Owner to ${hit.rule === 'your-side' ? 'act on his side' : 'run a command'} the session could run`,
    evidence: hit.evidence,
    command: hit.command,
    asks,
    preauthorized: Boolean(options.preauthorized),
  };
}

// ---------- the suite ----------

const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function loadSuite(file = DEFAULT_SUITE) {
  const suite = readJSON(file);
  if (suite.version !== 1 || !Array.isArray(suite.cases) || !suite.cases.length) {
    throw Error('suite needs version 1 and a nonempty cases array');
  }
  const ids = new Set();
  for (const item of suite.cases) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) {
      throw Error('case ids must be unique nonempty strings');
    }
    ids.add(item.id);
    for (const key of ['source', 'text', 'reason', 'class']) {
      if (typeof item[key] !== 'string' || !item[key].trim()) throw Error(`${item.id}: missing ${key}`);
    }
    if (!LABELS.includes(item.expected)) throw Error(`${item.id}: expected must be handback or ok`);
    if (item.set !== undefined && !SETS.includes(item.set)) throw Error(`${item.id}: set must be dev or held-out`);
    // The repository is public. Nothing that identifies a person, a machine or a
    // real session may ride in on a fixture, so the suite refuses it rather than
    // relying on a reviewer to notice.
    // Exactly what `redact` looks for, and one more: a uuid prefix, because a
    // fixture is usually written from a clipped excerpt. The two must not drift
    // apart — a suite that accepts what the redactor removes is not a guarantee.
    for (const [what, pattern] of [
      ['a home path', HOME_RE], ['a session id', UUID_RE], ['an email address', EMAIL_RE],
      ['a long hash', LONG_HASH_RE], ['a session id', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}\b/i],
    ]) {
      pattern.lastIndex = 0; // these are /g, and a shared regex keeps its index
      if (pattern.test(item.text)) throw Error(`${item.id}: text carries ${what}; redact it first`);
    }
  }
  return suite;
}

function suiteHash(suite) { return hash(JSON.stringify(suite)); }

// ---------- scoring ----------

function score(suite, options = {}) {
  const only = options.set || null;
  // A typo in `--set` must not read as "everything matched nothing": an empty
  // scoreboard with null rates looks like a clean run to anyone skimming it.
  if (only && !SETS.includes(only)) throw Error(`unknown set ${only}; expected one of ${SETS.join(', ')}`);
  const rows = suite.cases
    .filter((item) => !only || (item.set || 'dev') === only)
    .map((item) => {
      const result = detect(item.text, { preauthorized: item.preauthorized, without: options.without });
      const actual = result.handback ? 'handback' : 'ok';
      return {
        id: item.id,
        set: item.set || 'dev',
        class: item.class,
        expected: item.expected,
        actual,
        status: actual === item.expected ? 'match' : (item.expected === 'ok' ? 'false-positive' : 'missed'),
        rule: result.rule,
        detectorReason: result.reason,
        evidence: result.evidence,
        reason: item.reason,
      };
    });
  const count = (fn) => rows.filter(fn).length;
  const truePositives = count((row) => row.expected === 'handback' && row.actual === 'handback');
  const falsePositives = count((row) => row.status === 'false-positive');
  const missed = count((row) => row.status === 'missed');
  const positives = count((row) => row.expected === 'handback');
  const negatives = count((row) => row.expected === 'ok');
  const byKey = (key, fn) => {
    const groups = new Map();
    for (const row of rows.filter(fn)) groups.set(row[key] || 'none', (groups.get(row[key] || 'none') || 0) + 1);
    return Object.fromEntries([...groups.entries()].sort((a, b) => b[1] - a[1]));
  };
  return {
    version: 1,
    suiteHash: suiteHash(suite),
    set: only || 'all',
    metrics: {
      cases: rows.length,
      positives,
      negatives,
      truePositives,
      falsePositives,
      missed,
      precision: truePositives + falsePositives ? truePositives / (truePositives + falsePositives) : null,
      recall: positives ? truePositives / positives : null,
      falsePositiveRate: negatives ? falsePositives / negatives : null,
    },
    firedByRule: byKey('rule', (row) => row.actual === 'handback'),
    falsePositivesByClass: byKey('class', (row) => row.status === 'false-positive'),
    missedByClass: byKey('class', (row) => row.status === 'missed'),
    rows,
  };
}

function render(report) {
  const m = report.metrics;
  const pct = (n) => (n === null ? 'n/a' : `${(n * 100).toFixed(1)}%`);
  const lines = [
    `Handback detector — offline evaluation (${report.set} set), informational only`,
    `${m.cases} cases: ${m.positives} handbacks, ${m.negatives} justified or unrelated`,
    `precision ${pct(m.precision)} (${m.truePositives} true / ${m.falsePositives} false), recall ${pct(m.recall)}, false-positive rate ${pct(m.falsePositiveRate)}`,
    `fired by rule: ${JSON.stringify(report.firedByRule)}`,
  ];
  if (m.falsePositives) lines.push(`false positives by class: ${JSON.stringify(report.falsePositivesByClass)}`);
  if (m.missed) lines.push(`misses by class: ${JSON.stringify(report.missedByClass)}`);
  for (const row of report.rows.filter((r) => r.status !== 'match')) {
    lines.push(`${row.id} [${row.class}]: ${row.status} — detector said ${row.actual} (${row.detectorReason})`);
    lines.push(`  label: ${row.reason}`);
    if (row.evidence) lines.push(`  fired on: ${row.evidence.slice(0, 160)}`);
  }
  lines.push('This scores a frozen text-only suite. It measures neither live delivery nor whether a nudge would have helped.');
  return lines.join('\n');
}

// ---------- measuring on the live index ----------
//
// The suite says how the detector does on cases somebody chose. This says how
// often it would fire at all, over a sample nobody chose — the number that
// decides whether a lint would be background noise. It is read-only twice over:
// the connection is opened `readOnly`, so it cannot migrate or write the index
// the daemon is using, and it prints rows for a human to label rather than
// labeling them itself.

const SAMPLE_SQL = `SELECT t.id AS id, t.session_id AS session_id, t.n AS n, t.ended_at AS ended_at,
    s.agent AS agent, s.project AS project, t.last_assistant AS last_assistant
  FROM turns t JOIN sessions s ON s.id = t.session_id
  WHERE t.ended = 1 AND s.kind = 'interactive'
    AND t.ended_at >= ? AND t.ended_at < ?
    AND COALESCE(s.project, '') NOT LIKE ? AND COALESCE(s.cwd, '') NOT LIKE ?
    AND t.last_assistant IS NOT NULL AND length(t.last_assistant) > 40
  ORDER BY (t.id * 2654435761) % 1000003
  LIMIT ?`;

// Excerpts from the live index may be pasted into a report or a fixture, and the
// repository is public. Redact on the way out, once, here.
// Home directories on every platform, not just this one: a report is redacted or
// it is not, and "/Users only" is the kind of guarantee that holds until the
// first transcript from another machine.
const HOME_RE = /(?:\/(?:Users|home)\/[^\s/"'`]+|[A-Za-z]:\\+Users\\+[^\s\\"'`]+)/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const LONG_HASH_RE = /\b[0-9a-f]{32,}\b/gi;

function redact(text) {
  return String(text == null ? '' : text)
    .replace(HOME_RE, '~')
    .replace(UUID_RE, '<SESSION>')
    .replace(LONG_HASH_RE, '<HASH>')
    .replace(EMAIL_RE, '<EMAIL>');
}

// A stable pseudonym for a session, so two rows from one session are visibly
// from one session without the report carrying the id that names it. The raw id
// is printed only when the caller asks for it with `--identify`, which is for
// looking a turn up locally, not for anything that gets pasted.
function sessionTag(id) {
  return `s${crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 6)}`;
}

function sampleTurns(options = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const file = options.db || path.join(process.env.KEEP_DIR || path.join(require('node:os').homedir(), 'keep'), '.keep', 'turns.sqlite');
  const handle = new DatabaseSync(file, { readOnly: true });
  try {
    const exclude = options.exclude || 'hearing-aid';
    return handle.prepare(SAMPLE_SQL).all(
      Number(options.since), Number(options.until), `%${exclude}%`, `%${exclude}%`,
      Number.isInteger(options.limit) ? options.limit : 120);
  } finally { handle.close(); }
}

function indexReport(options = {}) {
  const rows = sampleTurns(options);
  const fired = [];
  for (const row of rows) {
    const result = detect(row.last_assistant);
    if (!result.handback) continue;
    fired.push({
      id: row.id,
      session: options.identify ? String(row.session_id) : sessionTag(row.session_id),
      n: row.n,
      agent: row.agent,
      date: new Date(Number(row.ended_at)).toISOString().slice(0, 10),
      project: row.project ? path.basename(row.project) : null,
      rule: result.rule,
      evidence: redact(result.evidence).slice(0, 300),
      closing: redact(tail(row.last_assistant, 320)),
    });
  }
  return { sampled: rows.length, fired: fired.length, rate: rows.length ? fired.length / rows.length : null, rows: fired, ids: rows.map((row) => row.id) };
}

// Which tier is carrying the result, and which is only making noise. A total
// hides a rule that fires ten times to be right twice, and that was the whole
// finding here, so the table is part of the tool rather than a note in a report.
const TIERS = ['please', 'you-can', 'go-ahead', 'your-side', 'invited', 'at-leisure', 'imperative', 'heading'];

function ablation(suite, options = {}) {
  const rows = [{ without: [], ...score(suite, options).metrics }];
  for (const tier of TIERS) {
    const metrics = score(suite, { ...options, without: [tier] }).metrics;
    rows.push({ without: [tier], ...metrics });
  }
  return rows;
}

function evaluate(options = {}) {
  const suite = loadSuite(options.suite);
  if (options.ablate) {
    const rows = ablation(suite, options);
    if (options.json) return JSON.stringify(rows, null, 2);
    const pct = (n) => (n === null ? 'n/a' : `${(n * 100).toFixed(0)}%`);
    return ['Per-tier ablation — what each rule is worth on this suite', ...rows.map((row) => `  ${(row.without.length ? `without ${row.without[0]}` : 'all rules').padEnd(22)}`
      + ` found ${row.truePositives}/${row.positives}, false ${row.falsePositives}/${row.negatives}, precision ${pct(row.precision)}, recall ${pct(row.recall)}`)].join('\n');
  }
  const report = score(suite, options);
  return options.json ? JSON.stringify(report, null, 2) : render(report);
}

module.exports = {
  detect, segments, stripRelayed, tail, redact, loadSuite, suiteHash, score, ablation, render, evaluate,
  sampleTurns, indexReport, TAIL_CHARS, LABELS,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const options = { json: argv.includes("--json"), ablate: argv.includes("--ablate"), suite: flag("--suite"), set: flag("--set") };
  if (argv.includes('--index')) {
    const day = (value, fallback) => (value ? Date.parse(`${value}T00:00:00Z`) : fallback);
    const report = indexReport({
      db: flag('--db'),
      since: day(flag('--since'), Date.now() - 8 * 86400e3),
      until: day(flag('--until'), Date.now()),
      limit: flag('--limit') ? Number(flag('--limit')) : 120,
      // Off by default: these rows get pasted into reports, and a session id is
      // the one field in them that names something real.
      identify: argv.includes('--identify'),
    });
    if (options.json) { console.log(JSON.stringify(report, null, 2)); }
    else {
      console.log(`Sampled ${report.sampled} ended interactive turns; the detector fired on ${report.fired} (${((report.rate || 0) * 100).toFixed(1)}%).`);
      for (const row of report.rows) {
        console.log(`\n#${row.id} ${row.session} turn ${row.n} ${row.agent} ${row.date} ${row.project || '-'} [${row.rule}]`);
        console.log(`  ${row.evidence}`);
      }
      console.log('\nLabel these by hand: the rate is only meaningful beside how many of them were real hand-offs.');
    }
  } else {
    console.log(evaluate(options));
  }
}
