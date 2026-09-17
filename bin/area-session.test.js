'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const areaSession = require('./area-session.js');
const agents = require('./agents.js');
const incidents = require('./incidents.js');

const MINUTE = 60e3;
const NOW = 1_700_000_000_000;

function makeRoot(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-area-'));
  for (const directory of ['tasks', 'archive', 'digests', 'watch']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  // The area's project basename is the worktree's repo, so it has to be a real
  // path ending in the repo name.
  const project = path.join(root, 'checkouts', 'castle-sandboxes');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(root, 'watch', 'incidents.json'), JSON.stringify({
    areas: {
      sandboxes: {
        project, match: ['^Sandbox '], session: options.session !== false,
        account: 'claude-secondary',
        ...(options.restartAfterIdleMin ? { restartAfterIdleMin: options.restartAfterIdleMin } : {}),
      },
      'app-server': { project: path.join(root, 'checkouts', 'ghost-server'), default: true },
    },
    quietMin: 60, reopenHours: 24,
  }));
  // A worktree that `wt new` has already finished with, so no tick has to build one.
  const worktree = path.join(root, 'wt', 'castle-sandboxes', 'responder');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: nowhere\n');
  fs.writeFileSync(path.join(worktree, '.wt.json'), '{}\n');
  return { root, project, worktree };
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

function livePane(id = 'pane-1', sessionId = 'sess-1', name = 'sandboxes') {
  return { id, alive: true, agentAlive: true, meta: { sessionId, agentName: name, agent: 'claude' } };
}

function idleSession(id = 'sess-1', pane = 'pane-1') {
  return { id, kind: 'claude', pane, endedTurn: true, state: 'idle', mtime: NOW - 10 * MINUTE };
}

// Every seam the tick reaches the world through. Nothing here spawns a process,
// opens a pane, or types into a terminal.
function makeDeps(fixture, state = {}) {
  const calls = {
    wt: [], opens: [], sends: [], closes: [], targets: [], notes: [],
  };
  const deps = {
    calls,
    worktreePath: (repo, name) => path.join(fixture.root, 'wt', repo, name),
    worktreeReady: () => state.worktreeReady !== false,
    insideWorktreeRoot: () => state.insideWorktreeRoot !== false,
    runWt: async (args) => {
      calls.wt.push(args);
      return { ok: true, stdout: `${fixture.worktree}\n`, error: '' };
    },
    openSession: async (body, openDeps) => {
      calls.opens.push({ body, openDeps });
      if (state.openError) throw state.openError;
      return { sessionId: state.newSessionId || 'sess-1', pane: state.newPane || 'pane-1' };
    },
    listPanes: async () => state.panes || [],
    scanSessions: () => state.sessions || [],
    resolveSessionTarget: async (session) => {
      calls.targets.push(session.id);
      if (state.targetError) throw state.targetError;
      return { pane: session.pane || 'pane-1' };
    },
    sendToResolvedTarget: async (session, target, text, opts) => {
      calls.sends.push({ session: session.id, pane: target.pane, text, opts });
      if (state.sendError) throw state.sendError;
      return {};
    },
    withInjectionLock: (fn) => fn(),
    closeIdleSession: async (body) => {
      calls.closes.push(body);
      if (state.closeError) throw state.closeError;
      return { ok: true };
    },
    deliveryStatus: () => state.receipt || null,
    openIncidents: () => state.open || [],
    write: (line) => { calls.notes.push(String(line)); },
  };
  return deps;
}

function tick(fixture, deps, options = {}) {
  return areaSession.tick({ root: fixture.root, area: 'sandboxes', now: NOW, ...options }, deps);
}

function sandboxes(result) {
  return result.areas.find((row) => row.area === 'sandboxes');
}

// ---------- launch ----------

test('the first tick installs the recipe, creates the record, and opens exactly one session', async () => {
  const fixture = makeRoot();
  try {
    const state = { panes: [], sessions: [] };
    const deps = makeDeps(fixture, state);
    const first = sandboxes(await tick(fixture, deps));

    assert.equal(first.record, 'created');
    assert.equal(first.recipe.state, 'copied');
    assert.equal(fs.existsSync(path.join(fixture.root, 'agents', 'sandboxes.md')), true);
    assert.equal(first.launch.state, 'launched');
    assert.equal(deps.calls.opens.length, 1);

    const [{ body, openDeps }] = deps.calls.opens;
    assert.equal(body.fresh, true);
    assert.equal(body.cwd, fixture.worktree);
    assert.equal(body.agent, 'claude');
    assert.equal(body.accountId, 'claude-secondary');
    assert.equal(body.model, 'fable');
    // The session's own name goes on the pane as `agentName`; `meta.agent` is the
    // provider everywhere in the daemon and must not be overloaded.
    assert.deepEqual(openDeps.launchMeta, { agentName: 'sandboxes' });
    assert.deepEqual(openDeps.launchEnv, { KEEP_AGENT: 'sandboxes' });
    // The bootstrap is the four reads, in order.
    for (const fragment of ['agents/sandboxes.md', '.keep/agents/sandboxes/notes.md',
      'keep incidents', 'keep agents events sandboxes --unseen']) {
      assert.ok(body.message.includes(fragment), `the bootstrap names ${fragment}`);
    }
    assert.ok(body.message.length <= 2000, 'the bootstrap fits an opening message');

    const record = agents.readRecord('sandboxes', fixture.root);
    assert.equal(record.session.id, 'sess-1');
    assert.equal(record.session.pane, 'pane-1');
    assert.equal(record.session.startedAt, NOW);
    assert.equal(record.role, 'incident-responder');
    assert.equal(record.model, 'fable');
    assert.equal(record.cwd, fixture.worktree);
    assert.equal(record.area, 'sandboxes');

    // A launch tick delivers nothing and closes nothing: the session has a
    // bootstrap to read, and `--unseen` is how it finds what is waiting.
    assert.equal(first.delivery.state, 'skipped');
    assert.equal(first.restart.state, 'not-due');

    // Second tick, session now live: no second session, ever.
    state.panes = [livePane()];
    state.sessions = [idleSession()];
    const second = sandboxes(await tick(fixture, deps));
    assert.equal(second.launch.state, 'live');
    assert.equal(deps.calls.opens.length, 1, 'no second session while one is live');
    assert.equal(second.record, 'present');
  } finally { cleanup(fixture.root); }
});

test('a pane that reads dead waits out the grace window before another launch', async () => {
  const fixture = makeRoot();
  try {
    const state = { panes: [], sessions: [] };
    const deps = makeDeps(fixture, state);
    await tick(fixture, deps);
    assert.equal(deps.calls.opens.length, 1);

    // The host answers, and nothing in its list is ours. That is one dead
    // observation, not a reason to relaunch: an in-place restart looks the same.
    state.panes = [{ id: 'pane-other', alive: true, agentAlive: true, meta: { sessionId: 'someone-else' } }];
    const noticed = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(noticed.launch.state, 'waiting');
    assert.equal(deps.calls.opens.length, 1);
    assert.equal(agents.readRecord('sandboxes', fixture.root).launch.deadSince, NOW + MINUTE);

    // Still inside the window.
    const still = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE + areaSession.PANE_DEAD_GRACE_MS - 1 }));
    assert.equal(still.launch.state, 'waiting');
    assert.equal(deps.calls.opens.length, 1);

    // Past it, and the launch retry window with it.
    const past = NOW + MINUTE + areaSession.PANE_DEAD_GRACE_MS + areaSession.LAUNCH_RETRY_MS;
    const relaunched = sandboxes(await tick(fixture, deps, { now: past }));
    assert.equal(relaunched.launch.state, 'launched');
    assert.equal(deps.calls.opens.length, 2);
    assert.equal(agents.readRecord('sandboxes', fixture.root).session.startedAt, past);
  } finally { cleanup(fixture.root); }
});

