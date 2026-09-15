'use strict';
// The launcher marker: how Keep's own resume is told apart from a hand-typed one
// without handing every hosted agent a bypass.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const launcher = require('./agent-launcher.js');

test('launcherEnv marks the pane shell and profileEnvironment strips it again', () => {
  assert.equal(launcher.LAUNCHER_MARKER, 'KEEP_LAUNCHER');
  assert.deepEqual(launcher.launcherEnv(), { KEEP_LAUNCHER: '1' });
  // The reviewer's own pane env still rides along.
  assert.deepEqual(launcher.launcherEnv({ KEEP_REVIEWER: '1' }), { KEEP_REVIEWER: '1', KEEP_LAUNCHER: '1' });
  assert.deepEqual(launcher.launcherEnv(null), { KEEP_LAUNCHER: '1' });

  // The zsh function unsets the marker before exec, but only when the exec'd word is
  // literally `claude` — and it never is, because the launcher execs node. Stripping
  // it here is what actually guarantees the agent (and every Bash call it makes)
  // never inherits a bypass. That inheritance is exactly how exempting KEEP_PANE
  // turned the resume guard into a no-op.
  const source = { KEEP_LAUNCHER: '1', KEEP_PANE: 'pane-7', PATH: '/usr/bin' };
  assert.equal(launcher.profileEnvironment('claude', null, source).KEEP_LAUNCHER, undefined);
  assert.equal(launcher.profileEnvironment('claude', null, source).KEEP_PANE, 'pane-7', 'only the marker is removed');
  const profile = { id: 'secondary', agent: 'claude', configDir: '/tmp/keep-launcher-test', builtIn: false, managed: true };
  const profiled = launcher.profileEnvironment('claude', profile, source);
  assert.equal(profiled.KEEP_LAUNCHER, undefined);
  assert.equal(profiled.KEEP_AGENT_ACCOUNT_ID, 'secondary');
  assert.equal(source.KEEP_LAUNCHER, '1', 'the caller\'s own env object is untouched');
});

test('every host pane the daemon launches an agent into carries the marker', () => {
  // A structural check on purpose: the failure this guards against is a fifth spawn
  // site added later without the env, which no unit test of the existing four sees.
  const source = fs.readFileSync(path.join(__dirname, 'serve.js'), 'utf8');
  const lines = source.split('\n');
  const sites = [];
  lines.forEach((line, index) => {
    if (line.includes("'-lic'") && line.includes('profileCommand(')) sites.push(index);
  });
  assert.equal(sites.length >= 4, true, `expected the known launcher spawn sites, found ${sites.length}`);
  for (const index of sites) {
    const window = lines.slice(Math.max(0, index - 4), index + 5).join('\n');
    assert.match(window, /env: require\('\.\/agent-launcher'\)\.launcherEnv\(/,
      `the launcher spawn at serve.js:${index + 1} must set KEEP_LAUNCHER on the pane env`);
  }
});
