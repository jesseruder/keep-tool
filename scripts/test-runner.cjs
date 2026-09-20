#!/usr/bin/env node
'use strict';

// Node's test runner defaults to one test process per core minus one, and a Keep
// test file is not one process: it spawns CLIs, daemons and fake hosts of its own.
// On a laptop that is also running the daemon, the host and a few agent sessions,
// the full suite is what pushes the machine into swap — and the failures that come
// back are timeouts, which read like product bugs rather than a busy machine.
//
// So the suite runs at a conservative fraction of the machine by default. This is a
// cap, not a scheduler: it looks at nothing but the core count, and anyone who wants
// the old behaviour says so with KEEP_TEST_CONCURRENCY.
//
//   KEEP_TEST_CONCURRENCY=8     run eight test files at once
//   KEEP_TEST_CONCURRENCY=1     serialize (a flake that only appears under load)
//   KEEP_TEST_CONCURRENCY=auto  leave the choice to Node, as before
//
// An explicit --test-concurrency in the arguments always wins. Everything else about
// the invocation is passed straight through, including the exit code and the signal
// that stopped it.

const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_MAX = 4;
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function resolveConcurrency(options = {}) {
  const env = options.env || process.env;
  const argv = options.argv || [];
  if (argv.some((arg) => arg === '--test-concurrency' || String(arg).startsWith('--test-concurrency='))) {
    return { mode: 'argv' };
  }
  const raw = String(env.KEEP_TEST_CONCURRENCY == null ? '' : env.KEEP_TEST_CONCURRENCY).trim();
  if (raw) {
    if (/^(auto|node|default)$/i.test(raw)) return { mode: 'node', source: 'KEEP_TEST_CONCURRENCY' };
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0) {
      return { mode: 'fixed', concurrency: value, source: 'KEEP_TEST_CONCURRENCY' };
    }
    return { mode: 'invalid', raw };
  }
  const reported = Number(options.parallelism);
  const cpus = Number.isFinite(reported) && reported > 0 ? Math.floor(reported) : 1;
  return { mode: 'fixed', concurrency: Math.max(1, Math.min(DEFAULT_MAX, Math.floor(cpus / 2))), source: 'default cap' };
}

function buildArgs(decision, argv, requirePath) {
  const args = ['--require', requirePath, '--test'];
  if (decision.mode === 'fixed') args.push(`--test-concurrency=${decision.concurrency}`);
  return args.concat(argv);
}

function main(argv = process.argv.slice(2)) {
  let parallelism = 1;
  try { parallelism = os.availableParallelism(); } catch {}
  const decision = resolveConcurrency({ env: process.env, argv, parallelism });
  if (decision.mode === 'invalid') {
    process.stderr.write(`KEEP_TEST_CONCURRENCY must be a positive integer or "auto"; got ${JSON.stringify(decision.raw)}\n`);
    process.exit(1);
    return;
  }
  if (decision.mode === 'fixed') {
    process.stderr.write(`test concurrency ${decision.concurrency} (${decision.source}; override with KEEP_TEST_CONCURRENCY)\n`);
  }
  const args = buildArgs(decision, argv, path.join(__dirname, 'test-env.cjs'));
  const child = spawn(process.execPath, args, { stdio: 'inherit' });
  const handlers = new Map();
  for (const signal of FORWARDED) {
    const handler = () => { try { child.kill(signal); } catch {} };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  child.on('error', (error) => {
    process.stderr.write(`could not start the test runner: ${error && error.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
    // Report the same death the child died: a suite stopped with Ctrl-C must not
    // look like a clean exit, and a wrapper is not allowed to invent a code.
    if (signal) { process.kill(process.pid, signal); return; }
    process.exit(code == null ? 1 : code);
  });
}

module.exports = { resolveConcurrency, buildArgs, DEFAULT_MAX };

if (require.main === module) main();
