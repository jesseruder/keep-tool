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
const HOUR = 60 * MINUTE;
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
        ...(options.sandboxesAgent ? { agent: options.sandboxesAgent } : {}),
      },
      'app-server': {
        project: path.join(root, 'checkouts', 'ghost-server'), default: true,
        ...(options.appServer || {}),
      },
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

function livePane(id = 'pane-1', sessionId = 'sess-1', extra = {}) {
  return {
    id, alive: true, agentAlive: true, attached: 0,
    meta: { sessionId, agentName: 'sandboxes', agent: 'claude' },
    lastOutputAt: NOW - 4 * HOUR, lastInputAt: NOW - 4 * HOUR,
    ...extra,
  };
}

// A session whose turn ended. `mtime` is real activity, so it is explicit: idle
// is measured from it, and a default of "just now" would hide the restart tests.
function idleSession(id = 'sess-1', pane = 'pane-1', mtime = NOW - 4 * HOUR) {
  return { id, kind: 'claude', pane, endedTurn: true, state: 'idle', mtime };
}

// Every seam the tick reaches the world through. Nothing here spawns a process,
// opens a pane, or types into a terminal.
function makeDeps(fixture, state = {}) {
  const calls = { wt: [], opens: [], sends: [], types: [], closes: [], targets: [], notes: [], flushes: 0, writes: [] };
  // The transport's own delivery journal, modelled: `delivery.deliver` writes one
  // before it types and finishes it on a confirmation, so a retry of an
  // unconfirmed send submits the draft it still recognises instead of retyping,
  // while a retry after a confirmed send has nothing left to recover from.
  const journal = new Set();
  // And the session's transcript: a message lands in it when the session accepts
  // it, which is exactly what a confirmed send means. It is the witness a retry
  // consults when the journal has nothing left.
  const transcript = new Set();
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
      if (state.openGate) await state.openGate;
      if (state.openError) throw state.openError;
      return { sessionId: state.newSessionId || 'sess-1', pane: state.newPane || 'pane-1' };
    },
    // `null` is a host that could not be asked; `[]` is a host that answered and
    // has no panes. serve.js's listHostPanes draws exactly that distinction.
    listPanes: async () => (state.panes === undefined ? [] : state.panes),
    scanSessions: () => state.sessions || [],
    resolveSessionTarget: async (session) => {
      calls.targets.push(session.id);
      if (state.targetError) throw state.targetError;
      return { pane: session.pane || 'pane-1' };
    },
    sendToResolvedTarget: async (session, target, text, opts) => {
      calls.sends.push({ session: session.id, pane: target.pane, text, opts });
      if (opts && opts.beforeType) await opts.beforeType();
      if (state.onSend) await state.onSend(text, opts);
      if (journal.has(text)) {
        // Its own draft, still in the box: submitted, not retyped.
        journal.delete(text);
        transcript.add(text);
        return { ok: true, delivery: 'received', recovered: true };
      }
      if (state.sendError) { journal.add(text); calls.types.push(text); throw state.sendError; }
      calls.types.push(text);
      if (state.sendResult) {
        // `assumed-delivered` is what the transport returns when it GIVES UP on an
        // expired journal, which it finishes on the way out — so there is nothing
        // left to recover from afterwards. A truncated send is the opposite: the
        // draft is still in the box and its journal is still there.
        if (state.sendResult.truncated) journal.add(text);
        else journal.delete(text);
        return state.sendResult;
      }
      // What delivery.js reports for a transcript-confirmed send: its journal is
      // finished, so there is nothing to recover from afterwards — the session's
      // own transcript is what remembers it.
      transcript.add(text);
      return { ok: true, delivery: 'received' };
    },
    // Wired by default, because the daemon and the CLI both wire it: a tick that
    // cannot ask this cannot retry safely, and defers.
    transcriptShows: (session, text) => transcript.has(text),
    withInjectionLock: (fn) => fn(),
    closeIdleSession: async (body, closeDeps) => {
      calls.closes.push({ body, closeDeps });
      if (state.closeError) throw state.closeError;
      return { ok: true };
    },
    deliveryStatus: (text, key) => (state.receiptFor ? state.receiptFor(text, key) : state.receipt || null),
    openIncidents: () => state.open || [],
    flushCommits: () => { calls.flushes += 1; return false; },
    writeRecord: (name, patch, options) => {
      calls.writes.push(patch);
      if (state.writeError && state.writeError(patch)) throw state.writeError(patch);
      return agents.writeRecord(name, patch, options);
    },
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

function record(fixture, name = 'sandboxes') {
  return agents.readRecord(name, fixture.root);
}

function cursor(fixture, name = 'sandboxes') {
  const found = record(fixture, name);
  return found ? Number(found.lastDeliveredSeq || 0) : 0;
}

// Events land on the feed the way the Slack poll puts them there, so each one
// gets its seq from the emit lock.
function feed(fixture, events, options = {}) {
  agents.ensure('sandboxes', {
    role: 'incident-responder', area: 'sandboxes', model: 'opus',
    lastDeliveredSeq: 0, lastDeliveredAt: 0,
    session: options.session === null ? undefined
      : { id: 'sess-1', pane: 'pane-1', startedAt: options.startedAt || NOW - 30 * MINUTE },
  }, { root: fixture.root });
  for (const event of events) agents.emit('sandboxes', event, { root: fixture.root, now: event.at || NOW });
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
    assert.equal(body.model, 'opus');
    // openSession's own dedupe, keyed to the attempt rather than a clock, so two
    // ticks trying the same attempt are one open.
    assert.equal(body.requestId, 'area-sandboxes-g1');
    assert.match(body.requestId, /^[A-Za-z0-9_-]{1,128}$/);
    // The session's own name goes on the pane as `agentName`; `meta.agent` is the
    // provider everywhere in the daemon and must not be overloaded.
    assert.deepEqual(openDeps.launchMeta, { agentName: 'sandboxes' });
    assert.deepEqual(openDeps.launchEnv, { KEEP_AGENT: 'sandboxes' });
    // The bootstrap is three reads. It is deliberately NOT told to read its
    // unseen events: the bootstrap is not a delivery.
    for (const fragment of ['agents/sandboxes.md', '.keep/agents/sandboxes/notes.md', 'keep incidents']) {
      assert.ok(body.message.includes(fragment), `the bootstrap names ${fragment}`);
    }
    assert.equal(body.message.includes('--unseen'), false, 'the bootstrap does not acknowledge events');
    assert.ok(body.message.length <= 2000, 'the bootstrap fits an opening message');

    const saved = record(fixture);
    assert.equal(saved.session.id, 'sess-1');
    assert.equal(saved.session.pane, 'pane-1');
    assert.equal(saved.session.startedAt, NOW);
    assert.equal(saved.role, 'incident-responder');
    assert.equal(saved.model, 'opus');
    assert.equal(saved.cwd, fixture.worktree);
    assert.equal(saved.area, 'sandboxes');
    assert.equal(saved.launchLease, null, 'the lease is released whatever the tick decided');

    // A launch tick delivers nothing and closes nothing.
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

test('two ticks racing open exactly one session', async () => {
  const fixture = makeRoot();
  try {
    // The first tick to claim the lease reaches openSession and then blocks
    // inside it; the second runs to completion while it is in there.
    let release;
    const state = { panes: [], sessions: [], openGate: new Promise((resolve) => { release = resolve; }) };
    const deps = makeDeps(fixture, state);
    const first = tick(fixture, deps);
    // Let the first tick get as far as the gate before the second starts.
    await new Promise((resolve) => setImmediate(resolve));
    const second = sandboxes(await tick(fixture, deps, { now: NOW + 1000 }));

    assert.equal(second.launch.state, 'skipped');
    assert.match(second.launch.reason, /launch lease/);
    assert.equal(second.delivery.state, 'skipped');
    assert.equal(second.restart.state, 'not-due');

    release();
    assert.equal(sandboxes(await first).launch.state, 'launched');
    assert.equal(deps.calls.opens.length, 1, 'one open, not two');
    assert.equal(record(fixture).session.id, 'sess-1');
    assert.equal(record(fixture).launchLease, null);

    // An expired lease does not lock the agent out for good.
    agents.writeRecord('sandboxes', {
      session: { id: '', pane: '', startedAt: 0 },
      launch: { attempts: 0, lastAt: 0, deadSince: 0 },
      launchLease: { at: NOW, by: 'somebody-who-died', requestId: 'area-sandboxes-1' },
    }, { root: fixture.root });
    const later = sandboxes(await tick(fixture, deps, { now: NOW + areaSession.LAUNCH_LEASE_MS + 1000 }));
    assert.equal(later.launch.state, 'launched');
  } finally { cleanup(fixture.root); }
});

test('a session that came up while the tick was deciding is adopted, not doubled', async () => {
  const fixture = makeRoot();
  try {
    // The first listing shows nothing; the confirming one, taken under the lease,
    // shows a live pane stamped with this agent's name.
    let listings = 0;
    const state = { panes: [], sessions: [idleSession('sess-9', 'pane-9')] };
    const deps = makeDeps(fixture, state);
    deps.listPanes = async () => {
      listings += 1;
      return listings === 1 ? [] : [livePane('pane-9', 'sess-9')];
    };
    const report = sandboxes(await tick(fixture, deps));
    assert.equal(report.launch.state, 'live');
    assert.equal(report.launch.adopted, true);
    assert.equal(deps.calls.opens.length, 0, 'nothing was opened');
    assert.equal(record(fixture).session.id, 'sess-9');
    assert.equal(record(fixture).launchLease, null);
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
    assert.equal(record(fixture).launch.deadSince, NOW + MINUTE);

    // Still inside the window.
    const still = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE + areaSession.PANE_DEAD_GRACE_MS - 1 }));
    assert.equal(still.launch.state, 'waiting');
    assert.equal(deps.calls.opens.length, 1);

    // Past it, and the launch retry window with it.
    const past = NOW + MINUTE + areaSession.PANE_DEAD_GRACE_MS + areaSession.LAUNCH_RETRY_MS;
    const relaunched = sandboxes(await tick(fixture, deps, { now: past }));
    assert.equal(relaunched.launch.state, 'launched');
    assert.equal(deps.calls.opens.length, 2);
    assert.equal(record(fixture).session.startedAt, past);
    // A relaunch is a new generation, so its request id is a new one too.
    assert.equal(deps.calls.opens[1].body.requestId, 'area-sandboxes-g2');
  } finally { cleanup(fixture.root); }
});