test('a host that lists no panes at all is never read as a dead session', async () => {
  const fixture = makeRoot();
  try {
    const state = { panes: [], sessions: [] };
    const deps = makeDeps(fixture, state);
    await tick(fixture, deps);
    assert.equal(deps.calls.opens.length, 1);
    // An unreachable or still-starting host: an empty list has told us nothing
    // about the session the record says is running.
    state.panes = [];
    const blind = sandboxes(await tick(fixture, deps, { now: NOW + areaSession.PANE_DEAD_GRACE_MS * 3 }));
    assert.equal(blind.launch.state, 'skipped');
    assert.match(blind.launch.reason, /listed no panes/);
    assert.equal(deps.calls.opens.length, 1);
    assert.equal(agents.readRecord('sandboxes', fixture.root).launch.deadSince, 0);
  } finally { cleanup(fixture.root); }
});

test('three launches that never come up stop, and a live session clears the count', async () => {
  const fixture = makeRoot();
  try {
    // The host always answers and nothing in its list is ever ours, so every one
    // of these launches is a launch that never came up.
    const other = { id: 'pane-other', alive: true, agentAlive: true, meta: { sessionId: 'somebody-else' } };
    const state = { panes: [other], sessions: [] };
    const deps = makeDeps(fixture, state);
    let at = NOW;
    for (let attempt = 1; attempt <= areaSession.MAX_LAUNCH_ATTEMPTS; attempt += 1) {
      state.newSessionId = `sess-${attempt}`;
      state.newPane = `pane-${attempt}`;
      const opened = sandboxes(await tick(fixture, deps, { now: at }));
      assert.equal(opened.launch.state, 'launched', `attempt ${attempt} launched`);
      // One dead observation, then past both the grace and the retry window.
      await tick(fixture, deps, { now: at + MINUTE });
      at += areaSession.LAUNCH_RETRY_MS + MINUTE;
    }
    assert.equal(deps.calls.opens.length, areaSession.MAX_LAUNCH_ATTEMPTS);
    const capped = sandboxes(await tick(fixture, deps, { now: at }));
    assert.equal(capped.launch.state, 'skipped');
    assert.match(capped.launch.reason, /produced no live session/);
    assert.equal(deps.calls.opens.length, areaSession.MAX_LAUNCH_ATTEMPTS);

    // One live observation and the cap is gone: it exists for launches that do
    // not come up, not for a session that has been running for a week.
    state.panes = [livePane('pane-3', 'sess-3')];
    state.sessions = [idleSession('sess-3', 'pane-3')];
    const live = sandboxes(await tick(fixture, deps, { now: at + MINUTE }));
    assert.equal(live.launch.state, 'live');
    assert.equal(agents.readRecord('sandboxes', fixture.root).launch.attempts, 0);
  } finally { cleanup(fixture.root); }
});

