'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanProbes, combineProbes, acknowledgeProbe, probeBackoff } = require('./review-probes');
const { replayReviews } = require('./review-replay');

function turn(n, result = '{"count":0,"error":false}') {
  const timestamp = new Date(1000000 + n * 20 * 60e3).toISOString();
  return [
    { type: 'user', timestamp, isMeta: true, promptSource: 'system', scheduledTaskId: 'cron-1', scheduledFireId: 'fire-' + n, message: { content: 'Check state' } },
    { type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id: 'call-' + n, name: 'mcp__browser__read', input: { tab: 1 } }], stop_reason: 'tool_use' } },
    { type: 'user', timestamp, message: { content: [{ type: 'tool_result', tool_use_id: 'call-' + n, content: result }] } },
    { type: 'assistant', timestamp, message: { content: [{ type: 'text', text: 'Probe complete.' }], stop_reason: 'end_turn' } },
  ];
}

test('probe signatures ignore harness IDs but preserve prompt, call, result and numerical changes', () => {
  const a = scanProbes(turn(1));
  assert.equal(a.eligible, true);
  assert.equal(a.fingerprint, scanProbes(turn(2)).fingerprint);
  assert.equal(scanProbes([...turn(1), ...turn(2)]).eligible, true);
  for (const mutate of [
    rows => { rows[0].message.content = 'New instruction'; },
    rows => { rows[1].message.content[0].input.tab = 2; },
    rows => { rows[2].message.content[0].content = '{"count":1,"error":false}'; },
    rows => { rows[3].message.content[0].text = 'A new concern.'; },
  ]) {
    const rows = turn(2); mutate(rows);
    assert.notEqual(scanProbes(rows).fingerprint, a.fingerprint);
    assert.equal(scanProbes([...turn(1), ...rows]).eligible, false);
  }
});

test('errors, human input, writes, unknown formats, compaction and incomplete probes cannot back off', () => {
  for (const mutate of [
    rows => { delete rows[0].isMeta; },
    rows => { delete rows[0].scheduledFireId; },
    rows => { rows[1].message.content[0].name = 'Bash'; },
    rows => { rows[1].message.content[0].name = 'mcp__service__deploy'; },
    rows => { rows[2].message.content[0].is_error = true; },
    rows => { rows[2].message.content[0].content = [{ type: 'image', data: 'opaque' }]; },
    rows => { rows.pop(); },
    rows => { rows.unshift({ type: 'system', subtype: 'compact_boundary' }); },
    rows => { rows.unshift('malformed'); },
    rows => { rows.push({ type: 'assistant', isSidechain: true, message: { content: 'background work' } }); },
  ]) {
    const rows = turn(1); mutate(rows);
    assert.equal(scanProbes(rows).eligible, false, JSON.stringify(rows));
  }
  assert.equal(scanProbes(turn(1), 'codex').eligible, false);
});

test('backoff requires read-only approval, grows to four hours, and is bypassed by changes', () => {
  const candidate = combineProbes([{ id: 'session', probe: scanProbes(turn(1)) }]);
  assert.equal(acknowledgeProbe(null, candidate, false, 0), null);
  let state = acknowledgeProbe(null, candidate, true, 0);
  assert.equal(probeBackoff(state, candidate, 1), false);
  state = acknowledgeProbe(state, candidate, false, 1);
  assert.equal(state.nextReviewAt, 1 + 3600e3);
  assert.equal(probeBackoff(state, candidate, 2), true);
  assert.equal(probeBackoff(state, candidate, 2, true), false);
  assert.equal(probeBackoff(state, { fingerprint: 'changed' }, 2), false);
  assert.equal(probeBackoff(state, candidate, state.nextReviewAt), false);
  for (let i = 0; i < 12; i++) state = acknowledgeProbe(state, candidate, false, 0);
  assert.equal(state.nextReviewAt, 4 * 3600e3);
  assert.equal(acknowledgeProbe(state, null, true, 0), null);
});

test('replay retains changed results and findings while reducing repeated clean probes', () => {
  const records = [];
  const ticks = [];
  for (let i = 0; i < 20; i++) {
    const rows = turn(i, i === 10 ? '{"count":1,"error":true}' : undefined);
    records.push(...rows); ticks.push({ at: Date.parse(rows[0].timestamp), clean: i !== 10 });
  }
  const report = replayReviews(records, ticks);
  assert.ok(report.deferred > 8);
  assert.equal(report.rows[10].deferred, false);
  assert.equal(report.rows[11].deferred, false);
});

test('benign harness metadata is ignored but hook errors and context force review', () => {
  const hook = { type: 'system', subtype: 'stop_hook_summary', hookErrors: [], hookAdditionalContext: [], preventedContinuation: false, hasOutput: false, stopReason: '' };
  assert.equal(scanProbes([...turn(1), hook, ...['turn_duration', 'away_summary', 'scheduled_task_fire'].map(subtype => ({ type: 'system', subtype }))]).eligible, true);
  for (const override of [{ hookErrors: ['failed'] }, { hookAdditionalContext: ['new instruction'] }, { preventedContinuation: true }, { hasOutput: true }]) {
    assert.equal(scanProbes([...turn(1), { ...hook, ...override }]).eligible, false);
  }
});
