'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  lightweightState,
  consoleState,
  wantsConsoleState,
  CONSOLE_STATE_KEYS,
  CONSOLE_DEAD_SESSION_FIELDS,
  CONSOLE_DEAD_PANE_FIELDS,
  CONSOLE_PANE_META_FIELDS,
  dashboardDetail,
  reviewQueueSearch,
  createJobChangeTracker,
} = require('./dashboard-state');

test('a card-usage run stamp does not change a card detail version', () => {
  const usage = (updatedAt, calls = 3) => ({ since: 1, updatedAt, pending: false, issues: {}, input: 10, cacheRead: 0, cacheWrite: 0, output: 5, calls, models: {} });
  const card = (modelUsage) => ({ id: 'card', fm: { title: 'Card' }, body: 'notes', lastLog: 'latest', modelUsage });
  const first = lightweightState({ tasks: [card(usage(1000))] }).tasks[0]._detailVersion;
  const restamped = lightweightState({ tasks: [card(usage(31000))] }).tasks[0]._detailVersion;
  assert.equal(restamped, first, 'only the collector run time changed');
  assert.notEqual(lightweightState({ tasks: [card(usage(31000, 4))] }).tasks[0]._detailVersion, first, 'new usage is a new version');
  const state = { tasks: [card(usage(61000))] };
  assert.equal(dashboardDetail(state, 'task', 'card').version, lightweightState(state).tasks[0]._detailVersion,
    'the detail route reports the version the list advertised');
  assert.equal(lightweightState({ tasks: [card(null)] }).tasks[0]._detailVersion,
    dashboardDetail({ tasks: [card(null)] }, 'task', 'card').version);
});

test('the session number reaches every client: summary and exited rows keep num', () => {
  const live = { id: 'live', num: 12, state: 'running' };
  const gone = { id: 'gone', num: 3, exited: true, state: 'exited', lastAssistantFull: 'answer', size: 10 };
  const state = { tasks: [], sessions: [live, gone], notifications: [], attention: [] };
  const light = lightweightState(state).sessions;
  assert.equal(light[0].num, 12);
  assert.equal(light[1].num, 3, 'an exited row is trimmed hard but keeps its number');
});

test('a hand-renamed session reaches every client with its name and the renamed flag', () => {
  const live = { id: 'live', title: 'The finder', renamed: true, state: 'running' };
  const gone = { id: 'gone', title: 'The fixer', renamed: true, exited: true, state: 'exited', lastAssistantFull: 'answer', size: 10 };
  const state = { tasks: [], sessions: [live, gone], notifications: [], attention: [] };
  const light = lightweightState(state).sessions;
  assert.deepEqual(light.map((session) => [session.title, session.renamed]),
    [['The finder', true], ['The fixer', true]], 'an exited row is trimmed hard but keeps its name');
});

test("a session's mark reaches every client: summary and exited rows", () => {
  const fire = '\u{1f525}';
  const live = { id: 'live', mark: { color: 'red', emoji: fire }, state: 'running' };
  const gone = { id: 'gone', mark: { color: 'blue' }, exited: true, state: 'exited', lastAssistantFull: 'answer', size: 10 };
  const state = { tasks: [], sessions: [live, gone], notifications: [], attention: [] };
  const light = lightweightState(state).sessions;
  assert.deepEqual(light.map((session) => session.mark),
    [{ color: 'red', emoji: fire }, { color: 'blue' }], 'an exited row is trimmed hard but keeps its mark');
});

