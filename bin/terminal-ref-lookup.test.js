'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCommitLookup, cardMentions, readHolds, sessionMention } = require('./terminal-ref-lookup.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ref-lookup-'));

const tasks = [
  { id: 'old-card', fm: { title: 'Old', status: 'done', project: '/repo/b', updated: '2026-09-01' }, body: '## 2026-09-01 10:00 — check-in\nWaiting on #453.\ncommits: 3229e2e' },
  { id: 'new-card', fm: { title: 'New', status: 'active', project: '/repo/a', updated: '2026-09-20' }, body: '## x\nasked #453 and #4530\nlanded 3229e2eb8401 today' },
  { id: 'none', fm: { title: 'None' }, body: 'nothing here, castle#453, #4530' },
];

test('card mentions match the literal, newest first, with the line that names it', () => {
  const found = cardMentions(tasks, sessionMention(453));
  assert.deepEqual(found.map((card) => [card.id, card.line]), [['new-card', 'asked #453 and #4530'], ['old-card', 'Waiting on #453.']]);
  assert.deepEqual(cardMentions(tasks, sessionMention(453), { exclude: (task) => task.id === 'new-card' }).map((card) => card.id), ['old-card']);
  assert.deepEqual(cardMentions(tasks, sessionMention(45)), []);
  assert.deepEqual(cardMentions([{ id: 'pr', fm: {}, body: 'see PR #453 and color: #453' }], sessionMention(453)), [], 'what the terminal would not link is not a mention');
});

test('holds: live ones only, with an absolute expiry and the holder number, nothing deleted', async () => {
  const root = tmp();
  const dir = path.join(root, '.keep', 'holds');
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  const now = Date.parse('2026-09-25T15:00');
  write('hold-a.json', { id: 'hold-a', project: '~/keep-tool', scopes: ['device:android-box'], until: '2026-09-25T15:23', reason: 'grow', by: { sessionId: 's1', agent: 'claude' } });
  write('hold-b.json', { id: 'hold-b', project: '~/x', scopes: [], until: '2026-09-25T14:00', by: {} });
  write('hold-c.json', { id: 'hold-c', project: '~/x', scopes: [], until: '2026-09-25T16:00', released: '2026-09-25 14:50', by: {} });
  write('notes.json', { id: 'nope' });
  fs.writeFileSync(path.join(dir, 'hold-d.json'), '{broken');
  const holds = await readHolds(root, { now, numberOf: (id) => (id === 's1' ? 429 : null) });
  assert.deepEqual(holds.map((hold) => [hold.id, hold.num, hold.untilMs - now]), [['hold-a', 429, 23 * 60e3]]);
  assert.equal(fs.readdirSync(dir).length, 5, 'expired and released holds are left for the CLI to prune');
  assert.deepEqual(await readHolds(path.join(root, 'missing')), []);
});

test('a commit resolves in the terminal project first, then citing cards, with landing and review', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.keep', 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(root, '.keep', 'reviews', 'new-card.json'), JSON.stringify([
    { id: 'rev-1', at: '2026-09-20T10:00', verdict: 'findings', by: 'codex sol', commits: [{ sha: '3229e2eb8401', subject: 's' }] },
    { id: 'rev-2', at: '2026-09-21T10:00', verdict: 'clean', by: 'codex sol', commits: [{ sha: '3229e2eb8401', subject: 's' }] },
  ]));
  const calls = [];
  const runGit = async (repo, args) => {
    calls.push([repo, args[0]]);
    if (repo !== '/repo/a') return null;
    if (args[0] === 'log') return ['3229e2eb8401aaaa', 'console: hover', 'Jesse', '1700000000'].join('\u0000') + '\n';
    if (args[0] === 'symbolic-ref') return 'origin/master\n';
    if (args[0] === 'merge-base') return '';
    return null;
  };
  const lookup = createCommitLookup({ root, runGit });
  const info = await lookup('3229e2e', { project: '/repo/elsewhere', tasks });
  assert.deepEqual(info.commit, { sha: '3229e2eb8401aaaa', subject: 'console: hover', author: 'Jesse', at: 1700000000000,
    repo: '/repo/a', branch: 'origin/master', landed: true });
  assert.deepEqual(info.cards.map((card) => card.id), ['new-card', 'old-card']);
  assert.deepEqual(info.review, { card: 'new-card', verdict: 'clean', by: 'codex sol', at: '2026-09-21T10:00' });
  assert.equal(calls[0][0], '/repo/elsewhere', 'the terminal project is asked first');
  const count = calls.length;
  await lookup('3229e2e', { project: '/repo/elsewhere', tasks });
  assert.equal(calls.length, count, 'answered from the cache');
  assert.equal(await lookup('not-a-sha', { tasks }), null);
  assert.equal(await createCommitLookup({ root, runGit: async () => null })('abcdef1', { tasks }), null);
});
