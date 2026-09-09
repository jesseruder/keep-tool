'use strict';

// The reviewer launcher exports KEEP_REVIEWER* into its shell; tests spawn the CLI
// from process.env, so reviewer-only refusals fired inside them when run from that
// session (17 spurious failures on 2026-09-02). Tests that need reviewer identity set
// it explicitly in their own env object.
for (const k of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[k];

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const health = require('./health.js');
const { scanCodexUsage, requestRefresh } = require('./usage.js');

function rateLimitLine(timestamp, limitId, usedPercent, windowMinutes = 10080) {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: limitId,
        primary: {
          used_percent: usedPercent,
          window_minutes: windowMinutes,
          resets_at: 1788459012,
        },
        secondary: null,
        plan_type: 'pro',
      },
    },
  });
}

test('demand-driven refresh records requests and fresh-cache skips without a timer', async () => {
  const records = [];
  const originalRecord = health.record;
  health.record = (name, options) => records.push({ name, options });
  try {
    const now = Number.MAX_SAFE_INTEGER - 1000;
    assert.equal(requestRefresh(now, async () => {}), true);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(records.at(-1), { name: 'usage', options: { ok: true } });
    assert.equal(requestRefresh(now, async () => { throw new Error('must not refresh'); }), false);
    assert.deepEqual(records.at(-1), {
      name: 'usage',
      options: { ok: true, skipped: true, detail: 'nothing due' },
    });
    assert.equal(require('./usage.js').startScheduler, undefined);
  } finally {
    health.record = originalRecord;
  }
});

test('canonical Codex usage wins over a newer named-model quota', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-usage-test-'));
  const canonical = path.join(dir, 'rollout-canonical.jsonl');
  const named = path.join(dir, 'rollout-named.jsonl');
  try {
    fs.writeFileSync(canonical, `${rateLimitLine('2026-08-28T23:16:30.465Z', 'codex', 44)}\n`);
    fs.writeFileSync(named, `${rateLimitLine('2026-08-28T23:16:39.452Z', 'codex_bengalfox', 0, 300)}\n`);
    fs.utimesSync(canonical, new Date(1000), new Date(1000));
    fs.utimesSync(named, new Date(2000), new Date(2000));

    assert.deepEqual(scanCodexUsage([dir]), {
      windows: [{ label: 'week', percent: 44, resetsAt: 1788459012000 }],
      planType: 'pro',
      asOf: Date.parse('2026-08-28T23:16:30.465Z'),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('named-model quota remains a fallback when no canonical bucket exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-usage-test-'));
  const named = path.join(dir, 'rollout-named.jsonl');
  try {
    fs.writeFileSync(named, `${rateLimitLine('2026-08-28T23:16:39.452Z', 'codex_bengalfox', 3, 300)}\n`);

    assert.deepEqual(scanCodexUsage([dir]), {
      windows: [{ label: '5h', percent: 3, resetsAt: 1788459012000 }],
      planType: 'pro',
      asOf: Date.parse('2026-08-28T23:16:39.452Z'),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