test('lightweight dashboard state preserves list context and moves opened content to details', () => {
  const longLog = 'x'.repeat(800);
  const state = {
    generatedAt: 123,
    tasks: [{
      id: 'card', body: '## 2026-09-07 12:34 — created\n\nFull task history', modelUsage: { total: 42 }, lastLog: longLog,
      fm: { title: 'Card', status: 'review', kind: 'task', project: '/repo', tags: ['work'], depends_on: ['upstream'], sessions: [{ id: 'linked' }], check: 'expensive recipe', probe: 'true' },
      overdue: true,
    }],
    sessions: [{
      id: 'session', title: 'Live work', state: 'waiting', stateLabel: 'Waiting', taskId: 'card',
      lastAssistant: 'Short update', lastAssistantFull: 'Full transcript tail', observation: { evidence: ['large'] },
      runtime: { process: 'details' }, backgroundJobs: [{ id: 'ledger-entry', status: 'completed' }],
      pendingBackground: true, activity: { background: { pending: true } },
    }, {
      id: 'old-session', kind: 'claude', title: 'Historical work', baseTitle: 'Historical work', project: '/repo',
      state: 'exited', stateLabel: 'Exited', exited: true, alive: false, pane: 'old-pane', taskId: 'card',
      taskStatus: 'review', accountId: 'claude-main', accountLabel: 'Claude Main', gitBranch: 'feature/history',
      mtime: 120, lastUserAt: 110, attentionAt: 115, lastAssistant: 'Historical preview',
      lastAssistantFull: 'Historical full transcript tail', lastUser: 'Large user prompt', lastHuman: 'human', size: 999,
      endedTurn: true, pendingQuestion: null, pendingPlan: null, localCommandPending: false, pendingOther: false,
      pendingBackground: true, unknownBackgroundJobs: ['unverified-child'], lifecycleAgents: ['child'],
      lifecycleForeground: { state: 'stopped' }, lifecycleStop: { intent: 'done' }, lifecycleTurnAt: 100,
      waitingFor: null, toolRunning: false, rateLimit: null, notify: { type: 'complete' }, askedProse: false,
      activity: { state: 'exited', label: 'Exited', decision: { rule: 'process-exited', alternatives: [{ rule: 'task-review' }] },
        background: { pending: true, uncertain: ['unverified-child'], scheduled: [], checkAfter: null, dependencies: ['upstream'] } },
    }],
    panes: [{ id: 'live-pane', alive: true, cmd: '/bin/zsh', args: ['-lic'], rows: 40, cols: 120 }, {
      id: 'old-pane', alive: false, pid: 42, cwd: '/repo', title: 'Historical work', exitCode: 0,
      createdAt: '2026-09-07T12:00:00Z', exitedAt: '2026-09-07T13:00:00Z', cmd: '/bin/zsh', args: ['-lic', 'claude'],
      rows: 40, cols: 120, attached: 0, visibleAttached: 0, bytes: 123456, inputCount: 1, outputCount: 2,
      meta: { agent: 'claude', sessionId: 'old-session', project: '/repo', card: 'card', accountId: 'claude-main' },
    }],
    reviewQueue: { counts: { 'needs-decision': 1 }, items: [{
      id: 'finding:card:key', type: 'finding', status: 'needs-decision', title: 'Finding', card: 'card',
      project: '/repo', at: 123, body: 'searchable note', evidence: 'full evidence', outcome: { status: 'unresolved' },
      sessions: [{ id: 'discussion', action: 'discuss', at: 124 }],
    }] },
    notifications: [{ id: 'notification', card: 'card', read: false }],
    attention: [{ sessionId: 'session', kind: 'input' }],
  };
  const before = JSON.stringify(state);
  const summary = lightweightState(state);

  assert.equal(summary.generatedAt, 123);
  assert.deepEqual(summary.reviewQueue.counts, state.reviewQueue.counts);
  assert.deepEqual(summary.notifications, state.notifications);
  assert.deepEqual(summary.attention, state.attention);
  assert.equal(summary.tasks[0].body, undefined);
  assert.equal(summary.tasks[0].modelUsage, undefined);
  assert.equal(summary.tasks[0].fm.check, undefined);
  assert.equal(summary.tasks[0].fm.probe, undefined);
  assert.equal(summary.tasks[0].fm.title, 'Card');
  assert.deepEqual(summary.tasks[0].fm.sessions, [{ id: 'linked' }]);
  assert.equal(summary.tasks[0].createdAt, '2026-09-07T12:34');
  assert.equal(summary.tasks[0].hasCheck, true);
  assert.equal(summary.tasks[0].lastLog.length, 500);
  assert.equal(summary.sessions[0].lastAssistantFull, 'Full transcript tail');
  assert.equal(summary.sessions[0].observation, undefined);
  assert.equal(summary.sessions[0].runtime, undefined);
  assert.equal(summary.sessions[0].backgroundJobs, undefined);
  assert.equal(summary.sessions[0].pendingBackground, true);
  assert.equal(summary.sessions[0].lastAssistant, 'Short update');
  assert.deepEqual(summary.sessions[0].activity, state.sessions[0].activity);
  assert.equal(summary.sessions[1].lastAssistant, 'Historical preview');
  assert.equal(summary.sessions[1].lastAssistantFull, undefined);
  assert.equal(summary.sessions[1].lastUser, 'Large user prompt');
  assert.equal(summary.sessions[1].lastHuman, undefined);
  assert.equal(summary.sessions[1].size, undefined);
  assert.equal(summary.sessions[1].lifecycleForeground, undefined);
  assert.equal(summary.sessions[1].stateLabel, 'Exited');
  assert.equal(summary.sessions[1].accountLabel, 'Claude Main');
  assert.equal(summary.sessions[1].gitBranch, 'feature/history');
  assert.equal(summary.sessions[1].pendingBackground, true);
  assert.deepEqual(summary.sessions[1].unknownBackgroundJobs, ['unverified-child']);
  assert.deepEqual(summary.sessions[1].lifecycleAgents, ['child']);
  assert.deepEqual(summary.sessions[1].activity, { background: state.sessions[1].activity.background });
  assert.deepEqual(summary.panes[0], state.panes[0], 'live pane metadata is unchanged');
  assert.equal(summary.panes[1].cmd, undefined);
  assert.equal(summary.panes[1].args, undefined);
  assert.equal(summary.panes[1].rows, undefined);
  assert.equal(summary.panes[1].bytes, undefined);
  assert.equal(summary.panes[1].pid, 42);
  assert.equal(summary.panes[1].meta.sessionId, 'old-session');
  assert.equal(summary.reviewQueue.items[0].body, undefined);
  assert.equal(summary.reviewQueue.items[0].evidence, undefined);
  assert.equal(summary.reviewQueue.items[0].outcome, undefined);
  assert.equal(summary.reviewQueue.items[0].sessions, undefined);
  assert.equal(typeof summary.tasks[0]._detailVersion, 'string');
  assert.equal(JSON.stringify(state), before, 'source state is not mutated');

  assert.deepEqual(dashboardDetail(state, 'task', 'card').value, state.tasks[0]);
  assert.deepEqual(dashboardDetail(state, 'session', 'session').value, state.sessions[0]);
  assert.deepEqual(dashboardDetail(state, 'review', 'finding:card:key').value, state.reviewQueue.items[0]);
  assert.equal(dashboardDetail(state, 'task', 'card').version, summary.tasks[0]._detailVersion);
  assert.equal(dashboardDetail(state, 'session', 'old-session').version, summary.sessions[1]._detailVersion);

  const statusOnly = structuredClone(state.sessions[1]);
  statusOnly.title = 'Renamed historical work';
  statusOnly.accountLabel = 'Claude Secondary';
  statusOnly.activity.decision.at = 999;
  assert.equal(lightweightState({ sessions: [statusOnly] }).sessions[0]._detailVersion,
    summary.sessions[1]._detailVersion, 'list-only changes do not invalidate cached transcript detail');
  statusOnly.lastAssistantFull = 'A newer full transcript tail';
  assert.notEqual(lightweightState({ sessions: [statusOnly] }).sessions[0]._detailVersion,
    summary.sessions[1]._detailVersion, 'deferred full text invalidates cached transcript detail');
});