test('a live pane stamped with the agent name is adopted rather than doubled', async () => {
  const fixture = makeRoot();
  try {
    const state = {
      // A launch whose response was lost: the pane is up and says whose it is,
      // and the record never heard the session id.
      panes: [livePane('pane-9', 'sess-9')],
      sessions: [idleSession('sess-9', 'pane-9')],
    };
    const deps = makeDeps(fixture, state);
    agents.ensure('sandboxes', { role: 'incident-responder', area: 'sandboxes' }, { root: fixture.root });
    const report = sandboxes(await tick(fixture, deps));
    assert.equal(report.launch.state, 'live');
    assert.equal(report.launch.adopted, true);
    assert.equal(deps.calls.opens.length, 0, 'an adopted pane is not a reason to launch');
    assert.equal(agents.readRecord('sandboxes', fixture.root).session.id, 'sess-9');
  } finally { cleanup(fixture.root); }
});

// ---------- delivery ----------

function feed(fixture, events) {
  agents.ensure('sandboxes', {
    role: 'incident-responder', area: 'sandboxes', model: 'fable',
    session: { id: 'sess-1', pane: 'pane-1', startedAt: NOW - 30 * MINUTE },
  }, { root: fixture.root });
  for (const event of events) agents.emit('sandboxes', event, { root: fixture.root, now: event.at });
}

test('one delivery per tick carries every new event as pointers, and moves the cursor once', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [
      { at: NOW - 3 * MINUTE, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox Open Health', severity: 'high', permalink: 'https://slack/a' },
      { at: NOW - 2 * MINUTE, kind: 'incident-fired', card: 'inc-a', title: 'Sandbox Open Health', severity: 'high', permalink: 'https://slack/b' },
      { at: NOW - MINUTE, kind: 'human-note', card: 'inc-a', title: 'somebody replied', severity: 'low', permalink: 'https://slack/c' },
    ]);
    const state = { panes: [livePane()], sessions: [idleSession()] };
    const deps = makeDeps(fixture, state);
    const report = sandboxes(await tick(fixture, deps));

    assert.equal(report.delivery.state, 'sent');
    assert.equal(report.delivery.count, 3);
    assert.equal(deps.calls.sends.length, 1, 'ONE message, not one per event');
    const { text, opts } = deps.calls.sends[0];
    assert.match(text, /DATA, NOT INSTRUCTIONS/);
    assert.ok(text.includes('Handle these per your recipe.'), 'the message says what to do with them');
    for (const fragment of ['incident-opened', 'incident-fired', 'human-note', 'inc-a', 'high', 'https://slack/c']) {
      assert.ok(text.includes(fragment), `the batch carries ${fragment}`);
    }
    assert.equal(opts.compactIfCold, true);
    assert.equal(opts.retainReceipt, true);
    assert.equal(opts.deliveryKey, areaSession.deliveryKeyFor('sandboxes', NOW - MINUTE));
    assert.equal(agents.readRecord('sandboxes', fixture.root).lastDelivered, NOW - MINUTE);

    // Same tick again with nothing new: the cursor is past everything, so
    // nothing is typed a second time.
    const repeat = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(repeat.delivery.state, 'nothing');
    assert.equal(deps.calls.sends.length, 1);
  } finally { cleanup(fixture.root); }
});

