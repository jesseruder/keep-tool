'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childTranscripts = require('./child-transcripts');

const SID = 'session-123';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-child-transcripts-'));
  const configDir = path.join(base, '.claude');
  fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
  const project = (name) => path.join(configDir, 'projects', name);
  const tree = (name, sessionDir) => {
    const dir = path.join(project(name), sessionDir);
    fs.mkdirSync(path.join(dir, 'subagents'), { recursive: true });
    return dir;
  };
  const parent = (name) => {
    fs.mkdirSync(project(name), { recursive: true });
    const file = path.join(project(name), `${SID}.jsonl`);
    fs.writeFileSync(file, '{}\n');
    return file;
  };
  const child = (dir, id) => {
    const file = path.join(dir, 'subagents', `agent-${id}.jsonl`);
    fs.writeFileSync(file, `{"agent":"${id}"}\n`);
    return file;
  };
  return { base, configDir, project, tree, parent, child };
}

function run(body) {
  const f = fixture();
  try { body(f); } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
}

test('a child beside its parent transcript is the first answer', () => run((f) => {
  const parentFile = f.parent('-repo');
  const expected = f.child(f.tree('-repo', SID), 'alpha');
  f.child(f.tree('-worktree', SID), 'alpha');
  const located = childTranscripts.locateClaudeChild('alpha', parentFile, { configDir: f.configDir });
  assert.equal(located.file, expected);
  assert.equal(located.tree, path.join(f.project('-repo'), SID));
  assert.equal(located.foreign, false);
  assert.equal(childTranscripts.resolveClaudeChild('alpha', parentFile, { configDir: f.configDir }), expected);
}));

test('a child written under another project directory is found by session id', () => run((f) => {
  const parentFile = f.parent('-repo');
  f.tree('-repo', SID);
  const expected = f.child(f.tree('-wt-repo-slug', SID), 'beta');
  const located = childTranscripts.locateClaudeChild('beta', parentFile, { configDir: f.configDir });
  assert.equal(located.file, expected);
  assert.equal(located.foreign, false);
  assert.deepEqual(childTranscripts.listClaudeSessionTrees(SID, f.configDir).map((entry) => entry.projectName),
    ['-repo', '-wt-repo-slug']);
}));

test('a superseded session tree is searched too', () => run((f) => {
  const parentFile = f.parent('-repo');
  const superseded = f.tree('-repo', `${SID}.superseded-1758000000000`);
  const expected = f.child(superseded, 'gamma');
  const located = childTranscripts.locateClaudeChild('gamma', parentFile, { configDir: f.configDir });
  assert.equal(located.file, expected);
  assert.equal(located.tree, superseded);
  assert.equal(located.foreign, false);
  assert.deepEqual(childTranscripts.listClaudeSessionTrees(SID, f.configDir).map((entry) => path.basename(entry.dir)),
    [`${SID}.superseded-1758000000000`]);
}));

test('two session trees holding different transcripts for one agent are ambiguous', () => run((f) => {
  const parentFile = f.parent('-repo');
  f.tree('-repo', SID);
  const worktree = f.child(f.tree('-wt-repo-slug', SID), 'theta');
  fs.writeFileSync(path.join(f.project('-repo'), SID, 'subagents', 'agent-theta.jsonl'), '{"agent":"theta","copy":2}\n');
  // Beside the parent wins outright, so take the parent out of that project first.
  const elsewhere = f.parent('-elsewhere');
  assert.equal(childTranscripts.resolveClaudeChild('theta', elsewhere, { configDir: f.configDir }), null);

  // One file under two names, on the other hand, is one transcript: the first tree
  // answers for it.
  fs.rmSync(worktree);
  fs.linkSync(path.join(f.project('-repo'), SID, 'subagents', 'agent-theta.jsonl'), worktree);
  assert.equal(childTranscripts.resolveClaudeChild('theta', elsewhere, { configDir: f.configDir }),
    path.join(f.project('-repo'), SID, 'subagents', 'agent-theta.jsonl'));
  assert.equal(childTranscripts.resolveClaudeChild('theta', parentFile, { configDir: f.configDir }),
    path.join(f.project('-repo'), SID, 'subagents', 'agent-theta.jsonl'));
}));

test('a symlinked path component inside the profile is refused even where it lands', () => run((f) => {
  const parentFile = f.parent('-repo');
  const shared = path.join(f.project('-repo'), 'shared');
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, 'agent-iota.jsonl'), '{"agent":"iota"}\n');
  const dir = path.join(f.project('-repo'), SID);
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(shared, path.join(dir, 'subagents'));
  assert.equal(childTranscripts.resolveClaudeChild('iota', parentFile, { configDir: f.configDir }), null);
}));

test('a lone child under some other session is accepted as foreign', () => run((f) => {
  const parentFile = f.parent('-repo');
  f.tree('-repo', SID);
  const expected = f.child(f.tree('-other', 'session-999'), 'delta');
  const located = childTranscripts.locateClaudeChild('delta', parentFile, { configDir: f.configDir });
  assert.equal(located.file, expected);
  assert.equal(located.tree, path.join(f.project('-other'), 'session-999'));
  assert.equal(located.foreign, true);
}));

test('two foreign candidates are ambiguous, which is no answer at all', () => run((f) => {
  const parentFile = f.parent('-repo');
  f.child(f.tree('-other', 'session-999'), 'epsilon');
  f.child(f.tree('-third', 'session-888'), 'epsilon');
  assert.equal(childTranscripts.locateClaudeChild('epsilon', parentFile, { configDir: f.configDir }), null);
  assert.equal(childTranscripts.resolveClaudeChild('epsilon', parentFile, { configDir: f.configDir }), null);
}));

test('nothing anywhere, an unusable id and an unusable profile all resolve to null', () => run((f) => {
  const parentFile = f.parent('-repo');
  f.tree('-repo', SID);
  assert.equal(childTranscripts.resolveClaudeChild('zeta', parentFile, { configDir: f.configDir }), null);
  assert.equal(childTranscripts.resolveClaudeChild('../escape', parentFile, { configDir: f.configDir }), null);
  assert.equal(childTranscripts.resolveClaudeChild('zeta', parentFile, { configDir: path.join(f.base, 'absent') }), null);
  assert.deepEqual(childTranscripts.listClaudeSessionTrees('../escape', f.configDir), []);
}));

test('a subagents directory symlinked out of the profile is refused', () => run((f) => {
  const parentFile = f.parent('-repo');
  const outside = path.join(f.base, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'agent-eta.jsonl'), '{"agent":"eta"}\n');
  const dir = path.join(f.project('-repo'), SID);
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'subagents'));
  assert.equal(childTranscripts.resolveClaudeChild('eta', parentFile, { configDir: f.configDir }), null);

  // A symlinked file inside the tree is refused for the same reason.
  const other = f.tree('-other', 'session-999');
  fs.symlinkSync(path.join(outside, 'agent-eta.jsonl'), path.join(other, 'subagents', 'agent-eta.jsonl'));
  assert.equal(childTranscripts.resolveClaudeChild('eta', parentFile, { configDir: f.configDir }), null);
}));