test('dashboard detail validation and full review-note search stay explicit', () => {
  const state = { reviewQueue: { items: [
    { id: 'one', title: 'Visible title', body: 'ordinary notes' },
    { id: 'two', title: 'Other title', body: 'Needle only appears in the full notes' },
  ] } };
  assert.deepEqual(reviewQueueSearch(state, 'needle'), { ids: ['two'] });
  assert.deepEqual(reviewQueueSearch(state, 'visible'), { ids: ['one'] });
  assert.throws(() => dashboardDetail(state, 'unknown', 'one'), (error) => error.status === 400);
  assert.throws(() => dashboardDetail(state, 'review', 'missing'), (error) => error.status === 404);
});


// A fixture with every top-level field the daemon publishes, both card shapes, all
// three dead-session signals, and a live and a dead pane.
function consoleFixture() {
  return {
    generatedAt: 123,
    shadowDecisions: { graduated: 1 },
    scopes: { names: ['castle'] },
    projectCatalog: [{ path: '/repo' }],
    restarts: [{ sessionId: 'flagged-exited', mode: 'restart', status: 'queued', at: 5 }],
    tasks: [
      { id: 'open-card', fm: { title: 'Open', status: 'active' }, body: 'full body', lastLog: 'latest log' },
      { id: 'linked-card', fm: { title: 'Linked', status: 'done' }, body: 'full body', lastLog: 'latest log' },
      { id: 'closed-card', fm: { title: 'Closed', status: 'done' }, body: 'full body', lastLog: 'latest log' },
      { id: 'pane-card', fm: { title: 'Pane only', status: 'done' }, body: 'full body', lastLog: 'latest log' },
    ],
    sessions: [
      {
        id: 'live', num: 4, kind: 'claude', state: 'running', stateLabel: 'Running', alive: true, exited: false,
        title: 'Live work', taskId: 'open-card', lastAssistant: 'Short update', lastAssistantFull: 'Full tail',
        lastUser: 'Large user prompt', opener: { via: 'keep' }, unknownBackgroundJobs: ['child'],
      },
      {
        id: 'flagged-exited', num: 7, kind: 'claude', agent: 'claude', agentName: 'fleet', title: 'Flagged',
        renamed: true, mark: 'target', project: '/repo', gitBranch: 'feature/history', taskId: 'linked-card',
        taskStatus: 'done', state: 'waiting', stateLabel: 'Waiting', alive: false, exited: true, pane: 'dead-pane',
        mtime: 120, lastUserAt: 110, turnStartedAt: 100, accountId: 'claude-main', account: 'claude-main-legacy',
        accountLabel: 'Claude Main', reviewer: true, rateLimit: { at: 5 }, lastAssistant: 'Historical preview',
        stateLine: 'Finished the review', lastVerdict: 'done', lastVerdictAt: 130, verdictConfidence: 0.9,
        pendingDecision: { id: 'd1', type: 'grade' }, pendingQuestion: 'Ship it?', pendingPlan: { text: 'plan' },
        activity: { background: { pending: true } },
        lastUser: 'Large user prompt', lastAssistantFull: 'Full historical tail', lastHuman: 'human', size: 999,
        opener: { via: 'keep' }, endedTurn: true, notify: { type: 'complete' }, lifecycleAgents: ['child'],
        askedProse: false, waitingFor: null, attentionAt: 115, localCommandPending: false,
      },
      {
        id: 'state-exited', kind: 'codex', title: 'By state', state: 'exited', stateLabel: 'Exited',
        lastUser: 'Large user prompt', waitingFor: null, toolRunning: false,
      },
      {
        id: 'not-alive', kind: 'claude', title: 'By alive', state: 'waiting', stateLabel: 'Waiting', alive: false,
        lastUser: 'Large user prompt', attentionAt: 9, localCommandPending: false,
      },
    ],
    attention: [{ sessionId: 'live', kind: 'input', taskId: 'open-card' }],
    setAside: { ids: [] },
    stalled: [{ id: 'live' }],
    unblocked: [{ id: 'live' }],
    digest: '# digest',
    notifications: [{ id: 'note', card: 'open-card', read: false }],
    reminders: [{ id: 'reminder' }],
    alerts: [{ id: 'alert' }],
    brief: { text: 'brief' },
    standup: { text: 'standup' },
    landed: { today: 1 },
    limitResume: { waiting: [] },
    slack: { unread: 2 },
    health: { ok: true },
    usage: { input: 1 },
    reviewQueue: { counts: { 'needs-decision': 1 }, items: [{ id: 'finding', card: 'open-card', body: 'note' }] },
    accounts: [{ id: 'claude-main' }],
    defaults: { model: 'opus' },
    automationAccounts: { headless: 'claude' },
    handoffs: [{ id: 'handoff' }],
    handoffQueue: [{ sessionId: 'live' }],
    resumeSummary: { text: 'resume' },
    reviewSummary: { text: 'review' },
    weeklySummary: { text: 'weekly' },
    reviewUsage: { calls: 3 },
    review: { events: [{ id: 'event' }], stats: { open: 1 } },
    agents: [{ name: 'fleet', card: 'open-card' }],
    panes: [
      { id: 'live-pane', alive: true, cmd: '/bin/zsh', args: ['-lic'], rows: 40, cols: 120, cwd: '/repo',
        meta: { agent: 'claude', sessionId: 'live', openRequestId: 'req-1' } },
      { id: 'dead-pane', alive: false, agentAlive: false, pid: 42, cwd: '/repo', title: 'Historical',
        createdAt: '2026-09-07T12:00:00Z', exitedAt: '2026-09-07T13:00:00Z', exitCode: 0, signal: null,
        lastActivityAt: 7, scope: 'castle', cmd: '/bin/zsh', args: ['-lic'], rows: 40, cols: 120, bytes: 123,
        meta: { agent: 'claude', agentName: 'fleet', sessionId: 'flagged-exited', project: '/repo',
          title: 'Historical', card: 'pane-card', accountId: 'claude-main', accountLabel: 'Claude Main',
          portableTransferId: 'transfer-1', url: 'http://localhost/app', attributes: { pinned: true },
          terminalRendererTrial: 'webgl', openRequestId: 'req-2', launchedBy: 'keep' } },
    ],
    hostStatus: { ok: true },
  };
}

