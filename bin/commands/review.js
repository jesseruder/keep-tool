// keep review — the reviewer's own commands: the daily digest, the review budget
// and tick, the queue, notes, ideas, outcomes, bundles and stats, and the nudge.

'use strict';

const {
  ROOT, nowStamp, withLock, commitAndPush, stampOf, loadAll, lastLogLine, loadTaskAnywhere, isOverdue, git,
  getKeepApi, parseArgs, die, postKeepApi, resolveProjectArg, KeepError, isReviewerSession,
} = require('../keep-core.js');

// A reviewer's write forwarded from a pane-only node runs here under the session the
// daemon verified (registry-route IDENTITY_VARS), and is the reviewer's only when
// that session is the registered reviewer: otherwise any session on a node, or a node
// shell with no session, would write findings under the reviewer's name.
function requireReviewerFromNode(command) {
  if (process.env.KEEP_REMOTE_CALLER && !isReviewerSession()) {
    die(`keep ${command} from a node runs only in the registered reviewer's session`);
  }
}
const fs = require('fs');
const path = require('path');

const commands = {};

commands.digest = () => {
  const md = buildDigest();
  const file = path.join(ROOT, 'digests', `${nowStamp().slice(0, 10)}.md`);
  withLock(() => {
    fs.writeFileSync(file, md);
    commitAndPush(`keep: digest ${nowStamp().slice(0, 10)}`, ['digests']);
  });
  console.log(md);
};