test('a pane listing that failed authorizes nothing, with or without a recorded session', async () => {
  const fixture = makeRoot();
  try {
    // An unreachable host, with an empty record: the listing is not evidence that
    // nothing is running, and launching on it is how a second session appears
    // beside one the daemon could not see.
    const state = { panes: null, sessions: [] };
    const deps = makeDeps(fixture, state);
    const blind = sandboxes(await tick(fixture, deps));
    assert.equal(blind.launch.state, 'skipped');
    assert.match(blind.launch.reason, /did not answer/);
    assert.equal(deps.calls.opens.length, 0, 'a failed listing never launches');
    assert.equal(blind.delivery.state, 'skipped');
    assert.equal(blind.restart.state, 'not-due');

    // A listing that throws reads the same way.
    deps.listPanes = () => { throw new Error('terminal host socket is gone'); };
    const threw = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(threw.launch.state, 'skipped');
    assert.match(threw.launch.reason, /could not be asked/);
    assert.equal(deps.calls.opens.length, 0);

    // And with a session on the record it is still not a dead pane.
    const live = makeDeps(fixture, { panes: [], sessions: [] });
    await tick(fixture, live, { now: NOW + 2 * MINUTE });
    assert.equal(live.calls.opens.length, 1);
    live.listPanes = async () => null;
    const kept = sandboxes(await tick(fixture, live, { now: NOW + 5 * areaSession.PANE_DEAD_GRACE_MS }));
    assert.equal(kept.launch.state, 'skipped');
    assert.equal(live.calls.opens.length, 1);
    assert.equal(record(fixture).launch.deadSince, 0, 'no dead clock was started');
  } finally { cleanup(fixture.root); }
});

test('three launches that never come up stop, and a live session clears the count', async () => {
  const fixture = makeRoot();
  try {
    const other = { id: 'pane-other', alive: true, agentAlive: true, meta: { sessionId: 'somebody-else' } };
    const state = { panes: [other], sessions: [] };
    const deps = makeDeps(fixture, state);
    let at = NOW;
    for (let attempt = 1; attempt <= areaSession.MAX_LAUNCH_ATTEMPTS; attempt += 1) {
      state.newSessionId = `sess-${attempt}`;
      state.newPane = `pane-${attempt}`;
      const opened = sandboxes(await tick(fixture, deps, { now: at }));
      assert.equal(opened.launch.state, 'launched', `attempt ${attempt} launched`);
      await tick(fixture, deps, { now: at + MINUTE });
      at += areaSession.LAUNCH_RETRY_MS + MINUTE;
    }
    assert.equal(deps.calls.opens.length, areaSession.MAX_LAUNCH_ATTEMPTS);
    const capped = sandboxes(await tick(fixture, deps, { now: at }));
    assert.equal(capped.launch.state, 'skipped');
    assert.match(capped.launch.reason, /produced no live session/);
    assert.equal(deps.calls.opens.length, areaSession.MAX_LAUNCH_ATTEMPTS);

    state.panes = [livePane('pane-3', 'sess-3')];
    state.sessions = [idleSession('sess-3', 'pane-3')];
    const live = sandboxes(await tick(fixture, deps, { now: at + MINUTE }));
    assert.equal(live.launch.state, 'live');
    assert.equal(record(fixture).launch.attempts, 0);
  } finally { cleanup(fixture.root); }
});

test('a spent automation pool defers the launch without spending an attempt, and the relaunch lands on the policy\'s account', async () => {
  const fixture = makeRoot();
  try {
    const state = { panes: [], sessions: [] };
    const deps = makeDeps(fixture, state);
    const retryAt = NOW + 5 * HOUR;
    const asked = [];
    let pool = 'spent';
    deps.selectAccount = (options) => {
      asked.push(options);
      return pool === 'spent'
        ? { account: null, deferred: true, retryAt, reason: 'automation pool exhausted for opus; retrying at later' }
        : { account: 'claude-tertiary', reason: 'most headroom in the automation pool' };
    };

    const first = sandboxes(await tick(fixture, deps));
    assert.deepEqual([first.launch.state, first.launch.retryAt], ['deferred', retryAt]);
    assert.match(first.launch.reason, /automation pool exhausted/);
    assert.equal(deps.calls.opens.length, 0, 'nothing was launched');
    assert.deepEqual(asked.map((options) => [options.purpose, options.model, options.preferredId]),
      [['incident-responder', 'opus', 'claude-secondary']]);
    assert.equal(record(fixture).launch.attempts, 0, 'a deferral is not a failed launch');
    assert.equal(record(fixture).launch.lastAt, 0);

    // Before the reset nothing is asked again.
    const waiting = sandboxes(await tick(fixture, deps, { now: NOW + HOUR }));
    assert.deepEqual([waiting.launch.state, waiting.launch.retryAt], ['deferred', retryAt]);
    assert.equal(asked.length, 1);
    assert.equal(record(fixture).launch.attempts, 0);

    // At the reset the policy is asked again and the launch goes to its account.
    pool = 'room';
    const launched = sandboxes(await tick(fixture, deps, { now: retryAt }));
    assert.equal(launched.launch.state, 'launched');
    assert.equal(asked.length, 2);
    assert.equal(deps.calls.opens.length, 1);
    assert.equal(deps.calls.opens[0].body.accountId, 'claude-tertiary');
    const after = record(fixture);
    assert.equal(after.account, 'claude-tertiary', 'the record says what the launch actually ran on');
    assert.equal(after.launch.attempts, 1);
    assert.equal(after.launch.deferredUntil, undefined);
  } finally { cleanup(fixture.root); }
});

test('a live pane stamped with the agent name is adopted rather than doubled', async () => {
  const fixture = makeRoot();
  try {
    const state = {
      panes: [livePane('pane-9', 'sess-9')],
      sessions: [idleSession('sess-9', 'pane-9')],
    };
    const deps = makeDeps(fixture, state);
    agents.ensure('sandboxes', { role: 'incident-responder', area: 'sandboxes' }, { root: fixture.root });
    const report = sandboxes(await tick(fixture, deps));
    assert.equal(report.launch.state, 'live');
    assert.equal(report.launch.adopted, true);
    assert.equal(deps.calls.opens.length, 0, 'an adopted pane is not a reason to launch');
    assert.equal(record(fixture).session.id, 'sess-9');
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
    const saved = record(fixture);
    assert.equal(saved.session.id, 'sess-7', 'a pane means a session IS running');
    assert.equal(saved.session.pane, 'pane-7');
    assert.equal(saved.launchLease, null);
  } finally { cleanup(fixture.root); }
});

// ---------- delivery ----------

test('one delivery per tick carries every new event, in seq order, and moves the cursor once', async () => {
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
    assert.ok(text.includes('Handle these per your recipe.'));
    for (const fragment of ['incident-opened', 'incident-fired', 'human-note', 'inc-a', 'high', 'https://slack/c']) {
      assert.ok(text.includes(fragment), `the batch carries ${fragment}`);
    }
    assert.equal(opts.compactIfCold, true);
    // No retained receipt: what a delivery is worth is our own
    // `pendingDelivery.state`, not the transport's receipt store, which files a
    // received receipt for a delivery it only assumed.
    assert.equal(opts.retainReceipt, false);
    assert.equal(opts.deliveryKey, 'agent:sandboxes:seq:1-3');
    assert.equal(cursor(fixture), 3);
    const acknowledged = areaSession.pendingDeliveryOf(record(fixture));
    assert.equal(acknowledged.state, 'confirmed', 'the cursor and the confirmation land together');
    assert.equal(acknowledged.lastSeq, 3);

    const repeat = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(repeat.delivery.state, 'nothing');
    assert.equal(deps.calls.sends.length, 1);
  } finally { cleanup(fixture.root); }
});