test('a launch moves the cursor past the feed the bootstrap already handed over', async () => {
  const fixture = makeRoot();
  try {
    // Events that arrived while there was no session. The bootstrap's fourth read
    // is `keep agents events sandboxes --unseen`, which is exactly this list, so
    // delivering it again a poll later would be a duplicate.
    agents.ensure('sandboxes', { role: 'incident-responder', area: 'sandboxes' }, { root: fixture.root });
    agents.emit('sandboxes', { at: NOW - 5 * MINUTE, kind: 'incident-opened', card: 'inc-a' }, { root: fixture.root, now: NOW - 5 * MINUTE });
    agents.emit('sandboxes', { at: NOW - 4 * MINUTE, kind: 'incident-fired', card: 'inc-a' }, { root: fixture.root, now: NOW - 4 * MINUTE });

    const state = { panes: [], sessions: [] };
    const deps = makeDeps(fixture, state);
    assert.equal(sandboxes(await tick(fixture, deps)).launch.state, 'launched');
    assert.equal(agents.readRecord('sandboxes', fixture.root).lastDelivered, NOW - 4 * MINUTE);

    state.panes = [livePane()];
    state.sessions = [idleSession()];
    const next = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(next.delivery.state, 'nothing');
    assert.equal(deps.calls.sends.length, 0);

    // Something genuinely new still gets delivered.
    agents.emit('sandboxes', { at: NOW + 2 * MINUTE, kind: 'human-note', card: 'inc-a' }, { root: fixture.root, now: NOW + 2 * MINUTE });
    const fresh = sandboxes(await tick(fixture, deps, { now: NOW + 3 * MINUTE }));
    assert.equal(fresh.delivery.state, 'sent');
    assert.equal(fresh.delivery.count, 1);
  } finally { cleanup(fixture.root); }
});

test('a mid-turn session is not interrupted and its cursor does not move', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [{ at: NOW - MINUTE, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox Open Health', severity: 'high' }]);
    const state = {
      panes: [livePane()],
      sessions: [{ ...idleSession(), endedTurn: false, state: 'running' }],
    };
    const deps = makeDeps(fixture, state);
    const busy = sandboxes(await tick(fixture, deps));
    assert.equal(busy.delivery.state, 'deferred');
    assert.match(busy.delivery.reason, /mid-turn/);
    assert.equal(deps.calls.sends.length, 0);
    assert.equal(Number(agents.readRecord('sandboxes', fixture.root).lastDelivered || 0), 0, 'the cursor is untouched');

    // A question on screen is Owner's turn, not ours.
    state.sessions = [{ ...idleSession(), pendingQuestion: { text: 'which host?' } }];
    const asked = sandboxes(await tick(fixture, deps));
    assert.equal(asked.delivery.state, 'deferred');
    assert.match(asked.delivery.reason, /waiting on Owner/);
    assert.equal(deps.calls.sends.length, 0);

    // The turn ends and the same batch goes out, once.
    state.sessions = [idleSession()];
    const sent = sandboxes(await tick(fixture, deps));
    assert.equal(sent.delivery.state, 'sent');
    assert.equal(deps.calls.sends.length, 1);
    assert.equal(agents.readRecord('sandboxes', fixture.root).lastDelivered, NOW - MINUTE);
  } finally { cleanup(fixture.root); }
});

test('a batch whose receipt says it already arrived advances the cursor without typing', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [{ at: NOW - MINUTE, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox Open Health', severity: 'high' }]);
    const state = {
      panes: [livePane()], sessions: [idleSession()],
      receipt: { sessionId: 'sess-1', kind: 'claude', received: true },
    };
    const deps = makeDeps(fixture, state);
    const report = sandboxes(await tick(fixture, deps));
    assert.equal(report.delivery.state, 'sent');
    assert.equal(report.delivery.delivery, 'received');
    assert.equal(deps.calls.sends.length, 0, 'the receipt is the delivery');
    assert.equal(agents.readRecord('sandboxes', fixture.root).lastDelivered, NOW - MINUTE);

    // An unconfirmed prior send is the opposite: wait for that one rather than
    // typing the same batch twice.
    state.receipt = { sessionId: 'sess-1', kind: 'claude', received: false, pending: true };
    agents.writeRecord('sandboxes', { lastDelivered: 0 }, { root: fixture.root });
    const unconfirmed = sandboxes(await tick(fixture, deps));
    assert.equal(unconfirmed.delivery.state, 'deferred');
    assert.match(unconfirmed.delivery.reason, /unconfirmed/);
    assert.equal(deps.calls.sends.length, 0);
    assert.equal(agents.readRecord('sandboxes', fixture.root).lastDelivered, 0);
  } finally { cleanup(fixture.root); }
});

