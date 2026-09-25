#!/usr/bin/env node
// keep — a work registry. One markdown file per task in tasks/; YAML-ish
// frontmatter is machine state, body is an append-only log (newest first).
// All mutations: lock -> edit -> git commit -> background push outside agent sessions.

'use strict';
// keep-core runs require('./config').apply() as it loads, so it comes first.
const {
  ROOT, TASKS, ARCHIVE, META, HOLDS_DIR, STATUSES, OPEN_MESSAGE_LIMIT, LAUNCH_MODEL_RE, PI_MODEL_RE, OPEN_MESSAGE_ERROR,
  KINDS, CHECK_ON_PASS, MIN_CHECK_EVERY_MS, STATUS_ORDER, KeepError, color, nowStamp, relativeDurationMs,
  parseWhen, stampOf, parseTask, serializeTask, taskPath, loadTask, loadTaskAnywhere, loadAll, saveTask,
  recordDoneTransition, slugify, currentSession, delegationDependencies, currentDelegation, commandSession,
  resumeCommand, claimSession, releaseCardSession, linkLaunchedSession, relinkSessionNode, linkSession, isReviewerSession,
  countReviewerStatusChange, recordScheduler, clearScheduler, recordContribution, recordSession,
  warnSkippedSessionLink, parsePlan, renderPlan, setPlan, nextStep, demoteHeadings, appendLog,
  recordDaemonSessionClose, lastLogLine, withLock, git, commitAndPush, parseArgs, inAgentSession, die,
  cleanScalar, cleanExperimentId, canonicalCwd, inferProject, normalizeProjectPath, canonicalProjectPath,
  resolveProjectArg, writeJsonAtomic, activeHolds, holdFile, scopeForProject, fmtTask, isOverdue,
  parseDependency, dependencyTarget, dependencyReason, dependencyStep, deploymentFact, isDoneLogHeading,
  dependencyResolved, dependencyInfo, unresolvedDependencyIds, dependencyPath, dependencyError, cleanNext,
  cleanCommits, requestedWaits, logMessage, structuredFieldTips, cleanProbe, cleanCheckEvery,
  applyCheckPolicy, applyCardAgent, runDoneWhen, runProbe, checkinTask, postKeepApi, getKeepApi, openNeeds, addNeed,
  meetNeeds, sweepNeeds, formatNeed, projectMatchesCwd,
} = require('./keep-core.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const stepRegistry = require('./steps.js');
const allow = require('./allow.js');
const cardUsage = require('./card-usage.js');
const delegation = require('./delegation.js');
const features = require('./features.js');
const sessionNumbers = require('./session-numbers.js');
const { ref: sessionRef, named: sessionNamed } = sessionNumbers;
const { TELL_TEXT_LIMIT } = require('./tell.js');
const sessionNames = require('./session-names.js');
const sessionMarks = require('./session-marks.js');
const hookGroup = require('./commands/hook.js');
const hostGroup = require('./commands/host.js');
const nodesGroup = require('./commands/nodes.js');
const reviewGroup = require('./commands/review.js');
const stepGroup = require('./commands/step.js');
const turnsGroup = require('./commands/turns.js');
const watcherGroup = require('./commands/watcher.js');
const secretGroup = require('./commands/secret.js');
const {
  codexToolInput, codexExitCode, emptyStopEvidence, looksLikeGitWrite, scanStopEvidence,
  hasSubstantiveStopEvidence, newestTaskForSession, taskForSession, readCodexParent, redactCommand,
  deployCommand, deployEntry, stepMatchForInput, guardStepCommand, rawClaudeResume, guardResumeCommand,
  repairInvocations, repairAllowedCommand, guardRepairCommand, recordStepRun, recordDeploy, writePaneRecord,
  recordSessionPane, releaseSessionPane, registerReviewerSession, stopHook,
} = hookGroup;
const { resolveHostPane, renderHostPanes, parseHostSpawn } = hostGroup;
const { buildDigest, resolveReviewBudgetTarget } = reviewGroup;
const { stepUsage } = stepGroup;

// ---------- commands ----------

const commands = {};

const usageTokens = (u) => Number(u.input || 0) + Number(u.cacheRead || 0) + Number(u.cacheWrite || 0) + Number(u.output || 0);
commands.usage = (argv) => {
  const o = parseArgs(argv, { json: 'bool' });
  if (o._.length > 1) die('usage: keep usage [<card>] [--json]');
  const snapshot = cardUsage.snapshot(ROOT);
  // No card: the fleet view. Unassigned usage is invisible in every per-card table,
  // so this is the only place a gap in attribution shows up at all.
  if (!o._.length) {
    const cards = snapshot ? Object.values(snapshot.cards || {}) : [];
    const attributed = cards.reduce((sum, card) => sum + usageTokens(card), 0);
    if (o.json) {
      console.log(JSON.stringify(snapshot ? {
        since: snapshot.since, updatedAt: snapshot.updatedAt ?? null, pending: Boolean(snapshot.pending),
        issues: snapshot.issues || {}, cards: cards.length, attributed,
        unassigned: snapshot.unassigned || 0, unassignedTokens: snapshot.unassignedTokens || 0,
      } : null, null, 2));
      return;
    }
    if (!snapshot) { console.log('Model usage collection has not started.'); return; }
    console.log(`Fleet model usage (since ${new Date(snapshot.since).toISOString()})`);
    console.log(`Attributed: ${attributed} tokens across ${cards.length} card${cards.length === 1 ? '' : 's'}`);
    console.log(`Unassigned: ${snapshot.unassignedTokens || 0} tokens (${snapshot.unassigned || 0} events)`);
    console.log(`Collected: ${snapshot.updatedAt ? new Date(snapshot.updatedAt).toISOString() : 'never'}${snapshot.pending ? ' (catching up)' : ''}`);
    if (Object.keys(snapshot.issues || {}).length) console.log('Some transcript evidence is incomplete; see --json.');
    return;
  }
  const task = loadTaskAnywhere(o._[0]);
  if (!task) die(`unknown card: ${o._[0]}`);
  const summary = cardUsage.forCard(snapshot, task.id);
  if (o.json) { console.log(JSON.stringify(summary, null, 2)); return; }
  if (!summary) { console.log('Model usage collection has not started.'); return; }
  console.log(`Model usage for ${task.id} (since ${new Date(summary.since).toISOString()})`);
  console.log('Model | Uncached input | Cache read | Cache write | Output | Events');
  for (const [model, u] of Object.entries(summary.models)) {
    console.log(`${model} | ${u.input} | ${u.cacheRead} | ${u.cacheWrite} | ${u.output} | ${u.calls}`);
  }
  if (!summary.calls) console.log('No attributed usage yet.');
  if (summary.pending || Object.keys(summary.issues).length) console.log('Collection is catching up or has incomplete evidence; see --json.');
  console.log(`Unassigned across all cards: ${snapshot?.unassignedTokens || 0} tokens (${snapshot?.unassigned || 0} events)`);
};

function addTask({
  title, kind, tags, project, checkAfter, check, status, note, experimentId, force, beforeSave,
  onPass, checkEvery, probe, agent,
  withinLock = false, commit = true, linkSession = true, claim,
}) {
  title = cleanScalar(title, 'title');
  if (!title) die('a task needs a title');
  experimentId = cleanExperimentId(experimentId);
  cleanScalar(project, 'project');
  for (const t of tags || []) cleanScalar(t, 'tag');
  kind = kind || 'task';
  if (!KINDS.includes(kind)) die(`kind must be one of: ${KINDS.join(', ')}`);
  status = status || 'inbox';
  if (!STATUSES.includes(status)) die(`status must be one of: ${STATUSES.join(', ')}`);
  if (status === 'waiting' && !checkAfter) die('waiting needs --check-after or an unresolved depends_on entry');
  if (kind === 'experiment' && !checkAfter) die('experiments need --check-after (that\'s the point)');

  // near-miss tag warning
  const existing = new Set();
  for (const t of loadAll(true)) (t.fm.tags || []).forEach((x) => existing.add(x));
  for (const tag of tags || []) {
    if (existing.has(tag)) continue;
    for (const e of existing) {
      if (near(tag, e)) process.stderr.write(`keep: note — new tag "${tag}" is close to existing "${e}"\n`);
    }
  }

  project = inferProject(project);
  tags = tags || [];
  if (!require('./preferences').scopes().names.some((name) => tags.includes(name))) {
    tags.push(scopeForProject(project) || require('./preferences').scopes().default);
    if (!project) {
      process.stderr.write(`keep: no project — defaulting to #${require('./preferences').scopes().default} (pass --tag to override)\n`);
    }
  }

  const create = () => {
    const id = slugify(title);
    const task = {
      id,
      fm: {
        title, status, kind,
        experiment_id: experimentId,
        tags,
        project,
        check_after: parseWhen(checkAfter),
        check: check || '',
        sessions: [],
        created: nowStamp().slice(0, 10),
      },
      body: '',
    };
    if (probe !== undefined) {
      const cleaned = cleanProbe(probe);
      if (cleaned) task.fm.probe = cleaned;
    }
    applyCheckPolicy(task, { onPass, checkEvery });
    applyCardAgent(task, agent);
    // Session participation and ownership are separate. Internal daemon/reviewer
    // callers use linkSession:false to suppress both. A user-filed card still
    // records who created or scheduled it without moving that session's card link.
    const shouldClaim = claim === undefined ? kind !== 'idea' : Boolean(claim);
    const sessionResult = linkSession
      ? (shouldClaim ? recordSession(task) : recordContribution(task))
      : null;
    if (linkSession && (checkAfter || check || probe)) recordScheduler(task);
    if (beforeSave) beforeSave(task);
    const filingSession = !shouldClaim && sessionResult && sessionResult.session;
    if (note || filingSession) appendLog(task, 'created', note || 'Filed for later.', filingSession);
    saveTask(task);
    if (shouldClaim) warnSkippedSessionLink(task, sessionResult, 'card created');
    if (commit) commitAndPush(`keep: add ${id}`);
    return task;
  };
  return withinLock ? create() : withLock(create);
}

// The Claude session that started this Codex worker, from the durable record the
// codex SessionStart hook writes, else the ambient id a Codex sub-session inherits.
function parentClaudeSession(session) {
  if (!session || session.agent !== 'codex') return null;
  const record = readCodexParent(ROOT, session.id);
  if (record && record.agent === 'claude' && record.parent) return record.parent;
  return process.env.CLAUDE_CODE_SESSION_ID || null;
}

// The open card this Codex session's parent Claude session owns, or null.
function shadowOwner() {
  const parentId = parentClaudeSession(currentSession());
  if (!parentId) return null;
  const owned = taskForSession(parentId);
  return owned ? { parentId, owned } : null;
}

commands.add = (argv) => {
  const o = parseArgs(argv, { kind: 'str', tag: 'list', project: 'str', 'check-after': 'str', check: 'str', 'on-pass': 'str', 'check-every': 'str', probe: 'str', agent: 'str', status: 'str', 'experiment-id': 'str', plan: 'many', 'done-when': 'list', allow: 'list', until: 'str', autonomous: 'bool', file: 'bool', claim: 'bool', force: 'bool', 'as-owner': 'bool' });
  const title = o._.join(' ');
  if (!title.trim()) die('usage: keep add "title" [--kind k] [--file|--claim] [--tag t] [--project p] [--plan "step" …] [--done-when "cmd"]… [--allow a,b] [--until when] [--autonomous] [--experiment-id id] [--check-after when] [--check "recipe"] [--on-pass done|rearm|review] [--check-every +7d] [--probe "cmd"] [--status s] [--force] [--as-owner] [-m note]');
  // Creating a card with grants is granting. Gated exactly like `keep allow
  // --grant`, or the refusal there would be one `keep add --allow` away.
  if ((o.allow || o.until) && inAgentSession() && !(o['as-owner'] && process.env.KEEP_OWNER === '1' && !process.env.KEEP_REMOTE_CALLER)) {
    die('only Owner grants. Create the card without --allow/--until and ask him for "keep allow <card> --grant …". '
      + 'If Owner is running this himself from an agent session, pass --as-owner with KEEP_OWNER=1 in the environment.');
  }
  if (o.file && o.claim) die('--file and --claim are mutually exclusive');
  const filesOnly = o.file || (!o.claim && o.kind === 'idea');
  let assigned = { kind: 'none' };
  if (!filesOnly) {
    assigned = currentDelegation();
    if (['active', 'stale', 'pending', 'invalid', 'identity-mismatch'].includes(assigned.kind)) {
      die(`${delegation.describe(assigned)} To start independent work deliberately, end the delegation or file it with --file.`);
    }
  }
  // Explicit `keep delegate` already stops a worker from opening its own card, but
  // it is opt-in and parents forget. Nine top-level cards in two days shadowed a
  // plan step of the card their parent Claude session owned, so the same refusal
  // fires on the implicit relationship the codex SessionStart hook recorded.
  // `keep delegate --end` is the documented way to start independent work, so an
  // explicitly ended delegation passes too: the codex-parents record outlives the end.
  const shadow = filesOnly ? null : shadowOwner();
  const endedDelegation = assigned.kind === 'ended' && assigned.explicit;
  if (shadow && !o.force && !endedDelegation) {
    die(`this Codex session was started by claude ${sessionRef(shadow.parentId)}, which owns ${shadow.owned.id} ("${shadow.owned.fm.title}").\n`
      + `  Contribute there with keep checkin ${shadow.owned.id} -m "..." (no claim needed), or have the parent register the step with keep delegate ${shadow.owned.id} --step <n> --prepare.\n`
      + '  File deliberately independent work with --file, or pass --force to create a top-level card anyway.');
  }
  // A card that passed deliberately must not look abandoned: the lint rule flags a
  // worker's card with no log entries, so record the decision as its created entry.
  const forcedNote = shadow && !o.m
    ? `Created ${o.force ? 'with --force' : 'after an explicitly ended delegation'} as independent of ${shadow.owned.id}, the card this worker's parent claude ${sessionRef(shadow.parentId)} owns.`
    : undefined;
  const plan = splitPlanValues(o.plan || []).map((text) => ({ text: cleanPlanText(text), state: 'todo' }));
  applyDoneWhen(plan, o['done-when']);
  let grants = [];
  try { grants = o.allow ? allow.parseGrants(o.allow) : []; }
  catch (error) { if (error instanceof allow.AllowError) die(error.message); throw error; }
  if (o.until && !grants.length) die('--until needs --allow: it bounds the grants, and there are none');
  // The whole point of the flag is that Owner is handing the card off. Refusing
  // here is what makes "autonomous" mean something: a card with no steps has
  // nothing for the Stop hook to continue, and a card with no grants stops on
  // the first action anyway — which is the state 20 of 22 active cards were in.
  if (o.autonomous) {
    if (!plan.length) die('--autonomous needs --plan: without steps the Stop hook has nothing to continue');
    if (!grants.length) die('--autonomous needs --allow: without grants every action still stops for Owner');
  }
  const task = addTask({
    // Canonicalize like review-idea does: a bare name stored raw resolves against
    // whichever cwd later reads the card, so runs, `keep who`, and the session-start
    // hook all miss it. Refuse an unresolvable name rather than store it.
    title, kind: o.kind, tags: o.tag, project: o.project ? resolveProjectArg(o.project) : undefined,
    checkAfter: o['check-after'], check: o.check, status: o.status, note: o.m || forcedNote,
    onPass: o['on-pass'], checkEvery: o['check-every'], probe: o.probe, agent: o.agent,
    experimentId: o['experiment-id'], force: o.force,
    claim: o.claim ? true : o.file ? false : undefined,
    beforeSave: (created) => {
      if (plan.length) setPlan(created, plan);
      if (grants.length) created.fm.allow = grants.map(allow.formatToken);
      if (o.until) created.fm.allow_until = parseWhen(o.until);
      if (o.autonomous) created.fm.autonomous = 'yes';
    },
  });
  console.log(fmtTask(task));
  if (grants.length) console.log(`  allows: ${formatAllow(task)}`);
};

function cleanPlanText(value) {
  const text = cleanScalar(value, 'plan step');
  if (!text) die('plan steps cannot be empty');
  return text;
}

// A step's acceptance criterion: the shell command that decides whether it
// really finished. Steps are free text, so before this nothing but the agent's
// own optimism stood between "I think I did it" and the plan advancing.
function cleanDoneWhen(value) {
  const text = cleanScalar(value, 'done-when');
  if (!text) die('a done-when command cannot be empty');
  if (text.length > 400) die('a done-when command must be at most 400 characters');
  return text;
}


// `--done-when` is positional against `--plan`: the nth one belongs to the nth
// step. An empty value ('') clears the criterion on that step.
function applyDoneWhen(steps, values) {
  if (!values || !values.length) return steps;
  if (values.length > steps.length) {
    die(`--done-when given ${values.length} time(s) but the plan has ${steps.length} step(s)`);
  }
  values.forEach((value, index) => {
    if (String(value).trim() === '') { delete steps[index].doneWhen; return; }
    steps[index].doneWhen = cleanDoneWhen(value);
  });
  return steps;
}


function splitPlanValues(values) {
  return values.flatMap((value) => {
    const parts = String(value).split(/\r?\n|\\n/).map((part) => part.trim()).filter(Boolean);
    if (!parts.length) die('plan steps cannot be empty');
    if (parts.length <= 1) return parts;
    return parts.map((part) => part.replace(/^\d+[.)]\s*/, '').trim());
  });
}

function planMark(state) {
  return state === 'doing' ? '~' : state === 'done' ? 'x' : ' ';
}

function printPlan(task) {
  const { steps } = parsePlan(task.body);
  if (!steps.length) console.log('(no plan)');
  for (const step of steps) {
    console.log(`${step.n}. [${planMark(step.state)}] ${step.text}`);
    if (step.doneWhen) console.log(`     done-when: ${step.doneWhen}`);
  }
  const next = nextStep(task);
  console.log(next ? `next: step ${next.n}/${steps.length} — ${next.text}` : 'next: none');
  if (next && next.doneWhen) console.log(`      it is done when: ${next.doneWhen}`);
}

commands.plan = (argv) => {
  const o = parseArgs(argv, { set: 'many', add: 'str', insert: 'str', remove: 'str', done: 'str', start: 'str', undo: 'str', 'done-when': 'list', verify: 'str' });
  const id = o._[0];
  if (!id) die('usage: keep plan <id> [--set "step" … [--done-when "cmd"]… | --add "text" [--done-when "cmd"] | --insert <n> "text" | --remove <n> | --done <n> | --start <n> | --undo <n> | --done-when <n> "cmd" | --verify <n|next>]');
  const operations = ['set', 'add', 'insert', 'remove', 'done', 'start', 'undo'].filter((name) => o[name] !== undefined);
  if (operations.length > 1) die('keep plan accepts one mutation at a time');

  // `keep plan <id> --verify <n>` runs a step's criterion without changing it:
  // the way an agent checks its own work before claiming the step.
  if (o.verify !== undefined) {
    if (operations.length) die('--verify does not combine with a plan mutation');
    if (process.env.KEEP_DONE_WHEN === '1') {
      die('a done-when criterion cannot run keep plan --verify — that is the command already running it');
    }
    const task = loadTask(id);
    const step = o.verify === 'next' ? nextStep(task) : parsePlan(task.body).steps[Number(o.verify) - 1];
    if (!step) die(o.verify === 'next' ? 'the plan has no doing or todo step' : `step ${o.verify} does not exist`);
    if (!step.doneWhen) die(`step ${step.n} has no done-when — set one with keep plan ${id} --done-when ${step.n} "<command>"`);
    const result = runDoneWhen(step.doneWhen, task.fm.project);
    console.log(`step ${step.n}: ${step.doneWhen}`);
    if (result.output) console.log(result.output);
    console.log(result.ok ? `done-when passed (${result.ms}ms)` : `done-when FAILED (exit ${result.code}${result.timedOut ? ', timed out' : ''})`);
    if (!result.ok) process.exitCode = 3;
    return;
  }

  // Setting one step's criterion, without touching the steps themselves.
  if (!operations.length && o['done-when']) {
    if (o['done-when'].length !== 1 || o._.length !== 2) die(`usage: keep plan ${id} --done-when <n> "<command>"`);
    return withLock(() => {
      const task = loadTask(id);
      const parsed = parsePlan(task.body);
      const position = /^\d+$/.test(String(o._[1])) ? Number(o._[1]) : NaN;
      if (!Number.isFinite(position) || position < 1 || position > parsed.steps.length) {
        die(`usage: keep plan ${id} --done-when <n> "<command>" (plan has ${parsed.steps.length} step${parsed.steps.length === 1 ? '' : 's'})`);
      }
      const steps = parsed.steps.map(({ text, state, doneWhen }) => ({ text, state, doneWhen }));
      const value = String(o['done-when'][0]);
      if (value.trim() === '') delete steps[position - 1].doneWhen;
      else steps[position - 1].doneWhen = cleanDoneWhen(value);
      setPlan(task, steps);
      recordContribution(task);
      saveTask(task);
      commitAndPush(`keep: plan ${id}`);
      printPlan(task);
    });
  }
  if (!operations.length) return printPlan(loadTask(id));

  withLock(() => {
    const task = loadTask(id);
    const parsed = parsePlan(task.body);
    if (parsed.present && !parsed.valid) {
      die('the card has a Plan heading but no valid checklist steps; fix the existing Plan block before mutating it');
    }
    let steps = parsed.steps.map(({ text, state, doneWhen }) => ({ text, state, doneWhen }));
    const operation = operations[0];
    let changedStep = null;
    const numbered = (value) => {
      if (!/^\d+$/.test(String(value || ''))) die(`${operation} needs a positive step number`);
      const n = Number(value);
      if (n < 1 || n > steps.length) die(`step ${n} does not exist (plan has ${steps.length})`);
      return n;
    };

    if (operation === 'set') {
      const statesByText = new Map();
      for (const step of steps) {
        const states = statesByText.get(step.text) || [];
        states.push({ state: step.state, doneWhen: step.doneWhen });
        statesByText.set(step.text, states);
      }
      steps = splitPlanValues(o.set).map((text) => {
        text = cleanPlanText(text);
        const states = statesByText.get(text);
        const prior = states && states.length ? states.shift() : null;
        return { text, state: prior ? prior.state : 'todo', doneWhen: prior ? prior.doneWhen : undefined };
      });
      applyDoneWhen(steps, o['done-when']);
    } else if (operation === 'add') {
      const added = splitPlanValues([o.add]).map((text) => ({ text: cleanPlanText(text), state: 'todo' }));
      applyDoneWhen(added, o['done-when']);
      steps.push(...added);
    } else if (operation === 'insert') {
      if (o._.length !== 2) die('usage: keep plan <id> --insert <n> "text"');
      const n = Number(o.insert);
      if (!/^\d+$/.test(String(o.insert)) || n < 1 || n > steps.length + 1) {
        die(`insert position must be between 1 and ${steps.length + 1}`);
      }
      const inserted = splitPlanValues([o._[1]]);
      if (inserted.length > 1) die('--insert takes one step; use --add or --set for several');
      steps.splice(n - 1, 0, { text: cleanPlanText(inserted[0]), state: 'todo' });
    } else {
      const n = numbered(o[operation]);
      changedStep = { n, text: steps[n - 1].text };
      if (operation === 'remove') steps.splice(n - 1, 1);
      if (operation === 'done') steps[n - 1].state = 'done';
      if (operation === 'start') {
        steps = steps.map((step, index) => ({ ...step, state: index === n - 1 ? 'doing' : step.state === 'doing' ? 'todo' : step.state }));
      }
      if (operation === 'undo') steps[n - 1].state = 'todo';
    }

    setPlan(task, steps);
    const contribution = recordContribution(task);
    if (changedStep && (operation === 'done' || operation === 'start')) {
      appendLog(task, 'plan', `plan → step ${changedStep.n} ${operation === 'done' ? 'done' : 'started'}: ${changedStep.text}`,
        contribution.session);
    }
    saveTask(task);
    commitAndPush(`keep: plan ${id}`);
    printPlan(task);
  });
};

function near(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return false;
  // one edit apart, cheap check
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}



const CHECKIN_FLAGS = { status: 'str', 'check-after': 'str', 'clear-check-after': 'bool', check: 'str', 'on-pass': 'str', 'check-every': 'str', probe: 'str', agent: 'str', 'experiment-id': 'str', step: 'str', force: 'bool', next: 'str', commit: 'list', handoff: 'str', attach: 'list' };
const CHECKIN_USAGE = 'usage: keep checkin <id> -m "state + next step" [--attach <file>]... [--next "text"] [--commit sha]... [--step <n|next>] [--status s] [--experiment-id id] [--check-after when] [--check "recipe"] [--on-pass done|rearm|review] [--check-every +7d] [--probe "cmd"] [--agent <name>] [--clear-check-after] [--handoff waiting|needs-input] [--force]';

// A check-in's message with the names its --attach files were stored under, so the
// log says what it showed; the card's artifacts are what the console displays.
function withAttached(message, names) {
  return names.length ? `${message}\nAttached: ${names.join(', ')}` : message;
}

commands.checkin = (argv) => {
  const o = parseArgs(argv, CHECKIN_FLAGS);
  const id = o._[0];
  if (!id || !o.m || !o.m.trim()) die(CHECKIN_USAGE);
  const next = cleanNext(o.next);
  const commits = cleanCommits(o.commit);
  // Stored first, the way `keep artifact` would, so the check-in can name them. A
  // check-in refused after this leaves them stored; a resend stores an unchanged file
  // again only when its name was already taken by other content (a timestamped copy).
  const attached = o.attach ? commands.artifact([id, '--', ...o.attach], { quiet: true }) : [];
  const task = checkinTask(id, {
    message: withAttached(o.m, attached.map((result) => path.basename(result.destination))), status: o.status, checkAfter: o['check-after'],
    clearCheckAfter: o['clear-check-after'], check: o.check, experimentId: o['experiment-id'],
    onPass: o['on-pass'], checkEvery: o['check-every'], probe: o.probe, agent: o.agent,
    step: o.step, force: o.force, next, commits, handoff: o.handoff,
  });
  structuredFieldTips(o.m, next, commits);
  console.log(fmtTask(task));
  if (!o.status) {
    console.log(`  status unchanged: ${task.fm.status} — pass --status if that's stale (review/waiting hold "Needs you" real estate)`);
  }
};

commands.retitle = (argv) => {
  const id = argv[0];
  const title = cleanScalar(argv.slice(1).join(' '), 'title');
  if (!id || !title) die('usage: keep retitle <id> "new title"');
  withLock(() => {
    const task = loadTask(id);
    const oldTitle = task.fm.title;
    task.fm.title = title;
    const contribution = recordContribution(task);
    appendLog(task, 'retitled', `Title changed from "${oldTitle}" to "${title}".`, contribution.session);
    saveTask(task);
    commitAndPush(`keep: retitle ${id}`);
    console.log(fmtTask(task, { brief: true }));
  });
};

// The session a per-session command acts on: `#n` or an id when one was named,
// otherwise the session this command is running inside. Shared by `keep rename`
// and `keep mark` so both resolve a target the same way.
function resolveSessionByNumberOrId(sessionArg, options = {}) {
  const root = options.root || ROOT;
  if (sessionArg != null) {
    const found = sessionNumbers.lookup(sessionArg, { root });
    if (found) return { sessionId: found.id, num: found.num };
    // A token that reads as a number and is not in the registry names nothing;
    // only an id-shaped token is taken at face value (the daemon may know a
    // session this checkout's registry has not numbered).
    const number = sessionNumbers.parseNumber(sessionArg);
    if (number) die(`no session ${sessionNumbers.label(number)}`);
    if (!/^[A-Za-z0-9_-]+$/.test(sessionArg)) die('bad session id');
    return { sessionId: sessionArg, num: null };
  }
  const self = (options.currentSession || currentSession)();
  if (!self || !self.id) die(options.noCurrent || 'no current session: run inside a Claude or Codex session, or name one');
  return { sessionId: self.id, num: sessionNumbers.lookup(self.id, { root })?.num || null };
}

// Names a session by hand, the way the console's rename does: the name replaces
// the generated title and switches generation off until it is cleared. The daemon
// owns the registry while it runs, so the rename goes through its route and the
// console updates at once; a daemon that is down is not a reason to refuse, so the
// CLI writes the registry itself and says the console will catch up.
commands.rename = async (argv, deps = {}) => {
  const o = parseArgs(argv, { clear: 'bool' });
  const usage = 'usage: keep rename [<#n|session-id>] "new title" | keep rename [<#n|session-id>] --clear';
  if (o.clear ? o._.length > 1 : o._.length < 1 || o._.length > 2) die(usage);
  const root = deps.root || ROOT;

  const sessionArg = o.clear ? (o._.length ? o._[0] : null) : (o._.length === 2 ? o._[0] : null);
  const { sessionId, num } = resolveSessionByNumberOrId(sessionArg, {
    root,
    currentSession: deps.currentSession || currentSession,
    noCurrent: 'no current session: run inside a Claude or Codex session, or name one: keep rename <#n|session-id> "title"',
  });

  const title = o.clear ? '' : sessionNames.sanitize(o._[o._.length - 1]);
  if (!o.clear && !title) die('title is empty (use --clear to hand the session back to automatic titles)');

  let response = null;
  let unreachable = null;
  try { response = await (deps.postKeepApi || postKeepApi)('/api/rename-session', { sessionId, title }, 10000); }
  catch (error) {
    // Only a refused connection means nobody owns the registry. A timeout or a
    // reset may have reached a daemon that then wrote the file; writing it again
    // here would race that write.
    if (error && error.code === 'ECONNREFUSED') unreachable = error;
    else die(`keep serve did not answer (${error && error.message || error}); try again`);
  }
  if (unreachable) {
    try { sessionNames.set(sessionId, title, { root }); }
    catch (error) { die('cannot write the session-name registry: ' + error.message); }
  } else if (response.status !== 200) {
    let result = {};
    try { result = JSON.parse(response.data); } catch {}
    die(result.error || `keep serve returned an unexpected response (${response.status})`);
  }

  const stdout = deps.stdout || console.log;
  const named = num ? `${sessionNumbers.label(num)} (${sessionId})` : String(sessionId);
  stdout(o.clear ? `cleared ${named}: automatic titles again` : `renamed ${named}: "${title}"`);
  if (unreachable) stdout("keep serve isn't running; written to the registry, the console picks it up when the daemon starts");
};