test('console state keeps only the top-level fields the console renders', () => {
  const state = consoleFixture();
  const before = JSON.stringify(state);
  const projected = consoleState(state);

  // Written out rather than derived from CONSOLE_STATE_KEYS: dropping a field the
  // console renders has to fail here, not quietly restate the new allowlist.
  const expectedKeys = [
    'generatedAt', 'shadowDecisions', 'scopes', 'projectCatalog', 'restarts', 'tasks', 'sessions',
    'attention', 'setAside', 'notifications', 'reminders', 'limitResume', 'health', 'usage',
    'reviewQueue', 'accounts', 'handoffs', 'handoffQueue', 'review', 'agents', 'panes', 'hostStatus',
  ];
  assert.deepEqual(Object.keys(projected).sort(), [...expectedKeys].sort(),
    'exactly the fields the console renders, and the fixture publishes every one of them');
  assert.deepEqual([...CONSOLE_STATE_KEYS].sort(), [...expectedKeys].sort(),
    'the exported allowlist and the rendered set have not drifted apart');
  for (const key of ['digest', 'landed', 'slack', 'alerts', 'weeklySummary', 'defaults',
    'stalled', 'unblocked', 'brief', 'standup', 'automationAccounts', 'resumeSummary',
    'reviewSummary', 'reviewUsage']) {
    assert.equal(projected[key], undefined, key + ' is legacy-board only');
  }
  assert.deepEqual(projected.review, state.review, 'review events pass through');
  assert.deepEqual(projected.reviewQueue.counts, state.reviewQueue.counts);
  assert.deepEqual(projected.notifications, state.notifications);
  assert.equal(projected.generatedAt, 123);
  assert.equal(JSON.stringify(state), before, 'source state is not mutated');
});