test('a send that throws leaves the cursor for the next tick', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [{ at: NOW - MINUTE, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox Open Health' }]);
    const state = {
      panes: [livePane()], sessions: [idleSession()],
      sendError: new Error('pane is busy typing'),
    };
    const deps = makeDeps(fixture, state);
    const failed = sandboxes(await tick(fixture, deps));
    assert.equal(failed.delivery.state, 'deferred');
    assert.match(failed.delivery.reason, /busy typing/);
    assert.equal(Number(agents.readRecord('sandboxes', fixture.root).lastDelivered || 0), 0);

    state.sendError = null;
    const retried = sandboxes(await tick(fixture, deps));
    assert.equal(retried.delivery.state, 'sent');
    assert.equal(agents.readRecord('sandboxes', fixture.root).lastDelivered, NOW - MINUTE);
  } finally { cleanup(fixture.root); }
});

test('a batch bigger than one message is capped, and the rest waits for the next tick', async () => {
  const fixture = makeRoot();
  try {
    const events = [];
    for (let i = 0; i < areaSession.DELIVERY_EVENT_MAX + 5; i += 1) {
      events.push({ at: NOW - (30 - i) * MINUTE, kind: 'incident-fired', card: `inc-${i}`, title: `Sandbox ${i}` });
    }
    feed(fixture, events);
    const state = { panes: [livePane()], sessions: [idleSession()] };
    const deps = makeDeps(fixture, state);
    const first = sandboxes(await tick(fixture, deps));
    assert.equal(first.delivery.count, areaSession.DELIVERY_EVENT_MAX);
    assert.equal(first.delivery.waiting, 5);
    assert.match(deps.calls.sends[0].text, /5 more events are queued/);
    const second = sandboxes(await tick(fixture, deps));
    assert.equal(second.delivery.count, 5);
    assert.equal(deps.calls.sends.length, 2);
  } finally { cleanup(fixture.root); }
});

// ---------- restart from the log ----------

function idleForHours(fixture, hours = 3) {
  agents.ensure('sandboxes', {
    role: 'incident-responder', area: 'sandboxes',
    session: { id: 'sess-1', pane: 'pane-1', startedAt: NOW - hours * 60 * MINUTE },
  }, { root: fixture.root });
}

test('an idle session with nothing open is closed gracefully, and the next tick opens a fresh one', async () => {
  const fixture = makeRoot();
  try {
    idleForHours(fixture, 3);
    const state = { panes: [livePane()], sessions: [idleSession()], open: [] };
    const deps = makeDeps(fixture, state);
    const closed = sandboxes(await tick(fixture, deps));
    assert.equal(closed.restart.state, 'closed');
    assert.deepEqual(deps.calls.closes, [{ sessionId: 'sess-1', pane: 'pane-1' }]);
    const record = agents.readRecord('sandboxes', fixture.root);
    assert.equal(record.session.id, '', 'the record drops the session it closed');
    assert.equal(record.lifecycle, 'idle');

    // Nothing is lost: the next tick launches fresh from the bootstrap.
    state.panes = [];
    state.sessions = [];
    const relaunched = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(relaunched.launch.state, 'launched');
    assert.equal(deps.calls.opens.length, 1);
  } finally { cleanup(fixture.root); }
});

test('an open incident in the area is never restarted out from under', async () => {
  const fixture = makeRoot();
  try {
    idleForHours(fixture, 9);
    const state = {
      panes: [livePane()], sessions: [idleSession()],
      open: [{ signature: 'grafana:sandbox-open-health', card: 'inc-a', area: 'sandboxes', title: 'Sandbox Open Health' }],
    };
    const deps = makeDeps(fixture, state);
    const held = sandboxes(await tick(fixture, deps));
    assert.equal(held.restart.state, 'not-due');
    assert.match(held.restart.reason, /open incident/);
    assert.equal(deps.calls.closes.length, 0);

    // Another area's incident is not this area's reason to stay up.
    state.open = [{ signature: 'grafana:server-faults', card: 'inc-b', area: 'app-server', title: 'Server Faults' }];
    const released = sandboxes(await tick(fixture, deps));
    assert.equal(released.restart.state, 'closed');
    assert.equal(deps.calls.closes.length, 1);
  } finally { cleanup(fixture.root); }
});

