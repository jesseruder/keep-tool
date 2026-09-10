'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildBrief, sendAlert, loadMeta, alertDecision } = require('./alerts');

function isolated(script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-idea-surface-'));
  try {
    fs.mkdirSync(path.join(root, 'tasks'));
    fs.mkdirSync(path.join(root, 'archive'));
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: __dirname, encoding: 'utf8',
      env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    return result;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('brief counts pending reviewer ideas, newest first, after findings, capped at ten', () => {
  const tasks = Array.from({ length: 12 }, (_, i) => ({
    fm: { title: `Idea ${i}`, status: i === 11 ? 'review' : 'active',
      tags: ['reviewer-idea'], created: `2026-09-${String(i + 1).padStart(2, '0')}T10:00:00` },
  }));
  tasks.push({ fm: { title: 'Done idea', status: 'done', tags: ['reviewer-idea'] } },
    { fm: { title: 'Ordinary', status: 'active', tags: [] } });
  const now = Date.parse('2026-09-14T10:00:00');
  const { text } = buildBrief({ tasks, now, findings: [{ at: now, severity: 'med', card: 'a', text: 'Finding' }] });
  assert.match(text.split('\n')[0], /12 ideas/);
  const block = text.slice(text.indexOf('Ideas awaiting a decision'));
  assert.match(block, /^Ideas awaiting a decision \(12\)\n- Idea 11 — 2 days old\n- Idea 10 — 3 days old/);
  assert.equal(block.match(/^- Idea /gm).length, 10);
  assert.match(block, /…and 2 more \(keep list\)/);
  assert.ok(text.indexOf('Reviewer findings') < text.indexOf('Ideas awaiting'));
  assert.doesNotMatch(block, /Done idea|Ordinary/);
  assert.doesNotMatch(buildBrief({ tasks: [], now }).text, /Ideas awaiting/);
});

test('digest resolves idea references and filters creation timestamps to yesterday 05:00 through now', () => {
  isolated(`
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const keep = require('./keep.js');
    const write = (id, title, stamp, kind = 'idea', dir = 'tasks', body) => {
      fs.writeFileSync(path.join(keep.ROOT, dir, id + '.md'), keep.serializeTask({
        fm: { title, status: 'active', kind, created: stamp.slice(0, 10), updated: '2026-09-10T08:00' },
        body: body || '## ' + stamp + ' — created\\nFirst proposal sentence. Second sentence.\\n',
      }));
    };
    write('old', 'Old idea', '2026-09-09 04:59');
    write('edge', 'At cutoff', '2026-09-09 05:00');
    write('new', 'Readable idea', '2026-09-10 07:59');
    write('future', 'Future idea', '2026-09-10 08:01');
    write('archived', 'Archived idea', '2026-09-10 08:00', 'idea', 'archive');
    write('work', 'Work', '2026-09-10 07:00', 'task', 'tasks', '## 2026-09-10 07:00 — review\\nReviewer idea: archived\\n');
    write('missing', 'Missing', '2026-09-10 07:00', 'task', 'tasks', '## 2026-09-10 07:00 — review\\nReviewer idea: missing-slug\\n');
    const text = keep.buildDigest({ now: '2026-09-10T08:00:00' });
    const block = text.split('## Ideas (3)')[1].split('## ')[0];
    assert.match(block, /Readable idea.*First proposal sentence\\./);
    assert.match(block, /At cutoff/);
    assert.match(block, /Archived idea/);
    assert.doesNotMatch(block, /Old idea|Future idea|Second sentence|Work/);
    assert.match(text, /Work — Archived idea/);
    assert.match(text, /Reviewer idea: missing-slug/);
  `);
});

test('reviewIdea notifies once for tick and sweep callers; delivery errors preserve landing', () => {
  const result = isolated(`
    const assert = require('node:assert/strict');
    const keep = require('./keep.js');
    const alerts = require('./alerts');
    const review = require('./review');
    const calls = [];
    alerts.sendAlert = (opts) => {
      calls.push(opts);
      if (calls.length === 2) return Promise.reject(new Error('async delivery error'));
      if (calls.length === 3) throw new Error('sync delivery error');
      return Promise.resolve({ deliveryOk: true });
    };
    for (let i = 0; i < 3; i++) {
      const out = review.reviewIdea('Proposal ' + i, {
        message: 'A'.repeat(180), commit: false,
        ...(i === 1 ? { reviewerName: 'fable sweep', withinLock: true, digestLines: [] } : {}),
      });
      assert.equal(keep.loadTask(out.task.id).fm.kind, 'idea');
      const call = calls[i];
      assert.equal(call.level, 'attention');
      assert.equal(call.key, 'idea:' + out.task.id);
      assert.equal(call.card, out.task.id);
      assert.equal(call.caller, 'reviewer-idea');
      assert.equal(call.text, out.task.fm.title + ' — ' + 'A'.repeat(140));
    }
    assert.throws(() => review.reviewIdea('Proposal 0', { message: 'Again', commit: false }), /already proposed/);
    assert.equal(calls.length, 3);
  `);
  assert.match(result.stderr, /async delivery error/);
  assert.match(result.stderr, /sync delivery error/);
});

test('idea alerts honor quiet hours and never spend the reviewer budget or use speakers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-idea-alert-'));
  const now = Date.parse('2026-09-10T10:00:00');
  try {
    for (const [index, presence] of [{ state: 'present' }, { state: 'away' }, { state: 'present', quietUntil: now + 10000 }].entries()) {
      const result = await sendAlert({ root, now, presence, level: 'attention', key: 'idea:' + index,
        caller: 'reviewer-idea', text: 'An idea', availableChannels: (channels) => channels,
        deliver: async (entry) => Object.fromEntries(entry.channels.map((channel) => [channel, 'ok'])),
      });
      assert.ok(!result.channels.includes('speak'));
      assert.equal(result.deferred, index === 2);
    }
    const meta = loadMeta(root);
    assert.equal(meta.days['2026-09-10'].callers?.reviewer, undefined);
    meta.days['2026-09-10'].callers = { reviewer: { attention: 5 } };
    assert.equal(alertDecision(meta, { now, level: 'attention', key: 'idea:new', caller: 'reviewer-idea' }).ok, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('brief uses created log time to order ideas filed on the same day', () => {
  const tasks = ['08:00', '11:00'].map((time) => ({
    fm: { title: time, status: 'active', tags: ['reviewer-idea'], created: '2026-09-10' },
    body: `## 2026-09-10 ${time} — created\nProposal.\n`,
  }));
  const { text } = buildBrief({ tasks, now: Date.parse('2026-09-10T12:00:00') });
  assert.match(text, /- 11:00 — 0 days old\n- 08:00 — 0 days old/);
});