test('equal timestamps and a backdated event are each delivered exactly once', async () => {
  const fixture = makeRoot();
  try {
    // Two events in the same millisecond, then one stamped BEFORE both — which is
    // what a backfilled Slack firing looks like next to a hand close a minute
    // ago. A timestamp cursor loses one of each pair.
    feed(fixture, [
      { at: NOW - 2 * MINUTE, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox A' },
      { at: NOW - 2 * MINUTE, kind: 'incident-opened', card: 'inc-b', title: 'Sandbox B' },
    ]);
    const state = { panes: [livePane()], sessions: [idleSession()] };
    const deps = makeDeps(fixture, state);
    assert.equal(sandboxes(await tick(fixture, deps)).delivery.count, 2);
    assert.ok(deps.calls.sends[0].text.includes('inc-a'));
    assert.ok(deps.calls.sends[0].text.includes('inc-b'));
    assert.equal(cursor(fixture), 2);

    agents.emit('sandboxes', { at: NOW - 10 * MINUTE, kind: 'incident-closed', card: 'inc-c', title: 'Sandbox C' },
      { root: fixture.root, now: NOW });
    const later = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(later.delivery.count, 1);
    assert.ok(deps.calls.sends[1].text.includes('inc-c'), 'a backdated event is still after the cursor');
    assert.equal(cursor(fixture), 3);
    assert.equal(sandboxes(await tick(fixture, deps, { now: NOW + 2 * MINUTE })).delivery.state, 'nothing');
    assert.equal(deps.calls.sends.length, 2, 'and never twice');
  } finally { cleanup(fixture.root); }
});

test('a batch is split by encoded size, never clipped, and every event gets delivered', async () => {
  const fixture = makeRoot();
  try {
    // Long titles, so the body runs past the limit well before any event count would.
    const events = [];
    for (let i = 0; i < 60; i += 1) {
      events.push({
        at: NOW - (120 - i) * MINUTE, kind: 'incident-fired', card: `inc-${i}`,
        title: `Sandbox ${i} ${'x'.repeat(100)}`, severity: 'med',
        permalink: `https://slack/${'y'.repeat(100)}${i}`,
      });
    }
    feed(fixture, events);
    const state = { panes: [livePane()], sessions: [idleSession()] };
    const deps = makeDeps(fixture, state);

    const seen = new Set();
    let ticks = 0;
    let at = NOW;
    while (cursor(fixture) < 60 && ticks < 20) {
      const report = sandboxes(await tick(fixture, deps, { now: at }));
      if (report.delivery.state === 'nothing') break;
      assert.equal(report.delivery.state, 'sent');
      ticks += 1;
      at += MINUTE;
      const body = deps.calls.sends.at(-1).text;
      // Never clipped: the ellipsis dataFence adds when it has to truncate must
      // never appear, because a clipped batch acknowledges a half-shown event.
      assert.equal(body.includes('…'), false, 'no batch was clipped');
      for (let i = 0; i < 60; i += 1) if (body.includes(`inc-${i}  `)) seen.add(i);
    }
    assert.ok(ticks > 1, `the backlog took more than one message (${ticks})`);
    assert.equal(seen.size, 60, 'every event was delivered');
    assert.equal(cursor(fixture), 60);
    assert.match(deps.calls.sends[0].text, /more events are queued behind these/);
  } finally { cleanup(fixture.root); }
});

test('a mid-turn session is not interrupted and its cursor does not move', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [{ at: NOW - MINUTE, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox Open Health' }]);
    const state = {
      panes: [livePane()],
      sessions: [{ ...idleSession(), endedTurn: false, state: 'running' }],
    };
    const deps = makeDeps(fixture, state);
    const busy = sandboxes(await tick(fixture, deps));
    assert.equal(busy.delivery.state, 'deferred');
    assert.match(busy.delivery.reason, /mid-turn/);
    assert.equal(deps.calls.sends.length, 0);
    assert.equal(cursor(fixture), 0, 'the cursor is untouched');
    assert.equal(areaSession.pendingDeliveryOf(record(fixture)), null, 'and nothing was persisted for a send that never started');

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
    assert.equal(cursor(fixture), 1);
  } finally { cleanup(fixture.root); }
});

test('a typed-but-unconfirmed batch is retried through the recovery path, not stalled', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [{ at: NOW - MINUTE, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox Open Health' }]);
    // What `delivery.deliver` leaves behind when it typed but could not confirm:
    // a pending, unreceived journal entry. A tick that merely reported "deferred"
    // here is what wedged the reviewer for 133 consecutive ticks in September.
    const state = {
      panes: [livePane()], sessions: [idleSession()],
      receipt: { sessionId: 'sess-1', kind: 'claude', received: false, pending: true },
      sendError: new Error('Previous delivery is unconfirmed; no message was retyped.'),
    };
    const deps = makeDeps(fixture, state);
    const first = sandboxes(await tick(fixture, deps));
    assert.equal(first.delivery.state, 'deferred');
    assert.equal(deps.calls.sends.length, 1, 'the send was attempted, so delivery.js could recover the draft');
    assert.equal(cursor(fixture), 0);
    const pending = areaSession.pendingDeliveryOf(record(fixture));
    assert.equal(pending.key, 'agent:sandboxes:seq:1-1');

    // Next tick: the draft was submitted, so the same call succeeds and the text
    // is byte-identical because the batch came off the record rather than being
    // recomputed.
    state.sendError = null;
    state.sendResult = { ok: true, delivery: 'received', recovered: true };
    const second = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(second.delivery.state, 'sent');
    assert.equal(second.delivery.recovered, true);
    assert.equal(deps.calls.sends[1].text, deps.calls.sends[0].text, 'the same characters, not a recomputed batch');
    assert.equal(deps.calls.sends[1].opts.deliveryKey, deps.calls.sends[0].opts.deliveryKey);
    assert.equal(cursor(fixture), 1);
  } finally { cleanup(fixture.root); }
});

test('a delayed tick cannot resurrect a batch built from a cursor that has moved', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [{ at: NOW - 2 * MINUTE, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox A' }]);
    const state = { panes: [livePane()], sessions: [idleSession()] };
    const deps = makeDeps(fixture, state);

    // The interleaving that used to get event 1 delivered twice. Tick A starts
    // while only event 1 exists, so it selects [1]. Before it can take the lease,
    // event 2 arrives and tick B delivers [1,2] and moves the cursor to 2. Tick A
    // then wakes up holding a batch built from a cursor of 0.
    //
    // The fix is that the batch tick A actually sends is chosen from the record it
    // reads AFTER claiming the lease — by which time the cursor is 2 and there is
    // nothing left to send — so its stale [1] is never persisted and never typed.
    let releaseA;
    let started = false;
    deps.claimDeliveryLease = (name, root, at, d) => {
      if (!started) {
        started = true;
        return new Promise((resolve) => { releaseA = () => resolve(areaSession.claimDeliveryLease(name, root, at, d)); });
      }
      return areaSession.claimDeliveryLease(name, root, at, d);
    };
    const a = tick(fixture, deps);
    await new Promise((resolve) => setImmediate(resolve));

    // Tick B, with both events, delivering [1,2].
    agents.emit('sandboxes', { at: NOW - MINUTE, kind: 'incident-fired', card: 'inc-a', title: 'Sandbox A' },
      { root: fixture.root, now: NOW });
    const b = makeDeps(fixture, state);
    const bReport = sandboxes(await tick(fixture, b, { now: NOW + 1000 }));
    assert.equal(bReport.delivery.state, 'sent');
    assert.equal(bReport.delivery.count, 2);
    assert.equal(cursor(fixture), 2);

    releaseA();
    const aReport = sandboxes(await a);
    assert.equal(aReport.delivery.state, 'nothing', 'tick A found nothing left to send');
    assert.equal(deps.calls.sends.length, 0, 'and typed nothing');
    assert.equal(cursor(fixture), 2, 'the cursor did not go backwards');
    // Event 1 went out exactly once, inside tick B's batch.
    const sent = b.calls.sends.filter((call) => call.text.includes('inc-a'));
    assert.equal(sent.length, 1);
    assert.equal(areaSession.pendingDeliveryOf(record(fixture)).lastSeq, 2);
  } finally { cleanup(fixture.root); }
});

test('two overlapping ticks send one message', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [{ at: NOW - MINUTE, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox Open Health' }]);
    const state = { panes: [livePane()], sessions: [idleSession()] };
    const deps = makeDeps(fixture, state);
    // The first tick blocks inside the send; the second runs to completion while
    // it is in there. Without a delivery lease both read "no receipt", both
    // persist their own pending batch over the other's, and both type — the
    // injection mutex only serialises the typing, it does not prevent it.
    let release;
    let second = null;
    state.onSend = async () => {
      if (second) return;
      second = tick(fixture, deps, { now: NOW + 1000 });
      await new Promise((resolve) => { release = resolve; });
    };
    const first = tick(fixture, deps);
    await new Promise((resolve) => setImmediate(resolve));
    const secondReport = sandboxes(await second);
    assert.equal(secondReport.delivery.state, 'deferred');
    assert.match(secondReport.delivery.reason, /delivery lease/);
    release();
    assert.equal(sandboxes(await first).delivery.state, 'sent');
    assert.equal(deps.calls.sends.length, 1, 'one message, not two');
    assert.equal(cursor(fixture), 1);
    assert.equal(record(fixture).deliveryLease, null, 'the lease is released either way');
  } finally { cleanup(fixture.root); }
});

test('a send whose batch was delivered by somebody else is abandoned inside the lock', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [{ at: NOW - MINUTE, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox Open Health' }]);
    const state = { panes: [livePane()], sessions: [idleSession()] };
    const deps = makeDeps(fixture, state);
    // Everything before the injection lock was decided outside it. If the cursor
    // moved past this batch in the meantime, the send is stale.
    deps.withInjectionLock = async (fn) => {
      agents.writeRecord('sandboxes', { lastDeliveredSeq: 1, pendingDelivery: null }, { root: fixture.root });
      return fn();
    };
    const report = sandboxes(await tick(fixture, deps));
    assert.equal(report.delivery.state, 'deferred');
    assert.match(report.delivery.reason, /delivered by somebody else/);
    assert.equal(deps.calls.sends.length, 0, 'nothing was typed');
  } finally { cleanup(fixture.root); }
});

test('a retry types the same characters, queued-count sentence and all', async () => {
  const fixture = makeRoot();
  try {
    // Enough events that the first batch says "N more are queued" — a sentence a
    // batch rebuilt from the feed would silently drop, making the retry a
    // different message with a receipt nobody can find.
    const events = [];
    for (let i = 0; i < 40; i += 1) {
      events.push({
        at: NOW - (60 - i) * MINUTE, kind: 'incident-fired', card: 'inc-' + i,
        title: 'Sandbox ' + i + ' ' + 'x'.repeat(100),
        permalink: 'https://slack/' + 'y'.repeat(100) + i,
      });
    }
    feed(fixture, events);
    const state = {
      panes: [livePane()], sessions: [idleSession()],
      sendError: new Error('pane is busy typing'),
    };
    const deps = makeDeps(fixture, state);
    const first = sandboxes(await tick(fixture, deps));
    assert.equal(first.delivery.state, 'deferred');
    assert.match(deps.calls.sends[0].text, /more events are queued behind these/);
    const pending = areaSession.pendingDeliveryOf(record(fixture));
    assert.equal(pending.text, deps.calls.sends[0].text, 'the record carries the rendered text');

    state.sendError = null;
    const second = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(second.delivery.state, 'sent');
    assert.equal(second.delivery.recovered, true);
    assert.equal(deps.calls.sends[1].text, deps.calls.sends[0].text, 'byte-identical');
    assert.equal(deps.calls.sends[1].opts.deliveryKey, deps.calls.sends[0].opts.deliveryKey);
  } finally { cleanup(fixture.root); }
});

test('a crash between the send and the state write does not double-type', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [
      { at: NOW - 2 * MINUTE, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox Open Health' },
      { at: NOW - MINUTE, kind: 'incident-fired', card: 'inc-a', title: 'Sandbox Open Health' },
    ]);
    // Confirmed by the transport, and then the write that would have recorded it
    // — the one that moves the cursor and sets `state: 'confirmed'` together — is
    // what dies. Our own state is still `sending`.
    const state = {
      panes: [livePane()], sessions: [idleSession()],
      writeError: (patch) => (patch.lastDeliveredSeq ? new Error('disk went away') : null),
    };
    const deps = makeDeps(fixture, state);
    const died = sandboxes(await tick(fixture, deps));
    assert.equal(deps.calls.types.length, 1, 'the message was typed once');
    assert.equal(died.delivery.state, 'sent');
    assert.match(died.delivery.cursorError, /disk went away/);
    assert.equal(cursor(fixture), 0, 'the cursor never advanced');
    const pending = areaSession.pendingDeliveryOf(record(fixture));
    assert.equal(pending.state, 'sending', 'so our state still says we were sending');
    assert.equal(pending.key, 'agent:sandboxes:seq:1-2');

    // The next tick. A confirmed send finished the transport's journal, so there
    // is nothing there to recover a draft from — the transcript is the remaining
    // witness, and it is asked before anything is typed.
    state.writeError = null;
    const asked = [];
    deps.transcriptShows = (session, text) => { asked.push(text); return true; };
    const recovered = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(recovered.delivery.state, 'sent');
    assert.equal(recovered.delivery.delivery, 'found-in-transcript');
    assert.equal(deps.calls.types.length, 1, 'and it was not typed a second time');
    assert.equal(asked[0], pending.text, 'the transcript was asked about the persisted text');
    assert.equal(cursor(fixture), 2);
    assert.equal(areaSession.pendingDeliveryOf(record(fixture)).state, 'confirmed');
  } finally { cleanup(fixture.root); }
});

