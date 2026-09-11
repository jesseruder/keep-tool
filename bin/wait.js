'use strict';

class WaitError extends Error {}

function parseDuration(value) {
  const match = String(value || '').trim().match(/^\+?(\d+(?:\.\d+)?)([smhdw])$/i);
  if (!match) throw new WaitError('--for must be a duration such as +15m or 2h');
  const units = { s: 1000, m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 };
  const milliseconds = Number(match[1]) * units[match[2].toLowerCase()];
  if (!Number.isFinite(milliseconds)) throw new WaitError('--for duration is too large');
  return milliseconds;
}

function parseWaitArgs(argv) {
  const conditions = [];
  let forMs = parseDuration('9m');
  let intervalMs = 10e3;
  const take = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new WaitError(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-hold') {
      const project = take(i, arg);
      conditions.push({ type: 'no-hold', project, summary: `--no-hold ${project}` });
      i += 1;
    } else if (arg === '--scope') {
      const condition = conditions[conditions.length - 1];
      if (!condition || condition.type !== 'no-hold') throw new WaitError('--scope must follow its --no-hold condition');
      const value = take(i, arg);
      condition.scopes = require('./hold-scopes').parse([...(condition.scopes || []), value]);
      condition.summary = `--no-hold ${condition.project} --scope ${condition.scopes.join(',')}`;
      i += 1;
    } else if (arg === '--card') {
      const value = take(i, arg);
      const match = value.match(/^([a-z0-9][a-z0-9-]*)(?:#([1-9]\d*))?$/);
      if (!match) throw new WaitError(`invalid card condition "${value}"; use <id> or <id>#<step>`);
      conditions.push({
        type: 'card', id: match[1], step: match[2] ? Number(match[2]) : null,
        summary: `--card ${value}`,
      });
      i += 1;
    } else if (arg === '--lane') {
      const project = take(i, arg);
      const step = take(i + 1, arg);
      conditions.push({ type: 'lane', project, step, summary: `--lane ${project} ${step}` });
      i += 2;
    } else if (arg === '--check-due') {
      const id = take(i, arg);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new WaitError(`invalid card id "${id}"`);
      conditions.push({ type: 'check-due', id, summary: `--check-due ${id}` });
      i += 1;
    } else if (arg === '--for') {
      forMs = parseDuration(take(i, arg));
      i += 1;
    } else if (arg === '--interval') {
      const seconds = Number(take(i, arg));
      if (!Number.isFinite(seconds) || seconds <= 0) throw new WaitError('--interval must be a positive number of seconds');
      intervalMs = Math.max(1000, seconds * 1000); // never spin on the registry files
      i += 1;
    } else {
      throw new WaitError(`unknown condition or flag "${arg}"`);
    }
  }
  if (!conditions.length) {
    throw new WaitError('usage: keep wait [--no-hold <project>] [--card <id>[#<n>]] [--lane <project> <step>] [--check-due <id>] [--for <duration>] [--interval <seconds>]');
  }
  return { conditions, forMs, intervalMs };
}

function evaluate(conditions, deps) {
  const now = deps.now();
  const results = conditions.map((condition) => {
    if (condition.type === 'no-hold') {
      const project = deps.resolveProject(condition.project);
      // Another project's device hold blocks only a wait that names that device, so an
      // unscoped project wait never stalls on a phone someone else is driving.
      const scoped = Boolean(condition.scopes && condition.scopes.length);
      const holds = deps.activeHolds(project, now, { prune: false, scopes: condition.scopes, devices: scoped });
      return {
        ...condition,
        satisfied: holds.length === 0,
        detail: holds.length ? `${condition.summary} (${holds.length} active hold${holds.length === 1 ? '' : 's'}: ${holds.map((hold) => require('./hold-scopes').label(hold)).join('; ')})` : condition.summary,
      };
    }
    if (condition.type === 'card') {
      const task = deps.loadTaskAnywhere(condition.id);
      const satisfied = deps.dependencyResolved(task, condition.step);
      return { ...condition, satisfied, detail: condition.summary };
    }
    if (condition.type === 'lane') {
      const project = deps.resolveProject(condition.project);
      const registry = deps.loadSteps(project);
      if (!registry) throw new WaitError(`unknown step project "${condition.project}"`);
      if (!registry.steps || !registry.steps[condition.step]) {
        throw new WaitError(`unknown step "${condition.step}" for ${condition.project}`);
      }
      const ledger = deps.loadLedger(registry.project, condition.step);
      const running = (ledger.runs || []).some((run) => run && run.status === 'running');
      const claimed = deps.activeHolds(registry.project, now, { step: condition.step, prune: false }).length > 0;
      const open = [claimed ? 'claimed' : '', running ? 'running' : ''].filter(Boolean).join(', ');
      return {
        ...condition,
        satisfied: !claimed && !running,
        detail: open ? `${condition.summary} (${open})` : condition.summary,
      };
    }
    if (condition.type === 'check-due') {
      const task = deps.loadTaskAnywhere(condition.id);
      if (task.fm && task.fm.status === 'done') {
        // keep done clears check_after; the check will never come due.
        throw new WaitError(`${condition.id} is done; its check will not come due`);
      }
      const due = Date.parse(task.fm && task.fm.check_after || '');
      const satisfied = Number.isFinite(due) && due <= now;
      const detail = satisfied || !task.fm || !task.fm.check_after
        ? condition.summary
        : `${condition.summary} (due ${task.fm.check_after})`;
      return { ...condition, satisfied, detail };
    }
    throw new WaitError(`unknown condition type "${condition.type}"`);
  });
  return {
    satisfied: results.every((result) => result.satisfied),
    summary: results.map((result) => result.summary).join(', '),
    open: results.filter((result) => !result.satisfied).map((result) => result.detail),
  };
}

function localStamp(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function run(argv, deps) {
  const output = deps.stdout || ((line) => process.stdout.write(`${line}\n`));
  const errorOutput = deps.stderr || ((line) => process.stderr.write(`keep wait: ${line}\n`));
  let parsed;
  try {
    parsed = parseWaitArgs(argv);
  } catch (error) {
    errorOutput(error.message);
    return 2;
  }

  const now = deps.now || Date.now;
  const sleep = deps.sleep;
  const stamp = deps.stamp || localStamp;
  const deadline = now() + parsed.forMs;
  let interrupted = false;
  let interrupt;
  let wakeSleep = null;
  const interruptedPromise = new Promise((resolve) => { interrupt = resolve; });
  const onSignal = () => {
    interrupted = true;
    interrupt(true);
    if (wakeSleep) wakeSleep();
  };
  if (deps.signals !== false) {
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
  }

  let transientFailures = 0;
  try {
    for (;;) {
      let state;
      try {
        state = evaluate(parsed.conditions, { ...deps, now });
        transientFailures = 0;
      } catch (error) {
        // A card being rewritten or archived mid-read can look missing for one
        // poll; only a persistent failure ends the wait.
        const transient = !(error instanceof WaitError) && transientFailures < 3;
        if (transient) {
          transientFailures += 1;
        } else {
          errorOutput(error.message);
          return 2;
        }
        state = { satisfied: false, open: [`${error.message} (retrying)`] };
      }
      if (state.satisfied) {
        output(`satisfied: ${state.summary} at ${stamp(now())}`);
        return 0;
      }
      const current = now();
      if (current >= deadline) {
        output(`still waiting: ${state.open.join(', ')}`);
        return 124;
      }
      const waitMs = Math.min(parsed.intervalMs, deadline - current);
      const signaled = sleep
        ? await Promise.race([Promise.resolve(sleep(waitMs)).then(() => false), interruptedPromise])
        : await new Promise((resolve) => {
          const timer = setTimeout(() => { wakeSleep = null; resolve(false); }, waitMs);
          wakeSleep = () => { clearTimeout(timer); wakeSleep = null; resolve(true); };
          if (interrupted) wakeSleep();
        });
      if (signaled || interrupted) return 130;
    }
  } finally {
    if (deps.signals !== false) {
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
    }
  }
}

module.exports = { WaitError, parseDuration, parseWaitArgs, evaluate, run };

if (require.main === module) {
  const keep = require('./keep.js');
  const steps = require('./steps.js');
  run(process.argv.slice(2), {
    now: Date.now,
    resolveProject: keep.resolveProjectArg,
    activeHolds: keep.activeHolds,
    loadTaskAnywhere: keep.loadTaskAnywhere,
    dependencyResolved: keep.dependencyResolved,
    loadSteps: steps.loadSteps,
    loadLedger: steps.loadLedger,
    stamp: (ms) => keep.stampOf(new Date(ms)),
  }).then((code) => { process.exitCode = code; });
}