test('a session is not restarted before its idle window, mid-turn, or with events waiting', async () => {
  const fixture = makeRoot();
  try {
    idleForHours(fixture, 1);
    const state = { panes: [livePane()], sessions: [idleSession()], open: [] };
    const deps = makeDeps(fixture, state);
    const early = sandboxes(await tick(fixture, deps));
    assert.equal(early.restart.state, 'not-due');
    assert.match(early.restart.reason, /idle for 60m of 120m/);
    assert.equal(deps.calls.closes.length, 0);

    // Past the window, but mid-turn.
    agents.writeRecord('sandboxes', { session: { startedAt: NOW - 5 * 60 * MINUTE } }, { root: fixture.root });
    state.sessions = [{ ...idleSession(), endedTurn: false }];
    const busy = sandboxes(await tick(fixture, deps));
    assert.equal(busy.restart.state, 'not-due');
    assert.match(busy.restart.reason, /mid-turn/);
    assert.equal(deps.calls.closes.length, 0);

    // Idle again, but a batch is still undelivered.
    state.sessions = [idleSession()];
    state.sendError = new Error('pane is busy typing');
    agents.emit('sandboxes', { at: NOW - MINUTE, kind: 'incident-opened', card: 'inc-a' }, { root: fixture.root, now: NOW - MINUTE });
    const pending = sandboxes(await tick(fixture, deps));
    assert.equal(pending.delivery.state, 'deferred');
    assert.equal(pending.restart.state, 'not-due');
    assert.match(pending.restart.reason, /undelivered/);
    assert.equal(deps.calls.closes.length, 0);
  } finally { cleanup(fixture.root); }
});

test('a refused close is final for the tick and leaves the session running', async () => {
  const fixture = makeRoot();
  try {
    idleForHours(fixture, 3);
    const state = {
      panes: [livePane()], sessions: [idleSession()], open: [],
      closeError: new Error('Pane has recent or unknown output activity'),
    };
    const deps = makeDeps(fixture, state);
    const refused = sandboxes(await tick(fixture, deps));
    assert.equal(refused.restart.state, 'refused');
    assert.match(refused.restart.reason, /recent or unknown output/);
    assert.equal(deps.calls.closes.length, 1, 'refused once, not retried inside the tick');
    const record = agents.readRecord('sandboxes', fixture.root);
    assert.equal(record.session.id, 'sess-1', 'the session it could not close is still its session');
    assert.equal(deps.calls.opens.length, 0, 'and no replacement is opened for it');
  } finally { cleanup(fixture.root); }
});

test('restartAfterIdleMin is read off the area', async () => {
  const fixture = makeRoot({ restartAfterIdleMin: 30 });
  try {
    assert.equal(incidents.config(fixture.root).areas.sandboxes.restartAfterIdleMin, 30);
    idleForHours(fixture, 1);
    const deps = makeDeps(fixture, { panes: [livePane()], sessions: [idleSession()], open: [] });
    assert.equal(sandboxes(await tick(fixture, deps)).restart.state, 'closed');
  } finally { cleanup(fixture.root); }
});

test('config defaults the account and the idle window, and leaves session off', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-area-cfg-'));
  try {
    fs.mkdirSync(path.join(root, 'watch'), { recursive: true });
    fs.writeFileSync(path.join(root, 'watch', 'incidents.json'), JSON.stringify({
      areas: { sandboxes: { project: '/tmp/castle-sandboxes' } },
    }));
    const area = incidents.config(root).areas.sandboxes;
    assert.equal(area.session, false);
    assert.equal(area.account, 'claude-secondary');
    assert.equal(area.restartAfterIdleMin, 120);
    assert.equal(area.agent, 'sandboxes');
  } finally { cleanup(root); }
});

// ---------- the switch, the recipe, and dry runs ----------