test('a transcript that does not show the text retypes it, through the journal path', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [{ at: NOW - MINUTE, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox Open Health' }]);
    const state = {
      panes: [livePane()], sessions: [idleSession()],
      sendError: new Error('Delivery unconfirmed: no matching transcript receipt.'),
    };
    const deps = makeDeps(fixture, state);
    // Typed, never confirmed: the transport keeps its journal for that.
    assert.equal(sandboxes(await tick(fixture, deps)).delivery.state, 'deferred');
    assert.equal(deps.calls.types.length, 1);
    assert.equal(areaSession.pendingDeliveryOf(record(fixture)).state, 'sending');

    // The transcript has nothing, so the send is attempted again — and the
    // transport recognises its own journal and submits the draft rather than
    // typing it twice.
    state.sendError = null;
    deps.transcriptShows = () => false;
    const retried = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(retried.delivery.state, 'sent');
    assert.equal(deps.calls.sends.length, 2, 'the transport was called again');
    assert.equal(deps.calls.types.length, 1, 'and recovered its draft instead of retyping');
    assert.equal(deps.calls.sends[1].text, deps.calls.sends[0].text);
    assert.equal(cursor(fixture), 1);
  } finally { cleanup(fixture.root); }
});

test('our own confirmed state moves the cursor with no transport at all', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [{ at: NOW - MINUTE, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox Open Health' }]);
    const deps = makeDeps(fixture, { panes: [livePane()], sessions: [idleSession()] });
    // A record left behind by a tick that confirmed a batch and then failed to
    // write the cursor in the same breath. Our state is the provenance, so the
    // cursor moves and nothing is sent, asked or recovered.
    agents.writeRecord('sandboxes', {
      pendingDelivery: {
        key: 'agent:sandboxes:seq:1-1', firstSeq: 1, lastSeq: 1, offset: 0, count: 1,
        text: 'whatever was sent', at: NOW - MINUTE, state: 'confirmed',
      },
    }, { root: fixture.root });
    const report = sandboxes(await tick(fixture, deps));
    assert.equal(report.delivery.state, 'sent');
    assert.equal(report.delivery.delivery, 'confirmed-earlier');
    assert.equal(deps.calls.sends.length, 0, 'nothing was sent');
    assert.equal(cursor(fixture), 1);
  } finally { cleanup(fixture.root); }
});

test('three unconfirmed sends advance the cursor and put the uncertainty on the feed', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [{ at: NOW - MINUTE, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox Open Health' }]);
    const state = {
      panes: [livePane()], sessions: [idleSession()],
      sendResult: { ok: true, delivery: 'assumed-delivered', expired: true },
    };
    const deps = makeDeps(fixture, state);
    deps.transcriptShows = () => false;
    let at = NOW;
    for (let attempt = 1; attempt < areaSession.ASSUMED_ATTEMPT_LIMIT; attempt += 1) {
      const report = sandboxes(await tick(fixture, deps, { now: at }));
      assert.equal(report.delivery.state, 'deferred', `attempt ${attempt} defers`);
      assert.equal(report.delivery.assumedAttempts, attempt);
      assert.equal(cursor(fixture), 0, 'and acknowledges nothing');
      at += MINUTE;
    }
    // The cap. Retyping the same events forever is its own failure — the session
    // has probably had them every time — so the queue moves on and says so.
    const capped = sandboxes(await tick(fixture, deps, { now: at }));
    assert.equal(capped.delivery.state, 'sent');
    assert.equal(capped.delivery.delivery, 'uncertain');
    assert.equal(capped.delivery.assumedAttempts, areaSession.ASSUMED_ATTEMPT_LIMIT);
    assert.equal(cursor(fixture), 1, 'the cursor moved past it');
    const uncertain = agents.readEvents('sandboxes', { root: fixture.root })
      .find((event) => event.kind === 'delivery-uncertain');
    assert.ok(uncertain, 'and the uncertainty is on the feed');
    assert.equal(uncertain.severity, 'med');
    assert.equal(uncertain.card, '');
    assert.match(uncertain.text, /seq 1-1/);
    assert.ok(uncertain.seq > 1, 'after the cursor, so the next batch carries it');

    // Which it does: the next batch is that event, and the queue is moving again.
    state.sendResult = null;
    const next = sandboxes(await tick(fixture, deps, { now: at + MINUTE }));
    assert.equal(next.delivery.state, 'sent');
    assert.match(deps.calls.sends.at(-1).text, /delivery-uncertain/);
  } finally { cleanup(fixture.root); }
});