test('console state drops closed cards nothing points at, and every card history', () => {
  const state = consoleFixture();
  const projected = consoleState(state);
  const ids = projected.tasks.map((task) => task.id);

  assert.ok(ids.includes('open-card'), 'an open card is always kept');
  assert.ok(ids.includes('linked-card'), 'a done card an exited session points at is kept');
  assert.ok(ids.includes('pane-card'), "a done card only a dead pane's meta.card points at is kept");
  assert.equal(ids.includes('closed-card'), false, 'a done card nothing points at is dropped');

  for (const task of projected.tasks) {
    assert.equal(task.lastLog, undefined, task.id + ' carries no log tail');
    assert.equal(task.body, undefined, task.id + ' carries no history');
    assert.equal(typeof task._detailVersion, 'string', task.id + ' keeps its detail version');
    assert.equal(typeof task.fm, 'object', task.id + ' keeps its frontmatter');
    assert.ok(Object.hasOwn(task, 'createdAt'), task.id + ' keeps the lightweight fields');
    assert.equal(task.hasCheck, false);
  }
  assert.equal(projected.tasks.find((task) => task.id === 'open-card').fm.title, 'Open');

  const byAttention = consoleState({ tasks: [{ id: 'done', fm: { status: 'done' } }], attention: [{ taskId: 'done' }] });
  assert.deepEqual(byAttention.tasks.map((task) => task.id), ['done'], 'attention keeps a closed card');
  const byQueue = consoleState({ tasks: [{ id: 'done', fm: { status: 'done' } }], reviewQueue: { items: [{ id: 'f', card: 'done' }] } });
  assert.deepEqual(byQueue.tasks.map((task) => task.id), ['done'], 'a review-queue item keeps a closed card');
  const byNotification = consoleState({ tasks: [{ id: 'done', fm: { status: 'done' } }], notifications: [{ id: 'n', card: 'done' }] });
  assert.deepEqual(byNotification.tasks.map((task) => task.id), ['done'], 'a notification keeps a closed card');
  const byAgent = consoleState({ tasks: [{ id: 'done', fm: { status: 'done' } }], agents: [{ name: 'a', card: 'done' }] });
  assert.deepEqual(byAgent.tasks.map((task) => task.id), ['done'], 'a standing agent keeps a closed card');
  // The Fleet list tags a dead pane's row from meta.card once the session is gone.
  const byPane = consoleState({ tasks: [{ id: 'done', fm: { status: 'done' } }],
    panes: [{ id: 'p', alive: false, meta: { agent: 'claude', card: 'done' } }] });
  assert.deepEqual(byPane.tasks.map((task) => task.id), ['done'], "a dead pane's card keeps a closed card");
  const bySession = consoleState({ tasks: [{ id: 'done', fm: { status: 'done' } }], sessions: [{ id: 's', exited: true, taskId: 'done' }] });
  assert.deepEqual(bySession.tasks.map((task) => task.id), ['done'], 'an exited session keeps a closed card');
  assert.deepEqual(consoleState({}).tasks, [], 'every referencing list is optional');
});

