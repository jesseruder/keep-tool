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
// off that loop and is bounded by killing the child. The answer lists jobs and never
// cancels, signals or repairs one. (A Pi job whose runner is gone is recorded as
// failed by the read itself, exactly as every other Pi job read on that node does.)

const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

// Answered within the daemon's request window (bin/serve.js asks with ten seconds).
const DEFAULT_TIMEOUT_MS = 6000;
// The daemon asks at most every few seconds; the companion's own `status` fallback
// need not run on every ask.
const FALLBACK_CACHE_MS = 5000;

function unknownPart(reason) {
  return { known: false, complete: false, discovery: 'unknown', jobs: [], reason };
}

function unknownAnswer(reason) {
  return { codexJobs: unknownPart(reason), piJobs: unknownPart(reason) };
}

// Runs in the child. `seam` is a test seam only (fixture state roots, a missing
// companion script); a real host passes nothing and the node's own defaults apply.
async function collect(seam = {}) {
  const processTable = require('./process-table.js');
  const stdout = await new Promise((resolve, reject) => {
    execFile('ps', processTable.PS_ROWS_ARGS, {
      encoding: 'utf8', timeout: 5000, maxBuffer: 32e6, env: { ...process.env, LC_ALL: 'C' },
    }, (error, out) => (error ? reject(error) : resolve(out)));
  });
  const rows = processTable.parseProcessTable(String(stdout || ''));
  const root = seam.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
  const options = {
    fallbackCacheMs: FALLBACK_CACHE_MS,
    ...seam,
    root,
    processRows: rows,
    psKnown: true,
    psOutput: rows.map((row) => `${row.pid} ${row.elapsed || '00:00'} ${row.args || ''}`).join('\n'),
  };
  const [codexJobs, piJobs] = await Promise.all([
    require('./codexjobs.js').list(options),
    require('./pi-jobs.js').list(options),
  ]);
  return { codexJobs, piJobs };
}

// Runs in the host. Never rejects: a child that fails, times out or prints something
// unreadable is an answer of `unknown`, which the daemon reads as "not known here".
function read(options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const seam = options.seam && typeof options.seam === 'object' ? options.seam : {};
  return new Promise((resolve) => {
    execFile(process.execPath, [__filename, JSON.stringify(seam)], {
      encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16e6,
      env: options.env || process.env,
    }, (error, stdout) => {
      if (error) {
        resolve(unknownAnswer(error.killed ? 'timeout' : 'failed'));
        return;
      }
      try {
        const answer = JSON.parse(String(stdout || ''));
        if (!answer || typeof answer !== 'object') throw new Error('no answer');
        resolve({
          codexJobs: answer.codexJobs && typeof answer.codexJobs === 'object' ? answer.codexJobs : unknownPart('unreadable'),
          piJobs: answer.piJobs && typeof answer.piJobs === 'object' ? answer.piJobs : unknownPart('unreadable'),
        });
      } catch {
        resolve(unknownAnswer('unreadable'));
      }
    });
  });
}

if (require.main === module) {
  let seam = {};
  try { seam = JSON.parse(process.argv[2] || '{}') || {}; } catch {}
  collect(seam).then((answer) => {
    process.stdout.write(JSON.stringify(answer));
  }, (error) => {
    process.stderr.write(`${error && error.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { read, collect, unknownAnswer, DEFAULT_TIMEOUT_MS };
