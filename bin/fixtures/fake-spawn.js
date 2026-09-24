'use strict';

// A stand-in for child_process.spawn in tests of bin/node-inventory.js: no process
// is started. `answer(file, args)` returns what the "process" does: a string (its
// stdout, exit 0), { stdout, stderr, code }, or 'hang' (it runs until it is killed
// or released). Every call is recorded in `calls`; `kills` counts kills asked for.
// With `{ holdKills: true }` a kill does not land until `landKills()`, so a test can
// see a process outlive the answer; `release()` lets every hung process exit 0.
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function fakeSpawn(answer = () => '', options = {}) {
  const hung = new Set();
  const heldKills = [];
  const state = {
    calls: [],
    kills: 0,
    release() { for (const end of [...hung]) end(0, null); },
    landKills() { for (const land of heldKills.splice(0)) land(); },
  };
  state.spawn = (file, args) => {
    state.calls.push({ file, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    child.exitCode = null;
    child.signalCode = null;
    const end = (code, signal) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      hung.delete(end);
      child.exitCode = signal ? null : code;
      child.signalCode = signal || null;
      child.emit('exit', child.exitCode, child.signalCode);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', child.exitCode, child.signalCode));
    };
    child.kill = (signal) => {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      state.kills += 1;
      const land = () => setImmediate(() => end(null, signal || 'SIGTERM'));
      if (options.holdKills) heldKills.push(land);
      else land();
      return true;
    };
    const result = answer(file, args);
    if (result === 'hang') hung.add(end);
    else {
      const reply = typeof result === 'string' ? { stdout: result } : (result || {});
      setImmediate(() => {
        if (reply.stdout) child.stdout.write(reply.stdout);
        if (reply.stderr) child.stderr.write(reply.stderr);
        end(reply.code == null ? 0 : reply.code, null);
      });
    }
    return child;
  };
  return state;
}

module.exports = { fakeSpawn };
