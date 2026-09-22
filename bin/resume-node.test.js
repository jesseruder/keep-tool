'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const sessionNumbers = require('./session-numbers.js');

const CLI = path.join(__dirname, 'keep.js');

function registry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-resume-node-'));
  for (const directory of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' };
  // A spawned CLI must not act as, or quote, the session running the tests.
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  delete env.KEEP_NODE_NAME;
  delete env.KEEP_DAEMON_NODE;
  return { root, env };
}

function writeCard(root, id, session) {
  fs.writeFileSync(path.join(root, 'tasks', `${id}.md`), [
    '---', `title: ${id}`, 'status: active', 'kind: task', 'tags: [personal]',
    'sessions:', `  - id: ${session.id}`, '    agent: codex', '    at: 2026-09-03T09:00',
    ...(session.node ? [`    node: ${session.node}`] : []),
    'created: 2026-09-03', 'updated: 2026-09-03T09:00', '---', '', `## 2026-09-03 09:00 — check-in\n${id} latest.\n`,
  ].join('\n'));
}

function resume(fixture, args = []) {
  const result = spawnSync(process.execPath, [CLI, 'resume', ...args], { cwd: fixture.root, encoding: 'utf8', env: fixture.env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\n').filter((line) => line.includes('keep open') || /resume /.test(line));
}

test('keep resume marks a session on another node after its number, and only there', () => {
  const fixture = registry();
  try {
    writeCard(fixture.root, 'here', { id: 'sess-here' });
    writeCard(fixture.root, 'there', { id: 'sess-there', node: 'aws1' });
    writeCard(fixture.root, 'unnumbered', { id: 'sess-unnumbered', node: 'aws1' });
    writeCard(fixture.root, 'named-daemon', { id: 'sess-daemon', node: 'main' });
    sessionNumbers.assign([{ id: 'sess-here' }, { id: 'sess-there' }, { id: 'sess-daemon' }], { root: fixture.root });
    const lines = resume(fixture);
    const number = (id) => sessionNumbers.label(sessionNumbers.lookup(id, { root: fixture.root }).num);
    assert.ok(lines.includes(`      keep open sess-here  ${number('sess-here')}`), lines.join('\n'));
    assert.ok(lines.includes(`      keep open sess-there  ${number('sess-there')} @aws1`), lines.join('\n'));
    assert.ok(lines.includes('      keep open sess-unnumbered  @aws1'), lines.join('\n'));
    // A card that names the daemon's own node is not a remote session.
    assert.ok(lines.includes(`      keep open sess-daemon  ${number('sess-daemon')}`), lines.join('\n'));
    // --raw prints a bare agent command, where a trailing word would become an argument.
    assert.ok(resume(fixture, ['--raw']).includes('      codex resume sess-there'));
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});