test('an area whose session is off gets no tick at all', async () => {
  const fixture = makeRoot({ session: false });
  try {
    const deps = makeDeps(fixture, { panes: [], sessions: [] });
    const result = await areaSession.tick({ root: fixture.root, now: NOW }, deps);
    assert.equal(result.areas.length, 2, 'every configured area is reported');
    for (const row of result.areas) assert.match(row.skipped, /not enabled/);
    assert.equal(deps.calls.opens.length, 0);
    assert.equal(agents.readRecord('sandboxes', fixture.root), null, 'and no record is invented for it');
  } finally { cleanup(fixture.root); }
});

test('--dry reports what it would do and performs nothing', async () => {
  const fixture = makeRoot();
  try {
    const deps = makeDeps(fixture, { panes: [], sessions: [] });
    const report = sandboxes(await tick(fixture, deps, { dry: true, force: true }));
    assert.equal(report.dry, true);
    assert.equal(report.record, 'would-create');
    assert.equal(report.recipe.state, 'would-copy');
    assert.equal(report.launch.state, 'would-launch');
    assert.equal(report.launch.cwd, fixture.worktree);
    assert.equal(deps.calls.opens.length, 0);
    assert.equal(deps.calls.wt.length, 0);
    assert.equal(deps.calls.sends.length, 0);
    assert.equal(deps.calls.closes.length, 0);
    assert.equal(agents.readRecord('sandboxes', fixture.root), null, 'no record');
    assert.equal(fs.existsSync(path.join(fixture.root, 'agents', 'sandboxes.md')), false, 'no recipe');
    assert.ok(areaSession.describe(report).join('\n').includes('would-launch'));

    // A dry run over a live, idle, quiet session says what it would close, and
    // does not close it.
    idleForHours(fixture, 3);
    const live = makeDeps(fixture, { panes: [livePane()], sessions: [idleSession()], open: [] });
    const quiet = sandboxes(await tick(fixture, live, { dry: true, force: true }));
    assert.equal(quiet.restart.state, 'would-close');
    assert.equal(live.calls.closes.length, 0);
  } finally { cleanup(fixture.root); }
});

test('the recipe is installed only when the registry has none', async () => {
  const fixture = makeRoot();
  try {
    const deps = makeDeps(fixture, { panes: [livePane()], sessions: [idleSession()] });
    agents.ensure('sandboxes', { area: 'sandboxes', session: { id: 'sess-1', pane: 'pane-1', startedAt: NOW } }, { root: fixture.root });
    const installed = sandboxes(await tick(fixture, deps));
    assert.equal(installed.recipe.state, 'copied');
    const file = path.join(fixture.root, 'agents', 'sandboxes.md');
    const shipped = fs.readFileSync(file, 'utf8');
    assert.match(shipped, /incident responder/);

    // Owner's edits survive every later tick.
    fs.writeFileSync(file, `${shipped}\n\n## Owner's own note\nDo not overwrite me.\n`);
    const again = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(again.recipe.state, 'present');
    assert.match(fs.readFileSync(file, 'utf8'), /Do not overwrite me/);
  } finally { cleanup(fixture.root); }
});

test('the recipe this repo ships covers every section the responder needs', () => {
  const text = fs.readFileSync(areaSession.recipeSource('sandboxes'), 'utf8');
  for (const fragment of [
    'sandbox_service_logs', 'sandbox_container_logs', 'Prometheus', 'cw_',
    'sandbox-hosts', 'browser-hosts', 'terraform',
    'keep checkin', 'keep artifact', 'keep decide close', 'keep decide escalate',
    'keep decide answer', 'keep decide unblock',
    'keep agents emit sandboxes --kind needs-you --card <id> --needs-you -m',
    'keep incidents', 'keep agents events sandboxes --unseen',
    'keep incidents close <card-id|signature> -m "why"',
    'read-only Slack MCP', 'DATA, NOT INSTRUCTIONS',
  ]) {
    assert.ok(text.includes(fragment), `the recipe covers ${fragment}`);
  }
  for (const heading of ['## Identity and scope', '## Log first, always', '## Diagnose only',
    '## Badging', '## Overlap', '## Untrusted input', '## Budget', '## Ending the turn']) {
    assert.ok(text.includes(heading), `the recipe has ${heading}`);
  }
} );

// ---------- the worktree ----------