function buildDigest(options = {}) {
  const now = options.now == null ? new Date() : new Date(options.now);
  const today = stampOf(now).slice(0, 10);
  // Match the existing recent-activity window: yesterday at 05:00 local time.
  const since = new Date(now);
  since.setDate(since.getDate() - 1);
  since.setHours(5, 0, 0, 0);
  const allTasks = loadAll(true);
  const tasks = loadAll(false);
  const lines = [`# Keep digest — ${today}`, ''];
  const section = (title, items, fmt) => {
    if (!items.length) return;
    lines.push(`## ${title} (${items.length})`, '');
    for (const t of items) lines.push(fmt(t));
    lines.push('');
  };
  const last = (t) => {
    let line = lastLogLine(t);
    const idea = line.match(/^Reviewer idea: (\S+)$/);
    if (idea) {
      try { line = loadTaskAnywhere(idea[1]).fm.title || line; } catch {}
    }
    return line ? ` — ${line}` : '';
  };
  const ideas = allTasks.filter((t) => t.fm.kind === 'idea').map((task) => {
    const created = String(task.body || '').match(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) — created\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
    const at = Date.parse(created ? created[1].replace(' ', 'T') : task.fm.created);
    const proposal = created ? created[2].trim().replace(/\s+/g, ' ').match(/^.*?[.!?](?:\s|$)|^.+$/)?.[0].trim() || '' : '';
    return { task, at, proposal };
  }).filter((idea) => idea.at >= since.getTime() && idea.at <= now.getTime())
    .sort((a, b) => b.at - a.at);
  section('Ideas', ideas, ({ task, proposal }) => `- **${task.fm.title || task.id || 'Untitled idea'}**${proposal ? ` — ${proposal}` : ''}`);
  let reportsSection = '';
  try { reportsSection = require('../reports.js').digestSection(since.getTime()); } catch {}
  if (reportsSection) lines.push(...reportsSection.split('\n'));
  const ideaIds = new Set(ideas.map(({ task }) => task.id));
  const statusTasks = tasks.filter((task) => !ideaIds.has(task.id));
  section('Needs you', statusTasks.filter((t) => t.fm.status === 'review'), (t) => `- **${t.id}**: ${t.fm.title}${last(t)}`);
  section('Overdue checks', tasks.filter(isOverdue), (t) => `- **${t.id}**: ${t.fm.title} — due ${t.fm.check_after.replace('T', ' ')}`);
  section('Blocked', statusTasks.filter((t) => t.fm.status === 'blocked'), (t) => `- **${t.id}**: ${t.fm.title}${last(t)}`);
  section('Active', statusTasks.filter((t) => t.fm.status === 'active'), (t) => `- **${t.id}**: ${t.fm.title}${last(t)}`);
  let activity = '';
  try { activity = git('log', '--since', 'yesterday 05:00', '--pretty=format:- %s (%cr)'); } catch {}
  if (activity.trim()) lines.push('## Recent activity', '', activity.trim(), '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

async function resolveReviewBudgetTarget(options = {}, deps = {}) {
  const review = deps.review || require('../review.js');
  const accountStore = deps.accounts || require('../accounts.js');
  const explicitAccount = Object.prototype.hasOwnProperty.call(options, 'account');
  let state = null;
  let stateError = '';
  try {
    const response = await (deps.getKeepApi || getKeepApi)('/api/state', 3000);
    if (!response || response.status !== 200) {
      stateError = `Keep state returned ${response && response.status ? response.status : 'no response'}`;
    } else {
      state = JSON.parse(response.data);
      if (!state || !Array.isArray(state.sessions)) stateError = 'Keep state has no session inventory';
    }
  } catch (error) {
    stateError = `Keep state is unavailable: ${error.message}`;
  }

  let reviewer = null;
  if (!stateError) {
    try {
      let attempts;
      try { attempts = (deps.loadReviewMeta || review.loadMeta)().bootstrapAttempts; } catch {}
      reviewer = (deps.findReviewerSession || review.findReviewerSession)(state.sessions, attempts);
    } catch (error) {
      stateError = `reviewer identity is unavailable: ${error.message}`;
    }
  }
  let marker = {};
  if (reviewer) {
    try { marker = (deps.readReviewerMarker || review.readReviewerMarker)(reviewer.id) || {}; } catch {}
  }
  const model = options.model || marker.model || review.reviewerModel();

  if (explicitAccount) {
    let account = null;
    try { account = accountStore.get(options.account, deps.env || process.env); } catch (error) {
      return { model, error: `account configuration is unavailable: ${error.message}` };
    }
    if (!account || account.agent !== 'claude') {
      return { model, error: `account ${options.account || '(empty)'} is not a configured Claude account` };
    }
    return { model, accountId: account.id };
  }

  if (stateError) return { model, error: stateError };
  if (!reviewer) return { model, error: 'no active fleet reviewer session is registered' };
  const rows = state.sessions.filter((session) => session && session.id === reviewer.id && session.exited !== true);
  const accountIds = [...new Set(rows.map((session) => session.accountId).filter(Boolean))];
  if (accountIds.length !== 1 || rows.some((session) => !session.accountId)) {
    return {
      model,
      error: accountIds.length > 1
        ? `reviewer ${reviewer.id} has conflicting account identities`
        : `reviewer ${reviewer.id} has no verified account identity`,
    };
  }
  let account = null;
  try { account = accountStore.get(accountIds[0], deps.env || process.env); } catch (error) {
    return { model, error: `account configuration is unavailable: ${error.message}` };
  }
  if (!account || account.agent !== 'claude') {
    return { model, error: `reviewer account ${accountIds[0]} is not an available Claude account` };
  }
  let authority;
  let authoritySource = 'durable';
  try {
    authority = accountStore.forSession(reviewer.id, 'claude', {
      root: deps.root || ROOT,
      env: deps.env || process.env,
      allowDiscovery: false,
    });
  } catch (error) {
    return { model, error: `reviewer account authority is unavailable: ${error.message}` };
  }
  if (!authority) {
    authoritySource = 'discovered';
    try {
      authority = accountStore.forSession(reviewer.id, 'claude', {
        root: deps.root || ROOT,
        env: deps.env || process.env,
        allowDiscovery: true,
      });
    } catch (error) {
      return { model, error: `reviewer account discovery is unavailable: ${error.message}` };
    }
    if (!authority) {
      return { model, error: `reviewer ${reviewer.id} has no durable or uniquely discovered account authority` };
    }
  }
  if (authority.id !== account.id) {
    return { model, error: `reviewer account conflicts with ${authoritySource} authority ${authority.id}` };
  }
  return { model, accountId: account.id };
}

async function reviewBudgetCommand(argv, deps = {}) {
  const o = parseArgs(argv, { json: 'bool', model: 'str', account: 'str' });
  if (o._.length) die('usage: keep review-budget [--json] [--model m] [--account claude-id]');
  const review = deps.review || require('../review.js');
  const target = await resolveReviewBudgetTarget(o, { ...deps, review });
  const usage = deps.usage || require('../usage.js');
  let verdict;
  if (target.error) {
    verdict = { code: 8, reason: target.error };
  } else {
    // The daemon points usage.js at this cache at startup; a short-lived CLI has to
    // do it itself, or every reading looks like "no snapshot". Wait only for the
    // selected reviewer's snapshot; the primary compatibility view may be unrelated.
    usage.setCacheFile(path.join(deps.root || ROOT, '.keep', 'usage-cache.json'));
    usage.getUsage(); // kicks off a refresh off the call stack
    for (let i = 0; i < 20 && !usage.getUsage().accounts?.[target.accountId]?.fetchedAt; i += 1) {
      await (deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(150);
    }
    verdict = review.reviewBudget(target.model, usage.getUsage(), target.accountId);
  }
  const output = { ...verdict, model: target.model, ...(target.accountId ? { accountId: target.accountId } : {}) };
  const log = deps.log || console.log;
  if (o.json) log(JSON.stringify(output, null, 2));
  else {
    const label = verdict.code === 0 ? 'ok' : verdict.code === 6 ? 'STOP (weekly)' : verdict.code === 7 ? 'pause (short window)' : 'unknown';
    log(`${label}: ${verdict.reason}${verdict.resetsAt ? `  resets ${verdict.resetsAt}` : ''}${target.accountId ? `  account ${target.accountId}` : ''}`);
  }
  if (verdict.code) {
    if (deps.exit) deps.exit(verdict.code);
    else process.exit(verdict.code);
  }
  return output;
}

commands['review-budget'] = reviewBudgetCommand;

commands['review-tick'] = async (argv) => {
  const o = parseArgs(argv, { force: 'bool' });
  let response;
  try {
    response = await postKeepApi('/api/reviewtick', { force: Boolean(o.force) });
  } catch {
    die("keep serve isn't running — the reviewer is woken by the daemon");
  }
  let result = {};
  try { result = JSON.parse(response.data); } catch {}
  if (response.status !== 200) die(result.error || `keep serve returned ${response.status}`);
  if (result.sent) console.log(`woke reviewer ${result.sessionId} for ${result.ranked} card(s)`);
  else console.log(`no tick: ${result.why}`);
};

commands['review-queue'] = async (argv) => {
  if (argv[0] === 'handoff') return reviewQueueHandoff(argv.slice(1));
  const o = parseArgs(argv, { limit: 'str', 'min-score': 'str', json: 'bool' });
  const review = require('../review.js');
  const out = await review.reviewQueue({
    limit: o.limit ? parseInt(o.limit, 10) : undefined,
    minScore: o['min-score'] !== undefined ? parseInt(o['min-score'], 10) : undefined,
    gitState: review.gitState,
  });
  if (o.json) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`# keep review-queue  generated=${nowStamp()}  ranked=${out.ranked.length}/${out.total}`);
  if (out.sweepDue) console.log('# fleet sweep due today (no cross-workstream pass yet on ' + out.today + ')');
  for (const row of out.ranked) console.log(review.formatQueueLine(row));
  const skipped = Object.entries(out.skips).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
  // stderr, so a quiet tick still shows the reviewer looked rather than slept
  if (skipped.length) process.stderr.write(`skipped: ${skipped.join(', ')}\n`);
  if (!out.ranked.length) process.exit(3);
};

// `keep review-queue handoff <name>`: the instructions a console review queue launch
// wrote for its session (bin/review-queue.js writeHandoff), whose opening message
// names this command. A session on a pane-only node reaches it forwarded to the
// daemon, whose registry holds the file.
function reviewQueueHandoff(argv) {
  const { REVIEW_QUEUE_HANDOFF_NAME_RE } = require('../registry-commands.js');
  if (argv.length !== 1 || !REVIEW_QUEUE_HANDOFF_NAME_RE.test(argv[0])) {
    die('usage: keep review-queue handoff <name>   (the 24 hex digits the opening message gave)');
  }
  let text;
  try { text = require('../review-queue.js').readHandoff(ROOT, argv[0]); }
  catch (error) {
    if (error.status === 404) die(`${error.message}; it was written on the daemon node for one launch`);
    throw error;
  }
  process.stdout.write(text);
}

commands['review-note'] = async (argv) => {
  requireReviewerFromNode('review-note');
  const o = parseArgs(argv, { kind: 'str', subject: 'str', severity: 'str', 'suggest-status': 'str', bundle: 'str', force: 'bool', 'no-digest': 'bool', basis: 'str', evidence: 'str', checked: 'str', question: 'str', unknown: 'str' });
  const id = o._[0];
  if (!id || !o.m) die('usage: keep review-note <id> --kind <k> --subject <s> [--severity low|med|high] [--suggest-status s] [--force] -m "finding"');
  const out = await require('../review.js').reviewNote(id, {
    kind: o.kind,
    subject: o.subject,
    severity: o.severity,
    message: o.m,
    suggestStatus: o['suggest-status'],
    bundle: o.bundle,
    force: o.force,
    noDigest: o['no-digest'],
    basis: o.basis, evidence: o.evidence, checked: o.checked, question: o.question, unknown: o.unknown,
  });
  console.log(out.notApplied ? `finding ${out.key} on ${id} — not applied: ${out.notApplied}`
    : `recorded finding ${out.key} on ${id}${out.count > 1 ? ` (seen ${out.count}x)` : ''}`);
};

commands['review-idea'] = (argv) => {
  requireReviewerFromNode('review-idea');
  const o = parseArgs(argv, { project: 'str', cards: 'str', severity: 'str' });
  const title = o._.join(' ');
  if (!title.trim() || !o.m) {
    die('usage: keep review-idea "<title>" -m "<body>" [--project <p>] [--cards a,b,c] [--severity low|med]');
  }
  const cards = o.cards ? o.cards.split(',').map((id) => id.trim()).filter(Boolean) : [];
  const out = require('../review.js').reviewIdea(title, {
    message: o.m,
    project: o.project ? resolveProjectArg(o.project) : undefined,
    cards,
    severity: o.severity,
  });
  console.log(`proposed ${out.task.id}`);
};

commands['review-ack'] = (argv) => {
  requireReviewerFromNode('review-ack');
  const o = parseArgs(argv, { bundle: 'str', 'probe-safe': 'bool' });
  const id = o._[0];
  if (!id) die('usage: keep review-ack <id> [--bundle id] [-m "nothing to flag"]');
  require('../review.js').reviewAck(id, o.m, { bundle: o.bundle, probeSafe: o['probe-safe'] });
  console.log(`reviewed ${id}: no findings`);
};

commands['review-dismiss'] = (argv) => {
  requireReviewerFromNode('review-dismiss');
  const o = parseArgs(argv, {});
  const [id, key] = o._;
  if (!id || !key) die('usage: keep review-dismiss <id> <finding-key> [-m why]');
  require('../review.js').reviewDismiss(id, key, o.m);
  console.log(`dismissed ${key} on ${id} — it will not be raised again`);
};

commands['review-outcome'] = (argv) => {
  // Not the reviewer's: an outcome is Owner's or the working session's (review.js
  // recordFindingOutcome refuses the reviewer), so a node's forwarded one needs only
  // the session the route verified.
  const o = parseArgs(argv, { evidence: 'str', json: 'bool' });
  const [id, key, status] = o._;
  const review = require('../review.js');
  if (!key && !status) {
    const rows = review.findingOutcomes().filter(row => !id || row.card === id);
    if (o.json) console.log(JSON.stringify(rows, null, 2));
    else for (const row of rows) console.log(`${row.card}\t${row.key}\t${row.outcome.status}\t${row.subject}${row.outcome.evidence ? ` · ${row.outcome.evidence}` : ''}`);
    return;
  }
  if (!id || !key || !status || o._.length !== 3) die('usage: keep review-outcome [<card> [<key> <status> -m "reason" --evidence "reference"]] [--json]');
  const outcome = review.recordFindingOutcome(id, key, status, { message: o.m, evidence: o.evidence });
  console.log(o.json ? JSON.stringify(outcome, null, 2) : `${id}/${key}: ${outcome.status}`);
};

commands['review-replay'] = (argv) => {
  const o = parseArgs(argv, { since: 'str', session: 'str' });
  if (o._.length !== 1) die('usage: keep review-replay <card> [--since ISO-timestamp] [--session id]');
  console.log(JSON.stringify(require('../review-replay').replayCard(o._[0], o.since, o.session), null, 2));
};

commands['review-eval'] = async (argv) => {
  const o = parseArgs(argv, { run: 'bool', prompt: 'bool', predictions: 'str', suite: 'str', skill: 'str', model: 'str', compare: 'str', json: 'bool' });
  if (o._.length) die('usage: keep review-eval <--run|--prompt|--predictions file> [--model name] [--skill file] [--suite file] [--compare report.json] [--json]');
  console.log(await require('../review-eval').evaluate(o));
};

commands['review-land'] = async (argv) => {
  requireReviewerFromNode('review-land');
  const o = parseArgs(argv, { file: 'str' });
  if ((o.file && o._.length) || (!o.file && (o._.length !== 1 || o._[0] !== '-'))) {
    die('usage: keep review-land --file <path> or keep review-land -');
  }
  let raw;
  try {
    raw = o.file ? fs.readFileSync(path.resolve(o.file), 'utf8') : require('../stdin.js').readStdin({ isatty: () => false });
    // A stdin that is not open reads as null, which JSON.parse would take for `null`.
    if (raw === null) throw new Error('cannot read stdin');
  } catch (error) {
    const out = new KeepError('cannot read review-land input: ' + error.message);
    out.exitCode = 2;
    throw out;
  }
  let document;
  try { document = JSON.parse(raw); }
  catch (error) {
    const out = new KeepError('review-land input is not valid JSON: ' + error.message);
    out.exitCode = 2;
    throw out;
  }
  const out = await require('../review.js').reviewLand(document);
  console.log('type\titem\ttarget\tresult\tdetail');
  for (const result of out.results) {
    console.log([
      result.type, result.index + 1, result.target,
      result.ok ? 'ok' : 'failed', String(result.detail || '').replace(/[\r\n\t]+/g, ' '),
    ].join('\t'));
  }
  console.log(`summary\t${out.total}\t-\t${out.failed ? 'failed' : 'ok'}\t${out.failed} failed`);
  if (out.failed) process.exitCode = 1;
};

commands['review-bundle'] = async (argv) => {
  const opts = parseArgs(argv, { budget: 'str', 'total-budget': 'str', queue: 'bool', limit: 'str', session: 'str', from: 'str', raw: 'bool', force: 'bool' });
  const review = require('../review.js');
  if (opts.queue && opts._.length) die('keep review-bundle accepts either card ids or --queue, not both');
  if (!opts.queue && !opts._.length) die('usage: keep review-bundle <id> [<id>...] or keep review-bundle --queue [--limit N]');
  if ((opts.queue || opts._.length > 1) && (opts.session || opts.from !== undefined || opts.raw)) {
    die('--session, --from, and --raw are available only for a single card');
  }
  const tickLimit = parseInt(process.env.KEEP_REVIEW_TICK_LIMIT || '5', 10);
  const ids = opts.queue
    ? (await review.reviewQueue({
      limit: opts.limit ? parseInt(opts.limit, 10) : (Number.isFinite(tickLimit) && tickLimit > 0 ? tickLimit : 5),
      gitState: review.gitState,
    })).ranked.map((row) => row.task)
    : opts._;
  if (!opts.queue && ids.length === 1) {
    const out = review.buildBundle(ids[0], {
      budget: opts.budget ? parseInt(opts.budget, 10) : undefined,
      session: opts.session,
      from: opts.from !== undefined ? parseInt(opts.from, 10) : undefined,
      raw: opts.raw,
      force: opts.force,
    });
    console.log(out.md);
    return;
  }
  const out = review.buildBundles(ids, {
    budget: opts.budget ? parseInt(opts.budget, 10) : undefined,
    totalBudget: opts['total-budget'] ? parseInt(opts['total-budget'], 10) : undefined,
    force: opts.force,
  });
  console.log(out.md);
  if (!out.emitted) process.exit(3);
};

commands['review-stats'] = async (argv) => {
  const o = parseArgs(argv, { json: 'bool' });
  const review = require('../review.js');
  const stats = review.reviewStats();
  try {
    const usage = require('../usage.js');
    const accountApi = require('../accounts.js');
    usage.setCacheFile(path.join(ROOT, '.keep', 'usage-cache.json'));
    usage.getUsage();
    const authority = accountApi.authority(ROOT);
    const liveMarker = stats.markers.find((marker) => !marker.ended);
    const accountId = liveMarker && authority[liveMarker.id] && authority[liveMarker.id].accountId;
    const selected = (value) => accountId
      ? value.accounts && value.accounts[accountId]
      : accountApi.hasMultiple('claude') ? null : value.claude;
    for (let i = 0; i < 20 && !(selected(usage.getUsage()) || {}).fetchedAt; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const limits = (selected(usage.getUsage()) || {}).limits || [];
    stats.weekly = review.reviewerWeekly(limits, accountId);
  } catch {}
  if (o.json) { console.log(JSON.stringify(stats, null, 2)); return; }
  const fmt = (t) => t ? new Date(t).toLocaleString() : 'never';
  console.log('reviewer sessions:');
  if (!stats.markers.length) console.log('  (none registered - launch one with keep-reviewer)');
  for (const m of stats.markers) {
    console.log(`  ${m.id.slice(0, 8)}  ${m.name} (${m.model})  ${m.state}  registered ${fmt(m.registeredAt)}`);
  }
  if (stats.cadence) {
    const c = stats.cadence;
    console.log(`cadence        : ${c.mode}`
      + (c.mode === 'events'
        ? `  (drift wakes${c.watcher ? '' : ' — watcher off, so a fallback tick runs every ' + Math.round(c.tickIntervalMs / 60e3) + ' min'}`
          + `, sweep ${c.sweepAt || 'unset'}, next ${fmt(c.nextSweepAt)})`
        : `  (a tick every ${Math.round(c.tickIntervalMs / 60e3)} min)`));
    if (c.lastDriftWakeAt) console.log(`last drift wake: ${fmt(c.lastDriftWakeAt)}${c.lastDriftCard ? '  (' + c.lastDriftCard + ')' : ''}`);
  }
  console.log(`last tick sent : ${fmt(stats.lastTickAt)}${stats.lastTickTasks.length ? '  (' + stats.lastTickTasks.join(', ') + ')' : ''}`);
  if (stats.lastSkip) console.log(`last skip      : ${fmt(stats.lastSkip.at)}  (${stats.lastSkip.why})`);
  const days = Object.keys(stats.days).sort().slice(-3);
  for (const day of days) {
    const d = stats.days[day];
    console.log(`${day}: ticks ${d.ticks || 0} (${d.driftWakes || 0} drift), notes ${d.notes || 0}, ideas ${d.ideas || 0}, acks ${d.acks || 0}, statuses ${d.statuses || 0}, nudges ${d.nudges || 0}, compacts ${d.compacts || 0}`);
  }
  console.log(`findings on record: ${stats.findingsTotal} (${stats.dismissed} dismissed)`);
  console.log('finding outcomes: ' + Object.entries(stats.outcomes).map(([key, n]) => `${n} ${key}`).join(', '));
  if (stats.transcript) {
    const t = stats.transcript;
    const fmtTokens = (value) => value == null ? 'n/a' : value >= 1e6 ? (value / 1e6).toFixed(1) + 'M' : value >= 1e3 ? Math.round(value / 1e3) + 'k' : String(value);
    console.log(`session today   : ${t.assistantMessages} assistant messages / ${t.ticks} ticks (${t.assistantMessagesPerTick == null ? 'n/a' : t.assistantMessagesPerTick.toFixed(1)} msgs/tick, target ${t.targetMessagesPerTick || 3})`);
    if (t.lastTickAssistantMessages != null) console.log(`last tick cost  : ${t.lastTickAssistantMessages} msgs (target ${t.targetMessagesPerTick || 3})`);
    console.log(`context/message : median ${fmtTokens(t.medianContextTokens)}, p90 ${fmtTokens(t.p90ContextTokens)} (input + cache creation/read)`);
    console.log(`compactions     : ${t.compactionsToday} today`);
  }
  if (stats.usage) {
    const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
    const line = (u) => `${fmt(u.in + u.cc)} input + ${fmt(u.out)} out (+${fmt(u.cr)} cache reads, ${u.msgs} msgs)`;
    console.log(`usage today    : ${line(stats.usage.today)}`);
    console.log(`usage 7 days   : ${line(stats.usage.week)}${stats.usage.models.length ? '  [' + stats.usage.models.join(', ') + ']' : ''}`);
  }
  if (stats.weekly) {
    const w = stats.weekly;
    // same units as the "Fable wk N%" limit: percent of that weekly window consumed
    if (w.pointsOfModelWeek !== undefined) {
      console.log(`weekly window  : reviewer ~${w.pointsOfModelWeek.toFixed(1)}% of the ${w.modelLabel.replace(/ wk$/, '')} week (${w.modelPercent}% used in total)`);
    } else if (w.pointsOfWeek !== undefined) {
      console.log(`weekly window  : reviewer ~${w.pointsOfWeek.toFixed(1)}% of the week (${w.weekPercent}% used in total)`);
    }
    if (w.warming) console.log(`                 (still folding ${Math.round(w.backlogBytes / 1e6)}MB of transcript history - the estimate will settle)`);
    console.log('                 note: usage from other devices/cloud is not visible locally, so this reads slightly high');
  }
};

commands.nudge = async (argv) => {
  if (argv[0] === 'live' && !argv.includes('--session')) {
    const review = require('../review.js');
    const arg = argv[1];
    if (arg === 'off') review.setNudgesLive(false);
    else if (arg === 'on') review.setNudgesLive(true);
    else if (arg === 'contradictions') review.setNudgesLive(true, undefined, review.CONTRADICTION_KINDS);
    else if (arg) {
      const kinds = arg.split(',').map((kind) => kind.trim()).filter(Boolean);
      const unknown = kinds.filter((kind) => !review.FINDING_KINDS.includes(kind));
      if (unknown.length) die(`unknown finding kind${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}\nvalid: ${review.FINDING_KINDS.join(', ')}`);
      review.setNudgesLive(true, undefined, kinds);
    }
    return console.log(`nudges: ${review.describeNudgeConfig(review.loadNudgeConfig())}`);
  }
  const o = parseArgs(argv, { session: 'str', key: 'str', send: 'bool' });
  const id = o._[0];
  if (!id || !o.m) die('usage: keep nudge <id> --session <sid> --key <finding-key> -m "finding" [--send]\n(dry-run by default: prints the envelope and logs it to reviews/ without sending)');
  const out = await require('../review.js').nudge(id, {
    session: o.session,
    key: o.key,
    message: o.m,
    send: o.send,
  });
  if (out.sent) console.log(`nudged ${out.sessionId}`);
  else console.log(`DRY RUN - nothing sent. Envelope:\n${out.envelope}\n(re-run with --send to deliver)`);
};

module.exports = { commands, buildDigest, resolveReviewBudgetTarget };