test('a delivery lease stolen during a slow send stops the cursor advancing', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [{ at: NOW - MINUTE, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox Open Health' }]);
    const state = { panes: [livePane()], sessions: [idleSession()] };
    const deps = makeDeps(fixture, state);
    // `compactIfCold` can spend minutes before a character is typed. Somebody
    // else takes the lease while this send is in flight.
    state.onSend = () => {
      agents.writeRecord('sandboxes', {
        deliveryLease: { at: Date.now(), by: 'another-tick' },
      }, { root: fixture.root });
    };
    const report = sandboxes(await tick(fixture, deps));
    assert.equal(report.delivery.state, 'deferred');
    assert.match(report.delivery.reason, /delivery lease was lost/);
    assert.equal(report.delivery.leaseLost, true);
    assert.equal(cursor(fixture), 0, 'the cursor is not ours to move any more');
    assert.equal(areaSession.pendingDeliveryOf(record(fixture)).state, 'sending',
      'and the batch stays sending, for whoever holds the lease');
    assert.equal(record(fixture).deliveryLease.by, 'another-tick', 'whose lease is left alone');
  } finally { cleanup(fixture.root); }
});

test('the lease is renewed underneath a slow send, and the timer is always cleared', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [{ at: NOW - MINUTE, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox Open Health' }]);
    const state = { panes: [livePane()], sessions: [idleSession()] };
    const deps = makeDeps(fixture, state);
    const renewals = [];
    deps.renewDeliveryLease = (name, root, at, by, d) => {
      renewals.push(at);
      return areaSession.renewDeliveryLease(name, root, at, by, d);
    };
    // The renewal timer runs on a 30 s clock, so what this asserts is that it is
    // created, unref'd and always cleared — not that it fires inside a test.
    const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
    const before = timers();
    const report = sandboxes(await tick(fixture, deps));
    assert.equal(report.delivery.state, 'sent');
    // Once before typing, once from beforeType, once after the send returns.
    assert.ok(renewals.length >= 3, `the lease was renewed around the send (${renewals.length})`);
    assert.equal(timers(), before, 'and no renewal timer was left running');
    assert.equal(record(fixture).deliveryLease, null);
  } finally { cleanup(fixture.root); }
});

test('the cursor carries a feed offset, and a bad one only costs a full scan', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [
      { at: NOW - 3 * MINUTE, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox A' },
      { at: NOW - 2 * MINUTE, kind: 'incident-fired', card: 'inc-b', title: 'Sandbox B' },
    ]);
    const state = { panes: [livePane()], sessions: [idleSession()] };
    const deps = makeDeps(fixture, state);
    const scans = [];
    deps.readAfterSeq = (name, afterSeq, options) => {
      const result = agents.readAfterSeq(name, afterSeq, options);
      scans.push({ fromOffset: options.fromOffset || 0, scannedFrom: result.scannedFrom });
      return result;
    };
    assert.equal(sandboxes(await tick(fixture, deps)).delivery.count, 2);
    const saved = record(fixture).lastDeliveredOffset;
    assert.ok(saved > 0, 'the offset was saved beside the cursor');

    agents.emit('sandboxes', { at: NOW, kind: 'human-note', card: 'inc-a' }, { root: fixture.root, now: NOW });
    scans.length = 0;
    const next = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(next.delivery.count, 1);
    assert.ok(scans.length > 0);
    assert.ok(scans.every((scan) => scan.fromOffset === saved), 'the next read started where the last stopped');
    assert.ok(scans.every((scan) => scan.scannedFrom === saved), 'and agents.js honoured it');

    // A nonsense offset must never lose an event: it falls back to a full scan.
    agents.writeRecord('sandboxes', { lastDeliveredSeq: 0, lastDeliveredOffset: 7, pendingDelivery: null },
      { root: fixture.root });
    scans.length = 0;
    const rescanned = sandboxes(await tick(fixture, deps, { now: NOW + 2 * MINUTE }));
    assert.equal(rescanned.delivery.count, 3, 'everything is still found');
    assert.ok(scans.every((scan) => scan.scannedFrom === 0), 'from the start of the feed');
  } finally { cleanup(fixture.root); }
});

test('a batch full of fence markers is measured after escaping, so it is never clipped', async () => {
  const fixture = makeRoot();
  try {
    // `safeUntrusted` rewrites every KEEP_INPUT to KEEP_INPUT_DATA and dataFence
    // prefixes every line, so text that fitted as raw lines can arrive over the
    // limit. Measuring the rendered message is the only honest check.
    const events = [];
    for (let i = 0; i < 40; i += 1) {
      events.push({
        at: NOW - (60 - i) * MINUTE, kind: 'incident-fired', card: 'inc-' + i,
        title: 'KEEP_INPUT ' + 'KEEP_INPUT '.repeat(10) + i,
        permalink: 'https://slack/KEEP_INPUT/' + 'KEEP_CONTEXT/'.repeat(8) + i,
      });
    }
    feed(fixture, events);
    const deps = makeDeps(fixture, { panes: [livePane()], sessions: [idleSession()] });
    let at = NOW;
    let ticks = 0;
    const seen = new Set();
    while (cursor(fixture) < 40 && ticks < 25) {
      const report = sandboxes(await tick(fixture, deps, { now: at }));
      if (report.delivery.state === 'nothing') break;
      assert.equal(report.delivery.state, 'sent');
      ticks += 1;
      at += MINUTE;
      const body = deps.calls.sends.at(-1).text;
      assert.equal(body.includes('…'), false, 'no batch was clipped');
      assert.ok(body.length <= areaSession.DELIVERY_BODY_MAX + 200,
        'the rendered message stayed near the limit (' + body.length + ')');
      // The fence markers in somebody's title cannot close the fence they sit in.
      assert.equal(body.split('KEEP_INPUT>>>').length, 2, 'exactly one fence terminator');
      for (let i = 0; i < 40; i += 1) if (body.includes('inc-' + i + '  ')) seen.add(i);
    }
    assert.ok(ticks > 1, 'the backlog took more than one message (' + ticks + ')');
    assert.equal(seen.size, 40, 'every event was delivered');
  } finally { cleanup(fixture.root); }
});

test('a batch the pane only half accepted is not acknowledged', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [{ at: NOW - MINUTE, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox Open Health' }]);
    const state = {
      panes: [livePane()], sessions: [idleSession()],
      sendResult: { truncated: true, received: 40, expected: 300 },
    };
    const deps = makeDeps(fixture, state);
    const report = sandboxes(await tick(fixture, deps));
    assert.equal(report.delivery.state, 'deferred');
    assert.equal(report.delivery.truncated, true);
    assert.equal(cursor(fixture), 0, 'a half-delivered batch is not delivered');
    assert.equal(areaSession.pendingDeliveryOf(record(fixture)).key, 'agent:sandboxes:seq:1-1');

    state.sendResult = null;
    const retried = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(retried.delivery.state, 'sent');
    assert.equal(cursor(fixture), 1);
  } finally { cleanup(fixture.root); }
});

test('a launch leaves the cursor alone and the next tick delivers the backlog', async () => {
  const fixture = makeRoot();
  try {
    // Events that arrived while there was no session. The bootstrap does not hand
    // them over, so they are still undelivered.
    agents.ensure('sandboxes', { role: 'incident-responder', area: 'sandboxes' }, { root: fixture.root });
    agents.emit('sandboxes', { at: NOW - 5 * MINUTE, kind: 'incident-opened', card: 'inc-a' }, { root: fixture.root, now: NOW });
    agents.emit('sandboxes', { at: NOW - 4 * MINUTE, kind: 'incident-fired', card: 'inc-a' }, { root: fixture.root, now: NOW });

    const state = { panes: [], sessions: [] };
    const deps = makeDeps(fixture, state);
    assert.equal(sandboxes(await tick(fixture, deps)).launch.state, 'launched');
    assert.equal(cursor(fixture), 0, 'the bootstrap acknowledged nothing');

    state.panes = [livePane()];
    state.sessions = [idleSession()];
    const next = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(next.delivery.state, 'sent');
    assert.equal(next.delivery.count, 2, 'the backlog is delivered by the tick, not the bootstrap');
    assert.equal(cursor(fixture), 2);
  } finally { cleanup(fixture.root); }
});

test('a control sequence in an event never reaches the pane', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [{
      at: NOW - MINUTE, kind: 'incident-opened', card: 'inc-a',
      title: 'Sandbox \x1b[2JOpen\x03 Health\x15',
      permalink: 'https://slack/\x1b]0;pwned\x07a',
    }]);
    const deps = makeDeps(fixture, { panes: [livePane()], sessions: [idleSession()] });
    assert.equal(sandboxes(await tick(fixture, deps)).delivery.state, 'sent');
    const { text } = deps.calls.sends[0];
    assert.ok(text.includes('Sandbox Open Health'));
    assert.ok(text.includes('https://slack/a'));
    assert.equal(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text), false, 'not one control byte is typed');
    assert.equal(text.includes('[2J'), false, 'and no escape sequence is left as visible junk');
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
    assert.equal(cursor(fixture), 0);

    state.sendError = null;
    const retried = sandboxes(await tick(fixture, deps));
    assert.equal(retried.delivery.state, 'sent');
    assert.equal(cursor(fixture), 1);
  } finally { cleanup(fixture.root); }
});