test('console state reduces every dead session and leaves live rows whole', () => {
  const state = consoleFixture();
  const projected = consoleState(state);
  const live = projected.sessions.find((session) => session.id === 'live');

  assert.equal(live.lastUser, 'Large user prompt');
  assert.deepEqual(live.opener, { via: 'keep' });
  assert.deepEqual(live.unknownBackgroundJobs, ['child']);
  assert.equal(live.lastAssistantFull, 'Full tail', 'a live row keeps everything lightweight state left');

  // Written out, not derived: 'flagged-exited' carries every allowlisted field, so
  // removing one the console renders — state, title, num, mark, mtime, pane,
  // lastUserAt, account — fails here.
  const expectedDeadSession = [
    'id', 'num', 'kind', 'agent', 'agentName', 'title', 'renamed', 'mark', 'project', 'gitBranch',
    'taskId', 'taskStatus', 'state', 'stateLabel', 'alive', 'exited', 'pane', 'mtime', 'lastUserAt',
    'turnStartedAt', 'accountId', 'account', 'accountLabel', 'reviewer', 'rateLimit', 'lastAssistant',
    'stateLine', 'lastVerdict', 'lastVerdictAt', 'verdictConfidence', 'pendingDecision',
    'pendingQuestion', 'pendingPlan', 'activity', '_detailVersion',
  ];
  const flagged = projected.sessions.find((session) => session.id === 'flagged-exited');
  assert.deepEqual(Object.keys(flagged).sort(), [...expectedDeadSession].sort(),
    'an exited row keeps exactly the fields the console renders on it');
  assert.deepEqual([...CONSOLE_DEAD_SESSION_FIELDS].sort(), [...expectedDeadSession].sort(),
    'the exported dead-session allowlist and the rendered set have not drifted apart');

  // The other two dead signals reduce the same way, on rows that carry only a few.
  assert.deepEqual(Object.keys(projected.sessions.find((session) => session.id === 'state-exited')).sort(),
    ['_detailVersion', 'id', 'kind', 'state', 'stateLabel', 'title'], "state: 'exited' is a dead row");
  assert.deepEqual(Object.keys(projected.sessions.find((session) => session.id === 'not-alive')).sort(),
    ['_detailVersion', 'alive', 'id', 'kind', 'state', 'stateLabel', 'title'], 'alive: false is a dead row');

  for (const id of ['flagged-exited', 'state-exited', 'not-alive']) {
    assert.equal(projected.sessions.find((session) => session.id === id).lastUser, undefined,
      id + ' drops the user prompt');
  }
  assert.equal(flagged.accountLabel, 'Claude Main');
  assert.equal(flagged.account, 'claude-main-legacy', 'the legacy account field still reaches the batch count');
  assert.equal(flagged.lastAssistant, 'Historical preview');
  assert.equal(flagged.taskId, 'linked-card');
  assert.equal(flagged.notify, undefined);
  assert.equal(flagged.lastAssistantFull, undefined);
  assert.deepEqual(flagged.activity, { background: { pending: true } });
  assert.equal(typeof flagged._detailVersion, 'string');
});