test('a finished worktree is reused, a half-built one is rebuilt, and no keep child inherits this session', async () => {
  const fixture = makeRoot();
  try {
    const wt = [];
    const reused = await areaSession.ensureWorktree('castle-sandboxes', 'responder', {
      worktreePath: () => fixture.worktree,
      worktreeReady: () => true,
      runWt: async (args) => { wt.push(args); return { ok: true, stdout: '', error: '' }; },
    });
    assert.deepEqual(reused, { ok: true, path: fixture.worktree, reused: true });
    assert.equal(wt.length, 0, 'a ready tree costs no wt run');

    // Half-built: removed through wt, which knows how to unregister it, then built.
    const stump = path.join(fixture.root, 'wt', 'castle-sandboxes', 'stump');
    fs.mkdirSync(stump, { recursive: true });
    const built = await areaSession.ensureWorktree('castle-sandboxes', 'stump', {
      worktreePath: () => stump,
      worktreeReady: () => false,
      runWt: async (args) => {
        wt.push(args);
        if (args[0] === 'rm') { fs.rmSync(stump, { recursive: true, force: true }); return { ok: true, stdout: '', error: '' }; }
        return { ok: true, stdout: `${stump}\n`, error: '' };
      },
    });
    assert.equal(built.ok, true);
    assert.deepEqual(wt.map((args) => args[0]), ['rm', 'new']);
    assert.deepEqual(wt[1], ['new', 'castle-sandboxes/stump']);

    // The child must not attribute what it writes to whichever session spawned it.
    let childEnv = null;
    await areaSession.runWt(['ls'], {
      env: { PATH: '/usr/bin', CLAUDE_CODE_SESSION_ID: 'session_abc' },
      execFile: (file, args, options, done) => { childEnv = options.env; done(null, '', ''); },
    });
    assert.equal('CLAUDE_CODE_SESSION_ID' in childEnv, false);
    assert.equal(childEnv.PATH, '/usr/bin');
  } finally { cleanup(fixture.root); }
});

test('an area with no project, or a worktree outside the worktree root, launches nothing', async () => {
  const fixture = makeRoot();
  try {
    const deps = makeDeps(fixture, { panes: [], sessions: [] });
    const noProject = sandboxes(await areaSession.tick({ root: fixture.root, now: NOW, area: 'sandboxes',
      config: { areas: { sandboxes: { session: true, project: '', match: [], agent: 'sandboxes' } } } }, deps));
    assert.equal(noProject.launch.state, 'skipped');
    assert.match(noProject.launch.reason, /no project/);
    assert.equal(deps.calls.opens.length, 0);

    // The last gate before an unattended session starts: a responder only ever
    // runs in a worktree, never in a main checkout.
    const outside = makeDeps(fixture, { panes: [], sessions: [], insideWorktreeRoot: false });
    const refused = sandboxes(await tick(fixture, outside));
    assert.equal(refused.launch.state, 'failed');
    assert.match(refused.launch.reason, /worktree root/);
    assert.equal(outside.calls.opens.length, 0);
  } finally { cleanup(fixture.root); }
});

test('a launch that threw after its pane came up still counts as launched', async () => {
  const fixture = makeRoot();
  try {
    const error = new Error('could not confirm the session id');
    error.extra = { launch: { pane: 'pane-7', sessionId: 'sess-7' } };
    const deps = makeDeps(fixture, { panes: [], sessions: [], openError: error });
    const report = sandboxes(await tick(fixture, deps));
    assert.equal(report.launch.state, 'launched');
    assert.equal(report.launch.pane, 'pane-7');
    assert.match(report.launch.unconfirmed, /could not confirm/);
    const record = agents.readRecord('sandboxes', fixture.root);
    assert.equal(record.session.id, 'sess-7', 'a pane means a session IS running');
    assert.equal(record.session.pane, 'pane-7');
  } finally { cleanup(fixture.root); }
});

test('a tick never throws into the poll, whatever a dep does', async () => {
  const fixture = makeRoot();
  try {
    const deps = makeDeps(fixture, { panes: [], sessions: [] });
    deps.listPanes = () => { throw new Error('the terminal host is gone'); };
    const result = await areaSession.tickQuietly({ root: fixture.root, area: 'sandboxes', now: NOW }, deps);
    assert.ok(result.areas.length === 1);
    // A thrown listPanes reads as "could not tell", which is the safe answer.
    assert.equal(sandboxes(result).launch.state, 'launched');

    const broken = makeDeps(fixture, { panes: [], sessions: [] });
    broken.openSession = () => { throw new Error('boom'); };
    const second = await areaSession.tickQuietly({ root: fixture.root, area: 'sandboxes', now: NOW + MINUTE }, broken);
    assert.ok(second.areas.length === 1);

    const missing = await areaSession.tickQuietly({ root: fixture.root, area: 'nowhere', now: NOW }, deps);
    assert.match(missing.areas[0].error, /no area nowhere/);
  } finally { cleanup(fixture.root); }
});