test('a request id names one launch for all time, across generations', async () => {
  const fixture = makeRoot();
  try {
    idleFor(fixture, 3);
    const state = quietState(3);
    const deps = makeDeps(fixture, state);
    // Closing a session as idle resets `launch.attempts`, which is what the
    // request id used to be built from.
    assert.equal(sandboxes(await tick(fixture, deps)).restart.state, 'closed');

    state.panes = [];
    state.sessions = [];
    const first = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(first.launch.state, 'launched');
    assert.equal(deps.calls.opens[0].body.requestId, 'area-sandboxes-g1');
    // An area agent reads and writes this registry, so it runs beside it.
    assert.equal(deps.calls.opens[0].body.node, require('./nodes.js').daemonNode());
    assert.equal(record(fixture).generation, 1);

    // Close it as idle again and launch once more. The id must NOT come back
    // round to g1: openSession would recognise it and hand back the retained
    // record of the pane that already exited instead of opening a session.
    agents.writeRecord('sandboxes', { session: { startedAt: NOW - 9 * HOUR } }, { root: fixture.root });
    Object.assign(state, quietState(9));
    assert.equal(sandboxes(await tick(fixture, deps, { now: NOW + 2 * MINUTE })).restart.state, 'closed');
    assert.equal(record(fixture).launch.attempts, 0, 'the attempt counter did reset');
    state.panes = [];
    state.sessions = [];
    const second = sandboxes(await tick(fixture, deps, { now: NOW + 3 * MINUTE }));
    assert.equal(second.launch.state, 'launched');
    assert.notEqual(deps.calls.opens[1].body.requestId, deps.calls.opens[0].body.requestId);
    assert.match(deps.calls.opens[1].body.requestId, /^area-sandboxes-g[2-9]$/);
    assert.ok(record(fixture).generation > 1, 'the generation only ever increases');
  } finally { cleanup(fixture.root); }
});

test('a launch lease stolen while the worktree is being prepared spawns nothing', async () => {
  const fixture = makeRoot();
  try {
    const state = { panes: [], sessions: [], worktreeReady: false };
    const deps = makeDeps(fixture, state);
    // `wt rm` plus `wt new` is minutes of out-of-process work, and the lease is
    // five. Somebody else takes it while that runs.
    deps.runWt = async (args) => {
      deps.calls.wt.push(args);
      if (args[0] === 'rm') fs.rmSync(fixture.worktree, { recursive: true, force: true });
      else fs.mkdirSync(fixture.worktree, { recursive: true });
      agents.writeRecord('sandboxes', {
        launchLease: { at: Date.now(), by: 'another-tick', requestId: 'area-sandboxes-g9' },
      }, { root: fixture.root });
      return { ok: true, stdout: fixture.worktree + '\n', error: '' };
    };
    const report = sandboxes(await tick(fixture, deps));
    assert.equal(report.launch.state, 'skipped');
    assert.match(report.launch.reason, /launch lease was lost/);
    assert.equal(deps.calls.opens.length, 0, 'nothing was spawned');
    assert.equal(report.delivery.state, 'skipped');
    assert.equal(report.restart.state, 'not-due');
    // Not a failed attempt either: it never tried, so it must not burn one.
    assert.equal(record(fixture).launch.attempts, 0);
    assert.equal(record(fixture).launchLease.by, 'another-tick', 'and the thief keeps its lease');
  } finally { cleanup(fixture.root); }
});

test('the lease is renewed across the worktree steps, so a slow build keeps its claim', async () => {
  const fixture = makeRoot();
  try {
    const state = { panes: [], sessions: [], worktreeReady: false };
    const deps = makeDeps(fixture, state);
    deps.runWt = async (args) => {
      deps.calls.wt.push(args);
      if (args[0] === 'rm') fs.rmSync(fixture.worktree, { recursive: true, force: true });
      else fs.mkdirSync(fixture.worktree, { recursive: true });
      return { ok: true, stdout: fixture.worktree + '\n', error: '' };
    };
    const renewals = [];
    deps.renewLaunchLease = (name, root, at, by, d) => {
      renewals.push(by);
      return areaSession.renewLaunchLease(name, root, at, by, d);
    };
    const report = sandboxes(await tick(fixture, deps));
    assert.equal(report.launch.state, 'launched');
    // Once after the worktree work, once immediately before the spawn.
    assert.equal(renewals.length, 2);
    assert.equal(new Set(renewals).size, 1, 'the same holder both times');
    assert.equal(record(fixture).launchLease, null, 'and released at the end');
  } finally { cleanup(fixture.root); }
});

test('a message carries its own delivery key, so an older identical batch cannot answer for it', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [{ at: NOW - 5 * MINUTE, kind: 'incident-fired', card: 'inc-a', title: 'Sandbox Open Health' }]);
    const state = { panes: [livePane()], sessions: [idleSession()] };
    const deps = makeDeps(fixture, state);
    const first = sandboxes(await tick(fixture, deps));
    assert.equal(first.delivery.state, 'sent');
    assert.match(deps.calls.sends[0].text, /^\[keep\] delivery agent:sandboxes:seq:1-1$/m);
    assert.equal(cursor(fixture), 1);

    // The same event again: every rendered line is identical, so without the key
    // the two messages would be the same string and the first one's transcript
    // entry would answer for the second.
    agents.emit('sandboxes', { at: NOW - 5 * MINUTE, kind: 'incident-fired', card: 'inc-a', title: 'Sandbox Open Health' },
      { root: fixture.root, now: NOW });
    // This one is confirmed by the transport but its cursor write dies, so the
    // next tick has to recover it — which is where the transcript is consulted.
    state.writeError = (patch) => (patch.lastDeliveredSeq ? new Error('disk went away') : null);
    const second = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(second.delivery.state, 'sent');
    assert.match(deps.calls.sends[1].text, /^\[keep\] delivery agent:sandboxes:seq:2-2$/m);
    assert.notEqual(deps.calls.sends[1].text, deps.calls.sends[0].text, 'two batches, two messages');
    assert.equal(cursor(fixture), 1, 'the cursor write died');

    // Now prove the key is what makes the recovery specific. A transcript that
    // only ever saw the FIRST batch must not satisfy the second's retry.
    const onlyFirst = makeDeps(fixture, { panes: [livePane()], sessions: [idleSession()] });
    onlyFirst.transcriptShows = (session, text) => text === deps.calls.sends[0].text;
    const stillOwed = sandboxes(await tick(fixture, onlyFirst, { now: NOW + 2 * MINUTE }));
    assert.equal(stillOwed.delivery.state, 'sent');
    assert.notEqual(stillOwed.delivery.delivery, 'found-in-transcript',
      'the first batch\'s entry did not answer for the second');
    assert.equal(onlyFirst.calls.types.length, 1, 'so the second batch was actually sent');
    assert.equal(cursor(fixture), 2);
  } finally { cleanup(fixture.root); }
});

test('a retry with no usable transcript check defers instead of typing', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [{ at: NOW - MINUTE, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox Open Health' }]);
    const state = {
      panes: [livePane()], sessions: [idleSession()],
      sendError: new Error('Delivery unconfirmed: no matching transcript receipt.'),
    };
    const deps = makeDeps(fixture, state);
    assert.equal(sandboxes(await tick(fixture, deps)).delivery.state, 'deferred');
    assert.equal(deps.calls.types.length, 1);
    assert.equal(areaSession.pendingDeliveryOf(record(fixture)).state, 'sending');
    state.sendError = null;

    // Not wired at all. Without an answer there is no way to tell an arrived
    // batch from a lost one, and both guesses are wrong in their own way, so the
    // only safe move is to wait.
    delete deps.transcriptShows;
    const unwired = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(unwired.delivery.state, 'deferred');
    assert.match(unwired.delivery.reason, /no transcript check is wired/);
    assert.equal(deps.calls.types.length, 1, 'nothing more was typed');
    assert.equal(cursor(fixture), 0);
    assert.ok(deps.calls.notes.some((line) => line.includes('no transcript check is wired')));

    // Wired but broken: same answer.
    deps.transcriptShows = () => { throw new Error('EACCES: the transcript is unreadable'); };
    const broken = sandboxes(await tick(fixture, deps, { now: NOW + 2 * MINUTE }));
    assert.equal(broken.delivery.state, 'deferred');
    assert.match(broken.delivery.reason, /transcript could not be read/);
    assert.equal(deps.calls.types.length, 1);
    assert.ok(deps.calls.notes.some((line) => line.includes('could not read the session transcript')));

    // Wired but evasive: anything that is not a plain yes or no is "could not
    // tell", which is a reason to wait rather than to guess.
    deps.transcriptShows = () => null;
    const evasive = sandboxes(await tick(fixture, deps, { now: NOW + 3 * MINUTE }));
    assert.equal(evasive.delivery.state, 'deferred');
    assert.match(evasive.delivery.reason, /gave no answer/);
    assert.equal(deps.calls.types.length, 1);

    // And a straight answer lets it move again.
    deps.transcriptShows = () => false;
    const answered = sandboxes(await tick(fixture, deps, { now: NOW + 4 * MINUTE }));
    assert.equal(answered.delivery.state, 'sent');
    assert.equal(cursor(fixture), 1);
  } finally { cleanup(fixture.root); }
});

