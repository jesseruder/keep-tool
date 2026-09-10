'use strict';
// Expected outcomes are product contracts, not calls to the production policy.
const expect = (state, extra = {}) => ({ type: 'expect', state, input: state === 'needs-input', ...extra });
const user = { type: 'user' }, stop = { type: 'stop' }, schedule = { type: 'schedule' };
const cases = [
  { name: 'proposal needs a next instruction without a question', events: [user, expect('running'), stop, expect('needs-input')] },
  { name: 'browser post-deploy handoff and subsequent user turn', events: [user, schedule,
    { type: 'stop', text: 'Still healthy. Recorded in Keep; next check in ten minutes.' }, expect('waiting'),
    user, expect('running'), stop, expect('needs-input')] },
  { name: 'approval to land overrides scheduled waiting', events: [user, schedule,
    { type: 'stop', text: 'Should I land this change?' }, expect('needs-input')] },
  { name: 'cancelled schedule is not a continuing wait', events: [user, schedule, stop, expect('waiting'), { type: 'cancel' }, expect('needs-input')] },
  { name: 'automated turn invalidates old handoff despite long output and restart', events: [user, schedule, stop,
    { type: 'user', automated: true }, { type: 'output', large: true }, { type: 'restart' }, stop, expect('needs-input')] },
  { name: 'local commands do not invalidate a handoff', events: [user, schedule, stop, { type: 'wrapper' }, expect('waiting')] },
  { name: 'duplicate and late stop hooks cannot override a newer question', events: [user, schedule, stop,
    { type: 'hook', text: 'Waiting for the deploy.', duplicate: true }, user,
    { type: 'stop', text: 'Should I change the rollout?' },
    { type: 'hook', text: 'Waiting for the deploy.', lag: 10000 }, expect('needs-input')] },
  { name: 'stop hook does not finish an active turn', events: [user, { type: 'hook', text: 'Should I land?' }, expect('running')] },
  { name: 'process closure removes input request and reopen restores readiness', events: [user, stop, expect('needs-input'),
    { type: 'close' }, expect('exited'), { type: 'reopen' }, expect('needs-input')] },
  { name: 'replacement transcript cannot revive old scheduled handoff', events: [user, schedule, stop,
    { type: 'truncate' }, user, stop, expect('needs-input')] },
  { name: 'background build completion survives restart', events: [user, { type: 'job-start' }, stop,
    expect('waiting', { pending: true }), { type: 'restart' }, expect('waiting', { pending: true }),
    { type: 'job-end' }, stop, expect('needs-input', { pending: false })] },
  { name: 'subagent is a wait, not a request for human input', events: [user, { type: 'agent-start' }, stop,
    expect('waiting', { pending: true }), { type: 'agent-end' }, stop, expect('needs-input', { pending: false })] },
  { name: 'recurring Play-review poll expires with its process', agent: 'claude', events: [user, { type: 'cron-start' },
    { type: 'stop', text: 'Waiting for the review.' }, expect('waiting'), { type: 'close' }, expect('exited'),
    { type: 'reopen' }, expect('needs-input')] },
  { name: 'recurring poll cancellation and expiry', agent: 'claude', events: [user, { type: 'cron-start' },
    { type: 'stop', text: 'Waiting for the review.' }, expect('waiting'), { type: 'cron-end' }, stop, expect('needs-input'),
    user, { type: 'cron-start' }, { type: 'stop', text: 'Waiting for the review.' },
    { type: 'advance', ms: 8 * 86400e3 }, expect('needs-input')] },
  { name: 'restored Play Store poll yields until next tick, but a question still wins', agent: 'claude', events: [user,
    { type: 'stop', text: 'Idling until the next tick.' }, expect('needs-input'),
    user, { type: 'cron-start' }, { type: 'stop', text: 'POLLING RESTORED. Idling until the next tick.' },
    { type: 'hook', text: 'Unclassified prior-version stop hint.' }, expect('waiting'),
    user, { type: 'stop', text: 'Idling until the next tick. Should I change the rollout?' }, expect('needs-input'),
    user, { type: 'cron-end' }, { type: 'stop', text: 'Idling until the next tick.' }, expect('needs-input')] },
];
function random(seed) {
  let value = seed >>> 0;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
}
function generated(seed) {
  const pick = random(seed), events = [];
  // Stateful episodes, with independently chosen noise and hook availability.
  // Each episode starts a new turn: obligations deliberately survive between them.
  for (let i = 0; i < 8; i++) {
    events.push({ type: 'user', automated: pick() < 0.5 }, expect('running'));
    if (pick() < 0.5) events.push({ type: 'hook', event: 'UserPromptSubmit', id: `turn-${i}`, duplicate: pick() < 0.5 });
    const scheduled = pick() < 0.5, question = pick() < 0.5;
    if (pick() < 0.3) events.push({ type: 'job-start' }, { type: 'job-end' });
    if (scheduled) events.push(schedule);
    if (pick() < 0.3) events.push({ type: 'output', large: true });
    if (pick() < 0.5) events.push({ type: 'restart' });
    const text = question ? 'Should I land this change?' : 'Here is the proposed fix.';
    events.push({ type: 'stop', text });
    if (pick() < 0.5) events.push({ type: 'hook', text, duplicate: true });
    events.push(expect(scheduled && !question ? 'waiting' : 'needs-input'));
    if (pick() < 0.5) events.push({ type: 'advance', ms: 60000 }, expect(scheduled && !question ? 'waiting' : 'needs-input'));
    if (pick() < 0.25) events.push({ type: 'close' }, expect('exited'), { type: 'reopen' });
  }
  return events;
}
module.exports = { cases, generated };