// What `keep mark` prints when the daemon answered without echoing the mark:
// the same merge sessionMarks.set does, over whatever this checkout can read.
function mergeMarkForDisplay(sessionId, patch, root) {
  let current = {};
  try { current = sessionMarks.lookup(sessionId, { root }) || {}; } catch {}
  const next = { ...current };
  for (const field of ['color', 'emoji']) {
    if (patch[field] === undefined) continue;
    if (patch[field]) next[field] = patch[field];
    else delete next[field];
  }
  return next.color || next.emoji ? next : null;
}

// Marks a session with a color, an emoji, or both: decoration Owner (or an agent
// he asked) puts on a session so it is findable in a long console list. Nothing
// assigns a mark automatically, and a mark is independent of the session's name.
// Routed through the daemon, which is the single writer for this registry. An
// offline read/modify/write could lose another session's pin during daemon startup.
commands.mark = async (argv, deps = {}) => {
  const o = parseArgs(argv, {
    emoji: 'str', color: 'str', 'no-emoji': 'bool', 'no-color': 'bool', clear: 'bool', colors: 'bool',
  });
  const usage = 'usage: keep mark [<#n|session-id>] --emoji <e> | --color <name> | --no-emoji | --no-color | --clear'
    + '\n       keep mark --colors';
  const stdout = deps.stdout || console.log;
  const root = deps.root || ROOT;

  if (o.colors) {
    for (const color of sessionMarks.PALETTE) stdout(color);
    return;
  }

  const setting = o.emoji !== undefined || o.color !== undefined || o['no-emoji'] || o['no-color'];
  if (!setting && !o.clear) die(usage);
  // --clear says "no mark at all"; pairing it with a value, or asking to set and
  // remove the same half at once, is a typo rather than an order to guess at.
  if (o.clear && setting) die(usage);
  if (o.emoji !== undefined && o['no-emoji']) die(usage);
  if (o.color !== undefined && o['no-color']) die(usage);
  if (o._.length > 1) die(usage);

  // Checked here as well as in the daemon so a typo costs a message, not a round trip.
  let emoji = null;
  if (o.emoji !== undefined) {
    emoji = sessionMarks.normalizeEmoji(o.emoji);
    if (!emoji) die(`not an emoji: "${o.emoji}"`);
  }
  let color = null;
  if (o.color !== undefined) {
    color = sessionMarks.normalizeColor(o.color);
    if (!color) die(`not a palette color: "${o.color}" (keep mark --colors)`);
  }

  const { sessionId, num } = resolveSessionByNumberOrId(o._.length ? o._[0] : null, {
    root,
    currentSession: deps.currentSession || currentSession,
    noCurrent: 'no current session: run inside a Claude or Codex session, or name one: keep mark <#n|session-id> --emoji 🔥',
  });

  const patch = {};
  if (o.clear) {
    patch.color = null;
    patch.emoji = null;
  } else {
    if (emoji) patch.emoji = emoji;
    else if (o['no-emoji']) patch.emoji = null;
    if (color) patch.color = color;
    else if (o['no-color']) patch.color = null;
  }

  let response = null;
  let unreachable = null;
  try { response = await (deps.postKeepApi || postKeepApi)('/api/mark-session', { sessionId, ...patch }, 10000); }
  catch (error) {
    // Only a refused connection means nobody owns the registry. A timeout or a
    // reset may have reached a daemon that then wrote the file; writing it again
    // here would race that write.
    if (error && error.code === 'ECONNREFUSED') unreachable = error;
    else die(`keep serve did not answer (${error && error.message || error}); try again`);
  }
  let mark = null;
  if (unreachable) {
    try { ({ mark } = sessionMarks.set(sessionId, patch, { root })); }
    catch (error) { die('cannot write the session-mark registry: ' + error.message); }
  } else if (response.status !== 200) {
    let result = {};
    try { result = JSON.parse(response.data); } catch {}
    die(result.error || `keep serve returned an unexpected response (${response.status})`);
  } else {
    let result = {};
    try { result = JSON.parse(response.data); } catch {}
    // The daemon owns the merge, so its answer is what the mark now is; an answer
    // that does not carry one is merged here rather than printed as "no mark".
    mark = result.mark !== undefined ? result.mark : mergeMarkForDisplay(sessionId, patch, root);
  }

  const named = num ? `${sessionNumbers.label(num)} (${sessionId})` : String(sessionId);
  const shown = mark ? [mark.emoji, mark.color].filter(Boolean).join(' ') : '';
  stdout(shown ? `marked ${named}: ${shown}` : `cleared ${named}: no mark`);
  if (unreachable) stdout("keep serve isn't running; written to the registry, the console picks it up when the daemon starts");
};

// An explicit process-lifetime preference. It is deliberately separate from
// Watch layouts and card status: either can change without changing whether the
// automatic retirement sweep may stop this session's current process.
commands['keep-running'] = async (argv, deps = {}) => {
  const o = parseArgs(argv, {});
  const usage = 'usage: keep keep-running [<#n|session-id>] on|off';
  if (o._.length < 1 || o._.length > 2 || !['on', 'off'].includes(o._.at(-1))) die(usage);
  const root = deps.root || ROOT;
  const setting = o._.at(-1) === 'on';
  const sessionArg = o._.length === 2 ? o._[0] : null;
  const { sessionId, num } = resolveSessionByNumberOrId(sessionArg, {
    root,
    currentSession: deps.currentSession || currentSession,
    noCurrent: 'no current session: run inside a Claude or Codex session, or name one: keep keep-running <#n|session-id> on',
  });
  let response = null;
  try {
    response = await (deps.postKeepApi || postKeepApi)('/api/session-keep-running', {
      sessionId,
      keepRunning: setting,
    }, 10000);
  } catch (error) {
    die(`keep serve did not answer (${error && error.message || error}); try again`);
  }
  if (response.status !== 200) {
    let result = {};
    try { result = JSON.parse(response.data); } catch {}
    die(result.error || `keep serve returned an unexpected response (${response.status})`);
  }
  const named = num ? `${sessionNumbers.label(num)} (${sessionId})` : sessionId;
  (deps.stdout || console.log)(`${setting ? 'keeping' : 'allowing retirement of'} ${named}`);
};

commands.project = (argv) => {
  const o = parseArgs(argv, {});
  const [id, target] = o._;
  if (!id || o._.length > 2) die('usage: keep project <id> [<path|name>] [-m "reason"]');
  if (target === undefined) {
    console.log(loadTask(id).fm.project || '(none)');
    return;
  }
  if (isReviewerSession()) die('the fleet reviewer may suggest a project change, but cannot apply it');
  const project = cleanScalar(normalizeProjectPath(canonicalCwd(
    resolveProjectArg(target).replace(/^~(?=\/|$)/, os.homedir()),
  )), 'project');
  withLock(() => {
    const task = loadTask(id);
    const previous = task.fm.project || '';
    if (previous !== project) {
      require('./review.js').resetProjectEvidence(id);
      task.fm.project = project;
      // Metadata curation must not transfer the owner's resume link or schedule.
      appendLog(task, 'project changed', `Project changed from ${previous || '(none)'} to ${project}.${o.m ? ` ${o.m}` : ''}`);
      saveTask(task);
      commitAndPush(`keep: project ${id}`);
    }
    console.log(fmtTask(task, { brief: true }));
  });
};

commands.delegate = async (argv, deps = {}) => {
  const separator = argv.indexOf('--');
  const optionArgs = separator < 0 ? argv : argv.slice(0, separator);
  const command = separator < 0 ? [] : argv.slice(separator + 1);
  const o = parseArgs(optionArgs, {
    step: 'str', prepare: 'bool', session: 'str', agent: 'str', accept: 'str', end: 'bool',
  });

  if (o.end) {
    if (o._.length || command.length || o.step || o.prepare || o.session || o.agent || o.accept) {
      die('usage: keep delegate --end');
    }
    const assigned = currentDelegation();
    if (['pending', 'invalid', 'identity-mismatch'].includes(assigned.kind)) die(delegation.describe(assigned));
    if (!assigned.record || assigned.explicit) die('the current session has no delegation to end');
    try { withLock(() => delegation.end(ROOT, assigned.record, 'worker ended delegation')); }
    catch (error) { die(error.message); }
    console.log(`ended delegation ${assigned.record.id} for ${assigned.record.card} step ${assigned.record.step.number}`);
    return;
  }

  if (o.accept) {
    if (o._.length || command.length || o.step || o.prepare || o.session || o.agent) {
      die('usage: keep delegate --accept <delegation-id>');
    }
    let worker;
    let bound;
    try {
      bound = withLock(() => {
        const pending = delegation.read(ROOT, o.accept);
        if (!pending) throw new Error(`unknown delegation ${o.accept}`);
        const pendingState = delegation.state(ROOT, pending, delegationDependencies({ persist: true }));
        if (pendingState.kind === 'stale') throw new Error(delegation.describe(pendingState));
        worker = delegation.acceptSession(pending, process.env);
        return delegation.bind(ROOT, pending.id, worker, { source: 'accept' });
      });
    }
    catch (error) { die(error.message); }
    console.log(`accepted delegation ${bound.id}: ${bound.card} step ${bound.step.number} as ${worker.agent} session ${sessionNamed(worker.id)}`);
    return;
  }

  if (o._.length !== 1 || !o.step) {
    die('usage: keep delegate <card> --step <n> [--prepare | --session <sid> --agent claude|codex|pi | -- <command...>]');
  }
  if (!command.length && separator >= 0) die('keep delegate needs a command after --');
  const modes = Number(Boolean(o.prepare)) + Number(Boolean(o.session || o.agent)) + Number(Boolean(command.length));
  if (modes !== 1 || Boolean(o.session) !== Boolean(o.agent)) {
    die('choose one delegation transport: --prepare, --session <sid> --agent claude|codex|pi, or -- <command...>');
  }
  if (o.agent && !['claude', 'codex', 'pi'].includes(o.agent)) die('agent must be claude, codex, or pi');
  if (o.session && !delegation.SESSION_RE.test(o.session)) die('session id must contain only letters, digits, _ or -');

  const callerAssignment = currentDelegation();
  if (['active', 'stale', 'pending', 'invalid', 'identity-mismatch'].includes(callerAssignment.kind)) {
    die(`${delegation.describe(callerAssignment)} The parent session must register further delegated work.`);
  }

  const parent = commandSession();
  if (!parent || !delegation.SESSION_RE.test(parent.id)) die('keep delegate needs a current agent parent session');
  let record;
  try {
    record = withLock(() => {
      let task;
      try { task = loadTask(o._[0]); } catch { throw new Error(`no task "${o._[0]}"`); }
      const step = delegation.snapshot(task, o.step, parsePlan);
      const created = delegation.create(ROOT, { card: task.id, step, parent });
      if (!o.session) return created;
      try {
        return delegation.bind(ROOT, created.id, { id: o.session, agent: o.agent }, { source: 'registered' });
      } catch (error) {
        delegation.end(ROOT, created, `binding failed: ${error.message}`);
        throw error;
      }
    });
  }
  catch (error) { die(error.message); }

  if (o.prepare) {
    console.log(`prepared delegation ${record.id}: ${record.card} step ${record.step.number}`);
    console.log(`worker accepts with: keep delegate --accept ${record.id}`);
    return;
  }
  if (o.session) {
    console.log(`registered delegation ${record.id}: ${record.card} step ${record.step.number} to ${o.agent} session ${o.session}`);
    return;
  }

  const launch = deps.spawn || spawn;
  process.stderr.write(`keep: delegating ${record.card} step ${record.step.number} (${record.id})\n`);
  const childEnv = { ...process.env, KEEP_DELEGATION_ID: record.id };
  // The explicit record carries the parent identity. Leaving ambient session
  // variables in a cross-agent child lets ordinary Keep commands attribute the
  // worker's contributions and schedules to its parent before the native client
  // replaces that variable.
  for (const name of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'KEEP_PI_SESSION_ID']) delete childEnv[name];
  let child;
  try {
    child = launch(command[0], command.slice(1), {
      cwd: process.cwd(),
      env: childEnv,
      stdio: 'inherit',
    });
  } catch (error) {
    try { withLock(() => delegation.end(ROOT, record, `launch failed: ${error.message}`)); } catch {}
    die(`could not launch delegated command: ${error.message}`);
  }
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (result.error) {
    try { withLock(() => delegation.end(ROOT, record, `launch failed: ${result.error.message}`)); } catch {}
    die(`could not launch delegated command: ${result.error.message}`);
  }
  if (result.signal) process.exitCode = 1;
  else if (result.code) process.exitCode = result.code;
};

commands.link = (argv) => {
  const o = parseArgs(argv, { session: 'str', agent: 'str', node: 'str' });
  const id = o._[0];
  if (o._.length !== 1 || !o.session || !o.agent) {
    die('usage: keep link <card> --session <sid> --agent claude|codex|pi [--node <name>]');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(o.session)) die('session id must contain only letters, digits, _ or -');
  if (!['claude', 'codex', 'pi'].includes(o.agent)) die('agent must be claude, codex, or pi');
  if (o.node !== undefined && !require('./nodes.js').NODE_NAME_RE.test(o.node)) {
    die('node must contain only lowercase letters and digits');
  }
  if (isReviewerSession()) die('the fleet reviewer cannot link a working session to a card');
  const linked = linkSession(id, { id: o.session, agent: o.agent, ...(o.node === undefined ? {} : { node: o.node }) });
  if (!linked) die(`no task "${id}"`);
  console.log(`${id} linked to ${o.agent} session ${o.session}`);
};

commands.claim = (argv) => {
  if (argv.length !== 1) die('usage: keep claim <card>');
  if (isReviewerSession()) die('the fleet reviewer cannot claim a card');
  const assigned = currentDelegation();
  if (['pending', 'invalid', 'identity-mismatch'].includes(assigned.kind)) die(delegation.describe(assigned));
  const session = commandSession();
  if (!session || !/^[A-Za-z0-9_-]+$/.test(session.id)) {
    die('keep claim needs a current agent session');
  }
  const id = argv[0];
  const linked = linkSession(id, session, { requireProject: true, commitLabel: 'claim' });
  if (!linked) die(`no task "${id}"`);
  if (linked.skipped === 'outside-project') {
    die(`cannot claim ${id} outside its project (${linked.project}); run it from the project, or repair metadata explicitly with keep link ${id} --session ${session.id} --agent ${session.agent}`);
  }
  if ((assigned.kind === 'active' || assigned.kind === 'stale' || (assigned.kind === 'ended' && !assigned.explicit)) && assigned.record) {
    try { withLock(() => delegation.end(ROOT, assigned.record, `claimed ${id}`)); }
    catch (error) { die(error.message); }
  }
  console.log(`${id} claimed by current ${session.agent} session ${sessionNamed(session.id)}`);
};

commands.done = (argv) => {
  const o = parseArgs(argv, { force: 'bool', next: 'str', commit: 'list' });
  const id = o._[0];
  if (!id) die('usage: keep done <id> [--next "text"] [--commit sha]... [--force] [-m closing note]');
  const next = cleanNext(o.next);
  const commits = cleanCommits(o.commit);
  const message = o.m || 'Done.';
  withLock(() => {
    const task = loadTask(id);
    task.fm.status = 'done';
    task.fm.check_after = '';
    clearScheduler(task);
    const contribution = recordContribution(task);
    appendLog(task, 'done', logMessage(message, next, commits), contribution.session);
    saveTask(task);
    countReviewerStatusChange(task.id, 'done');
    commitAndPush(`keep: done ${id}`);
    console.log(fmtTask(task, { brief: true }));
  });
  structuredFieldTips(message, next, commits);
};

commands['wait-on'] = (argv) => {
  const o = parseArgs(argv, { remove: 'bool', whole: 'bool', commit: 'list', deployed: 'str', target: 'str', status: 'str' });
  const dependentId = o._[0];
  const upstreamEntries = o._.slice(1);
  if (!dependentId || !upstreamEntries.length) die('usage: keep wait-on <card> <upstream>[#<step>] [--commit <sha>[,<sha>] | --deployed <sha> --target <name> | --status review,landing,done] -m "why"');
  const requested = requestedWaits(o, upstreamEntries, !o.remove);
  withLock(() => {
    const dependent = loadTask(dependentId);
    if (o.remove) {
      const removeTargets = requested.map(dependencyTarget);
      const present = new Set((dependent.fm.depends_on || []).map(dependencyTarget));
      for (const target of removeTargets) {
        if (!present.has(target)) dependencyError(`dependency not present: ${target}; removal matches the exact wait target`);
      }
      dependent.fm.depends_on = (dependent.fm.depends_on || []).filter((entry) => !removeTargets.includes(dependencyTarget(entry)));
      const open = unresolvedDependencyIds(dependent);
      const activate = dependent.fm.status === 'waiting' && !open.length && !dependent.fm.check_after && !openNeeds([dependent]).length;
      saveTask(dependent);
      require('./unblock').cancelDependencies(dependentId, removeTargets, { root: ROOT });
      const checked = checkinTask(dependentId, {
        message: `Removed dependencies: ${removeTargets.join(', ')}${o.m ? ` — ${o.m}` : ''}. Other dependencies and blockers preserved.`,
        next: open.length ? `waiting on ${open.join(', ')}` : activate ? 'Continue work; removed dependency no longer blocks it' : undefined,
        status: activate ? 'active' : undefined,
        linkSession: false, withinLock: true, commit: false,
      });
      commitAndPush(`keep: remove dependencies ${dependentId}`);
      console.log(fmtTask(checked));
      return;
    }
    const tasks = new Map(loadAll(true).map((task) => [task.id, task]));
    const checkedUpstreams = [];
    for (const entry of requested) {
      const { id: upstreamId, step } = parseDependency(entry);
      const upstream = loadTaskAnywhere(upstreamId);
      checkedUpstreams.push({ entry, upstream });
      if (step != null) {
        const steps = parsePlan(upstream.body).steps;
        if (steps.length < step) dependencyError(`${upstreamId} has no plan step ${step} (plan has ${steps.length})`);
      }
      if (upstreamId === dependentId) dependencyError(`dependency cycle: ${dependentId} -> ${dependentId}`);
      const path = dependencyPath(upstreamId, dependentId, tasks);
      if (path) dependencyError(`dependency cycle: ${dependentId} -> ${path.join(' -> ')}`);
    }

    for (const { entry, upstream } of checkedUpstreams) {
      const target = parseDependency(entry);
      if (target.kind !== 'whole') continue;
      const steps = parsePlan(upstream.body).steps;
      if (steps.length && !o.whole) {
        const choices = steps.map((step) => `  ${upstream.id}#${step.n}  [${step.state}] ${step.text}`).join('\n');
        dependencyError(
          `${upstream.id} has a plan; a whole-card wait can remain blocked by unrelated later work.\n`
          + `Choose the plan step you actually need:\n${choices}\n`
          + `Or use --commit, --deployed with --target, or --status for a fact target. Pass --whole only when completion of the entire card is required.`,
        );
      }
    }

    for (const { entry, upstream } of checkedUpstreams) {
      if (parseDependency(entry).kind !== 'whole') continue;
      if (!['review', 'landing'].includes(upstream.fm.status) && upstream.fm.kind !== 'idea') continue;
      process.stderr.write(
        `keep: warning — whole-card wait on ${upstream.id} may sit for days (${upstream.fm.kind === 'idea' ? 'idea cards may never close' : `status ${upstream.fm.status}`}); `
        + `prefer --commit <sha>, --deployed <sha> --target <name>, or --status review,landing,done when one of those facts is enough.\n`,
      );
    }

    const requestedByTarget = new Map(requested.map((entry) => [dependencyTarget(entry), entry]));
    dependent.fm.depends_on = (dependent.fm.depends_on || []).map((entry) =>
      requestedByTarget.get(dependencyTarget(entry)) || entry);
    const present = new Set(dependent.fm.depends_on.map(dependencyTarget));
    dependent.fm.depends_on.push(...requested.filter((entry) => !present.has(dependencyTarget(entry))));
    saveTask(dependent);
    const alreadyDone = requested.filter((entry) => {
      const parsed = parseDependency(entry);
      return dependencyResolved(loadTaskAnywhere(parsed.id), parsed);
    }).map(dependencyTarget);
    const status = ['active', 'review', 'landing'].includes(dependent.fm.status) ? 'waiting' : undefined;
    const suffix = alreadyDone.length ? `; already done: ${alreadyDone.join(', ')}` : '';
    const targets = requested.map(dependencyTarget);
    const checked = checkinTask(dependentId, {
      message: `waiting on: ${targets.join(', ')}${suffix} — reason: ${cleanScalar(o.m, 'wait reason')}`,
      next: `waiting on ${targets.join(', ')}`,
      status,
      heading: 'check-in',
      withinLock: true,
      dependencyWait: true,
      commit: false,
    });
    const unblock = require('./unblock.js');
    for (const entry of requested) {
      const target = dependencyTarget(entry);
      unblock.beginWait(dependentId, target, { root: ROOT });
      const parsed = parseDependency(entry);
      const upstream = loadTaskAnywhere(parsed.id);
      if (dependencyResolved(upstream, parsed)) {
        unblock.writePending(checked, upstream, { root: ROOT, dependency: entry });
      } else {
        unblock.removeDelivered(dependentId, target, { root: ROOT });
      }
    }
    commitAndPush(`keep: wait-on ${dependentId}`);
    console.log(fmtTask(checked));
  });
};

commands.wait = async (argv) => {
  process.exitCode = await require('./wait.js').run(argv, {
    now: Date.now,
    resolveProject: resolveProjectArg,
    activeHolds,
    loadTaskAnywhere,
    dependencyResolved,
    loadSteps: stepRegistry.loadSteps,
    loadLedger: stepRegistry.loadLedger,
    stamp: (ms) => stampOf(new Date(ms)),
  });
};

commands.deps = (argv) => {
  if (argv.length > 1) die('usage: keep deps [<card>]');
  const render = (task) => {
    console.log(`${task.id}:`);
    for (const entry of dependencyInfo(task)) {
      const status = entry.resolved ? 'resolved' : 'pending';
      let detail = ' (missing)';
      if (entry.task && entry.target.kind === 'commit') {
        detail = ` (${entry.target.commits.join(', ')} on origin) — ${entry.task.fm.title}`;
      } else if (entry.task && entry.target.kind === 'deployed') {
        detail = ` (${entry.target.sha} deployed to ${entry.target.target}) — ${entry.task.fm.title}`;
      } else if (entry.task && entry.target.kind === 'status') {
        detail = ` (status ${entry.task.fm.status}; wants ${entry.target.statuses.join('|')}) — ${entry.task.fm.title}`;
      } else if (entry.task && entry.step != null) {
        const total = parsePlan(entry.task.body).steps.length;
        detail = entry.resolved
          ? ` (step ${entry.step} done) — ${entry.task.fm.title}`
          : ` (step ${entry.step}/${total} open) — ${entry.task.fm.title}`;
      } else if (entry.task) {
        detail = ` (${entry.task.fm.status}) — ${entry.task.fm.title}`;
      }
      console.log(`  ${status}  ${entry.id}${detail}${entry.reason ? ` — ${entry.reason}` : ''}`);
    }
  };
  if (argv[0]) {
    const task = loadTaskAnywhere(argv[0]);
    if (!(task.fm.depends_on || []).length) return console.log(`${task.id}: no dependencies`);
    render(task);
    return;
  }
  const tasks = loadAll(false).filter((task) => unresolvedDependencyIds(task).length);
  if (!tasks.length) return console.log('no unresolved dependencies');
  for (const task of tasks) render(task);
};

commands.archive = (argv) => {
  const o = parseArgs(argv, {});
  const id = o._[0];
  withLock(() => {
    if (id) {
      loadTask(id);
      fs.mkdirSync(ARCHIVE, { recursive: true });
      fs.renameSync(taskPath(id), path.join(ARCHIVE, `${id}.md`));
      commitAndPush(`keep: archive ${id}`, ['tasks', 'archive']);
      console.log(`archived: ${id}`);
      return;
    }

    const tasks = loadAll(false).filter((task) => task.fm.status === 'done');
    if (!tasks.length) return console.log('nothing to archive');
    fs.mkdirSync(ARCHIVE, { recursive: true });
    for (const task of tasks) {
      fs.renameSync(taskPath(task.id), path.join(ARCHIVE, `${task.id}.md`));
    }
    commitAndPush(`keep: archive ${tasks.length} done task(s)`, ['tasks', 'archive']);
    console.log(`archived: ${tasks.map((task) => task.id).join(', ')}`);
  });
};

commands.tag = (argv) => {
  const o = parseArgs(argv, {});
  const id = o._[0];
  const changes = o._.slice(1);
  if (!id || !changes.length || !changes.every((c) => /^[+-]/.test(c))) die('usage: keep tag <id> +tag -tag …');
  withLock(() => {
    const task = loadTask(id);
    const tags = new Set(task.fm.tags || []);
    for (const c of changes) {
      const tag = cleanScalar(c.slice(1), 'tag');
      if (!tag) die('empty tag');
      c[0] === '+' ? tags.add(tag) : tags.delete(tag);
    }
    task.fm.tags = [...tags];
    saveTask(task);
    commitAndPush(`keep: tag ${id} ${changes.join(' ')}`);
    console.log(fmtTask(task, { brief: true }));
  });
};

commands.tags = () => {
  const counts = {};
  for (const t of loadAll(true)) for (const tag of t.fm.tags || []) counts[tag] = (counts[tag] || 0) + 1;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!entries.length) return console.log('no tags yet');
  for (const [tag, n] of entries) console.log(`  ${color('36', '#' + tag)}  ${n}`);
};