test('a confirmed delivery does not pin the session open for good', async () => {
  const fixture = makeRoot();
  try {
    feed(fixture, [{ at: NOW - 9 * HOUR, kind: 'incident-opened', card: 'inc-a', title: 'Sandbox Open Health' }],
      { startedAt: NOW - 9 * HOUR });
    const state = quietState(9);
    const deps = makeDeps(fixture, state);
    // Deliver, and confirm it.
    const sent = sandboxes(await tick(fixture, deps));
    assert.equal(sent.delivery.state, 'sent');
    assert.equal(areaSession.pendingDeliveryOf(record(fixture)).state, 'confirmed');
    // That delivery is this session's last activity, so it is not idle yet.
    assert.equal(sent.restart.state, 'not-due');

    // Wind every clock back past the window. The batch on the record is the
    // record of what was last delivered, not work still owed, so a caught-up
    // idle session restarts — it used to be pinned open by its own success.
    agents.writeRecord('sandboxes', { lastDeliveredAt: NOW - 9 * HOUR }, { root: fixture.root });
    const later = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(later.delivery.state, 'nothing');
    assert.equal(later.restart.state, 'closed');
    assert.equal(deps.calls.closes.length, 1);

    // A batch that is genuinely still owed keeps blocking it, as it should.
    agents.writeRecord('sandboxes', {
      session: { id: 'sess-1', pane: 'pane-1', startedAt: NOW - 9 * HOUR },
      lastDeliveredAt: NOW - 9 * HOUR,
      pendingDelivery: {
        key: 'agent:sandboxes:seq:9-9', firstSeq: 9, lastSeq: 9, offset: 0, count: 1,
        text: 'still owed', at: NOW - 9 * HOUR, state: 'sending',
      },
    }, { root: fixture.root });
    const owed = makeDeps(fixture, quietState(9));
    owed.transcriptShows = () => false;
    const blocked = sandboxes(await tick(fixture, owed, { now: NOW + 2 * MINUTE }));
    assert.equal(blocked.restart.state, 'not-due');
    assert.match(blocked.restart.reason, /undelivered/);
    assert.equal(owed.calls.closes.length, 0);
  } finally { cleanup(fixture.root); }
});

// ---------- restart from the log ----------

function idleFor(fixture, hours, options = {}) {
  agents.ensure('sandboxes', {
    role: 'incident-responder', area: 'sandboxes',
    lastDeliveredSeq: 0, lastDeliveredAt: 0,
    session: { id: 'sess-1', pane: 'pane-1', startedAt: NOW - hours * HOUR },
    ...options,
  }, { root: fixture.root });
}

// A pane and a session whose every activity clock is older than `hours`.
function quietState(hours = 3) {
  const at = NOW - hours * HOUR;
  return {
    panes: [livePane('pane-1', 'sess-1', { lastOutputAt: at, lastInputAt: at })],
    sessions: [idleSession('sess-1', 'pane-1', at)],
    open: [],
  };
}

test('an idle session with nothing open is closed gracefully, and the next tick opens a fresh one', async () => {
  const fixture = makeRoot();
  try {
    idleFor(fixture, 3);
    const state = quietState(3);
    const deps = makeDeps(fixture, state);
    const closed = sandboxes(await tick(fixture, deps));
    assert.equal(closed.restart.state, 'closed');
    assert.equal(deps.calls.closes.length, 1);
    assert.deepEqual(deps.calls.closes[0].body, { sessionId: 'sess-1', pane: 'pane-1' });
    // The area's own idle window, not zero: closeIdleSession's elapsed-activity
    // checks are a second opinion this decision wants, not one it should waive.
    assert.deepEqual(deps.calls.closes[0].closeDeps.closePolicy,
      { automatic: true, idleMs: 120 * MINUTE });
    const saved = record(fixture);
    assert.equal(saved.session.id, '', 'the record drops the session it closed');
    assert.equal(saved.lifecycle, 'idle');

    state.panes = [];
    state.sessions = [];
    // A record made under an older default keeps saying so until a launch
    // proves otherwise: the relaunch records what it actually ran on.
    agents.writeRecord('sandboxes', { model: 'fable' }, { root: fixture.root });
    const relaunched = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(relaunched.launch.state, 'launched');
    assert.equal(deps.calls.opens.length, 1);
    assert.equal(deps.calls.opens[0].body.model, 'opus');
    assert.equal(record(fixture).model, 'opus');
    assert.equal(record(fixture).account, 'claude-secondary');
  } finally { cleanup(fixture.root); }
});

test('a session that just finished a turn is not closed, however long ago it started', async () => {
  const fixture = makeRoot();
  try {
    idleFor(fixture, 9);
    // Started nine hours ago, but the transcript moved two minutes ago: it has
    // been working, not sitting there. Idle is measured from real activity.
    const state = { ...quietState(9), sessions: [idleSession('sess-1', 'pane-1', NOW - 2 * MINUTE)] };
    const deps = makeDeps(fixture, state);
    const busy = sandboxes(await tick(fixture, deps));
    assert.equal(busy.restart.state, 'not-due');
    assert.match(busy.restart.reason, /idle for 2m of 120m/);
    assert.equal(deps.calls.closes.length, 0);

    // Same for the pane's own clocks.
    state.sessions = [idleSession('sess-1', 'pane-1', NOW - 9 * HOUR)];
    state.panes = [livePane('pane-1', 'sess-1', { lastOutputAt: NOW - 3 * MINUTE, lastInputAt: NOW - 9 * HOUR })];
    const echoing = sandboxes(await tick(fixture, deps));
    assert.equal(echoing.restart.state, 'not-due');
    assert.match(echoing.restart.reason, /idle for 3m of 120m/);
    assert.equal(deps.calls.closes.length, 0);

    // A confirmed delivery counts too.
    agents.writeRecord('sandboxes', { lastDeliveredAt: NOW - 5 * MINUTE }, { root: fixture.root });
    state.panes = quietState(9).panes;
    const delivered = sandboxes(await tick(fixture, deps));
    assert.equal(delivered.restart.state, 'not-due');
    assert.match(delivered.restart.reason, /idle for 5m of 120m/);
  } finally { cleanup(fixture.root); }
});

test('an open incident in any of the agent’s areas keeps its session', async () => {
  const fixture = makeRoot();
  try {
    // Both areas route to one agent: `sandboxes` has the session, `app-server`
    // merely feeds it. An incident in either is this agent's work.
    const fixtureRoot = fixture.root;
    fs.writeFileSync(path.join(fixtureRoot, 'watch', 'incidents.json'), JSON.stringify({
      areas: {
        sandboxes: { project: fixture.project, match: ['^Sandbox '], session: true, account: 'claude-secondary' },
        'app-server': { project: path.join(fixtureRoot, 'checkouts', 'ghost-server'), default: true, agent: 'sandboxes' },
      },
      quietMin: 60, reopenHours: 24,
    }));
    idleFor(fixture, 9);
    const state = quietState(9);
    state.open = [{ signature: 'grafana:server-faults', card: 'inc-b', area: 'app-server', title: 'Server Faults' }];
    const deps = makeDeps(fixture, state);
    const held = sandboxes(await tick(fixture, deps));
    assert.equal(held.restart.state, 'not-due');
    assert.match(held.restart.reason, /open incident in app-server/);
    assert.equal(deps.calls.closes.length, 0);

    // Its own area counts the same way.
    state.open = [{ signature: 'grafana:sandbox-open-health', card: 'inc-a', area: 'sandboxes', title: 'Sandbox Open Health' }];
    assert.equal(sandboxes(await tick(fixture, deps)).restart.state, 'not-due');
    assert.equal(deps.calls.closes.length, 0);

    // An area that is not this agent's is not its reason to stay up.
    state.open = [{ signature: 'grafana:multiplayer', card: 'inc-c', area: 'multiplayer', title: 'Multiplayer' }];
    assert.equal(sandboxes(await tick(fixture, deps)).restart.state, 'closed');
    assert.equal(deps.calls.closes.length, 1);
  } finally { cleanup(fixture.root); }
});

test('two areas that both want a session as one agent are a config error, and neither runs', async () => {
  const fixture = makeRoot({ appServer: { session: true, agent: 'sandboxes' } });
  try {
    const deps = makeDeps(fixture, { panes: [], sessions: [] });
    const result = await areaSession.tick({ root: fixture.root, now: NOW }, deps);
    assert.equal(result.areas.length, 2);
    for (const row of result.areas) assert.match(row.error, /both want a session as agent sandboxes/);
    assert.equal(deps.calls.opens.length, 0, 'neither area is half-served');
    assert.equal(agents.readRecord('sandboxes', fixture.root), null);
    // Reported once for the agent, not once per area.
    assert.equal(deps.calls.notes.filter((line) => line.includes('both want a session')).length, 1);
  } finally { cleanup(fixture.root); }
});