test('console state reduces dead panes and their meta, and leaves live panes whole', () => {
  const state = consoleFixture();
  const projected = consoleState(state);
  const live = projected.panes.find((pane) => pane.id === 'live-pane');
  const dead = projected.panes.find((pane) => pane.id === 'dead-pane');

  assert.equal(live.cols, 120);
  assert.equal(live.rows, 40);
  assert.equal(live.meta.openRequestId, 'req-1');

  // Written out, not derived: the fixture's dead pane carries every allowlisted
  // field and meta field, so removing one the console renders fails here.
  const expectedDeadPane = ['id', 'alive', 'agentAlive', 'cwd', 'title', 'createdAt', 'exitedAt', 'pid', 'scope', 'meta'];
  const expectedPaneMeta = [
    'agent', 'agentName', 'sessionId', 'project', 'title', 'card', 'accountId', 'accountLabel',
    'portableTransferId', 'url', 'attributes', 'terminalRendererTrial',
  ];
  assert.deepEqual(Object.keys(dead).sort(), [...expectedDeadPane].sort(),
    'a dead pane keeps exactly the fields the console renders on it');
  assert.deepEqual(Object.keys(dead.meta).sort(), [...expectedPaneMeta].sort(),
    'a dead pane keeps exactly the meta the console renders');
  assert.deepEqual([...CONSOLE_DEAD_PANE_FIELDS].sort(), [...expectedDeadPane].sort(),
    'the exported dead-pane allowlist and the rendered set have not drifted apart');
  assert.deepEqual([...CONSOLE_PANE_META_FIELDS].sort(), [...expectedPaneMeta].sort(),
    'the exported pane-meta allowlist and the rendered set have not drifted apart');
  assert.equal(dead.meta.openRequestId, undefined);
  assert.equal(dead.meta.launchedBy, undefined);
  assert.equal(dead.meta.card, 'pane-card');
  assert.equal(dead.pid, 42);
  assert.equal(dead.scope, 'castle');
  assert.equal(dead.exitCode, undefined);

  const agentDead = consoleState({ panes: [{ id: 'p', alive: true, agentAlive: false, cols: 80, meta: { sessionId: 's', openRequestId: 'r' } }] });
  assert.deepEqual(Object.keys(agentDead.panes[0]).sort(), ['agentAlive', 'alive', 'id', 'meta']);
  assert.deepEqual(agentDead.panes[0].meta, { sessionId: 's' });
});

test('console mode is opt-in and composes on the internal summary projection', () => {
  assert.equal(wantsConsoleState(new URL('http://localhost/api/state')), false);
  assert.equal(wantsConsoleState(new URL('http://localhost/api/state?view=home')), false);
  assert.equal(wantsConsoleState(new URL('http://localhost/api/state?console=0')), false);
  assert.equal(wantsConsoleState(new URL('http://localhost/api/state?console=1')), true);

  const state = consoleFixture();
  const light = lightweightState(state);
  assert.equal(light.digest, '# digest');
  assert.deepEqual(light.landed, state.landed);
  assert.deepEqual(light.slack, state.slack);
  assert.deepEqual(light.defaults, state.defaults);
  assert.equal(light.tasks.length, 4, 'the summary projection still carries every card');
  assert.equal(light.sessions.find((session) => session.id === 'flagged-exited').lastAssistantFull, undefined);
  assert.equal(light.tasks[0].lastLog, 'latest log');
  assert.equal(light.sessions.find((session) => session.id === 'not-alive').lastUser, 'Large user prompt');
  assert.equal(light.sessions.find((session) => session.id === 'flagged-exited').notify.type, 'complete');
  assert.deepEqual(light.panes[0], state.panes[0]);
  assert.equal(light.panes[1].meta.openRequestId, 'req-2', 'summary mode keeps the full pane meta');

  assert.deepEqual(consoleState(state, light), consoleState(state),
    'a prebuilt summary is the same input as building one');
});

