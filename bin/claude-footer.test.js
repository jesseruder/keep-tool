const test = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('./claude-footer');

const rule = '─'.repeat(80);
const box = [rule, '❯ ', rule, '  keep-tool  (master)  ctx:18%  5h:29%  7d:27%  Opus 5.5 (1M context)  effort:medium'];

test('an idle pane with nothing in the background reads as not running', () => {
  const r = read(['● Done. Landed as abc123.', '', '✻ Crunched for 9s · done 8:50 PM', '', ...box,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents']);
  assert.deepEqual(r, { recognized: true, shells: 0, agents: 0, turnRunning: false, running: false });
});

test('running shells are read from the done line and from the mode line', () => {
  assert.equal(read(['✻ Cooked for 2m 25s · done 9:50 AM · 1 shell still running', ...box]).shells, 1);
  assert.equal(read(['✻ Worked for 5m · done 1:02 PM · 2 shells still running', ...box]).shells, 2);
  const mode = read(['✻ Baked for 3s · done 9:31 AM', ...box, '  ⏵⏵ bypass permissions on · 1 shell · ← for agents']);
  assert.equal(mode.shells, 1);
  assert.equal(mode.running, true);
});

test('background agents are read from the waiting line and the agent rows', () => {
  const r = read(['✻ Waiting for 1 background agent to finish', ...box,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents', '  ● main', '  ◯ general-purpose  Verifying clamp tests']);
  assert.equal(r.agents, 1);
  assert.equal(r.running, true);
  // Rows alone count too, one per running agent.
  assert.equal(read(['✻ Brewed for 1m · done 7:41 PM', ...box, '  ● main', '  ◯ general-purpose  a', '  ◯ Explore  b']).agents, 2);
});

test('a spinner row means the turn is still running', () => {
  assert.equal(read(['✶ Enchanting… (4m 50s · ↓ 4.5k tokens)', ...box]).turnRunning, true);
  assert.equal(read(['✻ Cooked for 4m 50s · done 9:50 AM', ...box]).turnRunning, false);
});

test('no input box (a dialog, another program, a changed format) is not recognized', () => {
  assert.deepEqual(read(['Do you want to proceed?', '❯ 1. Yes', '  2. No']), { recognized: false, shells: null, agents: null, running: null });
  assert.equal(read([]).recognized, false);
  assert.equal(read(['$ ls', 'README.md']).recognized, false);
});

test('text elsewhere on screen that mentions shells above the box still counts only as footer shapes', () => {
  // A message line that happens to say "shell" without the footer's shape is ignored.
  assert.equal(read(['● I killed the shell that was running the build.', '✻ Baked for 3s · done 9:31 AM', ...box]).shells, 0);
});

test('a todo list spinner and a wrapped mode line still read', () => {
  assert.equal(read(['✶ Running the test suite… (2m 8s · ↓ 8.1k tokens)', '  ⎿  ☐ Fix the clamp', ...box]).turnRunning, true);
  assert.equal(read(['✻ Baked for 3s · done 9:31 AM', ...box, '  ⏵⏵ bypass permissions on · 1', '  shell · ← for agents']).shells, 1);
});