commands.list = (argv) => {
  const o = parseArgs(argv, { status: 'list', tag: 'str', project: 'str', overdue: 'bool', brief: 'bool', all: 'bool' });
  let tasks = loadAll(o.all);
  if (!o.all && !(o.status || []).includes('done')) tasks = tasks.filter((t) => t.fm.status !== 'done');
  if (o.status) tasks = tasks.filter((t) => o.status.includes(t.fm.status));
  if (o.tag) tasks = tasks.filter((t) => (t.fm.tags || []).includes(o.tag));
  if (o.project) {
    const bare = !o.project.includes('/') && !path.isAbsolute(o.project)
      && !o.project.startsWith('~') && !/^\.\.?$/.test(o.project);
    if (bare) {
      const needle = path.basename(o.project);
      tasks = tasks.filter((t) => t.fm.project && path.basename(t.fm.project) === needle);
    } else {
      // A worktree path (or a directory inside one) asks about its main checkout's cards,
      // but cards filed literally on the worktree path still have to answer to it.
      const wanted = canonicalProjectPath(o.project);
      const asTyped = normalizeProjectPath(o.project);
      // Reverse direction: a repo-root query also finds cards filed on a subdirectory.
      // String comparison only — canonicalizing every card's project would spawn git per card.
      const under = (project, root) => project === root || project.startsWith(root + path.sep);
      tasks = tasks.filter((t) => {
        if (!t.fm.project) return false;
        if (projectMatchesCwd(t.fm.project, wanted)) return true;
        const project = normalizeProjectPath(t.fm.project);
        return under(project, wanted) || under(project, asTyped) || under(asTyped, project);
      });
    }
  }
  if (o.overdue) tasks = tasks.filter(isOverdue);
  tasks.sort((a, b) =>
    STATUS_ORDER.indexOf(a.fm.status) - STATUS_ORDER.indexOf(b.fm.status) || (b.fm.updated || '').localeCompare(a.fm.updated || ''));
  if (!tasks.length) return o.brief ? undefined : console.log('nothing here');
  let lastStatus = null;
  for (const t of tasks) {
    if (!o.brief && t.fm.status !== lastStatus) {
      lastStatus = t.fm.status;
      console.log(color('90', lastStatus.toUpperCase()));
    }
    console.log(fmtTask(t, { brief: o.brief }));
  }
};

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; value >= 1024 && i < units.length; i++) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(1)} ${unit}`;
}

function artifactFiles(id) {
  const directory = path.join(META, 'artifacts', id);
  let names = [];
  try { names = fs.readdirSync(directory).sort(); } catch { return []; }
  const files = [];
  for (const name of names) {
    const file = path.join(directory, name);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) files.push({ file, name, stat });
    } catch {}
  }
  return files;
}

// Whether the regular file already at `existing` in a card's artifacts directory holds
// the same bytes as `source`. It is opened without following a link, and the open
// file must be the one the path names: a link planted there is refused rather than
// read, so it can neither be followed to another file nor serve as an oracle for
// that file's contents.
function artifactIdentical(source, existing) {
  let fd;
  try { fd = fs.openSync(existing, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
  catch (error) {
    if (error.code === 'ELOOP') die(`an artifact path is a link; remove it: ${existing}`);
    throw error;
  }
  try {
    const opened = fs.fstatSync(fd);
    const named = fs.lstatSync(existing);
    if (!opened.isFile() || !sameFileIdentity(opened, named)) die(`an artifact path is not a plain file; remove it: ${existing}`);
    const sourceStat = fs.statSync(source);
    return sourceStat.size === opened.size && fs.readFileSync(fd).equals(fs.readFileSync(source));
  } finally {
    fs.closeSync(fd);
  }
}

function sameFileIdentity(left, right) {
  return Boolean(left && right) && left.dev === right.dev && left.ino === right.ino;
}

// Removes `file` only while the path still names the file this process created
// (`identity`, its fstat): whatever took its place is someone else's and is left.
function removeIfCreated(file, identity) {
  try { if (sameFileIdentity(fs.lstatSync(file), identity)) fs.unlinkSync(file); } catch {}
}

// Creates `destination` in the verified card directory and copies `source` into it
// through the new descriptor. Node has no openat, so the strongest check available is
// made: the file is created exclusively without following a link (an existing link
// is EEXIST, never a target), and before any byte is written its descriptor must be
// the file a fresh lstat of the path names, in a parent that still resolves to the
// verified directory. Returns the created file's identity; throws EEXIST when the
// name is taken.
function createArtifactCopy(source, destination, realDirectory) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(destination, flags, 0o666);
  let identity = null;
  try {
    identity = fs.fstatSync(fd);
    let named = null;
    let parent = null;
    try { named = fs.lstatSync(destination); parent = fs.realpathSync(path.dirname(destination)); } catch {}
    if (!sameFileIdentity(identity, named) || parent !== realDirectory) {
      die(`${destination} changed while it was being created; refusing to store artifacts through it`);
    }
    const input = fs.openSync(source, 'r');
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (;;) {
        const read = fs.readSync(input, buffer, 0, buffer.length, null);
        if (!read) break;
        for (let written = 0; written < read;) written += fs.writeSync(fd, buffer, written, read - written);
      }
    } finally { fs.closeSync(input); }
    identity = fs.fstatSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    removeIfCreated(destination, identity);
    throw error;
  }
  fs.closeSync(fd);
  return identity;
}

// For each path: the index entry it had if it was staged (differed from HEAD), or
// null if it was not. `git diff --cached` names the staged ones; `ls-files -s` gives
// their entries to put back.
function artifactIndexSnapshot(paths) {
  const staged = new Set(git('diff', '--cached', '--name-only', '-z', '--', ...paths).split('\0').filter(Boolean));
  const snapshot = new Map();
  for (const file of paths) {
    if (!staged.has(file)) { snapshot.set(file, null); continue; }
    const entry = git('ls-files', '-s', '-z', '--', file).split('\0').filter(Boolean)[0] || '';
    const match = entry.match(/^(\d+) ([0-9a-f]+) \d\t/);
    snapshot.set(file, match ? { mode: match[1], object: match[2] } : { removed: true });
  }
  return snapshot;
}

function restoreArtifactIndex(snapshot) {
  const unstaged = [...snapshot].filter(([, entry]) => entry === null).map(([file]) => file);
  if (unstaged.length) { try { git('reset', '-q', '--', ...unstaged); } catch {} }
  for (const [file, entry] of snapshot) {
    if (!entry) continue;
    try {
      if (entry.removed) git('rm', '-q', '--cached', '--force', '--ignore-unmatch', '--', file);
      else git('update-index', '--cacheinfo', `${entry.mode},${entry.object},${file}`);
    } catch {}
  }
}

// Where each stored file came from, for the card log. A node's files reach this CLI
// as the daemon's temporary copies (bin/artifact-route.js), which are gone once it
// exits; the route passes the node's own paths in KEEP_ARTIFACT_SOURCES, one per
// file, and the log names those, with the node, instead. It is read only under
// KEEP_REMOTE_CALLER, which only the daemon's route sets, and only when it fits.
function artifactOrigins(sources, env = process.env) {
  const caller = env.KEEP_REMOTE_CALLER;
  if (!caller || !env.KEEP_ARTIFACT_SOURCES) return sources;
  let named;
  try { named = JSON.parse(env.KEEP_ARTIFACT_SOURCES); } catch { return sources; }
  if (!Array.isArray(named) || named.length !== sources.length
    || !named.every((value) => typeof value === 'string' && value && !/[\r\n\0]/.test(value))) return sources;
  return named.map((value) => `${caller}:${value}`);
}

// The card's artifacts directory, made if it is missing and refused unless it is a
// real directory whose resolved path is the registry's own .keep/artifacts/<card>: a
// symbolic link planted there (or at .keep/artifacts) would send the copies, and
// the commit's view of them, somewhere else. Returns { directory, realDirectory }.
//
// The model these checks answer to: the registry is on Owner's machine, and a
// process of the same user that can swap directories under .keep can already edit
// any card directly. So they are against links that were planted and left there,
// not against an active racer with the same uid; the copies re-check the directory
// once each (createArtifactCopy) because that costs nothing, not because it closes
// every window.
function artifactDirectory(id) {
  const base = path.join(META, 'artifacts');
  const directory = path.join(base, id);
  fs.mkdirSync(base, { recursive: true });
  try { fs.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  for (const entry of [base, directory]) {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink() || !stat.isDirectory()) die(`${entry} is not a plain directory; refusing to store artifacts through it`);
  }
  const expected = path.join(fs.realpathSync(META), 'artifacts', id);
  if (fs.realpathSync(directory) !== expected) die(`${directory} does not resolve inside the registry's .keep/artifacts; refusing to store artifacts through it`);
  return { directory, realDirectory: expected };
}

const ARTIFACT_USAGE = 'usage: keep artifact <card> [--] [<file>...] [-m "note"] | keep artifact <card> --get <name> [--out <path>] [--force]';
const ARTIFACT_FLAGS = { get: 'str', out: 'str', force: 'bool' };

commands.artifact = (argv, deps = {}) => {
  const o = parseArgs(argv, ARTIFACT_FLAGS);
  const [id, ...inputs] = o._;
  if (!id) die(ARTIFACT_USAGE);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) die(`invalid artifact card id "${id}"`);
  if (o.get != null) return artifactGet(id, o, inputs);
  if (o.out != null || o.force) die(ARTIFACT_USAGE);
  loadTask(id);

  if (!inputs.length) {
    const files = artifactFiles(id);
    if (!files.length) return console.log(`no artifacts stored for ${id}`);
    for (const { file, stat } of files) {
      console.log(`${file} (${humanSize(stat.size)}, ${stat.mtime.toISOString()})`);
    }
    return;
  }

  const sources = inputs.map((input) => path.resolve(input));
  const limit = require('./registry-commands.js').ARTIFACT_FILE_MAX_BYTES;
  const origins = artifactOrigins(sources);
  for (const source of sources) {
    let stat;
    try { stat = fs.statSync(source); }
    catch { die(`artifact file does not exist: ${source}`); }
    if (!stat.isFile()) die(`artifact is not a regular file: ${source}`);
    if (stat.size > limit) {
      die(`artifact too large: ${source} (${(stat.size / 1024 / 1024).toFixed(1)} MB); trim or compress it before storing`);
    }
  }

  const stored = withLock(() => {
    const task = loadTask(id);
    // A conflicted index entry has several stages, which a rollback could not put
    // back as they were: refused before anything is copied.
    const conflicted = git('ls-files', '-u', '-z', '--', path.relative(ROOT, taskPath(task.id)), path.relative(ROOT, path.join(META, 'artifacts', id)));
    if (conflicted) die(`the card or its artifacts have a merge conflict in the registry's index; resolve it before storing artifacts`);
    const { directory, realDirectory } = artifactDirectory(id);
    const results = [];
    // { destination, identity } for each file this call created, so a rollback
    // removes only what is still that file.
    const created = [];
    const cleanupCreated = () => {
      for (const entry of created) removeIfCreated(entry.destination, entry.identity);
    };
    const tryCreate = (source, destination) => {
      try {
        const identity = createArtifactCopy(source, destination, realDirectory);
        created.push({ destination, identity });
        return identity;
      } catch (error) {
        if (error.code === 'EEXIST') return null;
        throw error;
      }
    };
    const taskFile = taskPath(task.id);
    const taskBefore = fs.readFileSync(taskFile);
    // The index entries of the paths about to be staged, as they were: a rollback
    // puts back an entry that was already staged and unstages only what this call
    // added, so a change Owner had staged to the card survives a failed store.
    let indexBefore = null;
    try {
      for (const source of sources) {
        const basename = path.basename(source);
        const preferred = path.join(directory, basename);
        let destination = preferred;
        let identity = tryCreate(source, destination);
        if (!identity && !artifactIdentical(source, preferred)) {
          const ext = path.extname(basename);
          const stem = ext ? basename.slice(0, -ext.length) : basename;
          for (let timestamp = Date.now(); !identity; timestamp++) {
            destination = path.join(directory, `${stem}-${timestamp}${ext}`);
            identity = tryCreate(source, destination);
          }
        }
        if (identity && identity.size > limit) {
          die(`artifact too large: ${source} (${(identity.size / 1024 / 1024).toFixed(1)} MB); trim or compress it before storing`);
        }
        results.push({ source, destination, created: Boolean(identity) });
      }

      // Every file already stored and nothing to say: a durable no-op, so a resent
      // command (or a loop of them) adds no card-log entry and no commit.
      if (o.m == null && !results.some((result) => result.created)) return results;
      const text = results.map(({ source, destination, created: made }, index) =>
        `${made ? 'Stored' : 'Already stored'} ${destination} (from ${origins[index]})`).join('\n');
      appendLog(task, 'artifact', o.m != null ? `${text}\n${o.m}` : text);
      saveTask(task);
      const paths = [...new Set([
        ...results.filter((result) => result.created).map((result) => path.relative(ROOT, result.destination)),
        path.relative(ROOT, taskFile),
      ])];
      indexBefore = artifactIndexSnapshot(paths);
      // .keep is otherwise ignored runtime state; only these immutable artifacts are
      // deliberately tracked. Never sweep up another card's artifacts or task.
      git('add', '-f', '--', ...paths);
      commitAndPush(`keep: artifact ${id} (${sources.length} file${sources.length === 1 ? '' : 's'})`, paths, { staged: true });
      return results;
    } catch (error) {
      // Nothing was committed (the commit is the last step that throws), so the
      // card, the index and the directory go back to how they were.
      cleanupCreated();
      try { fs.writeFileSync(taskFile, taskBefore); } catch {}
      if (indexBefore) restoreArtifactIndex(indexBefore);
      throw error;
    }
  });

  if (!deps.quiet) for (const result of stored) console.log(result.destination);
  return stored;
};

// `keep artifact <card> --get <name>`: a stored artifact copied back out as a file,
// read by the same checks the console's route makes (bin/card-artifacts.js).
function artifactGetArgs(id, o, inputs) {
  if (inputs.length || o.m != null) die(ARTIFACT_USAGE);
  const refusal = require('./registry-commands.js').artifactNameRefusal(o.get);
  if (refusal) die(`invalid artifact name "${o.get}": ${refusal}`);
}

async function artifactGet(id, o, inputs) {
  artifactGetArgs(id, o, inputs);
  const artifacts = require('./card-artifacts.js');
  const destination = artifacts.getDestination(o.get, o.out, process.cwd());
  try {
    const bytes = await artifacts.readArtifact(ROOT, id, o.get);
    artifacts.writeFetched(destination, bytes, { force: o.force });
  } catch (error) {
    if (error instanceof artifacts.ArtifactError) die(error.status === 404 ? `no artifact "${o.get}" on ${id}; keep artifact ${id} lists them` : error.message);
    throw error;
  }
  console.log(destination);
}

