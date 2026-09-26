'use strict';

// A node's own Codex companion jobs and Pi jobs, for the host's `companion-jobs` verb.
//
// The daemon discovers these for its own machine (the `companion-jobs` maintenance
// mutation). A session on another node starts its jobs in that node's companion state,
// under that node's broker, where nothing on the daemon's machine can see them; this
// is the same discovery, run on the node for the node.
//
// It runs in a child process. Both lists read their state files synchronously, and a
// host's event loop carries every keystroke typed into its panes, so the read happens
// off that loop. The child leads its own process group, and the whole group is killed
// once it has answered or run out of time, so nothing it started (the companion's own
// `status` fallback) outlives the ask. The answer lists jobs and never cancels,
// signals or repairs one. (A Pi job whose runner is gone is recorded as failed by the
// read itself, exactly as every other Pi job read on that node does.)

const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

// Answered within the daemon's request window (bin/serve.js asks with ten seconds).
const DEFAULT_TIMEOUT_MS = 6000;

function unknownPart(reason) {
  return { known: false, complete: false, discovery: 'unknown', jobs: [], reason };
}

function unknownAnswer(reason) {
  return { codexJobs: unknownPart(reason), piJobs: unknownPart(reason) };
}

// Each half on its own clock: a Codex read that hangs does not cost the Pi answer, and
// one that throws does not cost the other half either.
function bounded(read, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(unknownPart('timeout')), ms);
    Promise.resolve()
      .then(read)
      .then((value) => (value && typeof value === 'object' ? value : unknownPart('unreadable')), () => unknownPart('failed'))
      .then((value) => { clearTimeout(timer); resolve(value); });
  });
}

// Runs in the child. `seam` is a test seam only (fixture state roots, a missing
// companion script, a hanging half); a real host passes nothing and the node's own
// defaults apply. `timeoutMs` is the child's whole budget.
async function collect(seam = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const processTable = require('./process-table.js');
  const { execFile } = require('node:child_process');
  // Each half gets most of the budget, and the companion's `status` fallback less
  // than its half, so its own timer ends it before the half gives up on it.
  const halfMs = Math.max(50, timeoutMs - 1000);
  const fallbackMs = Math.max(25, halfMs - 1000);
  const stdout = await new Promise((resolve, reject) => {
    execFile('ps', processTable.PS_ROWS_ARGS, {
      encoding: 'utf8', timeout: Math.min(5000, halfMs), maxBuffer: 32e6, env: { ...process.env, LC_ALL: 'C' },
    }, (error, out) => (error ? reject(error) : resolve(out)));
  });
  const rows = processTable.parseProcessTable(String(stdout || ''));
  const { hang, hold, ...listSeam } = seam;
  // Test seam: a process this read started and left running, which the host must
  // take down with the child's group.
  if (typeof hold === 'string' && hold) {
    const sleeper = require('node:child_process').spawn('sleep', ['60'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(hold, String(sleeper.pid));
  }
  const root = listSeam.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
  const options = {
    // Nothing survives the child, so the fallback's in-memory cache would never hit.
    fallbackCacheMs: 0,
    fallbackTimeoutMs: fallbackMs,
    ...listSeam,
    root,
    processRows: rows,
    psKnown: true,
    psOutput: rows.map((row) => `${row.pid} ${row.elapsed || '00:00'} ${row.args || ''}`).join('\n'),
  };
  const never = () => new Promise(() => {});
  const [codexJobs, piJobs] = await Promise.all([
    bounded(hang === 'codex' ? never : () => require('./codexjobs.js').list(options), halfMs),
    bounded(hang === 'pi' ? never : () => require('./pi-jobs.js').list(options), halfMs),
  ]);
  return { codexJobs, piJobs };
}

function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}

// Runs in the host. Never rejects: a child that fails, times out or prints something
// unreadable is an answer of `unknown`, which the daemon reads as "not known here".
function read(options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const seam = options.seam && typeof options.seam === 'object' ? options.seam : {};
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [__filename, JSON.stringify(seam), String(timeoutMs)], {
        detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: options.env || process.env,
      });
    } catch {
      resolve(unknownAnswer('failed'));
      return;
    }
    let out = '';
    let done = false;
    let timedOut = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Whatever the child started goes with it, answered or not.
      killGroup(child);
      resolve(answer);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
      finish(unknownAnswer('timeout'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.length > 16e6) finish(unknownAnswer('unreadable'));
    });
    child.on('error', () => finish(unknownAnswer('failed')));
    child.on('close', (code) => {
      if (timedOut) return;
      if (code !== 0) { finish(unknownAnswer('failed')); return; }
      try {
        const answer = JSON.parse(out);
        if (!answer || typeof answer !== 'object') throw new Error('no answer');
        finish({
          codexJobs: answer.codexJobs && typeof answer.codexJobs === 'object' ? answer.codexJobs : unknownPart('unreadable'),
          piJobs: answer.piJobs && typeof answer.piJobs === 'object' ? answer.piJobs : unknownPart('unreadable'),
        });
      } catch {
        finish(unknownAnswer('unreadable'));
      }
    });
  });
}

if (require.main === module) {
  let seam = {};
  try { seam = JSON.parse(process.argv[2] || '{}') || {}; } catch {}
  const timeoutMs = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : DEFAULT_TIMEOUT_MS;
  collect(seam, timeoutMs).then((answer) => {
    // Exit once written: a half that gave up may have left a timer or a read behind.
    process.stdout.write(JSON.stringify(answer), () => process.exit(0));
  }, (error) => {
    process.stderr.write(`${error && error.message || error}\n`);
    process.exit(1);
  });
}

module.exports = { read, collect, unknownAnswer, DEFAULT_TIMEOUT_MS };
