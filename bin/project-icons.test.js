'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createProjectIcons, canonicalProject, projectDescription } = require('./project-icons');

async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keep-project-icons-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('discovery shows fallback, deduplicates worktrees, then persists chosen icon', async (t) => {
  const root = await temp(t);
  let result = { text: null }; let done; let launches = 0;
  const summary = (key, input, instruction, callback, options) => {
    assert.equal(options.priority, 3);
    assert.match(input, /Travel planner/);
    if (callback) { launches++; done = callback; }
    return result;
  };
  const service = createProjectIcons({ root, summary, canonicalize: async () => '/repos/travel', describe: async () => 'Travel planner' });
  const first = await service.lookup(['/repos/travel', '/wt/travel/feature']);
  assert.equal(first.projects['/repos/travel'].icon, undefined);
  assert.equal(first.projects['/wt/travel/feature'].path, '/repos/travel');
  result = { text: '{"icon":"plane"}' };
  done();
  // Callback persists asynchronously; lookup also consumes the ready summary.
  const next = await service.lookup(['/repos/travel', '/wt/travel/feature']);
  assert.equal(next.projects['/repos/travel'].icon, 'plane');
  assert.equal(next.projects['/wt/travel/feature'].h, 200);
  const restored = createProjectIcons({ root, canonicalize: async () => '/repos/travel', summary: () => assert.fail('must use saved choice') });
  assert.equal((await restored.lookup(['/repos/travel'])).projects['/repos/travel'].icon, 'plane');
});

test('invalid model markup never becomes an icon or saved choice', async (t) => {
  const root = await temp(t);
  for (const text of ['<svg onload="bad()">', '{"icon":"__proto__"}', '{"icon":"grid"}', '{"icon":"<script>"}']) {
    const service = createProjectIcons({ root, canonicalize: async () => '/repos/test', describe: async () => '', summary: () => ({ text }) });
    assert.deepEqual((await service.lookup(['/repos/test'])).projects['/repos/test'], { path: '/repos/test' });
  }
  await assert.rejects(fs.stat(path.join(root, '.keep/project-icons')));
});

test('known projects skip model selection and nonexistent paths are ignored', async (t) => {
  const root = await temp(t);
  const service = createProjectIcons({ root, canonicalize: async (p) => p === '/missing' ? null : path.join(os.homedir(), 'keep'), summary: () => assert.fail('known project') });
  const result = await service.lookup(['/worktree', '/missing']);
  assert.equal(result.projects['/worktree'].icon, 'castle');
  assert.equal(result.projects['/missing'], undefined);
  await assert.rejects(service.lookup(['bad\0path']));
  await assert.rejects(service.lookup(Array(201).fill('/repo')));
});

test('git worktrees and subdirectories resolve to main repo; README reads are bounded and reject symlinks', async (t) => {
  const root = await temp(t);
  const repo = path.join(root, 'repo'); const wt = path.join(root, 'feature');
  await fs.mkdir(repo);
  const git = (args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git(['init']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial']);
  git(['worktree', 'add', '--detach', wt]);
  await fs.mkdir(path.join(wt, 'src'));
  assert.equal(await canonicalProject(path.join(wt, 'src')), await fs.realpath(repo));
  await fs.writeFile(path.join(repo, 'README.md'), 'x'.repeat(9000));
  assert.equal((await projectDescription(repo)).length, 6000);
  await fs.unlink(path.join(repo, 'README.md'));
  const outside = path.join(root, 'secret'); await fs.writeFile(outside, 'do not read');
  await fs.symlink(outside, path.join(repo, 'README.md'));
  assert.equal(await projectDescription(repo), '');
});

test('invalid successful model output backs off then uses a fresh cache key', async (t) => {
  const root = await temp(t);
  let now = 1000; const keys = [];
  const service = createProjectIcons({ root, now: () => now, canonicalize: async () => '/repos/retry', describe: async () => '',
    summary: (key) => { keys.push(key); return { text: !key.includes('-retry-') ? '{"icon":"made-up"}' : '{"icon":"code"}' }; } });
  assert.equal((await service.lookup(['/repos/retry'])).projects['/repos/retry'].icon, undefined);
  await service.lookup(['/repos/retry']);
  assert.equal(keys.length, 1, 'bad cached output is not retried every poll');
  now += 5 * 60e3;
  assert.equal((await service.lookup(['/repos/retry'])).projects['/repos/retry'].icon, 'code');
  assert.notEqual(keys[0], keys[1]);
});


test('accepts a fenced choice with commentary but never arbitrary SVG', async (t) => {
  const root = await temp(t);
  const service = createProjectIcons({ root, canonicalize: async () => '/repos/fenced', describe: async () => '',
    summary: () => ({ text: '```json\n{"icon":"plane"}\n```\nA travel project.' }) });
  assert.equal((await service.lookup(['/repos/fenced'])).projects['/repos/fenced'].icon, 'plane');
});