commands.show = (argv) => {
  const id = argv[0];
  if (!id) die('usage: keep show <id>');
  const task = loadTask(id);
  console.log(fmtTask(task, { brief: true }));
  const f = task.fm;
  if (f.experiment_id) console.log(`  experiment_id: ${f.experiment_id}`);
  if (f.depends_on && f.depends_on.length) console.log(`  depends_on: ${f.depends_on.map(dependencyTarget).join(', ')}`);
  if (f.project) console.log(`  project: ${f.project}`);
  if (f.check_after) console.log(`  check after: ${f.check_after.replace('T', ' ')}${isOverdue(task) ? color('31', '  (overdue)') : ''}`);
  if (f.check) console.log(`  check recipe:\n${f.check.split('\n').map((l) => '    ' + l).join('\n')}`);
  if (f.check_on_pass) {
    console.log(`  on pass: ${f.check_on_pass === 'rearm' ? `re-arm every ${f.check_every}` : f.check_on_pass}`);
  }
  if (f.probe) console.log(`  probe: ${f.probe}`);
  if (f.agent) console.log(`  agent: ${f.agent}  (its checks run as this agent; keep agents)`);
  if (f.sessions && f.sessions.length) {
    const s = f.sessions[f.sessions.length - 1];
    console.log(`  last session: ${sessionNumbers.named(s.id, { root: ROOT })} (${s.at})  →  ${resumeCommand(s)}`);
  }
  const artifacts = artifactFiles(task.id);
  if (artifacts.length) {
    console.log('  artifacts:');
    for (const { file, stat } of artifacts) console.log(`    ${file} (${humanSize(stat.size)})`);
  }
  const parsed = parsePlan(task.body);
  if (parsed.steps.length) {
    console.log('  plan:');
    for (const step of parsed.steps) console.log(`    ${step.n}. [${planMark(step.state)}] ${step.text}`);
    const next = nextStep(task);
    console.log(next ? `  next: step ${next.n}/${parsed.steps.length} — ${next.text}` : '  next: none');
  }
  // The card stores `(by <agent> <full id>)` for the reviewer to parse; a reader
  // gets the session's number, which is what agents should repeat.
  if (parsed.rest) {
    console.log('\n' + parsed.rest.trim().replace(/^(## .*\(by (?:claude|codex|pi) )([A-Za-z0-9_-]+)\)/gm,
      (whole, head, sid) => (sessionNumbers.numberFor(sid, { root: ROOT }) ? `${head}${sessionRef(sid, { root: ROOT })})` : whole)));
  }
};

// Run a card's probe once, right now, with the daemon's semantics and none of its
// consequences: no check-in, no status change, no daemon required. The exit code is
// the answer, so this is also what a shell script or another agent can call.
commands.probe = (argv) => {
  const o = parseArgs(argv, {});
  const id = o._[0];
  if (!id || o._.length > 1) die('usage: keep probe <id>');
  const task = loadTask(id);
  if (!task.fm.probe) die(`${id} has no probe — set one with keep checkin ${id} --probe "<command>" -m "why"`);
  const result = runProbe(task.fm.probe, task.fm.project);
  console.log(task.fm.probe);
  if (result.output) console.log(result.output);
  console.log(result.ok
    ? `probe passed (${result.ms}ms)`
    : `probe FAILED (exit ${result.code}${result.timedOut ? ', timed out' : ''}, ${result.ms}ms)`);
  if (!result.ok) process.exitCode = 1;
};

commands.overdue = (argv) => {
  const o = parseArgs(argv, { brief: 'bool' });
  const tasks = loadAll(false).filter(isOverdue).sort((a, b) => a.fm.check_after.localeCompare(b.fm.check_after));
  if (!tasks.length) return o.brief ? undefined : console.log('nothing overdue');
  // Why a due check has not run is the part `keep overdue` could never say. The
  // scheduler records budget deferrals per card; reading them here is what turns a
  // list of stale dates into "this one is stalled on an exhausted account".
  const deferrals = require('./check-deferrals.js');
  const deferred = deferrals.read(ROOT);
  for (const t of tasks) {
    const why = deferrals.describe(deferred.get(t.id), t.fm.check_after);
    if (o.brief) console.log(`- ${t.id}: "${t.fm.title}" check was due ${t.fm.check_after.replace('T', ' ')}${t.fm.check ? ' (has check recipe)' : ''}${why}`);
    else console.log(`${fmtTask(t)}${why}`);
  }
};


async function whoSnapshot(project) {
  const who = require('./who.js');
  const tasks = loadAll(false);
  const holds = activeHolds(project, Date.now(), { devices: true });
  let sessions = null;
  try {
    const response = await getKeepApi('/api/state');
    if (response.status === 200) {
      const state = JSON.parse(response.data);
      sessions = Array.isArray(state.sessions) ? state.sessions : [];
    }
  } catch {}
  return who.fleetSnapshot(project, {
    tasks,
    sessions,
    holds,
    deviceHolds: true,
    steps: stepRegistry.status(project, { tasks, holds: activeHolds(project) }),
    notes: require('./notes.js').activeNotes(project),
    git: who.gitSnapshot(project),
    now: Date.now(),
  });
}

commands.who = async (argv) => {
  const o = parseArgs(argv, { json: 'bool', scope: 'list' });
  const scopes = require('./hold-scopes').parse(o.scope);
  if (o._.length !== 1) die('usage: keep who <project> [--json]');
  const project = resolveProjectArg(o._[0]);
  const snapshot = await whoSnapshot(project);
  const holdScopes = require('./hold-scopes');
  snapshot.holds = snapshot.holds.filter((hold) => (normalizeProjectPath(hold.project) === normalizeProjectPath(project)
    ? holdScopes.overlaps(hold, scopes) : holdScopes.sharesDevice(hold, scopes)));
  if (scopes.length) snapshot.holdScopes = scopes;
  console.log(o.json ? JSON.stringify(snapshot, null, 2) : require('./who.js').renderWho(snapshot));
};


commands.needs = (argv) => {
  const o = parseArgs(argv, { env: 'str', met: 'bool' });
  if (!o._.length) {
    if (o.env || o.met || o.m) die('usage: keep needs [<card> "<secret or action>" [--env NAME] | <card> --met [--env NAME]]');
    const needs = openNeeds(loadAll(false));
    if (!needs.length) return console.log('nothing waiting on Owner');
    console.log(`Waiting on Owner (${needs.length}):`);
    for (const need of needs) console.log(`  ${formatNeed(need)}`);
    return;
  }
  const id = o._[0];
  if (o.met) {
    if (o._.length > 2) die('usage: keep needs <card> --met [--env NAME | "<text>"]');
    const { met, restored } = meetNeeds(id, { env: o.env, text: o._[1], via: 'Marked met by hand.' });
    console.log(`${id}: ${met.length} need${met.length === 1 ? '' : 's'} met${restored ? ` — status back to ${restored}` : ''}`);
    return;
  }
  const text = o._.slice(1).join(' ') || o.m;
  if (!text) die('usage: keep needs <card> "<secret or action>" [--env NAME]');
  const task = addNeed(id, { text, env: o.env });
  console.log(`${id} → blocked, waiting on Owner: ${text}${o.env ? ` (clears when ${o.env} is set in a linked owning session, or keep needs ${id} --met --env ${o.env})` : ` (clear with keep needs ${id} --met)`}`);
  console.log(fmtTask(task));
};

// ---------- allow (pre-authorization) ----------

function formatAllow(task) {
  const grants = allow.readGrants(task);
  if (!grants.length) return '(no grants)';
  const until = String(task.fm.allow_until || '').trim();
  const stale = allow.expired(task, Date.now());
  const suffix = until ? ` — ${stale ? `EXPIRED ${until}` : `until ${until}`}` : '';
  return grants.map(allow.formatToken).join(', ') + suffix;
}

// `keep allow <card> land` with no explicit grant: the reviewed-patch path.
// Everything git-shaped lives in bin/reviews.js; the decision itself is
// allow.decideLand, which is pure.
// The obligations that bear on this land. An unreadable store becomes one synthetic
// blocker rather than an empty list: "I could not tell" must read as "not yet", not as
// "nothing outstanding".
function readObligations(taskId, records, commits, api) {
  try { return api.outstandingFor(api.readRecords(taskId), records, commits); }
  catch (error) {
    // Marked `unreadable`, not dressed up as an obligation: its id and job would
    // otherwise appear in --json and in the refusal as commands to run, and neither
    // recording a verdict for job "(unknown)" nor dropping "(unreadable)" repairs a
    // corrupt store.
    return [{ unreadable: true, card: taskId, why: String(error.message || error) }];
  }
}

function implicitLandVerdict(task, deps = {}) {
  const reviews = deps.reviews || require('./reviews.js');
  const records = deps.records || reviews.readRecords(task.id);
  const optOut = deps.optOut !== undefined ? deps.optOut : reviews.optOutReason(task);
  const obligationApi = deps.obligations || require('./review-obligations.js');
  // Always resolved, even when the card is opted out or holds an explicit grant:
  // `keep land` needs the worktree and the range, and an explicit `land` grant on
  // an opted-out card used to short-circuit past this and land `undefined`.
  const context = deps.context || reviews.landContext(deps.cwd || process.cwd());
  const verdict = allow.decideLand({
    grants: allow.readGrants(task),
    records,
    commits: context.ok ? context.commits : [],
    // Only the obligations whose commits are actually in this range: a review still
    // out for work that landed last week is not this land's problem. A file that
    // cannot be read is not an absence of obligations — it refuses the land and says
    // why, rather than failing open on the one question this gate exists to answer.
    obligations: context.ok ? readObligations(task.id, records, context.commits, obligationApi) : [],
    optOut,
    worktree: context.ok ? null : context,
  });
  return { ...verdict, context };
}

const ALLOW_SPEC = { grant: 'list', revoke: 'list', until: 'str', clear: 'bool', amount: 'str', quiet: 'bool', json: 'bool', 'as-owner': 'bool' };
const ALLOW_USAGE = 'usage: keep allow <id> [<action> [--amount n]] [--grant a,b] [--revoke a,b] [--until when] [--clear] [--quiet] [--json] [--as-owner]';

// allow.js throws AllowError, which the top-level handler does not know; every
// path here converts it so bad input prints `keep: …` and exits, not a stack.
function translatingAllow(fn) {
  try { return fn(); }
  catch (error) { if (error instanceof allow.AllowError) die(error.message); throw error; }
}

// `keep allow <card> <action>`: the answer, printed and given an exit status. The same
// for the card read here and for one a node reads from its daemon (allowRemote),
// which hands the land gate the daemon's facts in `landDeps`.
function answerAllow(id, task, request, o, landDeps = {}) {
  let verdict = translatingAllow(() => allow.decide(task, request, { amount: o.amount }));
  // No explicit grant covers `land`, so ask the reviewed-patch question instead.
  // Nothing else gets an implicit path: a land is the one action whose evidence
  // Keep can verify byte for byte.
  if (!verdict.ok && String(request).trim().toLowerCase() === 'land') {
    const implicit = implicitLandVerdict(task, landDeps);
    verdict = {
      ok: implicit.ok, why: implicit.why, ...(implicit.grant ? { grant: implicit.grant } : {}), implicit: true,
      ...(implicit.record ? { record: implicit.record } : {}),
      // The blocker that carried the refusal, so --json says which review is still
      // out rather than only spelling it in the prose.
      ...(implicit.obligation ? { obligation: implicit.obligation } : {}),
    };
  }
  if (o.json) console.log(JSON.stringify({ id, action: request, ...verdict }, null, 2));
  else if (!o.quiet) console.log(verdict.ok ? `allowed: ${verdict.why}` : `not allowed: ${verdict.why}`);
  // Exit 3, not 1: an agent must be able to tell "you may not" from "that
  // command was wrong". `if keep allow c push; then …` reads naturally.
  if (!verdict.ok) process.exitCode = 3;
}

commands.allow = (argv) => {
  const o = parseArgs(argv, ALLOW_SPEC);
  const id = o._[0];
  const usage = ALLOW_USAGE;
  if (!id) die(usage);
  const mutating = Boolean(o.grant || o.revoke || o.clear || o.until);
  const translating = translatingAllow;
  const request = o._[1];
  if (o._.length > 2) die(usage);
  if (mutating && request) die('keep allow either checks one action or changes the grants, not both');

  if (!mutating) {
    const task = loadTask(id);
    if (!request) {
      if (o.json) return console.log(JSON.stringify({ id, grants: allow.readGrants(task).map(allow.formatToken), until: task.fm.allow_until || '', expired: Boolean(allow.expired(task, Date.now())) }, null, 2));
      return console.log(`${id}: ${formatAllow(task)}`);
    }
    answerAllow(id, task, request, o);
    return;
  }

  // The grants are the authority an unattended agent runs on, and until now any
  // session could write its own: `keep allow <own card> --grant push` was an
  // ordinary, unlogged-as-unusual command. The skill has always said only Owner
  // grants; this is that sentence with an exit code behind it.
  // Revoking and clearing only ever reduce authority, so they stay open.
  const widening = Boolean(o.grant || o.until);
  // A node's request (KEEP_REMOTE_CALLER) is never Owner's terminal, so --as-owner
  // does not open this for it whatever reaches its environment.
  if (widening && inAgentSession() && !(o['as-owner'] && process.env.KEEP_OWNER === '1' && !process.env.KEEP_REMOTE_CALLER)) {
    die(`only Owner grants. Never grant on your own card — end the turn and ask him for "keep allow ${id} --grant …". `
      + 'If Owner is running this himself from an agent session, pass --as-owner with KEEP_OWNER=1 in the environment.');
  }

  translating(() => withLock(() => {
    const task = loadTask(id);
    let grants = allow.readGrants(task);
    let changed = [];
    if (o.clear) { grants = []; changed.push('cleared every grant'); }
    if (o.revoke) {
      const drop = new Set();
      for (const value of o.revoke) for (const part of String(value).split(',')) {
        // Match how a grant is stored and compared: without case in the scope,
        // so `--revoke deploy:prod` removes a stored `deploy:Prod`.
        if (part.trim()) drop.add(allow.tokenKey(allow.parseToken(part, 'grant')));
      }
      const before = grants.length;
      // Revoking a bare action drops its scoped grants too: "no more deploying"
      // must not leave `deploy:prod` standing.
      grants = grants.filter((g) => !drop.has(allow.tokenKey(g)) && !drop.has(g.action));
      if (before !== grants.length) changed.push(`revoked ${[...drop].join(', ')}`);
      else process.stderr.write(`keep: note — ${[...drop].join(', ')} was not granted on ${id}\n`);
    }
    if (o.grant) {
      const added = allow.parseGrants(o.grant);
      grants = allow.parseGrants([...grants.map(allow.formatToken), ...added.map(allow.formatToken)]);
      changed.push(`granted ${added.map(allow.formatToken).join(', ')}`);
    }
    grants = allow.parseGrants(grants.map(allow.formatToken));
    task.fm.allow = grants.map(allow.formatToken);
    if (o.until) { task.fm.allow_until = parseWhen(o.until); changed.push(`until ${task.fm.allow_until}`); }
    if (o.clear) task.fm.allow_until = '';
    if (!changed.length) die('nothing to change');
    const contribution = recordContribution(task);
    // The grant is the authority an unattended agent runs on, so it belongs in
    // the log where the reviewer and the next session can both see who gave it.
    appendLog(task, 'allow', `${changed.join('; ')} → ${formatAllow(task)}`, contribution.session);
    saveTask(task);
    commitAndPush(`keep: allow ${id}`);
    console.log(`${id}: ${formatAllow(task)}`);
  }));
};

// ---------- review records and the land they authorize ----------

function reviewRecordError(fn) {
  const reviews = require('./reviews.js');
  try { return fn(reviews); }
  catch (error) { if (error instanceof reviews.ReviewRecordError) die(error.message); throw error; }
}

// A node's `keep reviewed` / `keep reviewing` arrives with the commits and the job it
// resolved in its own worktree (reviews.nodeFactArgs) rather than --commit, which the
// daemon would resolve in its main checkout. Accepted only from a node's request
// (KEEP_REMOTE_CALLER, set only by /api/registry), and from a node only that way.
// Returns { commits, job } — each null when not given.
function nodeFacts(o, reviews) {
  const remote = process.env.KEEP_REMOTE_CALLER;
  if (!remote) {
    if (o.fact) die('--fact is not accepted here');
    if (o['job-fact']) die('--job-fact is not accepted here');
    return { commits: null, job: null };
  }
  if (o.commit) die('a node sends the commits it resolved in its worktree, not --commit: the daemon cannot see that worktree');
  if (o['job-fact'] && !o.job) die('--job-fact needs the --job it describes');
  return {
    commits: o.fact ? reviews.parseFacts(o.fact) : null,
    job: o['job-fact'] ? reviews.parseJobFact(o['job-fact'], o.job) : null,
  };
}

commands.reviewed = (argv) => {
  const o = parseArgs(argv, { commit: 'list', verdict: 'str', by: 'str', job: 'str', evidence: 'str', fallback: 'bool', json: 'bool', fact: 'list', 'job-fact': 'str' });
  const id = o._[0];
  const usage = 'usage: keep reviewed <card> --commit <sha|range>… --verdict clean|findings [--by codex|opus|claude|human…] [--job <id>] [--evidence "..."] [--fallback] [-m "..."] [--json]';
  const facts = reviewRecordError((reviews) => nodeFacts(o, reviews));
  if (!id || o._.length > 1 || !(o.commit || facts.commits) || !o.verdict) die(usage);
  const record = reviewRecordError((reviews) => withLock(() => {
    const task = loadTask(id);
    const built = reviews.buildRecord({
      commits: o.commit, verdict: o.verdict, by: o.by, job: o.job, evidence: o.evidence,
      fallback: o.fallback, message: o.m, session: commandSession(),
      ...(facts.commits ? { resolvedCommits: facts.commits } : {}),
    }, reviews.gitDeps(process.cwd()), facts.job ? { jobFact: facts.job } : {});
    reviews.append(id, built);
    const contribution = recordContribution(task);
    // A review of somebody else's card is legitimate — it is the whole point of an
    // independent reviewer — but the owner should be able to see who filed it.
    const session = commandSession();
    const owners = (task.fm.sessions || []).map((entry) => entry.id);
    if (session && owners.length && !owners.includes(session.id)) {
      process.stderr.write(`keep: note — ${id} is claimed by ${owners.map((owner) => sessionRef(owner)).join(', ')},`
        + ` not this ${session.agent} session ${sessionRef(session.id)}; the record is filed anyway\n`);
    }
    // `code-review`, never a bare `review`: bin/review.js swallows a log heading
    // that starts with the word review as one of the fleet reviewer's own notes.
    appendLog(task, 'code-review', reviews.logLine(built), contribution.session);
    task.fm.updated = nowStamp();
    saveTask(task);
    commitAndPush(`keep: code-review ${id}`);
    return built;
  }));
  // The verdict this card was waiting for closes the obligation that was waiting for
  // it, so the daemon never announces a review a session already recorded by hand.
  let closed = [];
  try { closed = require('./review-obligations.js').settleFromRecord(id, record); }
  catch (error) { process.stderr.write(`keep: the review was recorded but its obligation could not be settled: ${error.message}\n`); }
  if (o.json) return console.log(JSON.stringify({ ...record, settled: closed.map((entry) => entry.id) }, null, 2));
  console.log(`${id}: recorded ${record.verdict} review ${record.id} over ${record.commits.length} commit(s) by ${record.by}`);
  for (const commit of record.commits) console.log(`  ${commit.sha.slice(0, 12)} ${commit.patchId ? `patch ${commit.patchId.slice(0, 12)}` : 'no patch-id (merge or empty)'} ${commit.subject}`);
  for (const entry of closed) console.log(`  settled pending review ${entry.id} (job ${entry.job})`);
  if (record.verdict === 'clean') console.log(`  keep allow ${id} land now answers 0 while these are exactly what would land`);
};

// `keep review-route` — which reviewer this card's independent review should go to.
// Advice, not enforcement: it launches nothing and never queues a second review.
commands['review-route'] = (argv) => {
  const o = parseArgs(argv, { exhausted: 'str', until: 'str', clear: 'str', json: 'bool' });
  const usage = 'usage: keep review-route [--json]\n'
    + '       keep review-route --exhausted <codex-account-id> --until <when> [-m "..."]\n'
    + '       keep review-route --clear <codex-account-id>';
  if (o._.length) die(usage);
  const routing = require('./review-routing.js');
  if (o.clear) {
    if (o.exhausted || o.until) die(usage);
    const had = routing.clearExhausted(o.clear);
    console.log(had ? `${o.clear}: no longer recorded as exhausted` : `${o.clear}: was not recorded as exhausted`);
    return;
  }
  if (o.exhausted || o.until) {
    if (!o.exhausted || !o.until) die(usage);
    const known = routing.codexAccounts().includes(o.exhausted);
    if (!known) die(`${o.exhausted} is not a registered Codex account this install routes reviews to — keep accounts`);
    const entry = routing.markExhausted(o.exhausted, parseWhen(o.until), { note: o.m, session: commandSession() });
    console.log(`${o.exhausted}: exhausted until ${entry.until}`);
    console.log(routing.describe(routing.route()));
    return;
  }
  const decision = routing.route();
  if (o.json) return console.log(JSON.stringify(decision, null, 2));
  console.log(routing.describe(decision));
};

// `keep reviewing` — the other half of `keep reviewed`: a review that has been launched
// and has not answered yet. The daemon settles it from the job's own state, and until it
// does, the implicit land grant refuses the commits it covers.
commands.reviewing = (argv) => {
  const o = parseArgs(argv, { commit: 'list', job: 'str', account: 'str', by: 'str', drop: 'str', json: 'bool', fact: 'list', 'job-fact': 'str' });
  const id = o._[0];
  const usage = 'usage: keep reviewing <card> --job <codex-job-id> --commit <sha|range>… [--account <codex-id>] [--by "codex sol"] [-m "..."] [--json]\n'
    + '       keep reviewing <card> --drop <obligation-id> -m "why"   # stop waiting for a review you are not going to get\n'
    + '       keep reviewing <card> [--json]                          # what this card is still waiting for';
  if (!id || o._.length > 1) die(usage);
  const obligations = require('./review-obligations.js');
  const translating = (fn) => {
    try { return fn(); }
    catch (error) { if (error instanceof obligations.ObligationError) die(error.message); throw error; }
  };
  loadTask(id);
  const facts = reviewRecordError((reviews) => nodeFacts(o, reviews));
  const named = o.commit || facts.commits;

  if (o.drop) {
    if (o.job || named) die(usage);
    if (!o.m) die('--drop needs -m "why": an obligation dropped without a reason is a review nobody can tell was skipped');
    // Under the registry lock, because the daemon's sweep is reading and rewriting the
    // same file every five minutes.
    translating(() => withLock(() => {
      const records = obligations.readRecords(id);
      const target = records.find((record) => record.id === o.drop || record.job === o.drop);
      if (!target) die(`${id} has no pending review ${o.drop} — keep reviewing ${id} lists them`);
      if (!obligations.isOpen(target)) die(`pending review ${target.id} is already ${target.state}`);
      obligations.writeRecords(id, records.map((record) => (record.id === target.id
        ? obligations.applied(record, { state: 'abandoned', note: `dropped: ${o.m}` })
        : record)));
      console.log(`${id}: dropped pending review ${target.id} (job ${target.job});`
        + ` keep reviews ${id} lists what is on the card`);
    }));
    return;
  }

  if (!o.job && !named) {
    const records = translating(() => obligations.readRecords(id));
    if (o.json) return console.log(JSON.stringify({ id, obligations: records }, null, 2));
    if (!records.length) return console.log(`${id}: no pending reviews`);
    for (const record of records) console.log(obligations.summaryLine(record));
    return;
  }
  if (!o.job || !named) die(usage);

  const record = translating(() => {
    const reviews = require('./reviews.js');
    let commits;
    try { commits = facts.commits || reviews.resolveCommits(o.commit, reviews.gitDeps(process.cwd())); }
    catch (error) {
      if (error instanceof reviews.ReviewRecordError) die(error.message);
      throw error;
    }
    // The job must exist before Keep will wait for it: a typo here would become a
    // review nobody is running and a card nobody can land.
    const job = facts.job || reviews.resolveJob(o.job, { root: ROOT });
    if (!job) die(`--job "${o.job}" is not a Codex job Keep can find — run keep codex-jobs to see the live ones`);
    const built = obligations.open({
      card: id, job: o.job, accountId: o.account || job.accountId, by: o.by,
      commits, note: o.m, session: commandSession(),
      ...(process.env.KEEP_REMOTE_CALLER ? { node: process.env.KEEP_REMOTE_CALLER } : {}),
    });
    // Under the registry lock, like every other writer of this file: the daemon's
    // sweep reads and rewrites it every five minutes, and an unlocked append is how a
    // brand-new gate disappears under the sweep's older copy.
    return withLock(() => obligations.append(id, built));
  });
  if (o.json) return console.log(JSON.stringify(record, null, 2));
  console.log(`${id}: waiting on review job ${record.job}${record.accountId ? ` (${record.accountId})` : ''} over ${record.commits.length} commit(s)`);
  console.log(`  keep allow ${id} land refuses these commits until a verdict is recorded (keep reviewed ${id} --job ${record.job} …)`);
  console.log(`  record: ${record.id}`);
};

commands.reviews = (argv) => {
  const o = parseArgs(argv, { json: 'bool' });
  const id = o._[0];
  if (!id || o._.length > 1) die('usage: keep reviews <card> [--json]');
  loadTask(id);
  const records = require('./reviews.js').readRecords(id);
  const obligations = require('./review-obligations.js');
  let pending;
  try { pending = obligations.readRecords(id).filter(obligations.isOpen); }
  catch (error) { die(error.message || String(error)); }
  if (o.json) return console.log(JSON.stringify({ id, records, pending }, null, 2));
  for (const record of pending) console.log(`pending: ${obligations.summaryLine(record)}`);
  if (!records.length) return console.log(`${id}: no review records — keep reviewed ${id} --commit <sha> --verdict clean`);
  for (const record of records) {
    console.log(`${record.at}  ${record.verdict.padEnd(8)} ${record.id}  by ${record.by}${record.route ? ` [${record.route}]` : ''}${record.job ? ` job ${record.job}` : ''}`);
    for (const commit of record.commits) console.log(`    ${commit.sha.slice(0, 12)}  ${commit.subject}`);
    if (record.evidence) console.log(`    evidence: ${record.evidence}`);
    if (record.message) console.log(`    ${record.message}`);
  }
};

const KEEP_TOOL_LAND_DEPLOYMENT_GUIDANCE = 'For keep-tool, wt land deploys a ready live checkout by fast-forwarding it and restarting the daemon; it reports any skipped or failed deployment, then watches daemon health for up to 90 seconds and names any scheduler that started failing, with the revert to run.';

commands.land = (argv) => {
  const o = parseArgs(argv, { json: 'bool', 'dry-run': 'bool' });
  const id = o._[0];
  if (!id || o._.length > 1) die('usage: keep land <card> [--dry-run] [--json]\n'
    + '  Checks keep allow <card> land, then runs wt land from the current worktree and cites the landed sha.\n'
    + `  ${KEEP_TOOL_LAND_DEPLOYMENT_GUIDANCE}`);
  const task = loadTask(id);
  const verdict = implicitLandVerdict(task);
  if (!verdict.ok) {
    if (o.json) console.log(JSON.stringify({ id, action: 'land', ...verdict, context: undefined }, null, 2));
    else process.stderr.write(`keep: not allowed: ${verdict.why}\n`);
    process.exitCode = 3;
    return;
  }
  const record = verdict.record || null;
  // An explicit `land` grant says Owner allowed it; it does not say there is a
  // landable worktree here. Without this, a granted card in an unusable tree
  // reached wt.landWorktree(undefined).
  const context = verdict.context;
  if (!context || !context.ok) {
    process.stderr.write(`keep: cannot land: ${(context && context.why) || 'no landable worktree here'}\n`);
    process.exitCode = 3;
    return;
  }
  if (o['dry-run']) {
    console.log(`allowed: ${verdict.why}`);
    for (const commit of context.commits || []) console.log(`  ${commit.sha.slice(0, 12)} ${commit.subject}`);
    console.log(`would run wt land in ${context.worktree}`);
    return;
  }
  const wt = require('./wt.js');
  let sha;
  // The deploy is handed back and run after the check-in, as the node path below
  // does: a keep-tool deploy restarts the daemon and then watches its health for a
  // couple of minutes, and the citation should not wait on that, or be lost with a
  // land whose caller gave up waiting.
  let deploy = null;
  try { sha = wt.landWorktree(context.worktree, { deferDeploy: (run) => { deploy = run; } }); }
  catch (error) { die(`wt land refused: ${error.message}`); }
  if (!sha) die('wt land had nothing to push');
  const cited = record ? ` (review record ${record.id})` : '';
  // The push already happened. A failure here loses the citation, not the land,
  // so say what to record by hand rather than dying with a stack.
  try {
    checkinTask(id, {
      message: `Landed ${context.branch} onto ${context.defaultBranch}${cited}.`,
      commits: [sha],
    });
  } catch (error) {
    process.stderr.write(`keep: landed ${sha} but the check-in failed: ${error.message}\n`
      + `keep: record it by hand — keep checkin ${id} --commit ${sha} -m "Landed ${context.branch} onto ${context.defaultBranch}${cited}."\n`);
  }
  if (deploy) deploy();
  if (o.json) return console.log(JSON.stringify({ id, landed: sha, record, why: verdict.why }, null, 2));
  console.log(`${id}: landed ${sha.slice(0, 12)} onto origin/${context.defaultBranch}${cited}`);
  console.log(`  ${KEEP_TOOL_LAND_DEPLOYMENT_GUIDANCE}`);
};

// What `keep land` on another node needs from the registry to decide a land where
// the worktree is: the card's grants, its review records, its open review
// obligations, and whether it has opted out of auto-land. Read-only, JSON only; an
// obligation store that cannot be read refuses, as it refuses a land here.
commands['land-facts'] = (argv) => {
  const o = parseArgs(argv, {});
  const id = o._[0];
  if (!id || o._.length > 1) die('usage: keep land-facts <card>');
  const task = loadTask(id);
  const reviews = require('./reviews.js');
  const obligations = require('./review-obligations.js');
  let open;
  try { open = obligations.readRecords(id).filter(obligations.isOpen); }
  catch (error) { die(error.message || String(error)); }
  console.log(JSON.stringify({
    id, grants: allow.readGrants(task).map(allow.formatToken), records: reviews.readRecords(id),
    obligations: open, optOut: reviews.optOutReason(task),
    // The card's allow_until, so a node's `keep allow <card> land` decides the explicit
    // grant exactly as allow.decide does here.
    until: String(task.fm.allow_until || ''),
  }));
};

// `keep land` on a pane-only node that knows its daemon. The worktree is here, so
// the range, the rebase and the push are too; the registry is on the daemon, so the
// facts the gate reads come from it (land-facts) and the landed check-in goes to it.
// The gate itself is implicitLandVerdict, the same one `keep land` runs, handed
// those facts in place of the files it would read. wt land deploys keep-tool by
// asking the daemon to deploy itself (wt.deployOnDaemon).
// The daemon's land-facts for a card, or null after printing the daemon's own answer
// and setting the exit status (no card, an unreadable store). `until` is required
// only by the callers that decide explicit grants with allow.decide.
async function fetchLandFacts(id, where, remote, { needUntil = false } = {}) {
  const facts = await remote.runRemote('land-facts', [id], { where });
  if (facts.code !== 0) {
    if (facts.stdout) process.stdout.write(facts.stdout);
    if (facts.stderr) process.stderr.write(facts.stderr);
    process.exitCode = facts.code;
    return null;
  }
  let value;
  try { value = JSON.parse(facts.stdout); } catch { die(`the daemon on ${where.daemon} answered land-facts with something that is not JSON`); }
  if (!value || value.id !== id || !Array.isArray(value.grants) || !Array.isArray(value.records)
    || !Array.isArray(value.obligations) || typeof value.optOut !== 'string'
    || (needUntil && typeof value.until !== 'string')) {
    die(`the daemon on ${where.daemon} answered land-facts for ${id} in a shape this keep does not read`);
  }
  return value;
}

// What implicitLandVerdict reads, from the daemon's facts instead of the files here.
function landFactsDeps(value, deps = {}) {
  const obligationApi = require('./review-obligations.js');
  return {
    records: value.records,
    optOut: value.optOut,
    obligations: { readRecords: () => value.obligations, outstandingFor: obligationApi.outstandingFor },
    ...(deps.context ? { context: deps.context } : {}),
  };
}

// `keep allow <card> land` on a node that knows its daemon: the question is about the
// worktree here, so it is answered here, from the daemon's facts, by the same code
// and in the same words as on the daemon node (answerAllow). Anything else `keep
// allow` does goes to the daemon (allowRemoteHandles says which).
function allowRemoteHandles(argv) {
  let o;
  try { o = parseArgs(argv, ALLOW_SPEC); } catch { return false; }
  const mutating = Boolean(o.grant || o.revoke || o.clear || o.until);
  return !mutating && o._.length === 2 && String(o._[1]).trim().toLowerCase() === 'land';
}

async function allowRemote(argv, where, deps = {}) {
  const remote = deps.remote || require('./remote-cli.js');
  const o = parseArgs(argv, ALLOW_SPEC);
  const [id, request] = o._;
  if (!id || o._.length !== 2) die(ALLOW_USAGE);
  const value = await fetchLandFacts(id, where, remote, { needUntil: true });
  if (!value) return;
  answerAllow(id, { id, fm: { allow: value.grants, allow_until: value.until } }, request, o, landFactsDeps(value, deps));
}

async function landRemote(argv, where, deps = {}) {
  const remote = deps.remote || require('./remote-cli.js');
  const o = parseArgs(argv, { json: 'bool', 'dry-run': 'bool' });
  const id = o._[0];
  if (!id || o._.length > 1) die('usage: keep land <card> [--dry-run] [--json]\n'
    + '  Checks keep allow <card> land, then runs wt land from the current worktree and cites the landed sha.\n'
    + `  ${KEEP_TOOL_LAND_DEPLOYMENT_GUIDANCE}`);
  const value = await fetchLandFacts(id, where, remote);
  if (!value) return;
  const verdict = implicitLandVerdict({ id, fm: { allow: value.grants } }, landFactsDeps(value, deps));
  if (!verdict.ok) {
    if (o.json) console.log(JSON.stringify({ id, action: 'land', ...verdict, context: undefined }, null, 2));
    else process.stderr.write(`keep: not allowed: ${verdict.why}\n`);
    process.exitCode = 3;
    return;
  }
  const record = verdict.record || null;
  const context = verdict.context;
  if (!context || !context.ok) {
    process.stderr.write(`keep: cannot land: ${(context && context.why) || 'no landable worktree here'}\n`);
    process.exitCode = 3;
    return;
  }
  if (o['dry-run']) {
    console.log(`allowed: ${verdict.why}`);
    for (const commit of context.commits || []) console.log(`  ${commit.sha.slice(0, 12)} ${commit.subject}`);
    console.log(`would run wt land in ${context.worktree}`);
    return;
  }
  const wt = deps.wt || require('./wt.js');
  let deploy = null;
  let sha;
  try { sha = wt.landWorktree(context.worktree, { deferDeploy: (run) => { deploy = run; } }); }
  catch (error) { die(`wt land refused: ${error.message}`); }
  if (!sha) die('wt land had nothing to push');
  const cited = record ? ` (review record ${record.id})` : '';
  const message = `Landed ${context.branch} onto ${context.defaultBranch}${cited}.`;
  // The check-in goes first: deploy-self answers and then restarts the daemon, so a
  // check-in sent after it would meet a daemon on its way down.
  const checkin = await remote.runRemote('checkin', [id, '--commit', sha, '-m', message], { where });
  if (checkin.code !== 0) {
    const why = String(checkin.stderr || '').trim().split('\n').pop() || `exit ${checkin.code}`;
    process.stderr.write(`keep: landed ${sha} but the check-in failed: ${why}\n`
      + `keep: record it by hand — keep checkin ${id} --commit ${sha} -m "${message}"\n`);
  }
  if (deploy) {
    const deployed = deploy();
    if (deployed && typeof deployed.then === 'function') await deployed;
  }
  if (o.json) return console.log(JSON.stringify({ id, landed: sha, record, why: verdict.why }, null, 2));
  console.log(`${id}: landed ${sha.slice(0, 12)} onto origin/${context.defaultBranch}${cited}`);
  console.log(`  ${KEEP_TOOL_LAND_DEPLOYMENT_GUIDANCE}`);
}

// ---------- shadow decisions ----------

commands.decide = (argv) => {
  const decisions = require('./decisions.js');
  const o = parseArgs(argv, { type: 'str', card: 'str', session: 'str', send: 'str' });
  const type = o.type || o._[0];
  if (!type || !o.m) {
    die('usage: keep decide <type> [--card <id>] [--session <sid>] --send "<the exact message>" -m "why"\n'
      + `types: ${Object.entries(decisions.TYPES).map(([name, gloss]) => `${name} (${gloss})`).join('\n       ')}`);
  }
  let entry;
  try {
    entry = decisions.record({
      type, card: o.card, session: o.session, why: o.m, message: o.send,
      reviewer: process.env.KEEP_REVIEWER_NAME || (isReviewerSession() ? 'reviewer' : ''),
    });
  } catch (error) {
    if (error instanceof decisions.DecisionError) die(error.message);
    throw error;
  }
  console.log(entry.id);
  console.log('recorded, not sent — Owner marks it with keep decisions agree|disagree|edit ' + entry.id);
};

commands.decisions = (argv) => {
  const decisions = require('./decisions.js');
  const verb = ['agree', 'disagree', 'edit'].includes(argv[0]) ? argv[0] : null;
  if (verb) {
    const o = parseArgs(argv.slice(1), {});
    const id = o._[0];
    if (!id) die(`usage: keep decisions ${verb} <id>${verb === 'agree' ? ' [-m note]' : ' -m "why"'}`);
    let entry;
    try { entry = decisions.judge(id, verb, o.m); }
    catch (error) {
      if (error instanceof decisions.DecisionError) die(error.message);
      throw error;
    }
    return console.log(`${entry.id} ${verb}${entry.note ? `: ${entry.note}` : ''}`);
  }
  if (argv[0] === 'stats') {
    const o = parseArgs(argv.slice(1), { json: 'bool' });
    const result = decisions.stats(decisions.loadSafe());
    return console.log(o.json ? JSON.stringify(result, null, 2) : decisions.renderStats(result));
  }
  const o = parseArgs(argv, { all: 'bool', type: 'str', json: 'bool', verbose: 'bool' });
  if (o.type && !decisions.TYPES[o.type]) die(`--type must be one of: ${Object.keys(decisions.TYPES).join(', ')}`);
  let all;
  try { all = decisions.load(); }
  catch (error) {
    if (error instanceof decisions.DecisionError) die(error.message);
    throw error;
  }
  const rows = all
    .filter((entry) => (o.all || !entry.verdict) && (!o.type || entry.type === o.type))
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  if (o.json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log(o.all ? 'no decisions' : 'no decisions awaiting your verdict');
  for (const entry of rows) console.log(decisions.formatDecision(entry, { verbose: o.verbose !== false }));
};

commands.hold = (argv) => {
  const o = parseArgs(argv, { for: 'str', task: 'str', scope: 'list' });
  const scopes = require('./hold-scopes').parse(o.scope);
  if (o._.length !== 1 || !o.for || !o.m) {
    die('usage: keep hold <project> --for +15m -m "why" [--task <id>]');
  }
  if (!/^\+\d+[mhdw]$/i.test(o.for)) die('--for must be a duration such as +15m, +2h, or +1d');
  const project = resolveProjectArg(o._[0]);
  const reason = cleanScalar(o.m, 'reason');
  const until = parseWhen(o.for);
  if (o.task) loadTask(o.task);
  const session = commandSession();
  const hold = {
    id: `hold-${Date.now().toString(36)}`,
    project,
    by: { sessionId: session ? session.id : '', agent: session ? session.agent : 'manual' },
    scopes,
    task: o.task || '',
    reason,
    from: nowStamp(),
    until,
    released: false,
  };
  writeJsonAtomic(holdFile(hold.id), hold);
  if (o.task) {
    checkinTask(o.task, {
      heading: 'hold',
      message: `Holding ${project} [${require('./hold-scopes').label(hold)}] until ${until}: ${reason}`,
    });
  }
  console.log(`${hold.id}: ${project} [${require('./hold-scopes').label(hold)}] held until ${until} by ${hold.by.agent}${hold.by.sessionId ? ` session ${sessionRef(hold.by.sessionId)}` : ''} — ${reason}`);
};

commands.release = (argv) => {
  const o = parseArgs(argv, {});
  if (o._.length !== 1) die('usage: keep release <hold-id>');
  const file = holdFile(o._[0]);
  let hold;
  try { hold = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { die(`no hold "${o._[0]}"`); }
  if (!hold.released) {
    hold.released = nowStamp();
    writeJsonAtomic(file, hold);
    if (hold.task) {
      checkinTask(hold.task, {
        heading: 'hold released',
        message: `Released ${hold.project}: ${hold.reason}`,
      });
    }
  }
  console.log(`released ${hold.id}`);
};

commands.holds = (argv) => {
  const o = parseArgs(argv, {});
  if (o._.length) die('usage: keep holds');
  const holds = activeHolds();
  if (!holds.length) return console.log('no active holds');
  for (const hold of holds) {
    const by = hold.by || {};
    console.log(`${hold.id}  ${hold.project}  [${require('./hold-scopes').label(hold)}]  until ${hold.until}  ${by.agent || 'manual'}${by.sessionId ? ` ${sessionRef(by.sessionId)}` : ''}  ${hold.reason}`);
  }
};

// ---------- declared shared resources ----------

const RESOURCE_USAGE = [
  '  keep resources <project>',
  '  keep resources <project> --add <name> [--title t] [--command <re>]… [--path <glob>]… [--deploy <kind:target>]… [--note-for +2h]',
  '  keep resources <project> --remove <name>',
  '  keep resources --check <project> "<command>"',
].join('\n');

function renderResourceRegistry(registry) {
  const resources = require('./resources.js');
  const names = Object.keys(registry.resources || {}).sort();
  const lines = [`Shared resources declared on ${registry.project}:`];
  if (!names.length) lines.push('  (none)');
  for (const name of names) {
    const declaration = registry.resources[name] || {};
    const title = resources.titleOf(declaration);
    lines.push(`  ${name}${title ? ` — ${title}` : ''}`
      + `  · note for ${resources.noteForOf(declaration)}`);
    for (const pattern of declaration.commands || []) lines.push(`      command: ${pattern}`);
    for (const pattern of declaration.paths || []) lines.push(`      path:    ${pattern}`);
    for (const pattern of declaration.deploys || []) lines.push(`      deploy:  ${pattern}`);
  }
  lines.push(`Write a state note when you change one: keep note ${path.basename(registry.project)} --scope <name> -m "..." --for +2h`);
  return lines.join('\n');
}

commands.resources = (argv) => {
  const resources = require('./resources.js');
  const o = parseArgs(argv, {
    add: 'str', remove: 'str', title: 'str', command: 'list', path: 'list', deploy: 'list',
    'note-for': 'str', check: 'str', json: 'bool',
  });

  // --check reads: which declarations does this command touch? Nothing is
  // written and nothing is judged; it exists so a declaration can be tested by
  // hand before a watcher observation is the first thing that reads it.
  if (o.check !== undefined) {
    const project = resolveProjectArg(o.check);
    const command = o._.join(' ').trim();
    if (!command) die(RESOURCE_USAGE);
    const registry = resources.loadResources(project);
    if (!registry) die(`no resources registry for ${project}`);
    const touched = resources.touchedResources({ commands: [command], files: [], deploys: deployCommand(command) ? [deployCommand(command)] : [] }, registry);
    if (o.json) return console.log(JSON.stringify({ project: registry.project, command, touched }, null, 2));
    if (!touched.length) return console.log(`no declared resource matches: ${command}`);
    for (const line of resources.describeTouched(touched)) console.log(line);
    return;
  }

  if (o._.length !== 1) die(RESOURCE_USAGE);
  const project = resolveProjectArg(o._[0]);

  if (o.add !== undefined && o.remove !== undefined) die('pass one of --add or --remove');

  if (o.remove !== undefined) {
    const registry = resources.loadResources(project);
    if (!registry || !registry.resources[o.remove]) die(`no resource "${o.remove}" declared on ${project}`);
    const next = { ...registry.resources };
    delete next[o.remove];
    resources.saveResources(registry.project, next);
    return console.log(`removed ${o.remove} from ${registry.project}`);
  }

  if (o.add !== undefined) {
    const name = String(o.add);
    if (!resources.validName(name)) {
      die(`"${name}" is not a resource label — use lowercase letters, digits, "-" and ":" (e.g. staging, sandbox-hosts)`);
    }
    for (const pattern of o.command || []) {
      try { new RegExp(pattern, 'i'); }
      catch (error) { die(`--command ${pattern} is not a valid regex: ${error.message}`); }
    }
    if (o['note-for'] && !/^\+\d+[mhdw]$/i.test(o['note-for'])) {
      die('--note-for must be a duration such as +2h');
    }
    const registry = resources.loadResources(project);
    const declaration = { ...(registry && registry.resources[name]) || {} };
    if (o.title) declaration.title = resources.clean(cleanScalar(o.title, 'title'), 120);
    if (o.command) declaration.commands = [...new Set([...(declaration.commands || []), ...o.command])];
    if (o.path) declaration.paths = [...new Set([...(declaration.paths || []), ...o.path])];
    if (o.deploy) declaration.deploys = [...new Set([...(declaration.deploys || []), ...o.deploy])];
    if (o['note-for']) declaration.noteFor = o['note-for'];
    const next = { ...(registry && registry.resources) || {}, [name]: declaration };
    const saved = resources.saveResources(registry ? registry.project : project, next);
    return console.log(`${name} declared on ${saved.project} (${saved.file})`);
  }

  const registry = resources.loadResources(project);
  if (!registry) {
    if (o.json) return console.log(JSON.stringify({ project: normalizeProjectPath(project), resources: {} }, null, 2));
    return console.log(`no shared resources declared on ${project} — declare one with:\n${RESOURCE_USAGE.split('\n')[1]}`);
  }
  if (o.json) return console.log(JSON.stringify({ project: registry.project, resources: registry.resources }, null, 2));
  console.log(renderResourceRegistry(registry));
};

// ---------- state notes ----------

const NOTE_USAGE = [
  '  keep note <project> --scope <resource> [--scope ...] -m "what is true now" --for +2h [--task <card>]',
  '  keep note --extend <id> --for +2h',
  '  keep note --clear <id> [-m why]',
].join('\n');

// A note is information, so the daemon carries it to the siblings who need it and
// a daemon that is down costs the broadcast, never the note. Same shape as
// notifyStepWaiters: best effort, one line on failure, exit 0.
async function announceNote(note) {
  try {
    // No event: the daemon reads it off the note, so a replayed request cannot
    // tell the fleet a constraint was lifted when it was not.
    const response = await postKeepApi('/api/notes/announce', { id: note.id }, 5e3);
    if (response.status === 409) return console.log('already broadcast; nothing sent twice');
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    let sent = 0;
    try { sent = (JSON.parse(response.data).sent || []).length; } catch {}
    if (sent) console.log(`told ${sent} sibling session${sent === 1 ? '' : 's'} in this project`);
  } catch (error) {
    console.log(`not broadcast (${error.message}); the note is recorded and shows at session start`);
  }
}

function noteScopes(project, requested) {
  const scopes = require('./hold-scopes').parse(requested);
  if (!scopes.length) die(`a note needs at least one --scope\n${NOTE_USAGE}`);
  const resources = require('./resources.js');
  const declarations = resources.loadResources(project);
  const declared = declarations ? resources.declaredNames(declarations) : [];
  if (!declared.length) return scopes; // nothing declared: the label rules are all there is
  const unknown = scopes.filter((scope) => !declared.includes(scope));
  if (unknown.length) {
    die(`${unknown.join(', ')} ${unknown.length === 1 ? 'is not a resource' : 'are not resources'} declared on ${declarations.project}`
      + `\ndeclared here: ${declared.join(', ')}`
      + `\ndeclare another with: keep resources ${path.basename(declarations.project)} --add <name> --command <re>`);
  }
  return scopes;
}

commands.note = async (argv) => {
  const notes = require('./notes.js');
  const o = parseArgs(argv, { scope: 'list', for: 'str', task: 'str', extend: 'str', clear: 'str' });

  if (o.extend !== undefined) {
    if (!o.for || !/^\+\d+[mhdw]$/i.test(o.for)) die('usage: keep note --extend <id> --for +2h');
    const existing = notes.findNote(o.extend);
    if (!existing) die(`no state note "${o.extend}"`);
    if (existing.cleared) die(`${existing.id} was cleared at ${existing.cleared}`);
    const note = notes.extendNote(o.extend, parseWhen(o.for));
    if (!note) die(`${o.extend} could not be extended; it may have just been cleared`);
    console.log(`${note.id}: extended until ${note.until} (its expiry nag is reset)`);
    return announceNote(note);
  }

  if (o.clear !== undefined) {
    const existing = notes.findNote(o.clear);
    if (!existing) die(`no state note "${o.clear}"`);
    if (existing.cleared) return console.log(`${existing.id} was already cleared at ${existing.cleared}`);
    // A warning, not a refusal: whoever can see that a statement is no longer
    // true should be able to say so, whether or not they wrote it.
    const author = (existing.by && existing.by.sessionId) || '';
    const clearing = commandSession();
    if (author && clearing && clearing.id !== author) {
      console.log(`note: ${existing.id} was written by ${(existing.by && existing.by.agent) || 'another session'}`
        + ` ${author.slice(0, 8)} — clearing someone else's statement about shared state.`);
    }
    const note = notes.clearNote(o.clear, o.m ? cleanScalar(o.m, 'reason') : '');
    if (!note) die(`${o.clear} could not be cleared; it may have just been removed`);
    console.log(`${note.id}: cleared`);
    return announceNote(note);
  }

  if (o._.length !== 1 || !o.m || !o.for) die(NOTE_USAGE);
  if (!/^\+\d+[mhdw]$/i.test(o.for)) die('--for must be a duration such as +15m, +2h, or +1d');
  const project = resolveProjectArg(o._[0]);
  const scopes = noteScopes(project, o.scope);
  const message = cleanScalar(o.m, 'message');
  if (o.task) loadTask(o.task);
  const session = commandSession();
  const note = notes.addNote({
    project,
    scopes,
    by: { sessionId: session ? session.id : '', agent: session ? session.agent : 'manual' },
    task: o.task || '',
    message,
    until: parseWhen(o.for),
  });
  if (o.task) {
    checkinTask(o.task, {
      heading: 'state note',
      message: `State note on ${project} [${scopes.join(', ')}] until ${note.until}: ${note.message}`,
    });
  }
  console.log(`${note.id}: ${project} [${scopes.join(', ')}] until ${note.until} — ${note.message}`);
  console.log('Information only; nothing is blocked by a note. Clear it early with keep note --clear ' + note.id + '.');
  return announceNote(note);
};

commands.notes = (argv) => {
  const notes = require('./notes.js');
  const o = parseArgs(argv, { all: 'bool', json: 'bool', scope: 'list' });
  if (o._.length > 1) die('usage: keep notes [<project>] [--all] [--json]');
  // null, not '': activeNotes reads an empty string as "no project" and returns
  // nothing, so a fleet-wide listing has to say so explicitly.
  const project = o._.length ? resolveProjectArg(o._[0]) : null;
  const scopes = require('./hold-scopes').parse(o.scope);
  const { active, expired } = notes.activeNotes(project, Date.now(), scopes.length ? { scope: scopes } : {});
  const cleared = o.all
    ? notes.allNotes().filter((note) => note.cleared && Date.now() - Date.parse(note.cleared) <= 24 * 3600e3
      && (!project || normalizeProjectPath(note.project) === normalizeProjectPath(project)))
    : [];
  if (o.json) return console.log(JSON.stringify({ active, expired: o.all ? expired : [], cleared }, null, 2));
  if (!active.length && !(o.all && (expired.length || cleared.length))) {
    return console.log(project ? `no state notes on ${project}` : 'no state notes');
  }
  for (const note of active) console.log(`${note.id}  ${note.project}  ${notes.describeNote(note)}`);
  if (o.all) {
    for (const note of expired) console.log(`${note.id}  ${note.project}  ${notes.describeNote(note)}  [expired, unconfirmed]`);
    for (const note of cleared) console.log(`${note.id}  ${note.project}  ${notes.describeNote(note)}  [cleared ${note.cleared}]`);
  } else if (expired.length) {
    console.log(`${expired.length} expired, unconfirmed (keep notes --all)`);
  }
};


function alertText(value) {
  if (value == null || !String(value).trim()) die('an alert needs -m "text"');
  const text = String(value).trim();
  if (/\r|\n/.test(text)) die('alert text must be one line');
  if (text.length > 600) die('alert text must be at most 600 characters');
  return text;
}

function briefSnapshot(now = Date.now()) {
  const alerts = require('./alerts.js');
  const lintTool = require('./lint.js');
  const tasks = loadAll(false);
  const holds = activeHolds(null, now);
  const stepSnapshots = stepRegistry.registeredSteps().map((registry) => stepRegistry.status(registry.project, {
    tasks,
    holds: holds.filter((hold) => normalizeProjectPath(hold.project) === normalizeProjectPath(registry.project)),
  })).filter(Boolean);
  const meta = alerts.loadMeta(ROOT);
  const lintFile = path.join(META, 'lint.json');
  let hygiene = null;
  try {
    if (fs.existsSync(lintFile)) {
      const stat = fs.statSync(lintFile);
      if (now - stat.mtimeMs < 20 * 3600e3) hygiene = JSON.parse(fs.readFileSync(lintFile, 'utf8'));
    }
    if (!hygiene || !Array.isArray(hygiene.findings)) hygiene = lintTool.lint({ now, root: ROOT });
  } catch (error) {
    const detail = String(error && error.message || error).replace(/\s+/g, ' ').trim();
    process.stderr.write(`keep: could not load hygiene findings: ${detail}\n`);
    hygiene = null;
  }
  return alerts.buildBrief({
    tasks,
    decisions: require('./decisions.js').loadSafe(),
    alerts: alerts.readAlerts({ root: ROOT, all: true }),
    findings: alerts.loadReviewFindings(ROOT, now),
    holds,
    notes: require('./notes.js').activeNotes(null, now),
    steps: stepSnapshots,
    unblocked: require('./unblock.js').readRecords({ root: ROOT }).filter((record) => !record.deliveredAt),
    health: require('./health.js').snapshot(now),
    hygiene: hygiene && hygiene.findings,
    lastBriefAt: meta.lastBriefAt,
    now,
  });
}

commands.alert = async (argv) => {
  const o = parseArgs(argv, { level: 'str', key: 'str', card: 'str', from: 'str', dry: 'bool', force: 'bool' });
  if (o._.length) die('usage: keep alert -m "text" --level attention|urgent [--key k] [--card id] [--from name] [--dry]');
  const text = alertText(o.m);
  const level = String(o.level || '');
  if (!['attention', 'urgent'].includes(level)) die('--level must be one of: attention, urgent');
  const reviewer = isReviewerSession();
  const session = commandSession();
  const caller = reviewer ? 'reviewer' : session ? `session:${session.agent}` : 'manual';
  let from = cleanScalar(o.from || (reviewer ? 'reviewer' : 'manual'), 'from');
  if (!reviewer && from === 'reviewer') from = 'manual (claimed reviewer)';
  const key = cleanScalar(o.key, 'key');
  if (from && from.length > 80) die('from must be at most 80 characters');
  if (key && key.length > 200) die('key must be at most 200 characters');
  if (o.card) loadTask(o.card);
  const alerts = require('./alerts.js');
  const result = await alerts.sendAlert({
    root: ROOT,
    level,
    text,
    key,
    card: o.card,
    from,
    caller,
    force: o.force,
    dry: o.dry,
    withLock,
  });
  if (o.dry) {
    console.log(result.deferred ? `deferred: ${result.why}` : `would use: ${result.channels.join(', ') || 'none'}`);
    return;
  }
  if (result.entry && o.card) {
    checkinTask(o.card, {
      heading: 'alert',
      message: `alert (${level}): ${text}`,
      linkSession: false,
    });
  }
  if (!result.ok) {
    const error = new KeepError(result.why);
    error.exitCode = result.dropped ? 4 : 5;
    throw error;
  }
  console.log(result.deferred ? `deferred: ${result.entry.why}` : `channels: ${result.channels.join(', ') || 'none'}`);
};

commands.quiet = (argv) => {
  const o = parseArgs(argv, {});
  if (o._.length !== 1) die('usage: keep quiet <duration>|off');
  const alerts = require('./alerts.js');
  if (String(o._[0]).toLowerCase() === 'off') {
    alerts.setQuiet(null, ROOT);
    console.log('quiet off');
    return;
  }
  const until = parseWhen(o._[0]);
  alerts.setQuiet(until, ROOT);
  console.log(`quiet until ${until}`);
};

commands.alerts = (argv) => {
  const o = parseArgs(argv, { all: 'bool' });
  if (o._.length) die('usage: keep alerts [--all]');
  const entries = require('./alerts.js').readAlerts({ root: ROOT, all: o.all });
  if (!entries.length) return console.log('no alerts');
  for (const entry of entries) {
    const outcome = entry.deferred ? `deferred${entry.why ? ` (${entry.why})` : ''}` : (entry.channels || []).join(', ') || 'no channel';
    console.log(`${new Date(entry.at).toLocaleString()}  ${entry.level}  ${entry.from || 'unknown'}  ${outcome}  ${entry.text}`);
  }
};

commands.lint = (argv) => {
  const o = parseArgs(argv, { json: 'bool', rule: 'str', 'fix-hints': 'bool' });
  if (o._.length) die('usage: keep lint [--json] [--rule <name>] [--fix-hints]');
  const lintTool = require('./lint.js');
  if (o.rule && !lintTool.RULE_NAMES.includes(o.rule)) {
    die(`unknown lint rule "${o.rule}" — use one of: ${lintTool.RULE_NAMES.join(', ')}`);
  }
  const result = lintTool.lint({ root: ROOT, rule: o.rule });
  if (o.json) return process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  for (const item of result.findings) {
    const hint = o['fix-hints'] && item.fix ? ` — fix: ${item.fix}` : '';
    console.log(`${item.severity} ${item.rule} ${item.id} — ${item.text}${hint}`);
  }
};

commands.brief = async (argv) => {
  const o = parseArgs(argv, { send: 'bool' });
  if (o._.length) die('usage: keep brief [--send]');
  const now = Date.now();
  const brief = briefSnapshot(now);
  console.log(brief.text);
  if (!o.send) return;
  const result = await require('./alerts.js').sendAlert({
    root: ROOT,
    level: 'brief',
    key: `brief:${require('./alerts.js').dayOf(now)}`,
    text: brief.text,
    spoken: brief.spoken,
    from: 'manual',
    caller: 'manual',
    now,
    withLock,
    allowBriefDuplicate: true,
  });
  console.log(`channels: ${result.channels.join(', ') || 'none'}`);
};

commands.health = (argv) => {
  const o = parseArgs(argv, { json: 'bool' });
  if (o._.length) die('usage: keep health [--json]');
  const health = require('./health.js');
  const value = health.snapshot();
  if (o.json) process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  else console.log(health.render(value));
};

// Whether the session a self-repair entry recorded is still running: true, false,
// or null for "the host could not be asked". Matched by session id as well as pane
// id, because an in-place restart moves a live session to a new pane. Never dies:
// no host is an answer here, not an error.
async function repairSessionAlive(entry, deps = {}) {
  if (!entry || (!entry.pane && !entry.sessionId)) return false;
  let client;
  try { client = await (deps.connectHost || require('./hostclient.js').connect)({ sock: deps.sock }); }
  catch { return null; }
  try {
    const { panes } = await client.request('list');
    // An empty list is a host that told us nothing useful, not a host with no panes.
    if (!Array.isArray(panes) || !panes.length) return null;
    const match = panes.find((pane) => pane && (pane.id === entry.pane
      || (entry.sessionId && pane.meta && pane.meta.sessionId === entry.sessionId)));
    // `alive` only, not `agentAlive`: that annotation is added by the daemon when it
    // lists panes, and a plain CLI client never sees it. So this errs conservative —
    // a pane whose agent has died but whose shell is up still reads as alive, and
    // the reset is refused. Refusing a reset Owner can repeat is the cheap mistake;
    // clearing the record out from under a running repair agent is not.
    return Boolean(match && match.alive);
  } catch { return null; }
  finally { try { client.close(); } catch {} }
}

function describeResetWait(entry) {
  const selfRepair = require('./self-repair.js');
  const left = selfRepair.LEGACY_RUN_TTL_MS - (Date.now() - (Number(entry && entry.lastAttemptAt) || 0));
  return left > 0 ? `${Math.ceil(left / 60000)}m` : 'a moment';
}

commands['self-repair'] = async (argv) => {
  const o = parseArgs(argv, { json: 'bool', dry: 'bool', reset: 'str', disable: 'bool', enable: 'bool' });
  if (o._.length) die('usage: keep self-repair [--dry] [--json] [--reset <signature>] [--disable|--enable]');
  if (o.disable && o.enable) die('pass either --disable or --enable, not both');
  const selfRepair = require('./self-repair.js');
  if (o.disable || o.enable) {
    const config = selfRepair.saveConfig({ enabled: Boolean(o.enable) });
    if (o.json) return process.stdout.write(JSON.stringify(config, null, 2) + '\n');
    return console.log(`self-repair ${config.enabled ? 'enabled' : 'disabled'} in ${selfRepair.configFile(ROOT)}`);
  }
  if (o.reset) {
    // Ask the host whether the recorded session is still running before clearing
    // anything: a reset over a live repair agent takes its KEEP_REPAIR marker away
    // and lets the next tick open a second card on the same fault.
    const entry = selfRepair.loadState(ROOT).signatures[o.reset];
    const sessionAlive = await repairSessionAlive(entry);
    const result = selfRepair.reset(o.reset, { root: ROOT, sessionAlive });
    if (o.json) return process.stdout.write(JSON.stringify({ signature: o.reset, sessionAlive, ...result }, null, 2) + '\n');
    if (!result.found) return console.log(`no such signature: ${o.reset}`);
    if (result.reason === 'session-alive') {
      return console.log(`${o.reset} still has a repair session running (${entry.sessionId ? `session ${sessionRef(entry.sessionId)}, ` : ''}pane ${entry.pane || '?'})`
        + `\nwait for it, or close the pane (keep pane kill ${entry.pane || '<pane>'}), then reset`);
    }
    if (result.reason === 'unverified') {
      return console.log(`${o.reset} has a repair session that could not be confirmed either way (pane ${entry.pane || '?'})`
        + `\nthe terminal host could not be reached; check the pane, then reset — or wait ${describeResetWait(entry)}`);
    }
    if (!result.cleared) {
      // `launched` distinguishes a real session from a legacy runId-only entry,
      // which has no session at all and must not be described as having one.
      const what = result.launched ? 'a confirmed session' : 'a legacy run record';
      return console.log(`${o.reset} has a live repair card (${result.cardId}${result.status ? `, ${result.status}` : ''}) with ${what}`
        + `\none repair card per signature — let it finish, or close the card if it is not going to`);
    }
    return console.log(`cleared ${o.reset}; the next tick may open a fresh card for it`);
  }
  if (o.dry) {
    const value = await selfRepair.dryRun({ root: ROOT });
    if (o.json) return process.stdout.write(JSON.stringify(value, null, 2) + '\n');
    return console.log(selfRepair.renderDry(value));
  }
  const value = selfRepair.status({ root: ROOT });
  if (o.json) return process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  console.log(selfRepair.renderStatus(value));
};

commands.stalled = (argv) => {
  const o = parseArgs(argv, { json: 'bool' });
  if (o._.length) die('usage: keep stalled [--json]');
  const stalled = require('./stalled.js');
  const items = stalled.readCurrent({ root: ROOT });
  if (o.json) process.stdout.write(JSON.stringify(items, null, 2) + '\n');
  else console.log(stalled.render(items));
};

function codexJobDuration(ms) {
  const minutes = Math.max(0, Number(ms) || 0) / 60e3;
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  if (minutes < 90) return `${Math.round(minutes)}m`;
  return `${Math.round(minutes / 60)}h`;
}

function codexJobBytes(value) {
  const amount = Math.max(0, Number(value) || 0);
  if (amount < 1024) return `${amount} B`;
  return `${(amount / 1024).toFixed(amount < 10 * 1024 ? 1 : 0)} KB`;
}

function codexJobText(value) {
  return String(value ?? '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, '');
}

function renderCodexJobs(result) {
  const lines = [];
  if (result.discovery === 'unknown') lines.push('Codex companion discovery is unknown.');
  if (result.discovery === 'partial') lines.push('Codex companion discovery is partial.');
  const rows = result.jobs.map((job) => [
    codexJobText(job.id),
    codexJobText(job.accountId || 'legacy'),
    codexJobText(job.reason ? `${job.state} (${job.reason})` : job.state),
    codexJobDuration(job.idleMs),
    codexJobBytes(job.logBytes),
    codexJobText(job.summary).replace(/\s+/g, ' ').slice(0, 60),
  ]);
  const headings = ['id', 'account', 'state', 'idle', 'log size', 'summary'];
  const widths = headings.map((heading, index) => Math.max(heading.length, ...rows.map((row) => row[index].length)));
  lines.push(headings.map((heading, index) => heading.padEnd(widths[index])).join('  '));
  for (const row of rows) lines.push(row.map((value, index) => value.padEnd(widths[index])).join('  '));
  for (const orphan of result.orphans) {
    lines.push(`orphan pid ${codexJobText(orphan.pid)} (${codexJobText(orphan.etime)}) job ${codexJobText(orphan.jobId)}`);
  }
  for (const agent of result.orphanAgents?.agents || []) {
    lines.push(`orphan ${codexJobText(agent.agent)} pid ${agent.pid}: ${codexJobText(agent.reason)} (${codexJobText(agent.cwd)})`);
  }
  if (result.orphanAgents?.known === false) lines.push(`Orphan agent discovery unavailable: ${codexJobText(result.orphanAgents.reason)}`);
  lines.push('', 'brokers', 'pid  account  age  state  reason  cwd');
  for (const broker of result.brokers || []) {
    lines.push([broker.pid ?? '-', broker.accountId || 'legacy', broker.etime ?? '-', broker.state,
      broker.reason, broker.cwd ?? '-'].map(codexJobText).join('  '));
  }
  return lines.join('\n');
}

commands['codex-jobs'] = async (argv) => {
  const o = parseArgs(argv, { json: 'bool', reap: 'bool', dry: 'bool' });
  if (o._.length || (o.dry && !o.reap)) die('usage: keep codex-jobs [--json] [--reap] [--dry]');
  if (o.reap && isReviewerSession()) die('the fleet reviewer may list Codex jobs but may not reap them');
  const codexJobs = require('./codexjobs.js');
  const codexBrokers = require('./codexbrokers.js');
  if (o.reap) {
    const result = await codexJobs.reap({ dry: o.dry, deps: { includeAgents: true } });
    result.brokers = await codexBrokers.reap({ dry: o.dry });
    if (o.json) return process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    for (const item of result.brokers.shutdown) console.log(`${o.dry ? 'would shut down' : 'shut down'} broker ${codexJobText(item.pid ?? item.stateDir)} (${codexJobText(item.reason)}) ${codexJobText(item.cwd)}`);
    for (const item of result.brokers.skipped) console.log(`skipped broker ${codexJobText(item.pid ?? item.stateDir)}: ${codexJobText(item.why)}`);
    for (const id of result.cancelled) console.log(`${o.dry ? 'would cancel' : 'cancelled'} ${codexJobText(id)}`);
    for (const pid of result.killed) console.log(`${o.dry ? 'would kill' : 'killed'} pid ${codexJobText(pid)}`);
    for (const item of result.skipped) {
      console.log(`skipped ${codexJobText(item.id || `pid ${item.pid}`)}: ${codexJobText(item.why)}`);
    }
    return;
  }

  const result = await codexJobs.list({ includeAgents: true });
  result.brokers = await codexBrokers.list();
  if (o.json) return process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  console.log(renderCodexJobs(result));
};

commands.leftovers = async (argv) => {
  const o = parseArgs(argv, { json: 'bool', reap: 'bool', dry: 'bool' });
  if (o._.length || (o.dry && !o.reap)) die('usage: keep leftovers [--json] [--reap] [--dry]');
  if (o.reap && isReviewerSession()) die('the fleet reviewer may list leftover processes but may not stop them');
  const leftovers = require('./leftover-processes.js');
  // Asked for by hand, a leftover is stopped once its pane has been gone for the grace
  // period. A closed pane has no exit time and this run has not watched it, so its
  // tree stays in grace; the daemon's sweep, which has, handles it.
  const deps = { keepRoot: ROOT, graceMs: Number(process.env.KEEP_LEFTOVER_GRACE_MIN || 15) * 60e3 };
  if (o.reap) {
    const result = await leftovers.reap({ dry: o.dry, deps });
    if (o.json) return process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    for (const item of result.stopped) console.log(`${o.dry ? 'would stop' : 'stopped'} ${leftovers.describe(item)}`);
    for (const item of result.waiting) console.log(`in grace ${leftovers.describe(item)}`);
    for (const item of result.skipped) console.log(`skipped ${item.pid ? `pid ${item.pid}` : 'sweep'}: ${item.why}`);
    if (!result.stopped.length && !result.waiting.length && !result.skipped.length) console.log('no leftover processes');
    return;
  }
  const result = await leftovers.list(deps);
  if (o.json) return process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.known) die(`leftover discovery unavailable: ${result.reason}`);
  for (const item of result.leftovers) console.log(`${item.due ? 'due' : 'in grace'} ${leftovers.describe(item)}`);
  if (!result.leftovers.length) console.log('no leftover processes');
};

commands.codex = async (argv) => {
  try {
    const result = await require('./codex-companion-account.js').run(argv, { root: ROOT, env: process.env });
    if (result.code) process.exitCode = result.code;
  } catch (error) { die(error.message || String(error)); }
};

function renderPiJob(job) {
  const parent = job.parentSession ? `${job.parentSession.agent} ${sessionRef(job.parentSession.id)}` : '-';
  const detail = job.error ? ` (${job.error})` : '';
  return `${job.id}  ${job.status}${detail}  parent ${parent}  ${job.summary}`;
}

commands.pi = async (argv) => {
  const action = argv[0];
  const args = argv.slice(1);
  const piJobs = require('./pi-jobs.js');
  if (action === 'task') {
    const o = parseArgs(args, { background: 'bool', provider: 'str', model: 'str', cwd: 'str' });
    const prompt = o._.join(' ').trim();
    if (!o.background || !prompt) {
      die('usage: keep pi task --background [--provider <name>] [--model <model>] [--cwd <dir>] -- <prompt>');
    }
    const cwd = path.resolve(o.cwd || process.cwd());
    let stat;
    try { stat = fs.statSync(cwd); } catch { die(`Pi task cwd does not exist: ${cwd}`); }
    if (!stat.isDirectory()) die(`Pi task cwd is not a directory: ${cwd}`);
    const provider = cleanScalar(o.provider, 'provider');
    const model = cleanScalar(o.model, 'model');
    if (provider && (provider.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(provider))) die('Pi provider contains invalid characters');
    if (model && (model.length > 240 || /[\r\n\0]/.test(model))) die('Pi model contains invalid characters');
    const assigned = currentDelegation();
    if (['active', 'invalid', 'identity-mismatch', 'stale'].includes(assigned.kind)) {
      die(`${delegation.describe(assigned)} Only a pending parent transport may launch a delegated Pi job.`);
    }
    const pending = assigned.kind === 'pending' ? assigned.record : null;
    const parentSession = pending?.parent || currentSession();
    let card = pending?.card || null;
    if (!card && parentSession) {
      try { card = taskForSession(parentSession.id)?.id || null; } catch {}
    }
    const job = piJobs.launch({
      root: ROOT, cwd, provider, model, prompt, parentSession, card,
      delegationId: pending?.id || null,
    });
    console.log(job.id);
    return;
  }
  if (action === 'status') {
    const o = parseArgs(args, { json: 'bool' });
    if (o._.length > 1) die('usage: keep pi status [<job>] [--json]');
    const value = o._[0] ? piJobs.read(ROOT, o._[0]) : piJobs.records(ROOT);
    if (o._[0] && !value) die(`unknown Pi job ${o._[0]}`);
    if (o.json) return process.stdout.write(`${JSON.stringify(Array.isArray(value)
      ? value.map(piJobs.publicJob) : piJobs.publicJob(value), null, 2)}\n`);
    if (Array.isArray(value)) {
      if (!value.length) return console.log('No Pi jobs.');
      for (const job of value) console.log(renderPiJob(job));
    } else console.log(renderPiJob(value));
    return;
  }
  if (action === 'result') {
    const o = parseArgs(args, { json: 'bool' });
    if (o._.length !== 1) die('usage: keep pi result <job> [--json]');
    const job = piJobs.read(ROOT, o._[0]);
    if (!job) die(`unknown Pi job ${o._[0]}`);
    if (o.json) return process.stdout.write(`${JSON.stringify(piJobs.publicJob(job), null, 2)}\n`);
    if (job.status !== 'succeeded') die(`Pi job ${job.id} is ${job.status}${job.error ? `: ${job.error}` : ''}`);
    process.stdout.write(`${job.result || ''}${job.result?.endsWith('\n') ? '' : '\n'}`);
    return;
  }
  if (action === 'cancel') {
    const o = parseArgs(args, { json: 'bool' });
    if (o._.length !== 1) die('usage: keep pi cancel <job> [--json]');
    let job;
    try { job = piJobs.cancel(ROOT, o._[0]); } catch (error) { die(error.message); }
    if (o.json) return process.stdout.write(`${JSON.stringify(piJobs.publicJob(job), null, 2)}\n`);
    console.log(`${job.id}  ${job.status}`);
    return;
  }
  die('usage: keep pi task --background ... | keep pi status [job] | keep pi result <job> | keep pi cancel <job>');
};

commands.standup = async (argv) => {
  const o = parseArgs(argv, { since: 'str', dry: 'bool', show: 'bool' });
  if (o._.length) die('usage: keep standup [--since "YYYY-MM-DD HH:MM"|ISO] [--dry] [--show]');
  const standup = features.load('standup');
  if (o.show) {
    try { process.stdout.write(fs.readFileSync(path.join(ROOT, 'standup.md'), 'utf8')); }
    catch { die('no standup.md yet — run `keep standup`'); }
    return;
  }
  let since;
  if (o.since) {
    const bare = o.since.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/);
    try {
      since = bare
        ? standup.zonedTime(bare[1], Number(bare[2]), Number(bare[3]))
        : Date.parse(o.since);
    } catch { since = NaN; }
    if (!Number.isFinite(since)) die('--since must be YYYY-MM-DD HH:MM in Pacific time or a valid ISO timestamp');
  }
  const result = await standup.generate({ since, dry: o.dry });
  if (o.dry) {
    console.log(`${standup.renderEvidence(result.evidence)}\n\n${result.prompt}`);
    return;
  }
  if (result.skipped) {
    console.log(result.skipped);
    return;
  }
  console.log(result.text);
};

commands.ideas = async (argv) => {
  const o = parseArgs(argv, { dry: 'bool', model: 'str' });
  if (o._.length) die('usage: keep ideas [--dry] [--model <m>]');
  if (isReviewerSession() && !o.dry) die('the fleet reviewer may only run `keep ideas --dry`');
  const ideas = features.load('ideas');
  const result = await ideas.run({ dry: o.dry, model: o.model });
  if (o.dry && result.prompt) {
    console.log(`${ideas.renderEvidence(result.evidence)}\n\n${result.prompt}`);
    return;
  }
  if (typeof result.skipped === 'string') {
    console.log(result.skipped === 'budget' ? `budget: ${result.reason}` : result.skipped);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
};

commands.landed = async (argv) => {
  const landed = require('./landed.js');
  const [subcommand, ...rest] = argv;
  if (subcommand === 'policy') {
    if (isReviewerSession()) die('the fleet reviewer may not change landed policy');
    if (rest.length !== 1) die('usage: keep landed policy narrow|broad');
    const saved = landed.setPolicy(rest[0]);
    console.log(`landed policy: ${saved.policy}`);
    return;
  }
  if (subcommand === 'dry') {
    if (isReviewerSession()) die('the fleet reviewer may not change landed dry mode');
    if (rest.length !== 1) die('usage: keep landed dry on|off');
    const saved = landed.setCloseDry(rest[0]);
    console.log(`landed dry: ${saved.closeDry ? 'on' : 'off'}`);
    return;
  }
  if (subcommand === 'judge') {
    if (isReviewerSession()) die('the fleet reviewer may not change landed judge');
    if (rest.length !== 1) die('usage: keep landed judge rules|haiku|veto');
    const saved = landed.setJudge(rest[0]);
    console.log(`landed judge: ${saved.judge}`);
    return;
  }
  if (subcommand === 'decisions') {
    const o = parseArgs(rest, { disagree: 'bool' });
    if (o._.length) die('usage: keep landed decisions [--disagree]');
    console.log(landed.formatDecisions({ disagree: o.disagree }));
    return;
  }
  const o = parseArgs(argv, { dry: 'bool', only: 'str' });
  if (o._.length) die('usage: keep landed [--dry] [--only <id>]');
  if (isReviewerSession() && !o.dry) die('the fleet reviewer may only run `keep landed --dry`');
  const result = await landed.sweep({ dry: o.dry, only: o.only });
  for (const action of result.landed) {
    const close = action.closed ? '; closed' : action.wouldClose ? '; would close' : '';
    console.log(`${o.dry ? 'DRY RUN: ' : ''}${action.id}: ${action.shas.join(', ')} landed${close}`);
    for (const match of action.matched || []) {
      console.log(`  cited ${match.citedSha.slice(0, 7)} landed as ${match.sha.slice(0, 7)} (same patch)`);
    }
  }
};

commands.slack = async (argv) => {
  const slack = features.load('slack');
  const [subcommand, ...rest] = argv;
  if (subcommand === 'poll') {
    const o = parseArgs(rest, { dry: 'bool' });
    if (o._.length) die('usage: keep slack poll [--dry]');
    const decisions = await slack.poll({ dry: o.dry });
    if (!o.dry) console.log(`slack: classified ${decisions.length} new message${decisions.length === 1 ? '' : 's'}`);
    return;
  }
  if (subcommand === 'status') {
    if (rest.length) die('usage: keep slack status');
    const state = slack.status();
    console.log(`mode: ${state.mode}`);
    console.log(`last poll: ${state.lastPollAt ? new Date(state.lastPollAt).toLocaleString() : 'never'}`);
    console.log('cursors:');
    const rows = Object.entries(state.cursors);
    if (!rows.length) console.log('  (none)');
    for (const [channel, cursor] of rows) console.log(`  ${channel}: ${cursor.after_ts || '(none)'}`);
    const counts = Object.entries(state.counts);
    console.log(`today: ${counts.length ? counts.map(([kind, count]) => `${kind} ${count}`).join(', ') : 'no classifications'}`);
    return;
  }
  if (subcommand === 'mode') {
    if (rest.length !== 1) die('usage: keep slack mode log|cards|alerts');
    const saved = slack.setMode(rest[0]);
    console.log(`slack mode: ${saved.mode}`);
    return;
  }
  die('usage: keep slack poll [--dry] | keep slack status | keep slack mode log|cards|alerts');
};

// Incident cards come from the Slack poll, not from here: this reads what the
// parser has already recorded, and re-parses one message when a shape needs
// debugging.
commands.incidents = async (argv, cliDeps = {}) => {
  const incidents = require('./incidents.js');
  const [subcommand, ...rest] = argv;
  // One area-session tick by hand: what the daemon does after every Slack poll,
  // for one area, with its decisions printed. `--dry` performs nothing at all —
  // no worktree, no record, no recipe, no session opened and nothing typed — so
  // it is safe against the live registry and is how the switch gets checked
  // before it is flipped.
  if (subcommand === 'session') {
    const o = parseArgs(rest, { dry: 'bool', json: 'bool' });
    if (o._.length !== 1) die('usage: keep incidents session <area> [--dry] [--json]');
    const areaSession = require('./area-session.js');
    // The daemon's own seams, each requiring serve.js on first use rather than up
    // front, so an area whose session is off costs nothing. `--dry` gets the same
    // set on purpose: a dry run that could not ask the terminal host what is
    // running would have nothing true to report, and performing nothing is
    // area-session's own guarantee (every write, send and close is gated on it),
    // not something withholding a dependency buys.
    // Whether this command ever reached for serve.js. Only then is there a host
    // connection to hang up afterwards, and only then may this require it: the
    // point of the lazy require is that an area whose session is off pays nothing.
    let usedServe = false;
    const serve = () => { usedServe = true; return require('./serve.js'); };
    const deps = cliDeps.deps || ({
      openSession: (body, openDeps) => serve().openSession(body, openDeps),
      listPanes: () => serve().listHostPanes({}, true),
      scanSessions: () => serve().scanSessions(),
      resolveSessionTarget: (session, hint) => serve().resolveSessionTarget(session, hint),
      sendToResolvedTarget: (session, target, text, opts) => serve().sendToResolvedTarget(session, target, text, opts),
      withInjectionLock: (fn, scope) => serve().withInjectionLock(fn, scope),
      closeIdleSession: (body, closeDeps) => serve().closeIdleSession(body, closeDeps),
      // The same recovery the daemon tick has. A retry cannot tell an arrived
      // batch from a lost one without it, so a tick without this one defers
      // rather than risking a second copy of the message.
      transcriptShows: (session, text) => areaSession.transcriptShowsIn(
        session, text, serve().transcriptFileForSession),
    });

    // `force` only with `--dry`: a dry run is how the switch gets inspected
    // before it is flipped, but actually opening a session for an area whose
    // `session` is false would flip it from the command line.
    let result;
    try {
      result = await areaSession.tick({ root: ROOT, area: o._[0], dry: Boolean(o.dry), force: Boolean(o.dry) }, deps);
    } finally {
      // Asking the terminal host what is running opens a connection serve.js
      // keeps: right for the daemon, which holds one for its whole life, and
      // wrong here — the live socket would keep this process in the event loop
      // for good once the report was printed. Hang it up whether the tick
      // succeeded or threw. Not process.exit(): stdout to a pipe is
      // asynchronous, so exiting would cut the report short.
      if (usedServe) await require('./serve.js').closeHostClient();
    }
    if (o.json) { console.log(JSON.stringify(result, null, 2)); return; }
    if (result.error) die(result.error);
    for (const report of result.areas) for (const line of areaSession.describe(report)) console.log(line);
    return;
  }
  // Closing one by hand. The quiet sweep needs a `resolvedAt` to start its clock,
  // so an incident whose `resolved` message can never match — a merged signature
  // from the first live polls, before Grafana blocks were split by their `Labels:`
  // line — would otherwise stay open forever. Noise the responder has diagnosed is
  // the other case, and this is the command its recipe's `keep decide close` is
  // recommending.
  if (subcommand === 'close') {
    const o = parseArgs(rest, { json: 'bool' });
    if (o._.length !== 1) die('usage: keep incidents close <card-id|signature> -m "why"');
    if (!o.m) die('keep incidents close needs -m "why"');
    // Deliberately not the default no-op emitter the CLI uses elsewhere: a hand
    // close is a lifecycle change like the sweep's, and the area agent's feed is
    // where its own console row reads it.
    const result = incidents.close(o._[0], { root: ROOT, reason: o.m }, {
      emitAgentEvent: require('./agents.js').incidentEmitter({ root: ROOT }),
    });
    if (o.json) { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(result.already
      ? `${result.card} was already closed (${result.signature}); nothing changed`
      : `closed ${result.card} (${result.signature})`);
    return;
  }
  if (subcommand === 'parse') {
    const o = parseArgs(rest, { json: 'bool' });
    if (o._.length !== 1) die('usage: keep incidents parse <file|->');
    const raw = o._[0] === '-' ? require('./stdin.js').readStdin({ isatty: () => false }) : fs.readFileSync(o._[0], 'utf8');
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = { text: raw }; }
    const messages = (Array.isArray(payload) ? payload : [payload]).filter((message) => message && typeof message === 'object');
    const config = incidents.config(ROOT);
    const bots = incidents.alertBots(ROOT);
    const rows = messages.flatMap((message) => incidents.parse(message, { config, alertBots: bots }));
    if (o.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    if (!rows.length) { console.log('(nothing parsed)'); return; }
    for (const row of rows) {
      console.log(`${row.signature || '(no signature)'}  state=${row.state} area=${row.area} severity=${row.severity} shape=${row.shape}`);
      console.log(`  title: ${row.title}`);
      if (row.source) console.log(`  source: ${row.source}`);
    }
    return;
  }
  const o = parseArgs(argv, { json: 'bool' });
  if (o._.length) die('usage: keep incidents [--json] | keep incidents parse <file|-> | keep incidents close <card-id|signature> -m "why" | keep incidents session <area> [--dry]');
  const open = incidents.openIncidents(ROOT);
  // A write the last poll could not land is retried behind the channel cursor,
  // which means nothing newer is fetched until it succeeds. It is reported here
  // as well as on the Slack health row, and printed even when nothing is open —
  // a poll that failed every write is exactly the case with no open incidents.
  const pending = incidents.pendingFailures(ROOT);
  if (o.json) { console.log(JSON.stringify({ open, pending: pending || null }, null, 2)); return; }
  if (!open.length) console.log('no open incidents');
  for (const item of open) {
    const fired = item.lastFiredAt ? new Date(item.lastFiredAt).toLocaleString() : 'never';
    console.log(`${item.card || '(no card)'}  ${item.area}  x${item.fireCount}  last fired ${fired}${item.resolvedAt ? ' (resolved)' : ''}`);
    console.log(`  ${item.title}`);
    console.log(`  ${item.signature}`);
  }
  if (pending) {
    const when = pending.at ? new Date(pending.at).toLocaleString() : 'an unknown time';
    console.log(`pending: ${pending.failed} incident write${pending.failed === 1 ? '' : 's'} failed at ${when}: ${pending.error}`);
  }
};

// An agent's own way in and out of its feed. Listing and reading are free;
// `emit` is what an agent session calls to say what it found, and `seen` is what
// the console's Agents section posts when a row is expanded.
commands.agents = (argv) => {
  const agents = require('./agents.js');
  const [subcommand, ...rest] = argv;

  if (subcommand === 'events') {
    const o = parseArgs(rest, { json: 'bool', unseen: 'bool', limit: 'str' });
    if (o._.length !== 1) die('usage: keep agents events <name> [--unseen] [--limit N] [--json]');
    const name = o._[0];
    if (!agents.validName(name)) die(`bad agent name: ${name}`);
    const events = agents.readEvents(name, { root: ROOT, unseen: o.unseen, limit: Number(o.limit) || 50 });
    if (o.json) { console.log(JSON.stringify(events, null, 2)); return; }
    if (!events.length) { console.log(o.unseen ? 'no unseen events' : 'no events'); return; }
    for (const event of events) {
      console.log(`${new Date(event.at).toLocaleString()}  ${event.kind}${event.card ? `  ${event.card}` : ''}  ${event.severity}${event.needsYou ? '  needs-you' : ''}${event.seenAt ? '' : '  (unseen)'}`);
      const line = agents.eventLine(event);
      if (line && line !== event.kind) console.log(`  ${line}`);
    }
    return;
  }

  if (subcommand === 'emit') {
    const o = parseArgs(rest, { kind: 'str', card: 'str', severity: 'str', 'needs-you': 'bool', badge: 'bool' });
    if (o._.length !== 1) die('usage: keep agents emit <name> --kind <k> [--card <id>] [--severity low|med|high] [--needs-you] [--badge] -m "text"');
    const name = o._[0];
    if (!agents.validName(name)) die(`bad agent name: ${name}`);
    if (!o.kind) die('keep agents emit needs --kind');
    if (o.severity && !['low', 'med', 'high'].includes(o.severity)) die('--severity must be low, med or high');
    // Forwarded from a node, an emit speaks for the agent only from the session its
    // record names: the daemon verified which session is asking (registry-route
    // IDENTITY_VARS), and any session on a node could otherwise write any feed.
    if (process.env.KEEP_REMOTE_CALLER) {
      const caller = process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.KEEP_PI_SESSION_ID || '';
      const record = agents.readRecord(name, ROOT);
      if (!record) die(`no agent record for ${name}; nothing was written`);
      if (!caller || record.session.id !== caller) {
        die(`${name}'s record names session ${record.session.id ? sessionNamed(record.session.id) : '(none)'}; an emit from a node must come from that session`);
      }
    }
    const event = agents.emit(name, {
      kind: o.kind, card: o.card || '', severity: o.severity || 'med',
      needsYou: Boolean(o['needs-you']), text: o.m || '',
      // Only the kinds in agents.BADGE_KINDS light the row; --badge does it for another.
      ...(o.badge ? { badge: true } : {}),
    }, { root: ROOT });
    if (!event) die(`no agent record for ${name}; nothing was written`);
    agents.flushCommits(ROOT);
    console.log(`${name}: ${event.kind}${event.card ? ` on ${event.card}` : ''}${event.needsYou ? ' (needs you)' : ''}`);
    return;
  }

  if (subcommand === 'seen') {
    const o = parseArgs(rest, { json: 'bool' });
    if (o._.length !== 1) die('usage: keep agents seen <name>');
    const name = o._[0];
    if (!agents.validName(name)) die(`bad agent name: ${name}`);
    const result = agents.markSeen(name, Date.now(), { root: ROOT });
    agents.flushCommits(ROOT);
    if (o.json) { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(`${name}: marked ${result.marked} event${result.marked === 1 ? '' : 's'} seen`);
    return;
  }

  // Where an agent's sessions run. Owner's call, gated like a grant: an agent moving
  // itself (or another) to a machine is choosing where unattended work runs.
  if (subcommand === 'place') {
    const usage = 'usage: keep agents place <name> [--node <node>] [--needs cap,cap] [--daemon] [--as-owner] [--json]';
    const o = parseArgs(rest, { node: 'str', needs: 'list', daemon: 'bool', json: 'bool', 'as-owner': 'bool' });
    if (o._.length !== 1) die(usage);
    const name = o._[0];
    if (!agents.validName(name)) die(`bad agent name: ${name}`);
    if (name === agents.REVIEWER_NAME) {
      die('the fleet reviewer is not opened by Keep; move its session with keep move <session> --node <node>');
    }
    const current = agents.readRecord(name, ROOT);
    if (!current) die(`no agent record for ${name}`);
    const describePlacement = (record) => `${record.name}: runs on ${record.node || `the daemon node (${require('./nodes.js').daemonNode()})`}`
      + `${record.needs.length ? `, needs ${record.needs.join(', ')}` : ''}`;
    const changing = o.node !== undefined || o.needs !== undefined || o.daemon;
    if (!changing) {
      if (o.json) { console.log(JSON.stringify({ name, node: current.node, needs: current.needs }, null, 2)); return; }
      console.log(describePlacement(current));
      return;
    }
    if (o.daemon && (o.node !== undefined || o.needs !== undefined)) die('--daemon clears the placement; it takes no --node or --needs');
    if (inAgentSession() && !(o['as-owner'] && process.env.KEEP_OWNER === '1' && !process.env.KEEP_REMOTE_CALLER)) {
      die(`only Owner places an agent. End the turn and ask him for "keep agents place ${name} …". `
        + 'If Owner is running this himself from an agent session, pass --as-owner with KEEP_OWNER=1 in the environment.');
    }
    const nodesApi = require('./nodes.js');
    const patch = {};
    if (o.daemon) Object.assign(patch, { node: '', needs: [] });
    if (o.node !== undefined) {
      const node = String(o.node).trim();
      const known = nodesApi.configuredNodeNames();
      if (!known.includes(node)) die(`no configured node named ${node} (known: ${known.join(', ') || 'none'})`);
      // The daemon node is stored as no placement, so a rename of the daemon node
      // never strands an agent on a name that no longer exists.
      patch.node = node === nodesApi.daemonNode() ? '' : node;
    }
    if (o.needs !== undefined) patch.needs = o.needs.map((entry) => String(entry).trim()).filter(Boolean);
    const record = agents.writeRecord(name, patch, { root: ROOT });
    agents.flushCommits(ROOT);
    if (o.json) { console.log(JSON.stringify({ name, node: record.node, needs: record.needs }, null, 2)); return; }
    console.log(describePlacement(record));
    if (record.session && record.session.id) {
      console.log(`  the running session ${sessionNamed(record.session.id)} stays where it is; the next one opens on the new placement`);
    }
    return;
  }

  const o = parseArgs(argv, { json: 'bool' });
  if (o._.length) die('usage: keep agents [--json] | keep agents events|emit|seen|place <name> …');
  const rows = agents.records(ROOT).map((record) => agents.agentView(record, { root: ROOT }));
  if (o.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.log('no agent records'); return; }
  for (const row of rows) {
    const badge = row.unseen.count ? `  ${row.unseen.count} unseen${row.unseen.needsYou ? ' (needs you)' : ''}` : '';
    console.log(`${row.name}  ${row.lifecycle}${row.card ? ` on ${row.card}` : ''}${row.session && row.session.id ? `  session ${sessionNamed(row.session.id)}` : ''}${badge}`);
    if (row.role || row.area) console.log(`  ${[row.role, row.area && `area ${row.area}`].filter(Boolean).join(' · ')}`);
    if (row.lastEvent) console.log(`  last: ${row.lastEvent.kind} — ${agents.eventLine(row.lastEvent)}`);
  }
};

commands.discord = async (argv) => {
  const discord = features.load('discord');
  const [subcommand, ...rest] = argv;
  if (subcommand === 'poll') {
    const o = parseArgs(rest, { dry: 'bool' });
    if (o._.length) die('usage: keep discord poll [--dry]');
    const decisions = await discord.poll({ dry: o.dry });
    if (!o.dry) console.log(`discord: classified ${decisions.length} new message${decisions.length === 1 ? '' : 's'}`);
    return;
  }
  if (subcommand === 'status') {
    if (rest.length) die('usage: keep discord status');
    const state = discord.status();
    console.log(`enabled: ${state.enabled ? 'yes' : 'no'}`);
    console.log(`last poll: ${state.lastPollAt ? new Date(state.lastPollAt).toLocaleString() : 'never'}`);
    if (state.skipped) console.log(`last attempt: skipped${state.detail ? ` · ${state.detail}` : ''}`);
    if (state.cursor != null) console.log(`cursor: seq ${state.cursor}${state.backlog ? ' (backlog left for the next poll)' : ''}`);
    const counts = Object.entries(state.counts);
    console.log(`today: ${counts.length ? counts.map(([kind, count]) => `${kind} ${count}`).join(', ') : 'no classifications'}`);
    return;
  }
  die('usage: keep discord poll [--dry] | keep discord status');
};

// Optional features are switched from the configuration; bin/features.js holds the
// registry. The command stays registered when its feature is off so `keep <name>`
// says how to turn it on instead of looking like a typo.
for (const [name, feature] of Object.entries(features.FEATURES)) {
  const run = commands[feature.command];
  commands[feature.command] = async (...args) => {
    if (!features.enabled(name)) throw new KeepError(features.offMessage(name));
    return run(...args);
  };
}

commands.verify = async (argv, deps = {}) => {
  const o = parseArgs(argv, {});
  const id = o._[0];
  if (!id) die('usage: keep verify <id>');
  let response;
  try {
    response = await (deps.postKeepApi || postKeepApi)('/api/run', { id, kind: 'check' });
  } catch {
    die('keep serve isn\'t running (start it or use the dashboard)');
  }
  let result = {};
  try { result = JSON.parse(response.data); } catch {}
  if (response.status === 200 && result.ok) {
    // Nothing runs headless: the recipe is delivered into a session, which records the
    // outcome as a check-in on the card the way any other check does.
    const where = result.sessionId ? ` ${sessionRef(result.sessionId)}` : '';
    (deps.log || console.log)(result.delivered === 'thread'
      ? `verify delivered into this card's open ${result.kind || 'claude'} session${where}`
      : `verify opened a fresh session${where}${result.pane ? ` in pane ${result.pane}` : ''} on this card`);
    (deps.log || console.log)('the result lands as a check-in (dashboard review column)');
    return;
  }
  die(result.error || `keep serve returned an unexpected response (${response.status})`);
};

commands.compact = async (argv, deps = {}) => {
  const o = parseArgs(argv, { 'when-idle': 'bool' });
  let sessionId = o._[0];
  // Bare `keep compact` is an agent asking for its own session, and a session cannot
  // be compacted mid-turn, which is where this command runs: so it is always a request
  // the daemon carries out at the next idle moment.
  const own = !sessionId;
  if (own) {
    sessionId = (deps.commandSession || commandSession)()?.id;
    if (!sessionId) die('usage: keep compact <sessionId> [--when-idle]  (bare `keep compact` only works inside an agent session)');
  }
  const request = own || o['when-idle'] === true;
  let response;
  try {
    response = request
      ? await (deps.postKeepApi || postKeepApi)('/api/compact-request',
        { sessionId, by: own ? 'agent' : 'api', ...(o.m ? { reason: o.m } : {}) })
      : await (deps.postKeepApi || postKeepApi)('/api/compact', { sessionId });
  } catch {
    die('keep serve isn\'t running (start it or use the dashboard)');
  }
  let result = {};
  try { result = JSON.parse(response.data); } catch {}
  if (response.status === 200 && request && result.requested) {
    const expires = new Date(result.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    (deps.log || console.log)(`compaction requested for ${sessionRef(result.sessionId || sessionId)}; the daemon compacts it at the next idle moment (expires ${expires})`);
    return;
  }
  if (response.status === 200 && !request) {
    (deps.log || console.log)(JSON.stringify(result, null, 2));
    return;
  }
  // The daemon's own 'not found' for a path it has no route for: a daemon started
  // before this CLI learned to ask. A missing session is a 404 with its own error.
  if (request && response.status === 404 && result.error === 'not found') {
    die('this keep serve predates compaction requests; it needs a restart (keep restart-daemon) before keep compact can ask');
  }
  die(result.error || `keep serve returned an unexpected response (${response.status})`);
};

function openedSessionName(result) {
  if (!result.sessionId) return '';
  const num = sessionNumbers.parseNumber(result.num);
  return num ? `${sessionNumbers.label(num)} (${result.sessionId})` : String(result.sessionId);
}

function formatOpenResult(result) {
  const sent = result.sent ? ' (message sent)' : '';
  // Only when it is not this machine: a single-node install never mentions a node,
  // because it has never had to.
  const onNode = result.node ? ` on node ${result.node}` : '';
  // A fresh Codex on another node that has not named its session yet: it does at its
  // first turn, and a card open's session is put on the card then.
  const pending = result.pendingRegistration && !result.sessionId
    ? `; its session is pending: it registers at its first turn${result.card ? ` and is then linked to ${result.card}` : ''}` : '';
  if (result.existing && result.pane && pending) return `pane ${result.pane}${onNode} is already running this open${pending}; open it in the console`;
  if (result.existing && result.pane) return `session ${openedSessionName(result)} is running in pane ${result.pane}${onNode}; open it in the console${sent}`;
  const session = result.sessionId ? ` as ${openedSessionName(result)}` : '';
  // The account id, not its label: it is what `--account` takes back.
  const on = result.accountId ? ` on ${result.accountId}` : '';
  const handoff = [];
  if (result.linked) handoff.push(`card now owned by ${result.sessionId}`);
  if (result.unlinked) handoff.push(`${result.unlinked} unlinked`);
  const tail = handoff.length ? `; ${handoff.join(', ')}` : '';
  // Only an auto-selected open that had to pass over an account carries a note.
  const note = result.accountNote ? `\n${result.accountNote}` : '';
  if (result.created === 'pane') return `opened pane ${result.pane}${onNode}: ${result.command}${session}${on}${sent}${tail}${pending}${note}`;
  return `opened session${session}${on}${sent}${tail}${note}`;
}

async function postOpen(payload, post = postKeepApi, timeoutMs) {
  // Check the actual typed payload before contacting a daemon that might still
  // have the old truncating implementation. The CLI spills long source text first.
  if (payload.message != null && String(payload.message).length > OPEN_MESSAGE_LIMIT) {
    const error = new KeepError(OPEN_MESSAGE_ERROR);
    error.status = 400;
    throw error;
  }
  const response = await post('/api/open', payload, timeoutMs);
  let result = {};
  try { result = JSON.parse(response.data); } catch {}
  if (response.status !== 200 || !result.ok) {
    const error = new Error(result.error || `keep serve returned an unexpected response (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return result;
}

// `options` lets `keep tell` reuse the same committed spill with its own wording, and
// with `cardLog: false` — a message between two sessions is not a decision about the
// work, and a card whose log filled with relay traffic would be unreadable.
function writeOpenHandoff(id, message, task, options = {}) {
  const pointerFor = options.pointer || ((file) => `Your instructions are in ${file}; read that file first.`);
  id = String(id).replace(/^#(?=[0-9])/, 's');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) die('bad card or session id');
  return withLock(() => {
    const directory = path.join(META, 'handoffs');
    fs.mkdirSync(directory, { recursive: true });
    let file;
    let pointer;
    for (let timestamp = Date.now(); ; timestamp++) {
      file = path.join(directory, `${id}-${timestamp}.md`);
      pointer = pointerFor(file);
      if (pointer.length > OPEN_MESSAGE_LIMIT) die(OPEN_MESSAGE_ERROR);
      if (/[\r\n]/.test(pointer)) die('handoff path cannot contain newlines');
      try { fs.writeFileSync(file, message, { flag: 'wx' }); break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const paths = [path.relative(ROOT, file)];
    const owner = options.cardLog === false ? null : (task ? loadTask(task.id) : taskForSession(id));
    if (owner) {
      // Commit the complete instructions before a session can read the pointer.
      // This is a launch request, not a claim that the daemon succeeded.
      appendLog(owner, 'open requested', `Handoff instructions: ${file}`);
      saveTask(owner);
      paths.push(path.relative(ROOT, taskPath(owner.id)));
    }
    // .keep is otherwise ignored runtime state; only this immutable handoff is
    // deliberately tracked. Never sweep up another launch's handoff or card.
    git('add', '-f', '--', ...paths);
    commitAndPush(options.commitLabel ? options.commitLabel(id) : `keep: open ${id} (handoff instructions)`, paths, { staged: true });
    return pointer;
  });
}

commands.open = async (argv, deps = {}) => {
  const o = parseArgs(argv, { fresh: 'bool', agent: 'str', model: 'str', account: 'str', 'message-file': 'str', node: 'str', needs: 'str' });
  let id = o._[0];
  if (!id) die('usage: keep open <card|session-id|#n> [--fresh] [--agent claude|codex|pi] [--account <id>] [--model <id>] [--node <name>] [--needs <capability>] [-m "opening message" | --message-file <path>]');
  if (o.agent && !['claude', 'codex', 'pi'].includes(o.agent)) die('agent must be claude, codex, or pi');
  // Which machine to run on, and what that machine has to be able to do. The daemon
  // checks both against its own node list; this is only the shape.
  if (o.node != null && !require('./nodes.js').NODE_NAME_RE.test(o.node)) {
    die('--node must contain only lowercase letters and digits');
  }
  if (o.needs != null && !String(o.needs).trim()) die('--needs needs a capability name');
  // --model goes on the launched command line only (claude --model / codex -m), so it
  // applies to that process and never touches ~/.claude/settings.json.
  if (o.model != null && !PI_MODEL_RE.test(o.model) && !LAUNCH_MODEL_RE.test(o.model)) die('--model must be a model id');
  if (o.m != null && o['message-file'] != null) die('use either -m or --message-file, not both');
  let message = o.m;
  if (o['message-file'] != null) {
    try { message = fs.readFileSync(path.resolve(o['message-file']), 'utf8'); }
    catch (error) { die('cannot read message file: ' + error.message); }
  }
  if (message != null && !message.trim()) die(o['message-file'] != null ? '--message-file needs a message' : '-m needs a message');
  let task;
  try { task = (deps.loadTask || loadTask)(id); } catch {}
  if (!task) {
    const numbered = sessionNumbers.parseNumber(id);
    const found = numbered ? sessionNumbers.lookup(numbered, { root: ROOT }) : null;
    if (found) id = found.id;
  }
  if (message != null && (o['message-file'] != null || message.length > OPEN_MESSAGE_LIMIT || /[\r\n]/.test(message))) {
    message = writeOpenHandoff(id, message, task);
  }
  try {
    const payload = { ...(task ? { taskId: id } : { sessionId: id }), fresh: Boolean(o.fresh), agent: o.agent };
    if (o.account != null) payload.accountId = o.account;
    else if (o.fresh || task) {
      // No account named: let the daemon pick one that still has usage, starting from
      // this session's own. A card with no session to resume launches fresh without
      // --fresh, so it asks too; the daemon ignores the policy whenever it resolves a
      // session, because a resume is pinned to its account.
      payload.accountPolicy = 'auto';
      const caller = (deps.env || process.env).KEEP_AGENT_ACCOUNT_ID;
      if (caller) payload.callerAccountId = caller;
    }
    if (o.model != null) payload.model = o.model;
    if (o.node != null) payload.node = o.node;
    if (o.needs != null) payload.needs = String(o.needs).trim();
    if (message != null) payload.message = message;
    // A card open names itself, as the console's does: a fresh Codex on another node
    // may return pending, and the daemon records the launch under this id so the
    // session is put on the card when it registers.
    if (task) payload.requestId = deps.requestId || require('node:crypto').randomUUID();
    // The launching session hands the card over; the daemon unlinks it once the new session is on the card.
    const self = (deps.currentSession || currentSession)();
    if (task && self && self.id) payload.requester = self.id;
    const result = await postOpen(payload, deps.postKeepApi);
    (deps.log || console.log)(formatOpenResult(result));
    // An explicit --account is honoured even when it is spent; the launch says so.
    if (result.accountWarning) (deps.errorOutput || ((line) => process.stderr.write(line)))(`warning: ${result.accountWarning}\n`);
  } catch (e) {
    die(e.status ? e.message : "keep serve isn't running (start it or use the dashboard)");
  }
};

// How often `--wait` re-asks while the target is mid-turn. Long enough that a busy
// session is not polled once a second, short enough to land as soon as it is free.
const TELL_RETRY_MS = 15e3;

commands.tell = async (argv, deps = {}) => {
  const o = parseArgs(argv, { 'message-file': 'str', wait: 'str', dry: 'bool', json: 'bool' });
  const id = o._[0];
  if (!id || o._.length !== 1) die('usage: keep tell <card|session-id|#n> [-m "message" | --message-file <path>] [--wait <duration>] [--dry] [--json]');
  if (o.m != null && o['message-file'] != null) die('use either -m or --message-file, not both');
  let message = o.m;
  if (o['message-file'] != null) {
    try { message = fs.readFileSync(path.resolve(o['message-file']), 'utf8'); }
    catch (error) { die('cannot read message file: ' + error.message); }
  }
  if (message == null || !String(message).trim()) {
    die(o['message-file'] != null ? '--message-file needs a message' : 'keep tell needs -m "message" or --message-file <path>');
  }
  let waitMs = 0;
  if (o.wait != null) {
    try { waitMs = require('./wait.js').parseDuration(o.wait); }
    catch { die('--wait must be a duration such as +10m or 10m'); }
  }
  let target = id;
  let task;
  try { task = (deps.loadTask || loadTask)(target); } catch {}
  if (!task) {
    const numbered = sessionNumbers.parseNumber(target);
    const found = numbered ? sessionNumbers.lookup(numbered, { root: ROOT }) : null;
    if (found) target = found.id;
  }
  // Long or multi-line text is spilled to a committed handoff file, exactly as a long
  // `keep open -m` is, and the session is sent the pointer instead.
  if (o['message-file'] != null || message.length > TELL_TEXT_LIMIT || /[\r\n]/.test(message)) {
    // A dry run writes nothing, and a handoff file is a commit.
    if (o.dry) message = 'The full message is in <a handoff file written on the real send>; read that file.';
    else message = (deps.writeOpenHandoff || writeOpenHandoff)(target, message, task, {
      pointer: (file) => `The full message is in ${file}; read that file.`,
      commitLabel: (name) => `keep: tell ${name} (message text)`,
      cardLog: false,
    });
  }
  // The same identity a check-in is attributed to; a plain shell has none, and the
  // daemon frames the message as Owner's shell.
  const self = (deps.commandSession || commandSession)();
  const card = self ? (((deps.taskForSession || taskForSession)(self.id) || {}).id || null) : null;
  const payload = {
    ...(task ? { taskId: target } : { sessionId: target }),
    text: message,
    ...(self ? { senderSessionId: self.id, senderAgent: self.agent } : {}),
    ...(card ? { senderCard: card } : {}),
    ...(o.dry ? { dry: true } : {}),
  };
  const post = deps.postKeepApi || postKeepApi;
  const log = deps.log || console.log;
  const errorOutput = deps.errorOutput || ((line) => process.stderr.write(line));
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || Date.now;
  const deadline = now() + waitMs;
  for (;;) {
    let response;
    try { response = await post('/api/tell', payload); }
    catch { die("keep serve isn't running (start it or use the dashboard)"); }
    let result = {};
    try { result = JSON.parse(response.data); } catch {}
    if (response.status === 200 && result.ok) {
      if (o.json) log(JSON.stringify(result));
      else if (result.dry) log(`would tell ${result.name} (${result.sessionId}) on ${result.card || 'no card'}: ${result.text}`);
      else log(`told ${result.name} (${result.sessionId}) on ${result.card || 'no card'}`);
      return;
    }
    if (response.status !== 409) die(result.error || `keep serve returned an unexpected response (${response.status})`);
    // Only a session that is merely mid-turn is worth re-asking: every other refusal
    // is a state a wait cannot change, and waiting on a question Owner has to answer
    // would just type over it later.
    if (result.reason === 'busy' && now() < deadline) {
      await sleep(Math.min(TELL_RETRY_MS, deadline - now()));
      continue;
    }
    const timedOut = result.reason === 'busy' && waitMs > 0;
    if (o.json) log(JSON.stringify({ ok: false, reason: result.reason || null, error: result.error || null }));
    else errorOutput(`keep tell: ${timedOut ? `still busy after ${o.wait}: ` : ''}${result.error || 'refused'}\n`);
    process.exitCode = timedOut ? 124 : 3;
    return;
  }
};

commands.accounts = (argv, deps = {}) => {
  const accountStore = deps.accounts || require('./accounts');
  const verb = argv[0] || 'list';
  if (verb === 'list') {
    const o = parseArgs(argv.slice(1), { json: 'bool' });
    if (o._.length) die('usage: keep accounts list [--json]');
    const state = accountStore.publicState();
    if (o.json) return console.log(JSON.stringify(state, null, 2));
    for (const account of state.accounts) console.log(`${account.id}\t${account.agent}\t${account.isDefault ? 'default\t' : '\t'}${account.label}`);
    return;
  }
  if (verb === 'add') {
    const o = parseArgs(argv.slice(1), { agent: 'str', label: 'str', 'config-dir': 'str', 'credential-service': 'str' });
    const id = o._[0];
    if (!id || o._.length !== 1 || !o.agent || !o.label || !o['config-dir']) {
      die('usage: keep accounts add <id> --agent claude|codex --label <label> --config-dir <dir> [--credential-service <name>]');
    }
    if (!['claude', 'codex'].includes(o.agent)) die('--agent must be claude or codex');
    const account = accountStore.add({ id, agent: o.agent, label: o.label, configDir: o['config-dir'], credentialService: o['credential-service'] });
    console.log(`added ${account.id} (${account.label}); ${accountStore.defaultFor(account.agent).id} remains the ${account.agent} default`);
    return;
  }
  if (verb === 'default') {
    const [agent, id, ...extra] = argv.slice(1);
    if (!['claude', 'codex'].includes(agent) || !id || extra.length) die('usage: keep accounts default claude|codex <id>');
    const account = accountStore.setDefault(agent, id);
    console.log(`${account.id} is now the ${agent} default for new sessions`);
    return;
  }
  if (verb === 'setup') {
    const o = parseArgs(argv.slice(1), { 'share-from': 'str' });
    const id = o._[0];
    if (!id || o._.length !== 1 || !o['share-from']) die('usage: keep accounts setup <id> --share-from <source-id>');
    const target = accountStore.get(id), source = accountStore.get(o['share-from']);
    if (!target || !source) die('unknown source or target account');
    const accountSetup = require('./account-setup');
    const result = accountSetup.shareSetup(source, target);
    console.log(`shared ${source.agent === 'codex' ? 'Codex capabilities' : 'Claude setup'} from ${source.id} to ${target.id} (${result.sharedEntries.length} shared entries)`);
    if (target.agent !== 'claude') return;
    const plugins = accountSetup.syncPlugins(target);
    if (plugins.installed.length) console.log(`installed ${plugins.installed.length} plugin${plugins.installed.length === 1 ? '' : 's'}: ${plugins.installed.join(', ')}`);
    for (const failure of plugins.failed) console.error(`could not install plugin ${failure.id}: ${failure.error}`);
    if (plugins.failed.length) process.exitCode = 1;
    return;
  }
  die('usage: keep accounts list|add|default|setup');
};

commands.handoff = async (argv, deps = {}) => {
  const o = parseArgs(argv, { pane: 'str', account: 'str', force: 'bool' });
  const sessionId = o._[0];
  if (!sessionId || o._.length !== 1 || !o.pane || !o.account) {
    die('usage: keep handoff <session-id> --pane <pane-id> --account <target-id> [--force]');
  }
  // --force is Owner transferring it himself, the same as the console button: the source
  // is closed and killed instead of being proven idle first.
  let response;
  try { response = await (deps.postKeepApi || postKeepApi)('/api/handoff-session', { sessionId, pane: o.pane, accountId: o.account,
    ...(o.force ? { ownerForce: true } : {}) }, 180000); }
  catch { die("keep serve isn't running (start it or use the dashboard)"); }
  let result = {};
  try { result = JSON.parse(response.data); } catch {}
  if (response.status !== 200 || !result.ok) die(result.error || `keep serve returned an unexpected response (${response.status})`);
  console.log(`moved session ${sessionNamed(result.sessionId)} from ${result.sourceAccountId} to ${result.targetAccountId} in pane ${result.pane}`);
};

// Moves a Claude or Codex session to another node (bin/session-move.js, through the daemon's
// POST /api/move-session): stopped where it runs, its files carried and verified,
// then resumed on the other machine. A move that stops part way prints the command
// that continues it.
const MOVE_USAGE = 'usage: keep move <#n|session-id> --node <name> [--force] [--dry] [--json] | keep move --recover <tx> | keep move --abandon <tx>';
commands.move = async (argv, deps = {}) => {
  const o = parseArgs(argv, { node: 'str', force: 'bool', dry: 'bool', json: 'bool', recover: 'str', abandon: 'str' });
  const stdout = deps.stdout || console.log;
  let body;
  if (o.recover != null || o.abandon != null) {
    if (o._.length || o.node || o.force || o.dry || (o.recover != null && o.abandon != null)) die(MOVE_USAGE);
    body = o.recover != null ? { recover: o.recover } : { abandon: o.abandon };
  } else {
    if (o._.length !== 1 || !o.node) die(MOVE_USAGE);
    const { sessionId } = resolveSessionByNumberOrId(o._[0], { root: deps.root || ROOT });
    body = { sessionId, node: o.node, ...(o.force ? { ownerForce: true } : {}), ...(o.dry ? { dry: true } : {}) };
  }
  let response;
  // A move carries a session's whole transcript between machines: give it room.
  try { response = await (deps.postKeepApi || postKeepApi)('/api/move-session', body, 30 * 60e3); }
  catch (error) {
    // Only a refused connection means the daemon is not there. A timeout is a move
    // that may still be running (or may have stopped part way and be journalled),
    // and anything else is said as it is.
    if (error && error.code === 'ECONNREFUSED') die("keep serve isn't running (start it or use the dashboard)");
    const message = String(error && error.message || error);
    if (/^timed out after /.test(message)) {
      die(`keep move ${message}; a move that stopped part way is journalled under .keep/session-moves/ and continues with keep move --recover <tx>`);
    }
    die(`keep move could not get an answer from keep serve: ${message}`);
  }
  let result = {};
  try { result = JSON.parse(response.data); } catch {}
  if (response.status !== 200 || !result.ok) die(result.error || `keep serve returned an unexpected response (${response.status})`);
  if (o.json) { stdout(JSON.stringify(result, null, 2)); return; }
  if (result.dry) {
    stdout(`would move ${result.sessionId} from ${result.from} to ${result.to}: cwd ${result.cwd}, account ${result.accountId}, `
      + `${result.model ? `model ${result.model}` : 'the account\'s default model'}, ${result.bypass ? 'permissions skipped' : 'restricted permissions'}`
      + `${result.pane ? `, stopping pane ${result.pane.id}` : ', no live pane'}`);
    return;
  }
  if (result.status === 'abandoned' || result.status === 'abandoned-back') {
    stdout(result.message);
    for (const warning of result.warnings || []) stdout(`  note: ${warning}`);
    return;
  }
  stdout(`moved ${result.sessionId} from ${result.from} to ${result.to}${result.launch ? ` in pane ${result.launch.pane}` : ''}`
    + ` (${result.files} file${result.files === 1 ? '' : 's'}, ${result.bytes} bytes; move ${result.id})`);
  for (const warning of result.warnings || []) stdout(`  note: ${warning}`);
};

commands.transfer = async (argv, deps = {}) => {
  const o = parseArgs(argv, { account: 'str', context: 'str', cwd: 'str', 'prepare-only': 'bool', 'resolve-session': 'str' });
  const sourceSessionId = o._[0];
  if (!sourceSessionId || o._.length !== 1 || !o.account || !o.context) {
    die('usage: keep transfer <source-session-id> --account <target-id> --context <handoff.md> [--cwd <worktree>] [--prepare-only] [--resolve-session <id>]');
  }
  const runner = deps.portable || require('./portable-handoff');
  const storePackage = deps.storePackage || (async ({ cardId, fileName, content, note }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-portable-transfer-'));
    const file = path.join(directory, fileName);
    try {
      fs.writeFileSync(file, content, { mode: 0o600 });
      const stored = commands.artifact([cardId, file, '-m', note], { quiet: true });
      if (!stored?.[0]?.destination) throw new Error('portable transfer artifact was not stored');
      return stored[0].destination;
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  let result;
  try {
    result = await runner.run({ sourceSessionId, accountId: o.account, contextFile: o.context, cwd: o.cwd,
      prepareOnly: Boolean(o['prepare-only']), resolveSessionId: o['resolve-session'] }, {
      root: ROOT, env: process.env, accounts: deps.accounts || require('./accounts'),
      sourceFor: deps.sourceFor, taskForSession: deps.taskForSession || taskForSession,
      nextStep: deps.nextStep || nextStep, taskFile: deps.taskFile || ((task) => taskPath(task.id)), storePackage,
      gitSnapshot: deps.gitSnapshot,
      validateResolution: deps.validateResolution,
      open: deps.open || ((payload) => postOpen(payload, deps.postKeepApi)),
    });
  } catch (error) { die(error.message); }
  if (result.status === 'prepared') {
    console.log(`portable transfer ${result.requestKey.slice(0, 16)} prepared at ${result.artifactFile}`);
    return result;
  }
  console.log(`portable transfer ${result.requestKey.slice(0, 16)}: ${result.sourceSessionId} -> ${result.destinationSessionId} (${result.targetAccountId})`);
  console.log(`context package: ${result.artifactFile}`);
  return result;
};

function restoreAge(lastSeenAlive, now) {
  const ms = now - Number(lastSeenAlive);
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms < 60e3) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (ms < 3600e3) return `${Math.floor(ms / 60e3)}m`;
  if (ms < 86400e3) return `${Math.floor(ms / 3600e3)}h`;
  return `${Math.floor(ms / 86400e3)}d`;
}

commands.restore = async (argv, deps = {}) => {
  const o = parseArgs(argv || [], { dry: 'bool', since: 'str', project: 'str' });
  if (o._.length) die('usage: keep restore [--dry] [--since +48h|hours] [--project path]');
  const params = new URLSearchParams();
  if (o.since != null) {
    const since = relativeDurationMs(o.since, true);
    if (since == null || !Number.isFinite(since)) die('--since needs +48h, +3d, or a bare number of hours');
    params.set('since', String(since));
  }
  if (o.project != null) params.set('project', o.project);
  const pathname = `/api/restore-plan${params.size ? `?${params}` : ''}`;
  let response;
  try { response = await (deps.getKeepApi || getKeepApi)(pathname, 60000); }
  catch (error) {
    const detail = String(error && error.message || error);
    if (/timed out/i.test(detail)) {
      die(`keep serve did not answer while fetching the restore plan (${detail})`);
    }
    die(`keep serve isn't running (start it or use the dashboard): ${detail}`);
  }
  let plan = {};
  try { plan = JSON.parse(response.data); } catch {}
  if (response.status !== 200 || !plan.ok || !Array.isArray(plan.sessions)) {
    die(plan.error || `keep serve returned an unexpected response (${response.status})`);
  }
  const stdout = deps.stdout || console.log;
  const stderr = deps.stderr || process.stderr.write.bind(process.stderr);
  const now = (deps.now || Date.now)();
  for (const row of plan.sessions) {
    stdout(`${row.action} ${row.agent} ${sessionRef(row.id || row.sessionId)} ${row.project || '-'} ${row.reason}; last seen ${restoreAge(row.lastSeenAlive, now)} ago`);
  }
  if (o.dry) return;
  let restored = 0;
  let failed = 0;
  const skipped = plan.sessions.filter((row) => row.action !== 'restore').length;
  for (const row of plan.sessions) {
    if (row.action !== 'restore') continue;
    try {
      const result = await postOpen({ sessionId: row.id }, deps.postKeepApi, 180000);
      stdout(formatOpenResult(result));
      restored++;
    } catch (error) {
      failed++;
      stderr(`keep: ${row.id || row.sessionId}: ${error.message}\n`);
    }
  }
  stdout(`restored ${restored}, skipped ${skipped}, failed ${failed}`);
};

commands.resume = async (argv, deps = {}) => {
  const o = parseArgs(argv || [], { raw: 'bool' });
  if (o._.length) die('usage: keep resume [--raw]');
  const tasks = (deps.loadAll || loadAll)(false).filter((t) => ['active', 'review', 'landing'].includes(t.fm.status));
  const unblocked = require('./unblock.js').readRecords({ root: ROOT }).filter((record) => !record.deliveredAt);
  if (!tasks.length && !unblocked.length) return console.log('nothing active');
  if (unblocked.length) {
    console.log('Unblocked, nobody told');
    for (const record of unblocked) {
      console.log(`  ${record.dependent} — ${record.upstream} is done${record.gaveUp ? ` (${record.gaveUp})` : ''}`);
    }
  }
  let daemon = null;
  try { daemon = require('./nodes.js').daemonNode(); } catch {}
  for (const t of tasks) {
    console.log(fmtTask(t));
    const s = (t.fm.sessions || [])[t.fm.sessions ? t.fm.sessions.length - 1 : 0];
    if (s) {
      const proj = t.fm.project ? `cd ${t.fm.project} && ` : '';
      // The label rides the printed `keep open <id>` line: an extra positional the
      // command ignores, so the line stays copy-pasteable. --raw prints a bare agent
      // command, where a trailing word would become an argument.
      const numbered = !o.raw && s.id ? sessionNumbers.lookup(s.id, { root: ROOT }) : null;
      const num = numbered ? `  ${sessionNumbers.label(numbered.num)}` : '';
      // A session on another machine says which, after its number. The card records
      // a node only when it is not the daemon's, so single-node output is unchanged;
      // --raw stays bare for the same reason the label does.
      const node = !o.raw && s.node && s.node !== daemon ? `${num ? ' ' : '  '}@${s.node}` : '';
      console.log(color('90', `      ${proj}${resumeCommand(s, process.env, { raw: Boolean(o.raw) })}${num}${node}`));
    }
  }
};

commands.sync = () => {
  try { git('pull', '-q', '--rebase', 'origin', 'main'); } catch (e) { process.stderr.write(`keep: pull failed: ${e.message}\n`); }
  git('push', '-q', 'origin', 'HEAD');
  console.log('synced');
};





commands.serve = () => {
  require('./serve.js').start();
};

commands['restart-daemon'] = async (argv) => {
  if (argv.length) die('usage: keep restart-daemon');
  const response = await postKeepApi('/api/restart-daemon', {});
  let result = {};
  try { result = JSON.parse(response.data); } catch {}
  if (response.status !== 200) die(result.error || `Daemon restart refused (${response.status})`);
  console.log(`Daemon ${result.pid} is restarting under launchd; terminal sessions are preserved.`);
};

commands['force-restart'] = async argv => {
  const o = parseArgs(argv, { pane: 'str', recover: 'bool' });
  const sessionId = o._[0];
  // `--pane <id>@<node>` restarts a pane on another machine; the daemon routes it.
  if (o._.length !== 1 || !/^[a-z0-9_-]+$/i.test(sessionId || '') || !/^[A-Za-z0-9_-]{1,64}(?:@[a-z0-9]+)?$/.test(o.pane || '')) {
    die('usage: keep force-restart <session-id> --pane <pane-id>[@<node>] [--recover]');
  }
  const response = await postKeepApi('/api/restart-session', { sessionId, pane: o.pane,
    mode: o.recover ? 'recover' : 'force', confirmInterruption: true });
  const result = JSON.parse(response.data);
  if (response.status !== 200) die(result.error || 'Force restart refused');
  console.log(`Force restart ${result.status}; daemon owns recovery. Inspect /api/state restarts for outcome.`);
};


function helpText() {
  return `keep — work registry (~/keep)

  keep init [--dir path]   # create a separate private registry
  keep doctor              # diagnose this installation
  keep setup hooks [--account <id>]
                           # install Claude hooks and the core skill pack, in every
                           # managed Claude account (--account limits it to one)
  keep setup skills [--pack <name>]… [--replace] [--list]
                           # link skill packs into ~/.claude/skills and ~/.agents/skills;
                           # core plus the recorded packs, repairing stale links
                           # --list shows every pack and its status and writes nothing
  keep setup --shell [--write]
                           # print (or write to ~/.zshrc) a zsh claude() that routes
                           # --resume/-r/--continue/-c through keep open; KEEP_RAW_CLAUDE=1 bypasses
  keep service install|start|stop|restart|status
  keep nodes                # the machines this install runs terminals on, with a live check
  keep nodes add <name> --address <ip:port> [--capabilities a,b]
                           # mint the node's token and print the keep node init line to run there
  keep nodes rm <name>
  keep nodes usage <node> <account>
                           # that account's usage as the node itself reads it
  keep nodes update [<node>…] [--no-reload] [--json]
                           # every other node fast-forwards its keep-tool checkout (and reloads its host if host code changed);
                           # wt land runs it after a keep-tool deploy
  keep node init <name> --daemon-node <name> --listen <ip:port> --token-file <path> [--sock <path>]
                           # on the node itself: install the host-only service
  keep node audit <name> [--json] [--all]
                           # compare the node's tools, agent config dirs, skills, MCP servers,
                           # plugins, repos and logins with this daemon node's; --all shows
                           # the per-project memory and worktree rows it otherwise counts
  keep add "title" [--kind task|experiment|idea|chore|bug] [--file|--claim] [--tag t]… [--project p]
                   [--plan "step" …] [--done-when "cmd"]… [--allow a,b] [--until when]
                   [--autonomous] [--experiment-id id] [--check-after when]
                   [--check "recipe"] [--on-pass done|rearm|review] [--check-every +7d]
                   [--probe "cmd"] [--status s] [--force] [-m note]
                   # --file records follow-up work without moving this session; ideas file by default
                   # --claim starts an idea now; --file and --claim are mutually exclusive
                   # --autonomous requires both --plan and --allow
  keep checkin <id> -m "state + next step" [--attach <file>]... [--step <n|next>] [--status s] [--experiment-id id]
                    [--next "text"] [--commit sha]… [--check-after when] [--check "recipe"] [--clear-check-after]
                    [--on-pass done|rearm|review] [--check-every +7d] [--probe "cmd"]
                    [--handoff waiting|needs-input] [--force]
                    # --on-pass says what a passing check means: close it, re-arm it every
                    #   --check-every (minimum +10m, implied by --check-every alone), or Owner review (default)
                    # --probe "<cmd>" is a read-only one-liner whose exit code decides the check
                    #   with no model at all; a failing probe escalates to the recipe. --probe "" removes it
                    # --check-after yields this turn to its scheduled recipe; --handoff needs-input keeps a decision visible
                    # --handoff requires a check time and recipe; --check alone edits the recipe without yielding
  keep plan <id> [--set "step" … | --add "text" | --insert <n> "text" | --remove <n>
                  | --done <n> | --start <n> | --undo <n>]
                 [--done-when "cmd"]…          # positional against --set/--add
  keep plan <id> --done-when <n> "cmd"         # set or clear ('') one criterion
  keep plan <id> --verify <n|next>             # run one criterion now (exit 3 = failed)
  keep allow <id>                              # what this card may do unattended
  keep allow <id> <action> [--amount n] [--quiet]   # exit 0 allowed, 3 not allowed
  keep allow <id> --grant a,b [--until when] | --revoke a,b | --clear
                                               # only Owner grants: --grant/--until are refused inside an
                                               # agent session unless --as-owner is passed with KEEP_OWNER=1
  keep reviewed <card> --commit <sha|range>… --verdict clean|findings
                       [--by codex|opus|claude|human…] [--job <id>] [--evidence "..."] [--fallback] [-m "..."] [--json]
                       # record that an independent review saw exactly these patches
                       # --fallback: this reviewer stood in because the Codex accounts were exhausted
  keep reviewing <card> --job <id> --commit <sha|range>… [--account <codex-id>] [--by "codex sol"] [-m "..."]
                       # a review you launched and have not heard back from; the daemon settles it
                       # from the job, and keep land refuses its commits until a verdict is recorded
  keep reviewing <card> --drop <obligation-id> -m "why"   # stop waiting for a review that is not coming
  keep reviewing <card> [--json]               # what this card is still waiting for
  keep reviews <card> [--json]                 # the review records on this card
  keep review-route [--json]                   # which reviewer an independent review should go to now
  keep review-route --exhausted <codex-id> --until <when> [-m "..."]   # record an account's usage limit
  keep review-route --clear <codex-id>
  keep land <card> [--dry-run] [--json]        # keep allow <card> land, then wt land, then cite the sha
                       # exit 3 when the reviewed patches are not exactly what would land
                       # for keep-tool, wt land fast-forwards a ready live checkout, restarts the daemon,
                       # and reports any skipped or failed deployment; it then watches daemon health
                       # for up to 90s and names a scheduler that regressed (WT_HEALTH_WAIT=0 skips the wait)
  keep retitle <id> "new title"
  keep rename [<#n|session-id>] "new title"    # name a session by hand; its automatic title stops updating
  keep rename [<#n|session-id>] --clear        # hand the session back to automatic titles
  keep mark [<#n|session-id>] --emoji 🔥 | --color red     # mark a session so it stands out in the console
  keep mark [<#n|session-id>] --no-emoji | --no-color | --clear   # take the mark off again
  keep mark --colors                           # the eight palette colors
  keep keep-running [<#n|session-id>] on|off   # persistently protect or release a session from automatic retirement
  keep project <id> [<path|name>] [-m "reason"]   # show or change project; preserves session links and schedule
  keep claim <card>                                # claim for the current session; run from the card's project
  keep link <card> --session <sid> --agent claude|codex|pi   # repair ownership metadata without waking or launching
  keep list [--status s]… [--tag t] [--project p] [--overdue] [--brief] [--all]
  keep show <id>
  keep artifact <card> [--] [<file>...] [-m "note"]
                         # copies files into committed .keep/artifacts/<card>/ and prints durable paths; use instead of citing /tmp
  keep artifact <card> --get <name> [--out <path>] [--force]
                         # copies a stored artifact back out as a file (from a node too) and prints where
  keep wait [--no-hold <project> [--scope <resource>]] [--card <id>[#<n>]] [--lane <project> <step>]
            [--check-due <id>] [--for <duration>] [--interval <seconds>]
  keep wait-on <card> <upstream>[#<step>] [<upstream>[#<step>]...] [--whole] -m "why"
  keep wait-on <card> <upstream> [--commit <sha>[,<sha>] | --deployed <sha> --target <name> | --status review,landing,done] -m "why"
  keep wait-on <card> --remove <upstream>[#<step>] [...] [matching target flags] [-m "why"]
  keep deps [<card>]
  keep done <id> [--next "text"] [--commit sha]… [--force] [-m note]
  keep archive [<id>]     # archive one task, or sweep all done tasks
  keep tag <id> +a -b
  keep tags
  keep overdue [--brief]
  keep who <project> [--json] [--scope <resource>]  # scope filters holds only
  keep hold <project> --for +15m -m "why" [--task <id>] [--scope <resource>]
    Repeat --scope for each touched resource (e.g. browser-hosts and terraform).
    Exact labels overlap; omitted/legacy scopes are project-wide. Advisory, not authorization.
    device:<serial> names shared hardware and shows in every project (who, session start).
  keep release <hold-id>
  keep holds
  keep resources <project> [--json]
  keep resources <project> --add <name> [--title t] [--command <re>]… [--path <glob>]… [--deploy <kind:target>]… [--note-for +2h]
  keep resources <project> --remove <name>
  keep resources --check <project> "<command>"
                          # named shared resources a project declares; names are hold/note scopes
                          # matchers are regexes (commands), globs (paths), <kind>:<target> (deploys). Advisory.
  keep note <project> --scope <resource> [--scope ...] -m "what is true now" --for +2h [--task <card>]
  keep note --extend <id> --for +2h | --clear <id> [-m why]
                          # expiring, non-blocking statement about shared state; broadcast to siblings
  keep notes [<project>] [--all] [--json]
                          # active notes; --all adds recently expired and cleared ones
  keep needs [<card> "<secret or action>" [--env NAME] | <card> --met [--env NAME|"<text>"]]
                          # what only Owner can supply; no args is a read-only list
                          # env needs auto-clear only at startup of a linked owning session
  keep secret request <NAME> --to <path> [--key VAR] [-m "what it is for"] [--card <id>] [--replace] [--multiline]
                          # Owner pastes it in the console on this session; it is written to <path>
                          # on this machine (0600), never shown to the agent. --key upserts VAR=value
  keep secret status [<id>] [--all] [--json]
                          # this session's requests, or one; exits 3 while one is still pending
  keep secret wait <id> [--for 10m]
                          # 0 delivered, 1 declined, expired, cancelled or superseded, 124 still waiting
  keep secret cancel <id> [-m "why"]
                          # take back a request this session no longer needs; Owner stops seeing it
${stepUsage()}
  keep decide <type> [--card <id>] [--session <sid>] --send "<message>" -m "why"
                         # the reviewer records what it WOULD do; nothing is sent
  keep decisions [--all] [--type t] [--json]
  keep decisions agree <id> [-m note] | disagree <id> -m "why" | edit <id> -m "..."
  keep decisions stats [--json]   # agreement per decision type
  keep alert -m "text" --level attention|urgent [--key k] [--card id] [--from name] [--dry]
  keep quiet <duration>|off
  keep alerts [--all]
  keep lint [--json] [--rule <name>] [--fix-hints]
  keep brief [--send]
  keep health [--json]
  keep self-repair [--dry] [--json] [--reset <signature>] [--disable|--enable]
                         # what the daemon has opened on itself: open signatures, their cards,
                         #   cooldowns and today's count against the daily cap
                         # --dry prints what the next tick would open and why, writing nothing
                         # --reset <signature> clears one signature's cooldown and resolution
  keep stalled [--json]
                         # sessions, Codex jobs and brokers that stopped moving, and durable
                         #   in-flight records (transfers, delivery journals, model swaps, ...)
                         #   past their max age, each with the command that resolves it
  keep codex-jobs [--json] [--reap] [--dry]
  keep leftovers [--json] [--reap] [--dry]
    List companion jobs and brokers; --reap cleans stale jobs, pollers, and brokers.
  keep codex [--account <codex-id>] context [--json]
  keep codex [--account <codex-id>] <task|task-resume-candidate|status|result|cancel> [args]
    Run the installed Codex companion with isolated account state and credentials.
  keep pi task --background [--provider p] [--model m] [--cwd dir] -- <prompt>
  keep pi status [<job>] [--json] | result <job> [--json] | cancel <job> [--json]
  keep standup [--since "YYYY-MM-DD HH:MM"|ISO] [--dry] [--show]
  keep ideas [--dry] [--model <m>]
  keep landed [--dry] [--only <id>]
  keep landed policy narrow|broad
  keep landed dry on|off
  keep landed judge rules|haiku|veto
  keep landed decisions [--disagree]
  keep slack poll [--dry]
  keep slack status
  keep slack mode log|cards|alerts
  keep discord poll [--dry]
  keep discord status
    standup, ideas, slack and discord are optional features; keep doctor lists which are on.
  keep incidents [--json]
                         # open incident signatures: card, area, fire count, last fired
  keep incidents parse <file|-> [--json]
                         # parse one Slack message (or a JSON array of them) the way the
                         # poll does — the way to debug an alert shape without polling
  keep incidents close <card-id|signature> -m "why"
                         # close an incident that will never resolve itself (a merged
                         # signature, diagnosed noise): same locked close as the sweep
  keep incidents session <area> [--dry] [--json]
                         # one area-session tick by hand: launch, deliver, restart-from-log
                         # --dry performs nothing and reports what it would do
  keep agents [--json]   # agent records: lifecycle, current session, unseen events
  keep agents events <name> [--unseen] [--limit N] [--json]
  keep agents emit <name> --kind <k> [--card <id>] [--severity low|med|high] [--needs-you] -m "text"
                         # an agent session's own way to write its feed; --needs-you also
                         # raises an attention alert keyed agent:<name>:<card>
  keep agents seen <name>
                         # mark every unseen event seen (what the console posts on expand)
  keep probe <id>      # run this card's probe now (exit 1 = failed); no check-in, no daemon
  keep verify <id>     # run this task's check recipe now, in its thread or a fresh session (needs keep serve)
  keep compact <sid>   # compact a live Claude or Codex session (needs keep serve)
  keep compact [<sid> --when-idle] [-m "reason"]
                         # bare, from inside a session: ask the daemon to compact this session
                         # at its next idle moment (on its own model when the sweep would);
                         # use it at a stopping point: a card done, a land, a long keep wait
  keep open <card|session-id|#n> [--fresh] [--agent claude|codex|pi] [--account <id>] [--model <id>] [--node <name>] [--needs <capability>] [-m "opening message" | --message-file <path>]
                         # --node runs it on that machine; --needs picks one with that capability
                         # #n is the console's session number (12, #12 and s12 all work);
                         # a fresh launch without --account picks the caller's account, then the
                         # default, skipping accounts that are out of usage;
                         # --model applies to the launched process only (never settings.json);
                         # -m waits for the agent's prompt and types the message;
                         # --fresh on a card links the new session and unlinks the caller's
  keep tell <card|session-id|#n> -m "message" | --message-file <path> [--wait <duration>] [--dry] [--json]
                         # message another live agent session through the same guarded send
                         # path Keep's own deliveries use; the daemon builds the frame, and
                         # refuses a target that is mid-turn, waiting on Owner, or spent
                         # (exit 3 refused, 124 --wait ran out); --wait retries only on busy;
                         # --dry resolves the target and prints what would be sent
  keep delegate <card> --step <n> -- <command> [args]
  keep delegate <card> --step <n> --prepare
  keep delegate <card> --step <n> --session <sid> --agent claude|codex|pi
  keep delegate --accept <delegation-id> | --end
                         # explicit worker assignment; parent retains card ownership, check-ins and permissions
  keep pane ls [--json] | show <pane> [--json]
  keep pane new [--cwd dir] [--name n] [--meta key=value]... [--cols n --rows n] -- <cmd> [args]
  keep pane send <pane> [--no-enter] [--] <text...> | resize <pane> <cols>x<rows>
                         # use -- before text that starts with --
  keep pane screen <pane> [--lines n] [--scrollback n]
  keep pane clear <pane> | kill <pane> [--signal SIG] | rm <pane>
  keep pane attach <pane> [--raw] [--observer]
  keep host [status [--json] | reload | shutdown | ls | spawn [--cwd dir] [--meta key=value]... -- <cmd> [args] |
             screen <pane> [--lines n] [--scrollback n] | kill <pane> | clear <pane> | rm <pane>]
                         # no subcommand runs it in the foreground; shutdown ends every pane
  keep attach <pane> [--raw] [--observer]
  keep resume [--raw]    # post-restart: active tasks + keep open commands (--raw prints the bare CLI form)
  keep restore [--dry] [--since +48h|hours] [--project path]
                         # reopen sessions whose agent process is gone
  keep sync              # pull --rebase + push
  keep digest            # write digests/YYYY-MM-DD.md and print it
  keep serve             # start the dashboard server (KEEP_PORT, default 7777)
                         # KEEP_AUTO_CLOSE_DONE_MIN (default 15), ATTENTION_MIN (30), UNATTENDED_MIN (60); KEEP_AUTO_CLOSE=0 disables auto-close
  keep restart-daemon    # guarded daemon-only restart (requires launchd KeepAlive)
  keep accounts list [--json]
  keep accounts add <id> --agent claude|codex --label <label> --config-dir <dir>
  keep accounts default claude|codex <id>
  keep accounts setup <id> --share-from <source-id>
  keep handoff <session-id> --pane <pane-id> --account <target-id> [--force]
  keep move <#n|session-id> --node <name> [--force] [--dry] [--json]
                         # stops a Claude or Codex session, carries its files to <name> and resumes it there
                         # the cwd must exist on <name> first; --force is Owner's forced stop (needed off a node)
  keep move --recover <tx> | --abandon <tx>    # continue a move that stopped part way, or leave it where it was
  keep transfer <source-session-id> --account <target-id> --context <handoff.md> [--cwd <worktree>] [--prepare-only]
                         # starts a fresh conversation from a prose-only portable package; source session remains intact
                         # ambiguous launches require --resolve-session <destination-id>, never a blind second launch
  keep force-restart <session-id> --pane <pane-id> [--recover]    # explicit interruption; never automatic cleanup
  keep review-queue [--limit n] [--min-score n] [--json]   # what deserves review now
  keep review-bundle <id> [--budget n] [--session id] [--force]
  keep review-bundle <id> [<id>...] [--budget n] [--total-budget n] [--force]
  keep review-bundle --queue [--limit n] [--budget n] [--total-budget n] [--force]
                         # evidence bundle for the fleet reviewer (exit 3 = nothing new)
  keep review-bundle <id> --session <id> --from <byte> --raw
                         # re-read a coverage gap the delta cap skipped
  keep review-note <id> --kind k --subject s [--severity s] -m "finding"
                         [--basis observed|inferred|needs-verification] [--evidence "references"] [--checked "verification performed"] [--question "what to verify?"] [--unknown "missing evidence"]
  keep review-idea "<title>" -m "<body>" [--project p] [--cards a,b,c] [--severity low|med]
  keep review-ack <id> [--bundle id] [--probe-safe] [-m note]  # reviewed; probe-safe approves exact read-only automated calls
  keep review-replay <card> [--since ISO-timestamp] [--session id]  # read-only counterfactual against recorded review times
  keep review-eval <--run|--prompt|--predictions file> [--model name] [--skill file] [--suite file] [--compare report.json] [--json]  # informational frozen-case judgment evaluation
  keep review-dismiss <id> <key> [-m why]
  keep review-outcome [<card> [<key> <status> -m "reason" --evidence "reference"]] [--json]
                         # fixed, confirmed-deferred, incorrect, superseded, unresolved; list when status omitted
  keep review-land --file <path> | keep review-land -
                         # land one JSON review tick under one lock and commit
  keep review-budget [--json] [--model m] [--account claude-id]
                         # may the active reviewer account spend right now?
  keep review-tick [--force]               # wake the reviewer now (needs keep serve)
  keep usage [<card>] [--json]   Forward-only model token usage
                         # no card: fleet totals, including unassigned usage
  keep review-stats [--json]               # last tick, skips, per-day counts
  keep nudge <id> --session <sid> --key <k> -m "finding" [--send]
  keep nudge live [on|off|contradictions|<kind,kind>]
                         # --send only delivers for a live kind
                         # message a live agent about a finding (dry-run without --send)
  keep search "<words>" [--cards|--conversations] [--all] [--since when] [--project p] [--limit n] [--json]
                         # where was X decided: matching cards (title, tags, text), then conversations
  keep turns show <session-id|card-id> [--last N] [--json]
                         # indexed turns for a session, or for every session linked to a card
  keep turns search "<query>" [--all] [--since when] [--project p] [--agent claude|codex] [--limit n] [--json]
                         # find earlier conversations: one row per session, newest match first, with its
                         # #number, title and card; --all also searches tool output, headless runs and subagents
  keep turns stats [--since when] [--json]
                         # sessions, turns, human/[keep] openers and bare-nudge openers per agent and kind
  keep turns ingest <file> [--agent claude|codex] [--force]   # index one transcript now
  keep turns backfill [--since when] [--roots dir,dir] [--force] [--json]
                         # walk every Claude project root and Codex rollout dir (default: last 14 days)
                         # --since +7d means the last 7 days; a date means from that date
  keep turns prune [--older-than when] [--dry] [--json]
                         # drop indexed sessions last active before then (default: 120 days);
                         # the daemon runs this once a day with the same default

  keep watcher run <session-id|card-id> [--turn n] [--dry] [--json]
                         # judge one ended turn: what would Owner have typed next? Recorded, never sent.
                         # --dry prints the context and the rule-only verdict without calling a model
  keep watcher ls [--since when] [--verdict continue|needs-input|drift|quiet] [--limit n] [--json]
  keep watcher compare [--since when] [--limit n] [--only disagreements|all] [--json]
                         # the console's "Waiting on you" rules against the watcher's needs-input judgement
                         # noise = the rules asked for Owner and the model did not; missed = the other way
                         # the inferred-rule table (prose-request, conversation-wait, conversation-ready)
                         # is the real question; drift is counted apart and left out of the 2x2
  keep watcher replay [--since when] [--limit n] [--agent claude|codex] [--json]
                         # re-judge history and score each verdict against what Owner actually typed
  keep watcher score [--since when] [--agent claude|codex] [--misses n] [--include-late] [--json]
                         # score the verdicts the console actually showed against what Owner typed next;
                         # no model call, nothing written; every stored verdict unless --since
                         # a verdict stamped after Owner replied is skipped unless --include-late
  keep watcher stats [--since when] [--json]
                         # verdict counts plus the shadow-decision agreement rate per type
                         # the daemon tick is off unless KEEP_WATCHER=1
  keep watcher live [on|off|<type,type>] [--force] [--json]
                         # which verdict types are delivered to the session for real
                         # types: continue, needs-input, drift; off by default
                         # a type is refused until 30 of its decisions are graded at 90% (--force overrules)
                         # keep watcher live off stops every delivery immediately

  keep hook session-start|session-end|stop|notification|lifecycle|pre-bash|post-bash|prompt
                         # Claude context, enforcement, notifications and observation-only lifecycle records
  keep hook codex <start|stop|question|approval|complete|end|client-end|pre-tool|post-tool|lifecycle>
                         # Codex attention, lifecycle and Stop enforcement hooks

  when: YYYY-MM-DD | YYYY-MM-DDTHH:MM | +15m | +3d | +12h | +2w | tomorrow
  statuses: ${STATUSES.join(' → ')}`;
}

function commandUsage(cmd) {
  const escaped = String(cmd).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const commandLine = new RegExp(`^  keep ${escaped}(?:\\s|$)`);
  const lines = helpText().split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!commandLine.test(lines[i])) continue;
    const block = [lines[i]];
    while (i + 1 < lines.length && /^ {3,}/.test(lines[i + 1]) && !/^  keep /.test(lines[i + 1])) {
      block.push(lines[++i]);
    }
    blocks.push(block.join('\n'));
  }
  return blocks.length ? blocks.join('\n') : null;
}

commands.help = (argv) => {
  console.log(commandUsage(argv[0]) || helpText());
};

// Each command group lives in its own file; their tables merge into this one.
Object.assign(commands, hookGroup.commands, hostGroup.commands, nodesGroup.commands, reviewGroup.commands, stepGroup.commands, turnsGroup.commands, watcherGroup.commands, secretGroup.commands);

// ---------- main / module ----------

module.exports = {
  demoteHeadings,
  ROOT, TASKS, ARCHIVE, STATUSES, KINDS, STATUS_ORDER, META, HOLDS_DIR,
  isReviewerSession, registerReviewerSession, currentSession, inAgentSession, implicitLandVerdict, parseWhen, relativeDurationMs, postKeepApi, getKeepApi,
  loadAll, loadTask, loadTaskAnywhere, parseTask, serializeTask, parsePlan, renderPlan, setPlan, nextStep, lastLogLine, isOverdue, nowStamp, stampOf, buildDigest,
  parseDependency, dependencyTarget, dependencyReason, dependencyStep, deploymentFact, isDoneLogHeading, dependencyResolved, dependencyInfo, unresolvedDependencyIds,
  withLock, commitAndPush, saveTask, recordDoneTransition, recordDaemonSessionClose, addTask, checkinTask, briefSnapshot, scopeForProject, KeepError,
  CHECK_ON_PASS, MIN_CHECK_EVERY_MS, applyCheckPolicy, cleanProbe, cleanCheckEvery, runProbe,
  claimSession, linkLaunchedSession, relinkSessionNode, releaseCardSession,
  emptyStopEvidence, scanStopEvidence, hasSubstantiveStopEvidence, canonicalCwd, inferProject,
  writePaneRecord, stopHook,
  recordSessionPane,
  releaseSessionPane,
  projectMatchesCwd, looksLikeGitWrite, normalizeProjectPath, resolveProjectArg, activeHolds,
  openNeeds, addNeed, meetNeeds, sweepNeeds,
  taskForSession, newestTaskForSession, readCodexParent, deployCommand, deployEntry, recordDeploy, redactCommand,
  stepMatchForInput, guardStepCommand, guardResumeCommand, guardRepairCommand, repairAllowedCommand,
  repairInvocations, rawClaudeResume,
  recordStepRun, codexToolInput, codexExitCode,
  codexJobText, renderCodexJobs,
  codexCommandCli: commands.codex,
  commandUsage, helpText, formatOpenResult, openCommand: commands.open, verifyCommand: commands.verify, compactCommand: commands.compact,
  tellCommandCli: commands.tell, writeOpenHandoff,
  postOpen, OPEN_MESSAGE_LIMIT, OPEN_MESSAGE_ERROR, LAUNCH_MODEL_RE, PI_MODEL_RE,
  restoreCommandCli: commands.restore, resumeCommandCli: commands.resume, resumeCommand,
  renameCommandCli: commands.rename, markCommandCli: commands.mark, keepRunningCommandCli: commands['keep-running'],
  accountsCommandCli: commands.accounts, handoffCommandCli: commands.handoff, transferCommandCli: commands.transfer,
  moveCommandCli: commands.move,
  delegateCommandCli: commands.delegate,
  artifactCommandCli: commands.artifact,
  resolveReviewBudgetTarget, reviewBudgetCommandCli: commands['review-budget'],
  hostCommandCli: commands.host, paneCommandCli: commands.pane, attachCommandCli: commands.attach,
  resolveHostPane, renderHostPanes, parseHostSpawn,
};

commands.init = (args) => require('./setup').init(args);
commands.doctor = () => require('./setup').doctor(ROOT);
commands.setup = (args) => {
  if (args.includes('--shell')) return require('./setup').shell(args);
  if (args[0] === 'skills') return require('./setup').installSkills(args.slice(1));
  if (args[0] !== 'hooks' || (args.length !== 1 && (args.length !== 3 || args[1] !== '--account'))) {
    throw new KeepError('usage: keep setup hooks [--account <id>] | keep setup skills [--pack <name>]… [--replace] [--list] | keep setup --shell [--write]');
  }
  return require('./setup').installHooks(args.slice(1));
};
commands.service = (args) => require('./setup').service(args, ROOT);
commands.node = (args) => (args[0] === 'audit'
  ? nodesGroup.nodeAudit(args.slice(1))
  : require('./setup').node(args, ROOT));

// A machine that holds terminals for another one's registry answers only for
// itself. This table is the whole of what runs there, and it is an allow-list on
// purpose: every command that reads or writes the registry, including any added
// after it, is refused by not being named here. `true` allows every form of a
// command; a list allows those subcommands (a missing one is the command's default);
// a function reads the arguments itself.
const PANE_ONLY_COMMANDS = {
  help: true,
  hook: true, // the hooks have their own pane-only mode: bind, release, and nothing written
  host: true,
  pane: true,
  attach: true,
  doctor: true,
  setup: true, // hooks, skills and the shell block of this machine's own agents
  secret: true, // asks the daemon over its node API; the destination is checked here
  nodes: (args) => !args.length || ['ls', 'usage'].includes(args[0]) || String(args[0]).startsWith('-'),
  node: (args) => args[0] === 'init',
  // The Codex companion runs on this machine, for the sessions here: the codex binary,
  // its login and the plugin script live under this node's own profiles, its accounts
  // come from this machine's Keep configuration file, and a job's record goes under
  // this node's registry directory's `.keep` (a node holds a synced copy of the
  // registry, which node provisioning and `keep node audit` cover, and the guard
  // below still asks for it, as it did for `context`). The review a job answers is
  // recorded through the forwarded `reviewing` / `reviewed`, which carry the job as
  // this node read it (nodeFactArgs). Limited to `context` at first, every review a
  // session here ran had to fall back to Opus.
  codex: true,
};

function paneOnlyRefusal(cmd, args, env = process.env) {
  const where = require('./nodes.js').paneOnlyNode(env);
  if (!where) return null;
  const rule = Object.prototype.hasOwnProperty.call(PANE_ONLY_COMMANDS, cmd) ? PANE_ONLY_COMMANDS[cmd] : null;
  if (rule === true || (typeof rule === 'function' && rule(args))) return null;
  return `keep ${cmd}: the registry lives on node ${where.daemon}; this is node ${where.local}`;
}
// `keep checkin --attach` on a pane-only node. The files are on this node, so they
// go up the way a node's `keep artifact` does (remote-cli runArtifact), and the
// check-in is forwarded without --attach, naming what was stored. The daemon refuses
// a forwarded --attach (registry-commands NODE_FILE_FLAGS): it would read its own files.
async function checkinRemote(argv, where, deps = {}) {
  const remote = deps.remote || require('./remote-cli.js');
  const o = parseArgs(argv, CHECKIN_FLAGS);
  const id = o._[0];
  if (!id || !o.m || !o.m.trim()) die(CHECKIN_USAGE);
  const forwarded = [];
  // Where the message parseArgs reads (the last -m) sits in `forwarded`.
  let messageAt = -1;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') { forwarded.push(...argv.slice(i)); break; }
    if (arg === '--attach') { i += 1; continue; }
    forwarded.push(arg);
    if (arg === '-m') messageAt = forwarded.length;
    if (arg === '-m' || (arg.startsWith('--') && CHECKIN_FLAGS[arg.slice(2)] !== 'bool')) forwarded.push(argv[++i]);
  }
  let names = [];
  if (o.attach) {
    const stored = await remote.runArtifact([id, '--', ...o.attach], { where });
    if (stored.code !== 0) return stored;
    names = stored.stdout.split('\n').filter(Boolean).map((line) => path.basename(line));
    if (stored.stderr) process.stderr.write(stored.stderr);
  }
  forwarded[messageAt] = withAttached(o.m, names);
  return remote.runRemote('checkin', forwarded, { where });
}

// `keep artifact <card> --get <name>` on a pane-only node: the file is in the
// daemon's registry, so its bytes come from the daemon's node API.
async function artifactGetRemote(argv, where, deps = {}) {
  const o = parseArgs(argv, ARTIFACT_FLAGS);
  const [id, ...inputs] = o._;
  if (!id || o.get == null) die(ARTIFACT_USAGE);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) die(`invalid artifact card id "${id}"`);
  artifactGetArgs(id, o, inputs);
  const artifacts = require('./card-artifacts.js');
  const destination = artifacts.getDestination(o.get, o.out, deps.cwd || process.cwd());
  const fetched = await (deps.fetchArtifact || require('./remote-cli.js').fetchArtifact)(where, id, o.get);
  if (fetched.code !== 0) return fetched;
  try { artifacts.writeFetched(destination, fetched.bytes, { force: o.force }); }
  catch (error) {
    if (error instanceof artifacts.ArtifactError) return { code: 1, stdout: '', stderr: `keep artifact: ${error.message}\n` };
    throw error;
  }
  return { code: 0, stdout: `${destination}\n`, stderr: '' };
}

module.exports.artifactGetRemote = artifactGetRemote;
module.exports.checkinRemote = checkinRemote;
module.exports.paneOnlyRefusal = paneOnlyRefusal;
module.exports.PANE_ONLY_COMMANDS = PANE_ONLY_COMMANDS;
module.exports.landRemote = landRemote;
module.exports.allowRemote = allowRemote;

if (require.main === module) {
  (async () => {
    try {
      const [cmd, ...rest] = process.argv.slice(2);
      // A pane-only node that knows its daemon's node API sends registry commands
      // there. Without KEEP_DAEMON_URL remoteMode is null and nothing here runs.
      const remote = require('./remote-cli.js').remoteMode(process.env);
      if (remote && cmd === 'allow' && allowRemoteHandles(rest)) {
        await allowRemote(rest, remote);
        return;
      }
      // `keep nodes` answers for this machine (ls, usage) except `update`, which
      // only the daemon can run: it holds the node list and their tokens.
      const localNodes = cmd === 'nodes' && rest[0] !== 'update';
      if (remote && cmd === 'checkin' && rest.some((arg) => arg === '--attach')) {
        const result = await checkinRemote(rest, remote);
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exitCode = result.code;
        return;
      }
      if (remote && !localNodes && require('./registry-commands.js').isRegistryCommand(cmd || 'list')) {
        // The commits and the Codex job a review names are in this node's worktree and
        // jobs directory, so they are resolved here and sent as facts.
        const args = cmd === 'reviewed' || cmd === 'reviewing'
          ? reviewRecordError((reviews) => reviews.nodeFactArgs(cmd, rest, { cwd: process.cwd(), root: ROOT }))
          : rest;
        const result = await require('./remote-cli.js').runRemote(cmd || 'list', args, { where: remote });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exitCode = result.code;
        return;
      }
      if (remote && cmd === 'land') {
        await landRemote(rest, remote);
        return;
      }
      // Its files are on this node: they are read here and their bytes posted to the
      // daemon, which stores them with its own CLI (bin/artifact-route.js).
      if (remote && cmd === 'artifact' && parseArgs(rest, ARTIFACT_FLAGS).get != null) {
        const result = await artifactGetRemote(rest, remote);
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exitCode = result.code;
        return;
      }
      if (remote && cmd === 'artifact') {
        const result = await require('./remote-cli.js').runArtifact(rest, { where: remote });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exitCode = result.code;
        return;
      }
      // Before the registry is even looked for: on a pane-only node the answer is
      // where the registry is, not that there is none here.
      const elsewhere = commands[cmd || 'list'] ? paneOnlyRefusal(cmd || 'list', rest) : null;
      if (elsewhere) {
        process.stderr.write(`${elsewhere}\n`);
        process.exitCode = 2;
        return;
      }
      // `host` is exempt with them: the terminal host is a machine's process, not a
      // registry's, and it must start where there are no cards to read.
      // `node` joins them: `keep node init` runs on a machine that is being set up to
      // hold terminals for another one's registry, and has none of its own.
      if (!fs.existsSync(TASKS) && !['help', 'hook', 'init', 'doctor', 'setup', 'review-eval', 'host', 'node', 'secret'].includes(cmd)) die(`no repo at ${ROOT} (set KEEP_DIR?)`);
      const fn = commands[cmd || 'list'];
      if (!fn) die(`unknown command "${cmd}" — try \`keep help\``);
      const helpArgs = [];
      for (let i = 0; i < rest.length; i += 1) {
        if (rest[i] === '-m') {
          i += 1;
          continue;
        }
        helpArgs.push(rest[i]);
      }
      if (cmd !== 'step' && helpArgs.some((arg) => arg === '--help' || arg === '-h')) {
        console.log(commandUsage(cmd) || helpText());
        return;
      }
      await fn(rest);
    } catch (e) {
      if (e instanceof KeepError) {
        process.stderr.write(`keep: ${e.message}\n`);
        process.exit(Number.isInteger(e.exitCode) ? e.exitCode : 1);
      }
      // A sandboxed worker — a Codex task, whose writable root is its own workspace —
      // can read the registry and cannot write it. That is a fact about where this
      // command runs, not a crash: say so in one line, and say who does the writing.
      // Only here, at the CLI's edge: the daemon shares withLock, and for it an
      // unwritable registry is a server failure that should keep its own shape.
      // A path boundary, not a prefix: ~/keep-tool is not under ~/keep.
      const under = (file) => { const rel = path.relative(ROOT, path.resolve(String(file))); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
      if (e && ['EPERM', 'EACCES', 'EROFS'].includes(e.code) && e.path && under(e.path)) {
        process.stderr.write(`keep: the Keep registry at ${ROOT} is not writable from here (${e.code}); a sandboxed worker returns its result to the parent session, which checks in\n`);
        process.exit(1);
      }
      throw e;
    }
  })();
}