test('a session is not restarted before its idle window, mid-turn, or with events waiting', async () => {
  const fixture = makeRoot();
  try {
    idleFor(fixture, 1);
    const state = quietState(1);
    const deps = makeDeps(fixture, state);
    const early = sandboxes(await tick(fixture, deps));
    assert.equal(early.restart.state, 'not-due');
    assert.match(early.restart.reason, /idle for 60m of 120m/);
    assert.equal(deps.calls.closes.length, 0);

    // Past the window, but mid-turn.
    agents.writeRecord('sandboxes', { session: { startedAt: NOW - 5 * HOUR } }, { root: fixture.root });
    Object.assign(state, quietState(5));
    state.sessions = [{ ...idleSession('sess-1', 'pane-1', NOW - 5 * HOUR), endedTurn: false }];
    const busy = sandboxes(await tick(fixture, deps));
    assert.equal(busy.restart.state, 'not-due');
    assert.match(busy.restart.reason, /mid-turn/);
    assert.equal(deps.calls.closes.length, 0);

    // Idle again, but a batch is still undelivered.
    Object.assign(state, quietState(5));
    state.sendError = new Error('pane is busy typing');
    agents.emit('sandboxes', { at: NOW - MINUTE, kind: 'incident-opened', card: 'inc-a' }, { root: fixture.root, now: NOW });
    const pending = sandboxes(await tick(fixture, deps));
    assert.equal(pending.delivery.state, 'deferred');
    assert.equal(pending.restart.state, 'not-due');
    assert.match(pending.restart.reason, /undelivered/);
    assert.equal(deps.calls.closes.length, 0);

    // And still not, once that batch is merely pending on the record.
    state.sendError = null;
    state.sendResult = { truncated: true, received: 10, expected: 300 };
    const half = sandboxes(await tick(fixture, deps));
    assert.equal(half.restart.state, 'not-due');
    assert.equal(deps.calls.closes.length, 0);
  } finally { cleanup(fixture.root); }
});

test('a refused close is final for the tick and leaves the session running', async () => {
  const fixture = makeRoot();
  try {
    idleFor(fixture, 3);
    const state = quietState(3);
    state.closeError = new Error('Pane has recent or unknown output activity');
    const deps = makeDeps(fixture, state);
    const refused = sandboxes(await tick(fixture, deps));
    assert.equal(refused.restart.state, 'refused');
    assert.match(refused.restart.reason, /recent or unknown output/);
    assert.equal(deps.calls.closes.length, 1, 'refused once, not retried inside the tick');
    assert.equal(record(fixture).session.id, 'sess-1', 'the session it could not close is still its session');
    assert.equal(deps.calls.opens.length, 0, 'and no replacement is opened for it');
  } finally { cleanup(fixture.root); }
});

test('restartAfterIdleMin is read off the area', async () => {
  const fixture = makeRoot({ restartAfterIdleMin: 30 });
  try {
    assert.equal(incidents.config(fixture.root).areas.sandboxes.restartAfterIdleMin, 30);
    idleFor(fixture, 1);
    const deps = makeDeps(fixture, quietState(1));
    assert.equal(sandboxes(await tick(fixture, deps)).restart.state, 'closed');
    assert.equal(deps.calls.closes[0].closeDeps.closePolicy.idleMs, 30 * MINUTE);
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

// ---------- daemon hygiene ----------

test('a tick with nothing to do writes nothing and asks for no commit', async () => {
  const fixture = makeRoot();
  try {
    idleFor(fixture, 0);
    agents.writeRecord('sandboxes', { session: { startedAt: NOW - MINUTE } }, { root: fixture.root });
    fs.mkdirSync(path.join(fixture.root, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, 'agents', 'sandboxes.md'), '# already here\n');
    const deps = makeDeps(fixture, {
      panes: [livePane('pane-1', 'sess-1', { lastOutputAt: NOW - MINUTE, lastInputAt: NOW - MINUTE })],
      sessions: [idleSession('sess-1', 'pane-1', NOW - MINUTE)],
      open: [],
    });
    // A live session, nothing on the feed, nothing due: the quiet case, which is
    // most of them.
    // The fixture's own writes marked the agent dirty; the tick under test is the
    // only thing that may leave it that way.
    agents.flushCommits(fixture.root);
    const before = fs.readFileSync(agents.recordFile('sandboxes', fixture.root), 'utf8');
    const quiet = sandboxes(await tick(fixture, deps));
    assert.equal(quiet.launch.state, 'live');
    assert.equal(quiet.delivery.state, 'nothing');
    assert.equal(quiet.restart.state, 'not-due');
    assert.equal(quiet.changed, false);
    assert.deepEqual(deps.calls.writes, [], 'no record write at all');
    assert.equal(fs.readFileSync(agents.recordFile('sandboxes', fixture.root), 'utf8'), before);
    assert.equal(deps.calls.flushes, 0, 'and no commit was asked for');
    assert.equal(agents.pendingNames(fixture.root).length, 0);

    // One that does something asks for exactly one commit.
    agents.emit('sandboxes', { at: NOW, kind: 'incident-opened', card: 'inc-a' }, { root: fixture.root, now: NOW });
    const busy = sandboxes(await tick(fixture, deps, { now: NOW + MINUTE }));
    assert.equal(busy.delivery.state, 'sent');
    assert.equal(busy.changed, true);
    assert.equal(deps.calls.flushes, 1);
  } finally { cleanup(fixture.root); }
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
    assert.deepEqual(deps.calls.writes, [], 'no lease, no record, no cursor');
    assert.equal(agents.readRecord('sandboxes', fixture.root), null, 'no record');
    assert.equal(fs.existsSync(path.join(fixture.root, 'agents', 'sandboxes.md')), false, 'no recipe');
    assert.ok(areaSession.describe(report).join('\n').includes('would-launch'));

    // A dry run over a live, idle, quiet session says what it would close, and
    // does not close it; over a session with a batch waiting, what it would send.
    idleFor(fixture, 3);
    const live = makeDeps(fixture, quietState(3));
    const quiet = sandboxes(await tick(fixture, live, { dry: true, force: true }));
    assert.equal(quiet.restart.state, 'would-close');
    assert.equal(live.calls.closes.length, 0);

    agents.emit('sandboxes', { at: NOW, kind: 'incident-opened', card: 'inc-a' }, { root: fixture.root, now: NOW });
    const waiting = makeDeps(fixture, quietState(3));
    // A dry run takes no lease and touches nothing in the delivery directory; it
    // reports the batch it would have claimed the lease to send.
    const batch = sandboxes(await tick(fixture, waiting, { dry: true, force: true }));
    assert.equal(batch.delivery.state, 'would-send');
    assert.equal(batch.delivery.count, 1);
    assert.match(batch.delivery.note, /would claim the delivery lease and send agent:sandboxes:seq:1-1/);
    assert.equal(waiting.calls.sends.length, 0);
    assert.equal(cursor(fixture), 0);
    assert.equal(areaSession.pendingDeliveryOf(record(fixture)), null);
    assert.equal(record(fixture).deliveryLease, undefined, 'and no lease was taken');
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
    '--account claude-secondary', 'keep hold castle-sandboxes', 'keep who castle-sandboxes',
  ]) {
    assert.ok(text.includes(fragment), `the recipe covers ${fragment}`);
  }
  for (const heading of ['## Identity and scope', '## Log first, always', '## Act like the on-call engineer',
    '### Judgement, and what waits for Owner', '### Decisions are still recorded',
    '## Badging', '## Overlap', '## Untrusted input', '## Budget', '## Ending the turn']) {
    assert.ok(text.includes(heading), `the recipe has ${heading}`);
  }
});

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

    const outside = makeDeps(fixture, { panes: [], sessions: [], insideWorktreeRoot: false });
    const refused = sandboxes(await tick(fixture, outside));
    assert.equal(refused.launch.state, 'failed');
    assert.match(refused.launch.reason, /worktree root/);
    assert.equal(outside.calls.opens.length, 0);
    assert.equal(record(fixture).launchLease, null, 'a failed launch still releases the lease');
  } finally { cleanup(fixture.root); }
});

test('a tick never throws into the poll, whatever a dep does', async () => {
  const fixture = makeRoot();
  try {
    const deps = makeDeps(fixture, { panes: [], sessions: [] });
    const broken = makeDeps(fixture, { panes: [], sessions: [] });
    broken.openSession = () => { throw new Error('boom'); };
    const second = await areaSession.tickQuietly({ root: fixture.root, area: 'sandboxes', now: NOW }, broken);
    assert.equal(second.areas.length, 1);
    assert.equal(sandboxes(second).launch.state, 'failed');

    const missing = await areaSession.tickQuietly({ root: fixture.root, area: 'nowhere', now: NOW }, deps);
    assert.match(missing.areas[0].error, /no area nowhere/);

    const noConfig = await areaSession.tickQuietly({ root: fixture.root, now: NOW },
      { ...deps, config: () => { throw new Error('unreadable incidents.json'); } });
    assert.match(noConfig.error, /unreadable/);
  } finally { cleanup(fixture.root); }
});