test('job reconciliation notifies for meaningful changes, including child-only completion and stale confidence', () => {
  const changed = createJobChangeTracker();
  const result = { pending: true, uncertain: [], recovering: false, gap: false, bytesRead: 0,
    jobs: [{ id: 'child', kind: 'agent', status: 'pending', eventAt: 1, lastCorroboratedAt: 2, confidence: 'observed' }] };
  assert.equal(changed('s', result), true);
  result.lastReconciledAt = 3;
  result.bytesRead = 100;
  result.jobs[0].lastCorroboratedAt = 3;
  assert.equal(changed('s', result), false, 'no repeated refresh for unchanged retained jobs');
  assert.equal(changed('s', { pending: false, uncertain: ['ledger-busy'], jobs: [] }), false);
  assert.equal(changed('s', result), false, 'contention did not replace the last known signature');
  assert.equal(changed('other', result), true, 'sessions are independent');
  result.uncertain = ['child']; result.jobs[0].confidence = 'uncertain';
  assert.equal(changed('s', result), true);
  result.bytesRead = 0; result.pending = false; result.uncertain = [];
  result.jobs[0].status = 'completed'; result.jobs[0].confidence = 'observed';
  assert.equal(changed('s', result), true, 'completion outside the parent transcript is visible');
  assert.equal(changed('s', result), false, 'completed tombstone no longer refreshes forever');
  result.gap = true;
  assert.equal(changed('s', result), true);
});

test('the state payload carries the watcher state line, verdict and pending decision', () => {
  const { attachStateLines, shadowDecisionSummary } = require('./dashboard-state');
  const sessions = [{ id: 'judged' }, { id: 'unjudged' }];
  const watcher = {
    stateLines: (ids) => {
      assert.deepEqual(ids, ['judged', 'unjudged']);
      return new Map([['judged', {
        stateLine: 'fixed the parser; running the suite next',
        lastVerdict: 'continue', lastVerdictAt: 1234, confidence: 0.82,
      }]]);
    },
    pendingDecisions: () => new Map([['judged', { id: 'd-1', type: 'continue', message: 'run the suite' }]]),
    shadowSummary: () => ({ pending: 2, judged: 5, agree: 4, types: [] }),
  };
  attachStateLines(sessions, { watcher });
  assert.equal(sessions[0].stateLine, 'fixed the parser; running the suite next');
  assert.equal(sessions[0].lastVerdict, 'continue');
  assert.equal(sessions[0].lastVerdictAt, 1234);
  assert.equal(sessions[0].verdictConfidence, 0.82);
  assert.deepEqual(sessions[0].pendingDecision, { id: 'd-1', type: 'continue', message: 'run the suite' });
  // A session the watcher has not judged gains nothing, so the console falls back
  // to the summarizer rather than showing an empty panel.
  assert.equal(sessions[1].stateLine, undefined);
  assert.equal(sessions[1].pendingDecision, undefined);
  assert.equal(shadowDecisionSummary({ watcher }).pending, 2);
});

test('a watcher that has never run leaves the state untouched rather than failing it', () => {
  const { attachStateLines, shadowDecisionSummary } = require('./dashboard-state');
  const broken = { stateLines: () => { throw new Error('no index'); } };
  const sessions = [{ id: 'a' }];
  assert.equal(attachStateLines(sessions, { watcher: broken }), sessions);
  assert.equal(sessions[0].stateLine, undefined);
  assert.equal(shadowDecisionSummary({ watcher: { shadowSummary: () => { throw new Error('nope'); } } }), null);
  // A ledger failure must not lose the state line beside it.
  const partial = {
    stateLines: () => new Map([['a', { stateLine: 'still here', lastVerdict: 'quiet' }]]),
    pendingDecisions: () => { throw new Error('ledger unreadable'); },
  };
  const rows = [{ id: 'a' }];
  attachStateLines(rows, { watcher: partial });
  assert.equal(rows[0].stateLine, 'still here');
  assert.equal(rows[0].pendingDecision, undefined);
});
