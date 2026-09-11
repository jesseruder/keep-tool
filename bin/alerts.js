'use strict';

// Keep alerts: deterministic routing/rate policy plus small best-effort channel
// adapters. Persistent state is local machine state under .keep/.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const DEFAULT_ROOT = process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
const DAY_MS = 86400e3;
const HOUR_MS = 3600e3;

function atMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function dayOf(value, timeZone) {
  const date = new Date(atMs(value));
  const pad = (number) => String(number).padStart(2, '0');
  if (timeZone) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function quietActive(info, now) {
  const until = info && info.quietUntil;
  if (!until) return false;
  const value = typeof until === 'number' ? until : Date.parse(until);
  return Number.isFinite(value) && value > atMs(now);
}

function route(level, info, now = Date.now()) {
  const state = info && info.state === 'present' ? 'present' : 'away';
  if (level === 'attention') {
    if (quietActive(info, now)) return { channels: [], deferred: true };
    return state === 'present'
      ? { channels: ['sound'], deferred: false }
      : { channels: ['push'], deferred: false };
  }
  if (level === 'urgent') {
    return { channels: ['push', 'speak'], deferred: false };
  }
  if (level === 'brief') {
    // The morning brief is push-only: a spoken fleet summary at 08:00 was more
    // startling than useful, and the speakers stay reserved for urgent alerts.
    return { channels: ['push'], deferred: false };
  }
  return { channels: [], deferred: true };
}

function envLimit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function alertDecision(meta, input) {
  const level = input.level;
  if (level === 'brief') return { ok: true, why: 'allowed' };
  const now = atMs(input.now);
  const key = String(input.key || '');
  const prior = key && meta && meta.keys && meta.keys[key];
  const dedupeMs = envLimit('KEEP_ALERT_DEDUPE_HOURS', 6) * HOUR_MS;
  if (prior && now - Number(prior.at || 0) < dedupeMs && !(prior.level === 'attention' && level === 'urgent')) {
    return { ok: false, why: `duplicate key within ${envLimit('KEEP_ALERT_DEDUPE_HOURS', 6)}h` };
  }

  const day = dayOf(now);
  const counts = meta && meta.days && meta.days[day] || {};
  const attentionMax = envLimit('KEEP_ALERT_ATTENTION_DAILY', 12);
  const urgentMax = envLimit('KEEP_ALERT_URGENT_DAILY', 4);
  if (level === 'attention' && Number(counts.attention || 0) >= attentionMax) {
    return { ok: false, why: `attention daily cap (${attentionMax})` };
  }
  if (level === 'urgent') {
    if (Number(counts.urgent || 0) >= urgentMax) return { ok: false, why: `urgent daily cap (${urgentMax})` };
    const gapMin = envLimit('KEEP_ALERT_URGENT_GAP_MIN', 30);
    if (meta && meta.lastUrgentAt && now - Number(meta.lastUrgentAt) < gapMin * 60e3) {
      return { ok: false, why: `urgent ${gapMin}-minute gap` };
    }
  }

  if (input.caller === 'reviewer') {
    const reviewer = counts.callers && counts.callers.reviewer || {};
    const limit = level === 'urgent'
      ? envLimit('KEEP_ALERT_REVIEWER_URGENT_DAILY', 2)
      : envLimit('KEEP_ALERT_REVIEWER_ATTENTION_DAILY', 5);
    if (Number(reviewer[level] || 0) >= limit) {
      return { ok: false, why: `reviewer ${level} daily budget (${limit})` };
    }
  }
  return { ok: true, why: 'allowed' };
}

function metaFile(root = DEFAULT_ROOT) { return path.join(root, '.keep', 'alerts-meta.json'); }
function ledgerFile(root = DEFAULT_ROOT) { return path.join(root, '.keep', 'alerts.jsonl'); }
function quietFile(root = DEFAULT_ROOT) { return path.join(root, '.keep', 'quiet.json'); }

function loadMeta(root = DEFAULT_ROOT) {
  try { return JSON.parse(fs.readFileSync(metaFile(root), 'utf8')) || {}; } catch { return {}; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function saveMeta(meta, root = DEFAULT_ROOT) {
  writeJsonAtomic(metaFile(root), meta);
  return meta;
}

function readQuiet(root = DEFAULT_ROOT) {
  try {
    const quiet = JSON.parse(fs.readFileSync(quietFile(root), 'utf8')) || {};
    return quiet.until || null;
  } catch { return null; }
}

function setQuiet(until, root = DEFAULT_ROOT) {
  if (!until) {
    try { fs.unlinkSync(quietFile(root)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return null;
  }
  writeJsonAtomic(quietFile(root), { until });
  return until;
}

function presence(options = {}) {
  const root = options.root || DEFAULT_ROOT;
  let idleSec = null;
  try {
    const output = execFileSync('ioreg', ['-c', 'IOHIDSystem'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = output.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    if (!match) throw new Error('HIDIdleTime missing');
    idleSec = Math.floor(Number(match[1]) / 1e9);
    if (!Number.isFinite(idleSec)) throw new Error('invalid HIDIdleTime');
  } catch { idleSec = null; }
  return {
    idleSec,
    state: idleSec !== null && idleSec < 300 ? 'present' : 'away',
    quietUntil: readQuiet(root),
  };
}

function appendAlert(entry, root = DEFAULT_ROOT) {
  const file = ledgerFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

function readAlerts(options = {}) {
  const root = options.root || DEFAULT_ROOT;
  let lines = [];
  try { lines = fs.readFileSync(ledgerFile(root), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch {}
  }
  const cutoff = options.all ? -Infinity : Number(options.since || Date.now() - DAY_MS);
  const filtered = entries.filter((entry) => Number(entry.at || 0) >= cutoff);
  return options.limit ? filtered.slice(-options.limit) : filtered;
}

function recordAccepted(meta, input) {
  const now = atMs(input.now);
  const day = dayOf(now);
  meta.days = meta.days || {};
  const counts = meta.days[day] = meta.days[day] || {};
  if (input.level === 'attention' || input.level === 'urgent') {
    counts[input.level] = Number(counts[input.level] || 0) + 1;
    if (input.caller === 'reviewer') {
      counts.callers = counts.callers || {};
      const reviewer = counts.callers.reviewer = counts.callers.reviewer || {};
      reviewer[input.level] = Number(reviewer[input.level] || 0) + 1;
    }
  }
  if (input.level === 'urgent') meta.lastUrgentAt = now;
  recordKey(meta, input);
  for (const oldDay of Object.keys(meta.days).sort().slice(0, -14)) delete meta.days[oldDay];
  return meta;
}

function recordKey(meta, input) {
  if (!input.key) return meta;
  const now = atMs(input.now);
  meta.keys = meta.keys || {};
  meta.keys[input.key] = { at: now, level: input.level };
  for (const [key, value] of Object.entries(meta.keys)) {
    if (now - Number(value && value.at || 0) > 7 * DAY_MS) delete meta.keys[key];
  }
  return meta;
}

function pushWebhook(root = DEFAULT_ROOT) {
  if (process.env.KEEP_PUSH_WEBHOOK) return process.env.KEEP_PUSH_WEBHOOK.trim();
  try { return fs.readFileSync(path.join(os.homedir(), '.config', 'keep', 'push-webhook'), 'utf8').trim(); }
  catch { return ''; }
}

function enabledChannels() {
  const setting = String(process.env.KEEP_ALERT_CHANNELS || '').trim().toLowerCase();
  if (!setting) return null;
  if (setting === 'none') return new Set();
  return new Set(setting.split(',').map((value) => value.trim()).filter(Boolean));
}

function availableChannels(channels, root = DEFAULT_ROOT) {
  // node --test propagates this to spawned fixture CLIs. Temporary registries
  // still share the real speakers/webhook unless native delivery is disabled.
  // Adapter tests can explicitly inject availableChannels and a fake deliver.
  if (process.env.NODE_TEST_CONTEXT) return [];
  const enabled = enabledChannels();
  return channels.filter((channel) => {
    if (enabled && !enabled.has(channel)) return false;
    if (channel === 'push') return Boolean(pushWebhook(root));
    if (channel === 'speak') return fs.existsSync(path.join(os.homedir(), 'bin', 'announce'));
    if (channel === 'sound') return fs.existsSync('/System/Library/Sounds/Pop.aiff');
    return false;
  });
}

function spawnOutcome(command, args, env, spawnImpl = spawn) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish('failed'), 3000);
    try {
      const child = spawnImpl(command, args, { detached: true, stdio: 'ignore', ...(env ? { env } : {}) });
      child.once('error', () => finish('failed'));
      child.once('exit', (code) => finish(code === 0 ? 'ok' : code === 3 && command.endsWith('/announce') ? 'suppressed' : 'failed'));
      child.unref();
    } catch { finish('failed'); }
  });
}

async function sendPush(text, root = DEFAULT_ROOT) {
  const url = pushWebhook(root);
  if (!url) return 'failed';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Keep', body: text }),
      signal: AbortSignal.timeout(3000),
    });
    return response.ok ? 'ok' : 'failed';
  } catch { return 'failed'; }
}

async function deliver(entry, options = {}) {
  const text = entry.level === 'brief' && options.spoken ? options.spoken : entry.text;
  const attempts = (entry.channels || []).map(async (channel) => {
    if (channel === 'push') return [channel, await sendPush(entry.text, options.root || DEFAULT_ROOT)];
    if (channel === 'speak') {
      const args = ['--from', 'Keep'];
      if (entry.level === 'urgent' && options.force) args.push('--force');
      args.push('--', text);
      return [channel, await spawnOutcome(path.join(os.homedir(), 'bin', 'announce'), args, undefined, options.spawn)];
    }
    if (channel === 'sound') {
      return [channel, await spawnOutcome('afplay', ['/System/Library/Sounds/Pop.aiff'], undefined, options.spawn)];
    }
    return [channel, 'failed'];
  });
  return Object.fromEntries(await Promise.all(attempts));
}

function stableKey(text) {
  return 'text:' + crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

async function sendAlert(options) {
  const root = options.root || DEFAULT_ROOT;
  const now = atMs(options.now == null ? Date.now() : options.now);
  const key = String(options.key || '');
  const from = String(options.from || 'manual');
  const caller = String(options.caller || 'manual');
  const text = String(options.text || '');
  const info = options.presence || presence({ root });
  const routing = route(options.level, info, now);
  if (options.dry) return { ok: true, dry: true, why: routing.deferred ? 'quiet' : 'allowed', ...routing, presence: info };

  const prepare = () => {
    const meta = loadMeta(root);
    const decision = alertDecision(meta, { level: options.level, key, caller, now });
    if (!decision.ok && decision.why.startsWith('duplicate')) return { ...decision, dropped: true };
    const briefDay = options.level === 'brief' ? dayOf(now) : '';
    if (briefDay && !options.allowBriefDuplicate && meta.lastBriefDay === briefDay) {
      const staleClaim = meta.lastBriefClaim && now - Number(meta.lastBriefClaimAt || 0) >= 10e3;
      if (!staleClaim) {
        return { ok: true, duplicate: true, why: 'brief already claimed', channels: [], deferred: false, presence: info };
      }
      delete meta.lastBriefDay;
      delete meta.lastBriefClaim;
      delete meta.lastBriefClaimAt;
    }
    const deferred = !decision.ok || routing.deferred;
    const channels = deferred ? [] : (options.availableChannels || availableChannels)(routing.channels, root);
    const entry = {
      id: `a-${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      at: now,
      level: options.level,
      key,
      text,
      from,
      caller,
      card: options.card || '',
      channels,
      deferred,
      // The desktop shell adds a visual banner; existing channels retain delivery.
      desktop: !deferred && info.state === 'present' && options.level !== 'brief'
        && (!enabledChannels() || enabledChannels().has('desktop')),
      presence: info,
      ...(!decision.ok ? { why: decision.why } : routing.deferred ? { why: 'quiet' } : {}),
    };
    if (decision.ok) recordAccepted(meta, { level: options.level, key, caller, now });
    else recordKey(meta, { level: options.level, key, now });
    if (decision.ok && briefDay && !options.allowBriefDuplicate) {
      meta.lastBriefDay = briefDay;
      meta.lastBriefClaim = entry.id;
      meta.lastBriefClaimAt = now;
    }
    saveMeta(meta, root);
    return { ...decision, entry, channels, deferred, presence: info };
  };
  const result = options.withLock ? options.withLock(prepare) : prepare();
  if (!result.entry) return result;
  const delivered = result.deferred ? {} : await (options.deliver || deliver)(result.entry, {
    root, force: options.force, spoken: options.spoken,
  });
  const deliveryOk = result.entry.desktop === true || Object.values(delivered).includes('ok');
  const entry = { ...result.entry, delivered, ...(!result.deferred && !deliveryOk ? { failed: true } : {}) };
  const finalize = () => {
    const meta = loadMeta(root);
    if (options.level === 'brief') {
      const briefDay = dayOf(now);
      if (deliveryOk) {
        meta.lastBriefAt = now;
        meta.lastBriefDay = briefDay;
        meta.lastBriefText = text;
        delete meta.lastBriefClaim;
        delete meta.lastBriefClaimAt;
      } else {
        meta.lastBriefAttemptAt = now;
        if (meta.lastBriefClaim === entry.id) {
          delete meta.lastBriefDay;
          delete meta.lastBriefClaim;
          delete meta.lastBriefClaimAt;
        }
      }
      saveMeta(meta, root);
    }
    appendAlert(entry, root);
  };
  if (options.withLock) options.withLock(finalize); else finalize();
  return { ...result, entry, delivered, deliveryOk };
}

function oneLine(value, limit = 140) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, Math.max(0, limit - 1)) + '…' : text;
}

function nonReviewLog(task) {
  const body = String(task && task.body || '');
  const headings = [...body.matchAll(/^## (.+)$/gm)];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index][1];
    if (!/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+—\s+/.test(heading)) continue;
    if (/(?:^|—\s*)review\s*\(/i.test(heading)) continue;
    const start = headings[index].index + headings[index][0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : body.length;
    const line = body.slice(start, end).split('\n').map((part) => part.trim()).find(Boolean);
    if (line) return oneLine(line, 100);
  }
  return '';
}

function countLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural || singular + 's'}`;
}

function buildBrief(input) {
  const now = atMs(input.now == null ? Date.now() : input.now);
  const lastBriefAt = Number(input.lastBriefAt || 0);
  const ideaCreatedAt = (task) => {
    const stamp = String(task.body || '').match(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) — created$/m)?.[1];
    return Date.parse(stamp ? stamp.replace(' ', 'T') : task.fm.created);
  };
  const ideas = (input.tasks || []).filter((task) => task.fm
    && (task.fm.tags || []).includes('reviewer-idea') && ['active', 'review'].includes(task.fm.status))
    .sort((a, b) => (ideaCreatedAt(b) || 0) - (ideaCreatedAt(a) || 0));
  const ideaCards = new Set(ideas);
  const reviewCards = (input.tasks || []).filter((task) => task.fm && task.fm.status === 'review' && !ideaCards.has(task))
    .sort((a, b) => String(a.fm.updated || a.fm.created || '').localeCompare(String(b.fm.updated || b.fm.created || '')));
  const allOpenQuestions = (input.questions || []).filter((question) => question && question.status === 'open' && !question.answer);
  // A `--jesse` question is an agent parked on a decision only he can make, so it
  // gets its own block above reviewer traffic: answering it restarts a session.
  const askedOfOwner = allOpenQuestions.filter((question) => ['owner', 'jesse'].includes(question.to))
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  const openQuestions = allOpenQuestions.filter((question) => !['owner', 'jesse'].includes(question.to));
  const answeredQuestions = (input.questions || []).filter((question) => {
    if (!question || question.status !== 'answered' || !question.answer) return false;
    const hasAskingSession = Boolean(question.from && question.from.sessionId);
    const delivered = Number(question.answerDelivery
      ? question.answerDelivery.deliveredAt || 0
      : hasAskingSession ? 0 : question.answeredAt || 0);
    return delivered > lastBriefAt;
  });
  const questionCount = openQuestions.length + answeredQuestions.length;
  const overdue = (input.tasks || []).filter((task) => {
    const due = task.fm && task.fm.check_after && Date.parse(task.fm.check_after);
    return task.fm && task.fm.status !== 'done' && Number.isFinite(due) && due <= now;
  }).sort((a, b) => String(a.fm.check_after).localeCompare(String(b.fm.check_after)));
  const deferred = (input.alerts || []).filter((alert) => alert && alert.deferred && Number(alert.at || 0) > lastBriefAt)
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  const findings = (input.findings || []).filter((finding) => finding && ['med', 'high'].includes(finding.severity)
    && Number(finding.at || 0) >= now - DAY_MS).sort((a, b) => Number(a.at || 0) - Number(b.at || 0)).slice(0, 6);
  const hygiene = (input.hygiene || []).filter((finding) => finding && finding.rule && finding.id);
  const holds = (input.holds || []).filter((hold) => hold && !hold.released && Date.parse(hold.until) > now);
  const needs = (input.tasks || []).flatMap((task) => task && task.fm && task.fm.status !== 'done' && Array.isArray(task.fm.needs)
    ? task.fm.needs.filter((need) => need && need.text).map((need) => ({ ...need, task: task.id })) : [])
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  const pendingSteps = (input.steps || []).flatMap((snapshot) => snapshot && Array.isArray(snapshot.steps)
    ? snapshot.steps.map((step) => ({ ...step, project: snapshot.project })) : [])
    .filter((step) => step && Array.isArray(step.pending) && step.pending.length);
  const unblocked = (input.unblocked || []).filter((record) => record && !record.deliveredAt);
  const daemonProblems = (input.health && input.health.schedulers || [])
    .filter((entry) => entry && ['failing', 'silent', 'never'].includes(entry.state))
    .sort((a, b) => ({ failing: 0, silent: 1, never: 2 }[a.state] - { failing: 0, silent: 1, never: 2 }[b.state]));
  const daemonProblem = daemonProblems[0];
  const daemonSince = daemonProblem && (daemonProblem.lastErrorAt || daemonProblem.lastRunAt
    || input.health.daemon && input.health.daemon.startedAt);
  const daemonLine = daemonProblem
    ? `Daemon: ${daemonProblem.name} ${daemonProblem.state} since ${daemonSince ? new Date(Number(daemonSince)).toLocaleString() : 'unknown'}`
      + ` (${oneLine(daemonProblem.lastError || 'no recent tick', 100)})${daemonProblems.length > 1 ? `; +${daemonProblems.length - 1} more` : ''}`
    : '';

  // Shadow decisions are the reviewer's judgment awaiting a verdict. They are
  // never urgent — nothing was sent — so they sit at the end of the header and
  // never win the spoken line.
  const shadow = (input.decisions || []).filter((entry) => entry && !entry.verdict)
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  const headerCounts = [
    countLabel(reviewCards.length, 'needs review', 'need review'),
    ...(askedOfOwner.length ? [countLabel(askedOfOwner.length, 'agent waiting on you', 'agents waiting on you')] : []),
    countLabel(questionCount, 'question'),
    ...(needs.length ? [countLabel(needs.length, 'need from you', 'needs from you')] : []),
    countLabel(overdue.length, 'overdue check'),
    countLabel(deferred.length, 'deferred alert'),
    countLabel(findings.length, 'finding'),
    countLabel(ideas.length, 'idea'),
    countLabel(unblocked.length, 'unreported unblock'),
    ...(shadow.length ? [countLabel(shadow.length, 'shadow decision')] : []),
  ];
  const sections = [];
  const add = (title, rows) => { if (rows.length) sections.push(`${title} (${rows.length})\n${rows.map((row) => `- ${row}`).join('\n')}`); };
  if (daemonLine) sections.push(daemonLine);
  add('Agents waiting on your answer', askedOfOwner.map((question) =>
    `${question.id} ${oneLine(question.task || question.about || '', 40)} — ${oneLine(question.question, 110)}`));
  add('Review', reviewCards.slice(0, 8).map((task) => `${oneLine(task.fm.title, 100)}${nonReviewLog(task) ? ` — ${nonReviewLog(task)}` : ''}`));
  add('Questions', [
    ...openQuestions.map((question) => oneLine(question.question, 140)),
    ...answeredQuestions.map((question) => `${oneLine(question.question, 90)} — answered: ${oneLine(question.answer, 90)}`),
  ]);
  add('Waiting on you', needs.map((need) => `${oneLine(need.task, 50)} — ${oneLine(need.text, 90)}${need.env ? ` [env ${oneLine(need.env, 30)}]` : ''}`));
  add('Overdue', overdue.map((task) => `${oneLine(task.fm.title, 110)} — ${task.fm.check_after}`));
  add('Deferred alerts', deferred.map((alert) => `${alert.level}: ${oneLine(alert.text, 130)}${alert.why ? ` (${oneLine(alert.why, 50)})` : ''}`));
  add('Reviewer findings', findings.map((finding) => `${finding.severity} ${oneLine(finding.card, 50)}: ${oneLine(finding.text || finding.kind, 100)}`));
  if (ideas.length) {
    const rows = ideas.slice(0, 10).map((task) => {
      const created = ideaCreatedAt(task);
      const age = Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / DAY_MS)) : 0;
      return `- ${oneLine(task.fm.title, 100)} — ${countLabel(age, 'day')} old`;
    });
    if (ideas.length > 10) rows.push(`- …and ${ideas.length - 10} more (keep list)`);
    sections.push(`Ideas awaiting a decision (${ideas.length})\n${rows.join('\n')}`);
  }
  if (hygiene.length) {
    const rows = hygiene.slice(0, 5).map((finding) =>
      `- ${finding.severity} ${oneLine(finding.rule, 40)} ${oneLine(finding.id, 55)} — ${oneLine(finding.text, 100)}`);
    if (hygiene.length > 5) rows.push(`- +${hygiene.length - 5} more — keep lint`);
    sections.push(`Hygiene: ${countLabel(hygiene.length, 'finding')}\n${rows.join('\n')}`);
  }
  add('Holds and pending steps', [
    ...holds.map((hold) => `hold ${oneLine(hold.project, 70)} until ${oneLine(hold.until, 25)} — ${oneLine(hold.reason, 70)}`),
    ...pendingSteps.map((step) => `step ${oneLine(step.project, 55)} / ${oneLine(step.title || step.name, 65)} — ${step.pending.length} pending commit${step.pending.length === 1 ? '' : 's'}`),
  ]);
  add('Unblocked, nobody told', unblocked.map((record) =>
    `${oneLine(record.dependent, 70)} — ${oneLine(record.upstream, 70)} is done${record.gaveUp ? ` (${oneLine(record.gaveUp, 30)})` : ''}`));
  add('Shadow decisions (nothing was sent)', shadow.slice(0, 6).map((entry) =>
    `${entry.id} ${oneLine(entry.type, 12)} ${oneLine(entry.card || '', 40)} — ${oneLine(entry.why, 90)}`));

  const header = `Keep brief — ${headerCounts.join(', ')}`;
  let text = [header, ...sections].join('\n\n');
  if (text.length > 1500) text = text.slice(0, 1499).replace(/\s+$/, '') + '…';
  const important = daemonLine || (findings.find((finding) => finding.severity === 'high')
    ? `High finding: ${oneLine(findings.find((finding) => finding.severity === 'high').kind, 100)}`
    : askedOfOwner[0] ? `Agent waiting on you: ${oneLine(askedOfOwner[0].question, 100)}`
    : overdue[0] ? `Overdue: ${oneLine(overdue[0].fm.title, 100)}`
      : openQuestions[0] ? `Question: ${oneLine(openQuestions[0].question, 100)}`
        : needs[0] ? `Waiting on you: ${oneLine(needs[0].text, 100)}`
        : reviewCards[0] ? `Review: ${oneLine(reviewCards[0].fm.title, 100)}`
          : deferred[0] ? `Deferred: ${oneLine(deferred[0].text, 100)}`
            : holds[0] ? `Hold: ${oneLine(holds[0].reason, 100)}`
              : pendingSteps[0] ? `Step: ${oneLine(pendingSteps[0].title || pendingSteps[0].name, 100)}`
                : unblocked[0] ? `Unblocked, nobody told: ${oneLine(unblocked[0].dependent, 100)}`
                  : hygiene[0] ? `Hygiene: ${oneLine(hygiene[0].rule, 50)} on ${oneLine(hygiene[0].id, 70)}` : 'Nothing needs attention.');
  let spoken = `${header}. ${important}`;
  if (spoken.length > 280) spoken = spoken.slice(0, 279).replace(/\s+$/, '') + '…';
  return { text, spoken };
}

function loadReviewFindings(root = DEFAULT_ROOT, now = Date.now()) {
  const findings = [];
  const reviewDir = path.join(root, 'reviews');
  let names = [];
  try { names = fs.readdirSync(reviewDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort(); } catch { return findings; }
  for (const name of names.slice(-2)) {
    const day = name.slice(0, 10);
    let text = '';
    try { text = fs.readFileSync(path.join(reviewDir, name), 'utf8'); } catch { continue; }
    const headers = [...text.matchAll(/^## (\d{2}:\d{2}) - (.+?)\s+\[([^\]]+)\]\s*$/gm)];
    for (let index = 0; index < headers.length; index += 1) {
      const match = headers[index];
      const severity = match[3].trim();
      if (!['med', 'high'].includes(severity)) continue;
      const at = Date.parse(`${day}T${match[1]}:00`);
      if (!Number.isFinite(at) || at < atMs(now) - DAY_MS) continue;
      const bodyStart = match.index + match[0].length;
      const bodyEnd = index + 1 < headers.length ? headers[index + 1].index : text.length;
      const kindLine = text.slice(bodyStart, bodyEnd).match(/^\*\*(.+?)\*\*(.*)$/m);
      const kind = kindLine ? kindLine[1].trim() : 'finding';
      const summary = kindLine ? oneLine(kindLine[0].replace(/\*\*/g, ''), 140) : kind;
      findings.push({ at, card: match[2].trim(), severity, kind, text: summary });
    }
  }
  return findings;
}

module.exports = {
  route,
  alertDecision,
  buildBrief,
  presence,
  loadMeta,
  saveMeta,
  readQuiet,
  setQuiet,
  appendAlert,
  readAlerts,
  sendAlert,
  deliver,
  loadReviewFindings,
  stableKey,
  dayOf,
  metaFile,
  ledgerFile,
  quietFile,
};
