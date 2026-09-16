// keep step — the shared build and deploy steps a project registers, and the
// claim, run, done, fail and notify verbs agents drive them with.

'use strict';

const {
  die, KeepError, normalizeProjectPath, canonicalCwd, resolveProjectArg, parseArgs, loadAll, activeHolds,
  loadTask, commandSession, cleanScalar, withLock, nowStamp, writeJsonAtomic, holdFile, parseWhen,
  checkinTask, postKeepApi,
} = require('../keep-core.js');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const stepRegistry = require('../steps.js');

const commands = {};

function stepConfig(project, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(String(name || ''))) die(`invalid step name "${name}"`);
  const registry = stepRegistry.loadSteps(project);
  if (!registry) die(`no steps registry for ${project}`);
  const step = registry.steps[name];
  if (!step) die(`no step "${name}" for ${registry.project}`);
  return { registry, step };
}

function stepExitFive(message) {
  const error = new KeepError(message);
  error.exitCode = 5;
  throw error;
}

function describeClaim(hold) {
  const by = hold.by || {};
  return `${by.agent || 'manual'} ${String(by.sessionId || '').slice(0, 8) || '(no session)'} until ${hold.until} — ${hold.reason}`;
}

function stepProjectFromCwd(cwd) {
  let top = cwd;
  try {
    top = execFileSync('git', ['-C', top, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: 10e3, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}
  return normalizeProjectPath(canonicalCwd(top));
}

function resolveStepProject(arg) {
  if (!arg) return stepProjectFromCwd(process.cwd());
  const value = String(arg).trim();
  if (value && !value.includes('/') && !path.isAbsolute(value) && !value.startsWith('~')) {
    const matches = stepRegistry.registeredSteps().filter((registry) => path.basename(registry.project) === value);
    if (matches.length === 1) return matches[0].project;
    if (matches.length > 1) die(`step project "${value}" is ambiguous:\n${matches.map((match) => `- ${match.project}`).join('\n')}`);
  }
  return resolveProjectArg(value);
}

const STEP_USAGE_LINES = [
  '  keep steps [<project>] [--json]',
  '  keep step claim <project> <step> [--task <id>] [--for <dur>] [--wait] [--force] -m "why"',
  '  keep step run <project> <step> [--sha <sha>]',
  '  keep step done <project> <step> [--artifact <id>] [--sha <sha>] [--force] [-m note]',
  '  keep step fail <project> <step> [--force] -m "why"',
  '  keep step notify <project> <step>',
];

function stepUsage() {
  return STEP_USAGE_LINES.join('\n');
}

commands.steps = (argv) => {
  if (argv.some((arg) => ['help', '--help', '-h'].includes(arg))) return console.log(stepUsage());
  const o = parseArgs(argv, { json: 'bool' });
  if (o._.length > 1) die('usage: keep steps [<project>] [--json]');
  const project = resolveStepProject(o._[0]);
  const tasks = loadAll(false);
  const holds = activeHolds(project);
  const snapshot = stepRegistry.status(project, { tasks, holds });
  if (!snapshot) die(`no steps registry for ${project}`);
  if (o.json) return console.log(JSON.stringify(snapshot, null, 2));
  console.log(`Steps on ${snapshot.project}:`);
  for (const row of snapshot.steps) {
    console.log(row.line);
    if (row.git.available && row.pending.length) {
      for (const commit of row.pending) {
        console.log(`    ${commit.sha}  ${commit.subject}${commit.tasks.length ? `  [${commit.tasks.join(', ')}]` : ''}`);
      }
    }
  }
};

commands.step = async (argv) => {
  const [action, ...rest] = argv;
  if (['help', '--help', '-h'].includes(action)) return console.log(stepUsage());
  if (!action || !['claim', 'run', 'done', 'fail', 'notify'].includes(action)) {
    die(stepUsage());
  }
  if (action === 'claim') return stepClaim(rest);
  if (action === 'run') return stepRun(rest);
  if (action === 'done') return stepDone(rest);
  if (action === 'fail') return stepFail(rest);
  return stepNotify(rest);
};

function stepClaim(argv) {
  const o = parseArgs(argv, { task: 'str', for: 'str', wait: 'bool', force: 'bool' });
  if (o._.length !== 2 || !o.m) {
    die('usage: keep step claim <project> <step> [--task <id>] [--for <dur>] [--wait] [--force] -m "why"');
  }
  const project = resolveStepProject(o._[0]);
  const name = o._[1];
  const { registry, step } = stepConfig(project, name);
  const duration = o.for || step.defaultHold;
  if (!/^\+\d+[mhdw]$/i.test(duration || '')) die('--for or defaultHold must be a duration such as +45m or +2h');
  if (o.task) loadTask(o.task);
  const session = commandSession();
  const reason = cleanScalar(o.m, 'reason');
  const result = withLock(() => {
    const ledger = stepRegistry.loadLedger(registry.project, name);
    const running = [...ledger.runs].reverse().find((run) => run.status === 'running');
    let abandoned = null;
    if (running) {
      if (!o.force) return { running };
      running.status = 'abandoned';
      running.endedAt = nowStamp();
      running.note = [running.note, 'abandoned by forced claim'].filter(Boolean).join('; ');
      stepRegistry.saveLedger(registry.project, name, ledger);
      abandoned = running;
    }
    const existing = activeHolds(registry.project, Date.now(), { step: name })[0];
    if (existing && abandoned) {
      existing.released = nowStamp();
      writeJsonAtomic(holdFile(existing.id), existing);
    } else if (existing) {
      if (o.wait) {
        if (!session) die('--wait requires an agent session');
        if (!ledger.waiters.some((waiter) => waiter.sessionId === session.id)) {
          ledger.waiters.push({ sessionId: session.id, agent: session.agent, task: o.task || '', at: nowStamp() });
          stepRegistry.saveLedger(registry.project, name, ledger);
        }
        return { waiting: true, existing };
      }
      return { blocked: true, existing };
    }
    const hold = {
      id: `hold-${Date.now().toString(36)}`,
      project: registry.project,
      step: name,
      by: { sessionId: session ? session.id : '', agent: session ? session.agent : 'manual' },
      task: o.task || '',
      reason,
      from: nowStamp(),
      until: parseWhen(duration),
      released: false,
    };
    if (session) {
      const before = ledger.waiters.length;
      ledger.waiters = ledger.waiters.filter((waiter) => waiter.sessionId !== session.id);
      if (ledger.waiters.length !== before) stepRegistry.saveLedger(registry.project, name, ledger);
    }
    writeJsonAtomic(holdFile(hold.id), hold);
    return { hold, abandoned };
  });
  if (result.running) {
    const by = result.running.by || {};
    stepExitFive(`step ${name} still has running run ${result.running.id} by ${by.agent || 'manual'} ${String(by.sessionId || '').slice(0, 8) || '(no session)'} since ${result.running.startedAt || 'unknown'}; pass --force to abandon it`);
  }
  if (result.waiting) {
    console.log(`step ${name} is claimed by ${describeClaim(result.existing)}; registered once as a waiter and you will be notified`);
    return;
  }
  if (result.blocked) stepExitFive(`step ${name} is already claimed by ${describeClaim(result.existing)}`);
  const hold = result.hold;
  if (result.abandoned) {
    const by = result.abandoned.by || {};
    process.stderr.write(`keep: warning: abandoned running run ${result.abandoned.id} by ${by.agent || 'manual'} ${String(by.sessionId || '').slice(0, 8) || '(no session)'} from ${result.abandoned.startedAt || 'unknown'}\n`);
  }
  if (hold.task) {
    checkinTask(hold.task, {
      heading: `step ${name} claim`,
      message: `Claimed ${registry.project} step ${name} until ${hold.until}: ${reason}`,
    });
  }
  console.log(`${hold.id}: step ${name} on ${registry.project} claimed until ${hold.until} by ${hold.by.agent}${hold.by.sessionId ? ` session ${hold.by.sessionId.slice(0, 8)}` : ''} — ${reason}`);
}

function requireStepClaim(project, name) {
  const claim = activeHolds(project, Date.now(), { step: name })[0] || null;
  const session = commandSession();
  if (!session) return claim;
  if (!claim) stepExitFive(`step ${name} on ${project} has no active claim; run keep step claim first`);
  if (!claim.by || claim.by.sessionId !== session.id) stepExitFive(`step ${name} is claimed by ${describeClaim(claim)}`);
  return claim;
}

function gitAt(cwd, args, options = {}) {
  const output = execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: options.timeout || 10e3,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
  return typeof output === 'string' ? output.trim() : '';
}

function resolveLocalSha(project, ref) {
  try { return gitAt(stepRegistry.expandProject(project), ['rev-parse', `${ref}^{commit}`]); } catch { die(`cannot resolve git revision "${ref}" in ${project}`); }
}

function copyWorktreeIncludes(main, worktree) {
  let entries;
  try { entries = fs.readFileSync(path.join(main, '.worktreeinclude'), 'utf8').split('\n'); } catch { return; }
  for (const raw of entries) {
    const relative = raw.trim();
    if (!relative || relative.startsWith('#') || path.isAbsolute(relative) || relative.split(path.sep).includes('..')) continue;
    const source = path.join(main, relative);
    const target = path.join(worktree, relative);
    if (!fs.existsSync(source) || fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, errorOnExist: false });
  }
}

function runLogged(command, cwd, logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  return new Promise((resolve) => {
    const log = fs.createWriteStream(logFile, { flags: 'a' });
    const child = spawn('/bin/zsh', ['-lc', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { process.stdout.write(chunk); log.write(chunk); });
    child.stderr.on('data', (chunk) => { process.stderr.write(chunk); log.write(chunk); });
    let settled = false;
    const finish = (code, text) => {
      if (settled) return;
      settled = true;
      if (text) log.write(text);
      log.end(() => resolve(code));
    };
    child.on('error', (error) => {
      const text = `keep: could not start step command: ${error.message}\n`;
      process.stderr.write(text);
      finish(1, text);
    });
    child.on('close', (code) => finish(Number.isInteger(code) ? code : 1));
  });
}

function extractArtifact(logFile, pattern) {
  if (!pattern) return '';
  let body;
  try { body = fs.readFileSync(logFile, 'utf8'); } catch { return ''; }
  let regex;
  try { regex = new RegExp(pattern, 'g'); } catch { die(`invalid artifactPattern: ${pattern}`); }
  let artifact = '';
  for (const match of body.matchAll(regex)) artifact = match[0];
  return artifact;
}

async function stepRun(argv) {
  const o = parseArgs(argv, { sha: 'str' });
  if (o._.length !== 2) die('usage: keep step run <project> <step> [--sha <sha>]');
  const project = resolveStepProject(o._[0]);
  const name = o._[1];
  const { registry, step } = stepConfig(project, name);
  if (!step.command) die(`step ${name} has no command in its registry`);
  const claim = requireStepClaim(registry.project, name);
  withLock(() => {
    const current = activeHolds(registry.project, Date.now(), { step: name })[0] || null;
    if ((claim && (!current || current.id !== claim.id)) || (!claim && current)) {
      stepExitFive(`step ${name}'s claim changed before run setup; claim it again`);
    }
    const ledger = stepRegistry.loadLedger(registry.project, name);
    const otherRun = [...ledger.runs].reverse().find((entry) => entry.status === 'running');
    if (otherRun) {
      const by = otherRun.by || {};
      stepExitFive(`step ${name} already has running run ${otherRun.id} by ${by.agent || 'manual'} ${String(by.sessionId || '').slice(0, 8) || '(no session)'} since ${otherRun.startedAt || 'unknown'}`);
    }
    if (current && step.defaultHold) {
      const extendedUntil = parseWhen(step.defaultHold);
      if (Date.parse(extendedUntil) > Date.parse(current.until || '')) {
        current.until = extendedUntil;
        writeJsonAtomic(holdFile(current.id), current);
      }
    }
  });
  const main = stepRegistry.expandProject(registry.project);
  let cwd;
  let sha;
  let dirty = false;
  let prepareWorktree = null;
  if (step.from === 'landed') {
    try {
      gitAt(main, ['fetch', 'origin'], { timeout: 60e3, stdio: ['ignore', 'inherit', 'inherit'] });
    } catch { die(`git fetch origin failed for ${registry.project}`); }
    const branch = stepRegistry.defaultBranch(registry.project);
    sha = resolveLocalSha(registry.project, o.sha || `origin/${branch}`);
    try {
      gitAt(main, ['merge-base', '--is-ancestor', sha, `origin/${branch}`]);
    } catch { die(`${sha.slice(0, 7)} is not an ancestor of origin/${branch}; landed steps must run from a landed revision`); }
    if (!step.worktree) die(`landed step ${name} needs a worktree path in its registry`);
    cwd = stepRegistry.expandProject(step.worktree);
    prepareWorktree = () => {
      if (!fs.existsSync(cwd)) {
        try { gitAt(main, ['worktree', 'add', '--detach', cwd, sha], { timeout: 60e3, stdio: ['ignore', 'inherit', 'inherit'] }); }
        catch { die(`could not create step worktree ${cwd}`); }
      } else {
        let porcelain;
        try { porcelain = gitAt(cwd, ['status', '--porcelain']); } catch { die(`${cwd} is not a usable git worktree`); }
        if (porcelain) die(`step worktree ${cwd} is dirty; clean it before re-pinning`);
        try { gitAt(cwd, ['checkout', '--detach', sha], { timeout: 60e3, stdio: ['ignore', 'inherit', 'inherit'] }); }
        catch { die(`could not pin ${cwd} to ${sha.slice(0, 7)}`); }
        try {
          // prepare restores dependencies, and node_modules is excluded from the
          // bake's rsync; keep it so re-pinning does not force a full reinstall.
          gitAt(cwd, ['clean', '-fdX', '-e', '!node_modules'], { timeout: 60e3, stdio: ['ignore', 'inherit', 'inherit'] });
          // yarn trusts this file over the tree; a reused worktree keeps node_modules across revisions, so force the next --frozen-lockfile install to verify files (2026-09-02: two bakes failed on a missing vitest).
          fs.rmSync(path.join(cwd, 'node_modules', '.yarn-integrity'), { force: true });
        } catch { die(`could not clean ignored files from step worktree ${cwd}`); }
      }
      copyWorktreeIncludes(main, cwd);
    };
  } else if ((step.from || 'any') === 'any') {
    cwd = process.cwd();
    let top;
    try { top = gitAt(cwd, ['rev-parse', '--show-toplevel']); } catch { die('step must run from the project or one of its linked worktrees'); }
    if (normalizeProjectPath(canonicalCwd(top)) !== registry.project) {
      die(`cwd is not ${registry.project} or one of its linked worktrees`);
    }
    cwd = top;
    sha = resolveLocalSha(cwd, 'HEAD');
    // An `any` step runs whatever is checked out; `--sha` is the caller asserting
    // that this is the revision it thinks it is applying (2026-09-10: four production
    // applies passed --sha believing it pinned the run, and it was silently ignored).
    if (o.sha) {
      const wanted = resolveLocalSha(cwd, o.sha);
      if (wanted !== sha) {
        die(`${cwd} is at ${sha.slice(0, 7)}, not ${wanted.slice(0, 7)}; step ${name} runs from the current checkout, so check out ${wanted.slice(0, 7)} first`);
      }
    }
    dirty = Boolean(gitAt(cwd, ['status', '--porcelain']));
  } else {
    die(`step ${name} has unsupported from value "${step.from}"`);
  }

  const session = commandSession();
  const runId = `run-${Date.now().toString(36)}`;
  const logFile = stepRegistry.logPath(registry.project, name, runId);
  const runRecord = {
    id: runId,
    sha,
    startedAt: nowStamp(),
    endedAt: '',
    exitCode: null,
    status: 'running',
    by: { sessionId: session ? session.id : '', agent: session ? session.agent : 'manual' },
    task: claim && claim.task || '',
    cwd,
    logFile,
    artifact: '',
    note: dirty ? 'working tree was dirty' : '',
  };
  withLock(() => {
    const currentClaims = activeHolds(registry.project, Date.now(), { step: name });
    const current = currentClaims[0] || null;
    if ((claim && (!current || current.id !== claim.id)) || (!claim && current)) {
      stepExitFive(`step ${name}'s claim changed during run setup; claim it again before starting the command`);
    }
    const currentLedger = stepRegistry.loadLedger(registry.project, name);
    const otherRun = [...currentLedger.runs].reverse().find((entry) => entry.status === 'running');
    if (otherRun) {
      const by = otherRun.by || {};
      stepExitFive(`step ${name} already has running run ${otherRun.id} by ${by.agent || 'manual'} ${String(by.sessionId || '').slice(0, 8) || '(no session)'} since ${otherRun.startedAt || 'unknown'}`);
    }
    if (current && step.defaultHold) {
      const extendedUntil = parseWhen(step.defaultHold);
      if (Date.parse(extendedUntil) > Date.parse(current.until || '')) {
        current.until = extendedUntil;
        writeJsonAtomic(holdFile(current.id), current);
      }
    }
    if (prepareWorktree) prepareWorktree();
    currentLedger.runs.push(runRecord);
    stepRegistry.saveLedger(registry.project, name, currentLedger);
  });
  let exitCode = 0;
  if (step.prepare) exitCode = await runLogged(step.prepare, cwd, logFile);
  if (exitCode === 0) exitCode = await runLogged(step.command, cwd, logFile);
  const artifact = exitCode === 0 ? extractArtifact(logFile, step.artifactPattern) : '';
  const completion = withLock(() => {
    const finalLedger = stepRegistry.loadLedger(registry.project, name);
    const run = finalLedger.runs.find((entry) => entry.id === runId);
    if (!run || run.status !== 'running') return { abandoned: run && run.status === 'abandoned' };
    run.endedAt = nowStamp();
    run.exitCode = exitCode;
    run.artifact = artifact;
    // A failed run is history the moment the command exits: nothing to resolve later.
    // A successful one stays `running` for the few milliseconds until finalizeStep
    // marks it done, releases the claim, and notifies — it is the same command.
    if (exitCode !== 0) {
      run.status = 'failed';
      run.finalizedAt = nowStamp();
    }
    stepRegistry.saveLedger(registry.project, name, finalLedger);
    return { run };
  });
  if (completion.abandoned) {
    process.stderr.write(`keep: run ${runId} was abandoned while its command was executing; result not finalized\n`);
    process.exitCode = 5;
    return;
  }
  if (!completion.run) die(`run ${runId} disappeared from the ${name} ledger before completion`);
  if (exitCode !== 0) {
    process.stderr.write(`keep: step ${name} failed with exit ${exitCode}; log: ${logFile}; claim retained (use keep step fail to release it)\n`);
    if (claim && claim.task) {
      checkinTask(claim.task, {
        heading: `step ${name} attempt failed`,
        message: `Run ${runId} exited ${exitCode}; the claim is retained. Log: ${logFile}. Fix and re-run, or keep step fail ${registry.project} ${name} -m "why".`,
        linkSession: false,
        commitLabel: 'step',
      });
    }
    process.exitCode = exitCode;
    return;
  }
  console.log(`step ${name} completed from ${sha.slice(0, 7)}${artifact ? ` — artifact ${artifact}` : ' — no artifact found'}; log: ${logFile}`);
  await finalizeStep(registry, name, step, {
    sha, artifact, runId, expectedClaimId: claim && claim.id || '',
  });
}

function releaseStepClaim(project, name, options = {}) {
  const session = commandSession();
  const claims = activeHolds(project, Date.now(), { step: name });
  const claim = options.force
    ? claims[0]
    : session
    ? claims.find((hold) => hold.by && hold.by.sessionId === session.id)
    : claims[0];
  if (!claim) return null;
  claim.released = nowStamp();
  writeJsonAtomic(holdFile(claim.id), claim);
  return claim;
}

async function notifyStepWaiters(registry, name, details) {
  const deliveryId = `delivery-${process.pid}-${Date.now().toString(36)}`;
  const waiters = withLock(() => {
    const ledger = stepRegistry.loadLedger(registry.project, name);
    const staleBefore = Date.now() - 5 * 60e3;
    const selected = ledger.waiters.filter((waiter) => !waiter.deliveryId
      || (Number(waiter.deliveryAt) || 0) < staleBefore);
    for (const waiter of selected) {
      waiter.deliveryId = deliveryId;
      waiter.deliveryAt = Date.now();
    }
    stepRegistry.saveLedger(registry.project, name, ledger);
    return selected.map((waiter) => ({ ...waiter }));
  });
  const message = stepRegistry.notificationMessage({ step: name, project: registry.project, ...details });
  const failed = new Map();
  const delivered = new Set();
  for (const waiter of waiters) {
    try {
      const response = await postKeepApi('/api/send', { sessionId: waiter.sessionId, text: message });
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
      delivered.add(waiter.sessionId);
    } catch (error) {
      failed.set(waiter.sessionId, {
        ...waiter,
        attempts: (Number(waiter.attempts) || 0) + 1,
        lastError: error.message,
      });
      process.stderr.write(`keep: could not notify waiter ${String(waiter.sessionId || '').slice(0, 8)}: ${error.message}\n`);
    }
  }
  const remaining = withLock(() => {
    const latest = stepRegistry.loadLedger(registry.project, name);
    latest.waiters = latest.waiters.flatMap((waiter) => {
      if (waiter.deliveryId !== deliveryId) return [waiter];
      if (delivered.has(waiter.sessionId)) return [];
      const retry = failed.get(waiter.sessionId) || waiter;
      delete retry.deliveryId;
      delete retry.deliveryAt;
      return [retry];
    });
    stepRegistry.saveLedger(registry.project, name, latest);
    return latest.waiters.length;
  });
  return { waiters: waiters.length, failures: failed.size, remaining, message };
}

function describeRunOwner(run) {
  const by = run && run.by || {};
  return `${by.agent || 'manual'} ${String(by.sessionId || '').slice(0, 8) || '(no session)'}`;
}

function waiterRetrySuffix(notify) {
  return notify.remaining
    ? `; ${notify.remaining} waiter(s) remain; the next step done/fail will retry them, or run keep step notify`
    : '';
}

async function finalizeStep(registry, name, step, options = {}) {
  const finalized = withLock(() => {
    const ledger = stepRegistry.loadLedger(registry.project, name);
    let run = null;
    if (options.runId) {
      run = ledger.runs.find((entry) => entry.id === options.runId) || null;
      if (!run || run.status !== 'running') {
        stepExitFive(`run ${options.runId} is no longer running; reload the step before completing it`);
      }
    }
    const prior = [...ledger.runs].reverse().find((entry) => entry.status === 'done' && (!run || entry.id !== run.id));
    const branch = stepRegistry.defaultBranch(registry.project);
    const sha = resolveLocalSha(registry.project, options.sha || run && run.sha || `origin/${branch}`);
    if (step.from === 'landed') {
      try { gitAt(stepRegistry.expandProject(registry.project), ['merge-base', '--is-ancestor', sha, `origin/${branch}`]); }
      catch { die(`${sha.slice(0, 7)} is not an ancestor of origin/${branch}; landed steps must complete from a landed revision`); }
    }
    const session = commandSession();
    const activeClaim = activeHolds(registry.project, Date.now(), { step: name })[0] || null;
    if (activeClaim && activeClaim.id !== (options.expectedClaimId || '')) {
      stepExitFive(`step ${name}'s claim changed during finalization; reload it before completing the run`);
    }
    if (!options.force && session && activeClaim
        && (!activeClaim.by || activeClaim.by.sessionId !== session.id)) {
      stepExitFive(`step ${name} is claimed by ${describeClaim(activeClaim)}`);
    }
    // A recorded run keeps the identity of the session that started it; a synthetic
    // completion belongs to whoever is recording it now.
    const sessionBy = session ? { sessionId: session.id, agent: session.agent } : { sessionId: '', agent: 'manual' };
    const by = run && run.by || sessionBy;
    const artifact = options.artifact || run && run.artifact || '';
    if (!run) {
      run = {
        id: `run-${Date.now().toString(36)}`, sha, startedAt: nowStamp(), endedAt: nowStamp(), exitCode: 0,
        status: 'done', finalizedAt: nowStamp(), by, task: '', cwd: process.cwd(), logFile: '', artifact, note: options.note || '',
      };
      ledger.runs.push(run);
    } else {
      run.sha = sha;
      run.endedAt = nowStamp();
      run.exitCode = 0;
      run.status = 'done';
      run.finalizedAt = nowStamp();
      run.artifact = artifact;
      if (options.note) run.note = options.note;
    }
    stepRegistry.saveLedger(registry.project, name, ledger);
    const claim = releaseStepClaim(registry.project, name, { force: options.force });
    return { run, prior, sha, by, artifact, claim };
  });
  const { run, prior, sha, by, artifact, claim } = finalized;
  const notify = await notifyStepWaiters(registry, name, {
    outcome: 'finished', agent: by.agent, sessionId: by.sessionId, artifact, sha,
  });
  const included = stepRegistry.commitsBetween(registry.project, prior && prior.sha, sha, step);
  const attributed = stepRegistry.attributeCommits(included.commits, loadAll(false), registry.project);
  const cards = new Set(attributed.flatMap((commit) => commit.tasks));
  if (claim && claim.task) cards.add(claim.task);
  if (run.task) cards.add(run.task);
  const label = artifact || sha.slice(0, 7);
  const next = step.next ? ` Next: ${step.next}` : '';
  for (const card of cards) {
    checkinTask(card, {
      heading: `step ${name}`,
      message: `Included in ${label} (${name} run from ${sha.slice(0, 7)} by ${by.agent || 'manual'} ${String(by.sessionId || '').slice(0, 8) || '(none)'}).${next}`,
      linkSession: false,
      commitLabel: 'step',
    });
  }
  console.log(`finalized step ${name}: ${label}; released ${claim ? claim.id : 'no claim'}; notified ${notify.waiters - notify.failures}/${notify.waiters} waiter(s); checked in ${cards.size} card(s)${waiterRetrySuffix(notify)}`);
  return { run, claim, notify, cards: [...cards] };
}

async function stepDone(argv) {
  const o = parseArgs(argv, { artifact: 'str', sha: 'str', force: 'bool' });
  if (o._.length !== 2) die('usage: keep step done <project> <step> [--artifact <id>] [--sha <sha>] [--force] [-m note]');
  const project = resolveStepProject(o._[0]);
  const name = o._[1];
  const { registry, step } = stepConfig(project, name);
  const ledger = stepRegistry.loadLedger(registry.project, name);
  const running = [...ledger.runs].reverse().find((entry) => entry.status === 'running') || null;
  const finalized = [...ledger.runs].reverse().find((entry) => entry.finalizedAt
    && (entry.status === 'done' || entry.status === 'failed'));
  const claim = activeHolds(registry.project, Date.now(), { step: name })[0];
  const session = commandSession();
  // the claim is the ownership: a lane someone else holds is theirs to complete
  if (!o.force && session && claim && (!claim.by || claim.by.sessionId !== session.id)) stepExitFive(`step ${name} is claimed by ${describeClaim(claim)}`);
  if (running && !o.force) {
    stepExitFive(`run ${running.id} is still running by ${describeRunOwner(running)} since ${running.startedAt || 'unknown'};`
      + ` wait for it, or keep step fail ${registry.project} ${name} -m "why" if that session is gone,`
      + ` or pass --force to record it as done`);
  }
  if (!running && finalized && !claim && ledger.waiters.length) return stepNotify([registry.project, name]);
  await finalizeStep(registry, name, step, {
    sha: o.sha, artifact: o.artifact, note: o.m, force: o.force,
    expectedClaimId: claim && claim.id || '', runId: running && running.id,
  });
}

async function stepFail(argv) {
  const o = parseArgs(argv, { force: 'bool' });
  if (o._.length !== 2 || !o.m) die('usage: keep step fail <project> <step> [--force] -m "why"');
  const project = resolveStepProject(o._[0]);
  const name = o._[1];
  const { registry } = stepConfig(project, name);
  const ledger = stepRegistry.loadLedger(registry.project, name);
  const running = [...ledger.runs].reverse().find((entry) => entry.status === 'running') || null;
  const initialClaim = activeHolds(registry.project, Date.now(), { step: name })[0] || null;
  const session = commandSession();
  if (!o.force && session && initialClaim
      && (!initialClaim.by || initialClaim.by.sessionId !== session.id)) {
    stepExitFive(`step ${name} is claimed by ${describeClaim(initialClaim)}`);
  }
  // `step fail` resolves the lane, not one record: a claim to release or a waiter to
  // tell is reason enough, and with none of the three there is nothing to resolve.
  if (!running && !initialClaim && !ledger.waiters.length) {
    die(`step ${name} has nothing to fail: no running run, no claim, no waiters`);
  }
  const note = cleanScalar(o.m, 'note');
  const finalized = withLock(() => {
    const latest = stepRegistry.loadLedger(registry.project, name);
    const current = running ? latest.runs.find((entry) => entry.id === running.id) : null;
    if (running && (!current || current.status !== 'running')) {
      stepExitFive(`run ${running.id} is no longer running; reload the step before changing it`);
    }
    const activeClaim = activeHolds(registry.project, Date.now(), { step: name })[0] || null;
    if (activeClaim && activeClaim.id !== (initialClaim && initialClaim.id || '')) {
      stepExitFive(`step ${name}'s claim changed during finalization; reload it before completing the run`);
    }
    if (!o.force && session && activeClaim
        && (!activeClaim.by || activeClaim.by.sessionId !== session.id)) {
      stepExitFive(`step ${name} is claimed by ${describeClaim(activeClaim)}`);
    }
    if (current) {
      current.status = 'failed';
      current.endedAt = nowStamp();
      current.finalizedAt = nowStamp();
      if (current.exitCode == null || current.exitCode === 0) current.exitCode = 1;
      current.note = note;
      stepRegistry.saveLedger(registry.project, name, latest);
    }
    const released = releaseStepClaim(registry.project, name, { force: o.force });
    return { run: current, claim: activeClaim, released };
  });
  const finalizedRun = finalized.run;
  const claim = finalized.claim;
  const released = finalized.released;
  const actor = session || finalizedRun && finalizedRun.by || { id: '', agent: 'manual' };
  const by = actor.id !== undefined ? { sessionId: actor.id, agent: actor.agent } : actor;
  const sha = finalizedRun && finalizedRun.sha || '';
  const notify = await notifyStepWaiters(registry, name, {
    outcome: 'failed', agent: by.agent, sessionId: by.sessionId, note, sha,
  });
  const task = claim && claim.task || finalizedRun && finalizedRun.task;
  if (task) {
    checkinTask(task, {
      heading: `step ${name} failed`,
      message: `Failed ${name}${sha ? ` from ${String(sha).slice(0, 7)}` : ''}: ${note}`,
      linkSession: false,
      commitLabel: 'step',
    });
  }
  console.log(`failed step ${name}; released ${released ? released.id : 'no claim'}; notified ${notify.waiters - notify.failures}/${notify.waiters} waiter(s)${waiterRetrySuffix(notify)}`);
}

async function stepNotify(argv) {
  const o = parseArgs(argv, {});
  if (o._.length !== 2) die('usage: keep step notify <project> <step>');
  const project = resolveStepProject(o._[0]);
  const name = o._[1];
  const { registry } = stepConfig(project, name);
  const ledger = stepRegistry.loadLedger(registry.project, name);
  const run = [...ledger.runs].reverse().find((entry) => entry.finalizedAt
    && (entry.status === 'done' || entry.status === 'failed'));
  if (!run) die(`step ${name} has no completed run to notify waiters about`);
  const by = run.by || { sessionId: '', agent: 'manual' };
  const notify = await notifyStepWaiters(registry, name, run.status === 'failed'
    ? { outcome: 'failed', agent: by.agent, sessionId: by.sessionId, note: run.note, sha: run.sha }
    : { outcome: 'finished', agent: by.agent, sessionId: by.sessionId, artifact: run.artifact, sha: run.sha });
  console.log(`notified ${notify.waiters - notify.failures}/${notify.waiters} waiter(s) for step ${name}${waiterRetrySuffix(notify)}`);
}

module.exports = { commands, describeClaim, stepProjectFromCwd, stepUsage, finalizeStep };
