'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const turnIndex = require('./turn-index.js');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-turn-index-'));
  const priorDb = process.env.KEEP_TURN_INDEX_DB;
  // The index must never read or write the operator's real registry from a test.
  process.env.KEEP_TURN_INDEX_DB = path.join(dir, 'turns.sqlite');
  t.after(() => {
    turnIndex.close();
    if (priorDb === undefined) delete process.env.KEEP_TURN_INDEX_DB;
    else process.env.KEEP_TURN_INDEX_DB = priorDb;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function jsonl(records) {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

const SESSION = '11111111-2222-3333-4444-555555555555';

function claudeUser(text, extra = {}) {
  return {
    type: 'user', sessionId: SESSION, cwd: '/tmp/demo-project', timestamp: extra.timestamp,
    message: { role: 'user', content: text }, ...extra,
  };
}

function claudeRecords() {
  return [
    { type: 'summary', summary: 'Demo session', leafUuid: 'x' },
    claudeUser('<environment_details/>', { timestamp: '2026-09-10T00:00:00.000Z', isMeta: true }),
    claudeUser('<command-name>/clear</command-name>', { timestamp: '2026-09-10T00:00:01.000Z' }),
    claudeUser('Please fix the flaky screen reload test', { timestamp: '2026-09-10T00:01:00.000Z' }),
    {
      type: 'assistant', sessionId: SESSION, cwd: '/tmp/demo-project', timestamp: '2026-09-10T00:01:05.000Z',
      message: {
        role: 'assistant', stop_reason: 'tool_use', usage: { input_tokens: 120, output_tokens: 44 },
        content: [
          { type: 'text', text: 'Reading the test first.' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/demo-project/bin/host.test.js' } },
          { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'git commit -am "host: settle reload"' } },
        ],
      },
    },
    claudeUser([
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' },
      { type: 'tool_result', tool_use_id: 'tool-2', content: '[wt/turn-index 1a2b3c4] host: settle reload\n 1 file changed' },
    ], { timestamp: '2026-09-10T00:01:09.000Z' }),
    {
      type: 'assistant', sessionId: SESSION, cwd: '/tmp/demo-project', timestamp: '2026-09-10T00:01:20.000Z',
      message: {
        role: 'assistant', stop_reason: 'end_turn', usage: { input_tokens: 300, output_tokens: 60 },
        content: [{ type: 'text', text: 'Committed the fix.' }],
      },
    },
    // A subagent's own conversation, written inline into the parent's file.
    { type: 'assistant', sessionId: SESSION, isSidechain: true, timestamp: '2026-09-10T00:01:25.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'sidechain noise' }] } },
    claudeUser('[keep] Your card kt-1 has a next step.', { timestamp: '2026-09-10T00:02:00.000Z' }),
    {
      type: 'assistant', sessionId: SESSION, cwd: '/tmp/demo-project', timestamp: '2026-09-10T00:02:30.000Z',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Step two done.' }] },
    },
  ];
}

const CODEX_SESSION = '0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function codexRecords() {
  return [
    { type: 'session_meta', timestamp: '2026-09-10T01:00:00.000Z', payload: {
      id: CODEX_SESSION, cwd: '/tmp/demo-project', timestamp: '2026-09-10T01:00:00.000Z',
      originator: 'codex-tui', source: 'cli',
    } },
    { type: 'response_item', timestamp: '2026-09-10T01:00:01.000Z', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\ncwd=/tmp\n</environment_context>' }],
    } },
    { type: 'response_item', timestamp: '2026-09-10T01:00:02.000Z', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Port the reload guard to the console' }],
    } },
    { type: 'response_item', timestamp: '2026-09-10T01:00:03.000Z', payload: {
      type: 'function_call', name: 'shell', call_id: 'call-1',
      arguments: JSON.stringify({ command: ['bash', '-lc', 'git commit -m "console: guard reload"'] }),
    } },
    { type: 'response_item', timestamp: '2026-09-10T01:00:04.000Z', payload: {
      type: 'function_call_output', call_id: 'call-1', output: '[master abcdef1] console: guard reload\n',
    } },
    { type: 'response_item', timestamp: '2026-09-10T01:00:05.000Z', payload: {
      type: 'agent_message', text: 'Guard ported and committed.',
    } },
    { type: 'event_msg', timestamp: '2026-09-10T01:00:06.000Z', payload: { type: 'task_complete' } },
    { type: 'response_item', timestamp: '2026-09-10T01:01:00.000Z', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }],
    } },
    { type: 'response_item', timestamp: '2026-09-10T01:01:10.000Z', payload: {
      type: 'agent_message', text: 'Nothing left to do.',
    } },
    { type: 'event_msg', timestamp: '2026-09-10T01:01:11.000Z', payload: { type: 'task_complete' } },
  ];
}

test('a Claude transcript indexes its turns, kinds, files and commits', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, jsonl(claudeRecords()));

  const result = turnIndex.ingestFile(file, { agent: 'claude' });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, SESSION);

  const session = turnIndex.sessionRow(SESSION);
  assert.equal(session.agent, 'claude');
  assert.equal(session.kind, 'interactive');
  assert.equal(session.cwd, '/tmp/demo-project');
  assert.equal(session.title, 'Demo session');
  assert.equal(session.project, '/tmp/demo-project');

  const db = turnIndex.open();
  const kinds = db.prepare('SELECT role, kind, text FROM messages ORDER BY seq').all();
  assert.deepEqual(kinds.map((row) => `${row.role}/${row.kind}`), [
    'user/meta', 'user/command', 'user/human',
    'assistant/text', 'assistant/tool_use', 'assistant/tool_use',
    'tool/tool_result', 'tool/tool_result',
    'assistant/text',
    'user/keep', 'assistant/text',
  ], 'sidechain records belong to the subagent, not the parent conversation');

  const turns = turnIndex.turnsForSession(SESSION);
  assert.deepEqual(turns.map((turn) => turn.n), [1, 2, 3]);
  assert.deepEqual(turns.map((turn) => turn.opener_kind), ['command', 'human', 'keep']);
  const work = turns[1];
  assert.equal(work.tool_count, 2);
  assert.deepEqual(JSON.parse(work.tools), ['Read', 'Bash']);
  assert.deepEqual(JSON.parse(work.files), ['/tmp/demo-project/bin/host.test.js']);
  assert.deepEqual(JSON.parse(work.commits), ['1a2b3c4']);
  assert.equal(work.stop_reason, 'end_turn');
  assert.equal(work.ended, 1);
  assert.equal(work.last_assistant, 'Committed the fix.');
  assert.match(work.assistant_text, /Reading the test first[\s\S]*Committed the fix\./);

  const usage = db.prepare("SELECT tokens_in, tokens_out FROM messages WHERE kind = 'text' AND role = 'assistant' ORDER BY seq").all();
  assert.equal(usage[0].tokens_in, 120);
  assert.equal(usage[0].tokens_out, 44);
});

test('a Codex rollout indexes preambles, tool calls and task_complete turns', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, `rollout-2026-09-10T01-00-00-${CODEX_SESSION}.jsonl`);
  fs.writeFileSync(file, jsonl(codexRecords()));

  const result = turnIndex.ingestFile(file);
  assert.equal(result.ok, true);
  assert.equal(result.agent, 'codex', 'a rollout- filename identifies the agent without an explicit option');
  assert.equal(result.sessionId, CODEX_SESSION);

  const session = turnIndex.sessionRow(CODEX_SESSION);
  assert.equal(session.kind, 'interactive');
  assert.equal(session.cwd, '/tmp/demo-project');

  const db = turnIndex.open();
  assert.deepEqual(
    db.prepare('SELECT role, kind FROM messages ORDER BY seq').all().map((row) => `${row.role}/${row.kind}`),
    ['user/preamble', 'user/human', 'assistant/tool_use', 'tool/tool_result', 'assistant/text',
      'user/human', 'assistant/text'],
  );

  const turns = turnIndex.turnsForSession(CODEX_SESSION);
  assert.equal(turns.length, 2, 'a preamble never opens a turn');
  assert.equal(turns[0].opener_text, 'Port the reload guard to the console');
  assert.equal(turns[0].tool_count, 1);
  assert.deepEqual(JSON.parse(turns[0].tools), ['shell']);
  assert.deepEqual(JSON.parse(turns[0].commits), ['abcdef1']);
  assert.equal(turns[0].ended, 1);
  assert.equal(turns[0].stop_reason, 'task_complete');
  assert.equal(turns[1].opener_text, 'continue');

  const call = db.prepare("SELECT command FROM messages WHERE kind = 'tool_use'").get();
  assert.equal(call.command, 'git commit -m "console: guard reload"');
});

test('a subagent rollout and a keep headless run are classified apart from conversations', (t) => {
  const dir = tempDir(t);
  const child = path.join(dir, 'rollout-2026-09-10T02-00-00-0199ffff-1111-2222-3333-444444444444.jsonl');
  fs.writeFileSync(child, jsonl([
    { type: 'session_meta', timestamp: '2026-09-10T02:00:00.000Z', payload: {
      id: '0199ffff-1111-2222-3333-444444444444', cwd: '/tmp/demo-project', thread_source: 'subagent',
    } },
    { type: 'response_item', timestamp: '2026-09-10T02:00:01.000Z', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Investigate the flake' }],
    } },
  ]));
  assert.equal(turnIndex.ingestFile(child).ok, true);
  assert.equal(turnIndex.sessionRow('0199ffff-1111-2222-3333-444444444444').kind, 'subagent');

  const headlessId = '99999999-8888-7777-6666-555555555555';
  const headless = path.join(dir, `${headlessId}.jsonl`);
  fs.writeFileSync(headless, jsonl([
    claudeUser('You are running a scheduled status check for the task "demo".', {
      sessionId: headlessId, timestamp: '2026-09-10T03:00:00.000Z',
    }),
  ]).replace(new RegExp(SESSION, 'g'), headlessId));
  assert.equal(turnIndex.ingestFile(headless, { agent: 'claude' }).ok, true);
  assert.equal(turnIndex.sessionRow(headlessId).kind, 'headless');

  // Owner's own `claude -p` batch jobs and Keep's tab naming open the same way.
  const batchId = '99999999-8888-7777-6666-000000000001';
  const batch = path.join(dir, `${batchId}.jsonl`);
  fs.writeFileSync(batch, jsonl([
    claudeUser('You are naming the tab of a coding session. The input has two labeled parts.', {
      sessionId: batchId, timestamp: '2026-09-10T03:01:00.000Z',
    }),
  ]).replace(new RegExp(SESSION, 'g'), batchId));
  assert.equal(turnIndex.ingestFile(batch, { agent: 'claude' }).ok, true);
  assert.equal(turnIndex.sessionRow(batchId).kind, 'headless');
});

test('ingest is incremental, idempotent, and resets after truncation', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, `${SESSION}.jsonl`);
  const records = claudeRecords();
  fs.writeFileSync(file, jsonl(records.slice(0, 6)));
  const first = turnIndex.ingestFile(file, { agent: 'claude' });
  assert.equal(first.messages, 8);

  const db = turnIndex.open();
  const countMessages = () => db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  const countTurns = () => db.prepare('SELECT COUNT(*) AS n FROM turns').get().n;
  assert.equal(countMessages(), 8);

  // Re-ingesting an unchanged file is a no-op, not a second copy.
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude' }).skipped, 'unchanged');
  assert.equal(countMessages(), 8);

  fs.appendFileSync(file, jsonl(records.slice(6)));
  const second = turnIndex.ingestFile(file, { agent: 'claude' });
  assert.equal(second.messages, 3);
  assert.equal(countMessages(), 11);
  assert.equal(countTurns(), 3);
  // The turn that was open across both passes is completed from its own messages.
  const work = turnIndex.turnsForSession(SESSION)[1];
  assert.equal(work.tool_count, 2);
  assert.equal(work.last_assistant, 'Committed the fix.');

  // A partial trailing line is left for the next pass rather than parsed as JSON.
  fs.appendFileSync(file, '{"type":"user","sessionId":"');
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude' }).messages, 0);
  assert.equal(countMessages(), 11);

  fs.writeFileSync(file, jsonl(records.slice(0, 4)));
  const third = turnIndex.ingestFile(file, { agent: 'claude' });
  assert.equal(third.ok, true);
  assert.equal(countMessages(), 3, 'truncation discards the stale rows for that session');
  assert.equal(countTurns(), 2);
  // The FTS shadow table is only correct if the deletes ran through its trigger.
  assert.equal(turnIndex.search('Committed').length, 0);
  assert.equal(turnIndex.search('flaky').length, 1);
});

test('search finds indexed text and stats count nudges', (t) => {
  const dir = tempDir(t);
  const claudeFile = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(claudeFile, jsonl(claudeRecords()));
  turnIndex.ingestFile(claudeFile, { agent: 'claude' });
  const codexFile = path.join(dir, `rollout-2026-09-10T01-00-00-${CODEX_SESSION}.jsonl`);
  fs.writeFileSync(codexFile, jsonl(codexRecords()));
  turnIndex.ingestFile(codexFile);

  const hits = turnIndex.search('flaky');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].session_id, SESSION);
  assert.equal(hits[0].role, 'user');
  assert.match(hits[0].snippet, /\[flaky\]/);

  // Hyphens and colons are FTS5 operators; a plain query is quoted per token.
  assert.doesNotThrow(() => turnIndex.search('home-only staging: user1'));
  assert.equal(turnIndex.search('home-only').length, 0);
  assert.equal(turnIndex.search('flaky OR reload', { raw: true }).length >= 2, true);

  assert.equal(turnIndex.search('reload', { project: '/tmp/demo-project' }).length > 0, true);
  assert.equal(turnIndex.search('reload', { project: '/nowhere' }).length, 0);
  assert.equal(turnIndex.search('reload', { agent: 'codex' }).every((row) => row.agent === 'codex'), true);

  const summary = turnIndex.stats();
  assert.equal(summary.totals.sessions, 2);
  assert.equal(summary.totals.turns, 5);
  assert.equal(summary.totals.keepOpeners, 1);
  assert.equal(summary.totals.humanOpeners, 3);
  assert.equal(summary.totals.nudges, 1, 'the bare "continue" turn is the nudge');

  const since = turnIndex.stats({ since: Date.parse('2026-09-10T01:00:30.000Z') });
  assert.equal(since.totals.turns, 1);
});

test('the nudge pattern matches restart prompts and spares real instructions', () => {
  for (const text of ['continue', 'Continue.', 'ok continue', 'keep going', 'go ahead',
    'proceed', "what's next", 'check again', 'anything else to do?', 'done']) {
    assert.equal(turnIndex.isNudge(text), true, `expected a nudge: ${text}`);
  }
  for (const text of ['continue with the migration', 'go ahead and delete the branch',
    'done with the review, now write the docs', '']) {
    assert.equal(turnIndex.isNudge(text), false, `expected real work: ${text}`);
  }
});

test('ingestFile swallows a missing file and a directory without throwing', (t) => {
  const dir = tempDir(t);
  assert.deepEqual(turnIndex.ingestFile(path.join(dir, 'absent.jsonl'), { agent: 'claude' }),
    { ok: false, skipped: 'missing' });
  assert.equal(turnIndex.ingestFile(dir, { agent: 'claude' }).skipped, 'not-a-file');
  assert.equal(turnIndex.ingestFile(null).skipped, 'no-file');
  assert.equal(turnIndex.ingestFile('').skipped, 'no-file');
});

test('backfill walks explicit roots and reports a summary', (t) => {
  const dir = tempDir(t);
  const roots = path.join(dir, 'roots');
  fs.mkdirSync(roots, { recursive: true });
  fs.writeFileSync(path.join(roots, `${SESSION}.jsonl`), jsonl(claudeRecords()));
  fs.writeFileSync(path.join(roots, `rollout-2026-09-10T01-00-00-${CODEX_SESSION}.jsonl`), jsonl(codexRecords()));
  fs.writeFileSync(path.join(roots, 'ignored.txt'), 'not a transcript\n');

  const summary = turnIndex.backfill({ roots: [roots], since: 0 });
  assert.equal(summary.files, 2);
  assert.equal(summary.sessions, 2);
  assert.equal(summary.turns, 5);
  assert.equal(summary.skipped, 0);
  assert.equal(typeof summary.seconds, 'number');

  const old = turnIndex.backfill({ roots: [roots], since: Date.now() + 60e3 });
  assert.equal(old.files, 0, 'files older than --since are skipped');
});

test('live-state ingestion uses each session file and tolerates unresolvable ones', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, jsonl(claudeRecords()));
  const result = turnIndex.ingestSessionsFromLiveState([
    { id: SESSION, agent: 'claude', file },
    { id: 'no-such-session', agent: 'codex' },
  ]);
  assert.equal(result.ingested, 1);
  assert.equal(result.skipped, 1);
  assert.equal(turnIndex.turnsForSession(SESSION).length, 3);
});

test('a byte cap turns a big cold read into partial passes that still land every turn', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, `${SESSION}.jsonl`);
  const filler = 'y'.repeat(3000);
  const records = [];
  for (let i = 0; i < 40; i += 1) {
    const at = (n) => new Date(Date.UTC(2026, 8, 10, 0, i, n)).toISOString();
    records.push(claudeUser(`Task ${i}`, { timestamp: at(0) }));
    records.push({
      type: 'assistant', sessionId: SESSION, cwd: '/tmp/demo-project', timestamp: at(1),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `Done ${i}. ${filler}` }] },
    });
  }
  fs.writeFileSync(file, jsonl(records));
  const size = fs.statSync(file).size;
  assert.ok(size > 64 * 1024, 'the fixture must be bigger than the cap under test');

  const first = turnIndex.ingestFile(file, { agent: 'claude', maxBytes: 16 * 1024 });
  assert.equal(first.ok, true);
  assert.equal(first.partial, true, 'a capped pass reports that there is more to read');
  assert.ok(first.bytes < size, 'the cap really stopped short of the whole file');
  assert.ok(first.turns < 40);

  let guard = 0;
  let result = first;
  while (result.partial && (guard += 1) < 500) {
    result = turnIndex.ingestFile(file, { agent: 'claude', maxBytes: 16 * 1024 });
  }
  assert.equal(result.partial, false);

  // Capped passes must produce exactly what one uncapped pass would have.
  const turns = turnIndex.turnsForSession(SESSION, { last: 100 });
  assert.equal(turns.length, 40);
  assert.deepEqual(turns.map((turn) => turn.n), records.filter((row) => row.type === 'user').map((_, i) => i + 1));
  assert.equal(turns[0].last_assistant.startsWith('Done 0.'), true);
  assert.equal(turns[39].last_assistant.startsWith('Done 39.'), true);
  assert.equal(turns.every((turn) => turn.ended === 1), true);
  assert.equal(turnIndex.open().prepare('SELECT COUNT(*) AS n FROM messages').get().n, 80);
});

test('a single line longer than the cap still completes rather than stalling', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, jsonl([
    claudeUser('Read the enormous log', { timestamp: '2026-09-10T00:00:00.000Z' }),
    {
      type: 'assistant', sessionId: SESSION, cwd: '/tmp/demo-project', timestamp: '2026-09-10T00:00:01.000Z',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'z'.repeat(200000) }] },
    },
  ]));
  // A 1 KiB budget against a 200 KB record: dropping it would lose a real message.
  let result = turnIndex.ingestFile(file, { agent: 'claude', maxBytes: 1024 });
  let guard = 0;
  while (result.partial && (guard += 1) < 20) result = turnIndex.ingestFile(file, { agent: 'claude', maxBytes: 1024 });
  assert.equal(result.partial, false);
  assert.equal(turnIndex.open().prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);
});

test('a held write lock is skipped quietly instead of making a hook wait', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, jsonl(claudeRecords()));
  turnIndex.ingestFile(file, { agent: 'claude' });

  // A second connection holding the write lock is exactly what a hook races with.
  const { DatabaseSync } = require('node:sqlite');
  const blocker = new DatabaseSync(process.env.KEEP_TURN_INDEX_DB);
  blocker.exec('PRAGMA busy_timeout = 0');
  blocker.exec('BEGIN IMMEDIATE');
  blocker.exec("INSERT INTO sessions (id, agent, kind) VALUES ('blocker', 'claude', 'interactive')");
  try {
    fs.appendFileSync(file, jsonl([claudeUser('one more', { timestamp: '2026-09-10T00:05:00.000Z' })]));
    const startedAt = Date.now();
    const result = turnIndex.ingestFile(file, { agent: 'claude', busyTimeoutMs: 50, maxBytes: 4 * 1024 * 1024 });
    const elapsed = Date.now() - startedAt;
    assert.equal(result.ok, false);
    assert.equal(result.skipped, 'busy', 'a locked database is skipped quietly, never thrown');
    assert.ok(elapsed < 2000, `a hook must not wait on the lock (waited ${elapsed} ms)`);
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
  }
  // The delta is not lost: the next pass picks it up.
  const after = turnIndex.ingestFile(file, { agent: 'claude' });
  assert.equal(after.ok, true);
  assert.equal(after.messages, 1);
});

test('a subagent transcript is its own session and never overwrites its parent', (t) => {
  const dir = tempDir(t);
  const project = path.join(dir, '-Users-demo-project');
  const subagents = path.join(project, SESSION, 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  const parentFile = path.join(project, `${SESSION}.jsonl`);
  fs.writeFileSync(parentFile, jsonl(claudeRecords()));
  assert.equal(turnIndex.ingestFile(parentFile, { agent: 'claude' }).ok, true);
  const parentBefore = turnIndex.sessionRow(SESSION);
  assert.equal(parentBefore.kind, 'interactive');
  assert.equal(parentBefore.file, parentFile);
  const parentTurns = turnIndex.turnsForSession(SESSION).length;

  // Real subagent records carry the PARENT uuid in sessionId, their own identity
  // in agentId, and isSidechain on every line.
  const agentFile = path.join(subagents, 'agent-abc123.jsonl');
  const sub = (extra) => ({
    isSidechain: true, agentId: 'abc123', sessionId: SESSION, cwd: '/tmp/demo-project', ...extra,
  });
  fs.writeFileSync(agentFile, jsonl([
    sub({ type: 'user', timestamp: '2026-09-10T00:10:00.000Z', message: { role: 'user', content: 'Investigate the flake' } }),
    sub({ type: 'assistant', timestamp: '2026-09-10T00:10:05.000Z', message: {
      role: 'assistant', stop_reason: 'tool_use', content: [
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 's1', name: 'Read', input: { file_path: '/tmp/demo-project/a.js' } },
      ] } }),
    sub({ type: 'user', timestamp: '2026-09-10T00:10:06.000Z', message: {
      role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: 'ok' }] } }),
    sub({ type: 'assistant', timestamp: '2026-09-10T00:10:09.000Z', message: {
      role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'It is a load flake.' }] } }),
  ]));
  const result = turnIndex.ingestFile(agentFile, { agent: 'claude' });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'abc123', 'identity comes from agentId, not the parent uuid');

  const child = turnIndex.sessionRow('abc123');
  assert.equal(child.kind, 'subagent');
  assert.equal(child.parent_id, SESSION);
  assert.equal(child.file, agentFile);
  const childTurns = turnIndex.turnsForSession('abc123');
  assert.equal(childTurns.length, 1, 'sidechain records in a subagent file ARE the conversation');
  assert.equal(childTurns[0].tool_count, 1);
  assert.equal(childTurns[0].last_assistant, 'It is a load flake.');

  const parentAfter = turnIndex.sessionRow(SESSION);
  assert.equal(parentAfter.kind, 'interactive', 'the parent is not relabelled by its subagent');
  assert.equal(parentAfter.file, parentFile, 'the parent row still points at the parent transcript');
  assert.equal(turnIndex.turnsForSession(SESSION).length, parentTurns);

  // A reset of the subagent file must reach only the subagent's own rows.
  fs.writeFileSync(agentFile, jsonl([
    sub({ type: 'user', timestamp: '2026-09-10T00:11:00.000Z', message: { role: 'user', content: 'Start over' } }),
  ]));
  assert.equal(turnIndex.ingestFile(agentFile, { agent: 'claude' }).ok, true);
  assert.equal(turnIndex.turnsForSession('abc123').length, 1);
  assert.equal(turnIndex.turnsForSession(SESSION).length, parentTurns, 'the parent keeps every turn it had');
  assert.equal(
    turnIndex.open().prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(SESSION).n, 11,
  );
});

test('a rewritten file is re-indexed even when it never shrinks', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, jsonl([
    claudeUser('First conversation about caching', { timestamp: '2026-09-10T00:00:00.000Z' }),
    { type: 'assistant', sessionId: SESSION, cwd: '/tmp/demo-project', timestamp: '2026-09-10T00:00:05.000Z',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Cached it.' }] } },
  ]));
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude' }).ok, true);
  assert.equal(turnIndex.search('caching').length, 1);

  // Different bytes, and the file never shrinks: the offset alone cannot tell
  // this apart from an ordinary append.
  const replacement = jsonl([
    claudeUser('Second conversation about batching', { timestamp: '2026-09-10T01:00:00.000Z' }),
    { type: 'assistant', sessionId: SESSION, cwd: '/tmp/demo-project', timestamp: '2026-09-10T01:00:05.000Z',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Batched it, and then some.' }] } },
  ]);
  assert.ok(Buffer.byteLength(replacement) >= fs.statSync(file).size,
    'the rewrite must not shrink the file, or truncation detection would catch it instead');
  fs.writeFileSync(file, replacement);

  const result = turnIndex.ingestFile(file, { agent: 'claude' });
  assert.equal(result.ok, true);
  assert.equal(result.reset, true, 'a changed head fingerprint resets the file');
  assert.equal(turnIndex.search('caching').length, 0, 'the replaced conversation is gone');
  assert.equal(turnIndex.search('batching').length, 1);
  assert.equal(turnIndex.turnsForSession(SESSION).length, 1);
  assert.equal(turnIndex.open().prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);
});

test('appending to a transcript smaller than the fingerprint window is not a rewrite', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, jsonl([claudeUser('tiny', { timestamp: '2026-09-10T00:00:00.000Z' })]));
  assert.ok(fs.statSync(file).size < 4096, 'the fixture must be smaller than the fingerprint window');
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude' }).ok, true);
  fs.appendFileSync(file, jsonl([claudeUser('second', { timestamp: '2026-09-10T00:01:00.000Z' })]));
  const result = turnIndex.ingestFile(file, { agent: 'claude' });
  assert.equal(result.reset, undefined, 'growing past the hashed prefix is an append, not a replacement');
  assert.equal(result.messages, 1);
  assert.equal(turnIndex.turnsForSession(SESSION).length, 2);
});

test('the daemon sweep is bounded by time and bytes and resumes where it stopped', (t) => {
  const dir = tempDir(t);
  const sessions = [];
  for (let i = 0; i < 6; i += 1) {
    const id = `feed${i}-2222-3333-4444-555555555555`;
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, jsonl([
      { type: 'user', sessionId: id, cwd: '/tmp/demo-project', timestamp: '2026-09-10T00:00:00.000Z',
        message: { role: 'user', content: `Work on ${i}` } },
      { type: 'assistant', sessionId: id, cwd: '/tmp/demo-project', timestamp: '2026-09-10T00:00:05.000Z',
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `Did ${i}.` }] } },
    ]));
    sessions.push({ id, agent: 'claude', file });
  }
  const indexed = () => turnIndex.open().prepare('SELECT COUNT(DISTINCT session_id) AS n FROM messages').get().n;

  // A zero-millisecond budget stops before the first file rather than running away.
  const none = turnIndex.ingestSessionsFromLiveState(sessions, { budgetMs: 0 });
  assert.equal(none.files, 0);
  assert.equal(none.partial, true);
  assert.equal(indexed(), 0);

  // A byte budget smaller than one file still makes progress, one file per tick.
  const firstTick = turnIndex.ingestSessionsFromLiveState(sessions, { maxBytes: 1 });
  assert.equal(firstTick.files, 1);
  assert.equal(firstTick.partial, true);
  assert.equal(indexed(), 1);
  const secondTick = turnIndex.ingestSessionsFromLiveState(sessions, { maxBytes: 1 });
  assert.equal(secondTick.files, 1);
  assert.equal(indexed(), 2, 'the round-robin cursor moved on rather than redoing the first file');

  const rest = turnIndex.ingestSessionsFromLiveState(sessions);
  assert.equal(rest.partial, false);
  assert.equal(indexed(), 6);
  assert.ok(rest.ms >= 0 && rest.bytes > 0, 'the tick reports what it cost for the health row');
});

test('prune drops sessions last active before the cutoff and leaves the rest whole', (t) => {
  const dir = tempDir(t);
  const oldFile = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(oldFile, jsonl(claudeRecords()));
  turnIndex.ingestFile(oldFile, { agent: 'claude' });

  const freshId = 'aaaa1111-2222-3333-4444-555555555555';
  const freshFile = path.join(dir, `${freshId}.jsonl`);
  const now = new Date().toISOString();
  fs.writeFileSync(freshFile, jsonl([
    { type: 'user', sessionId: freshId, cwd: '/tmp/demo-project', timestamp: now,
      message: { role: 'user', content: 'Still working on the parser' } },
    { type: 'assistant', sessionId: freshId, cwd: '/tmp/demo-project', timestamp: now,
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Parsed.' }] } },
  ]));
  turnIndex.ingestFile(freshFile, { agent: 'claude' });

  const db = turnIndex.open();
  const cutoff = Date.parse('2026-09-11T00:00:00.000Z'); // after the fixture, before now

  const dry = turnIndex.prune({ cutoff, dry: true });
  assert.equal(dry.dry, true);
  assert.equal(dry.sessions, 1);
  assert.equal(dry.messages, 11);
  assert.equal(dry.files, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 13, 'a dry run deletes nothing');

  const pruned = turnIndex.prune({ cutoff });
  assert.equal(pruned.sessions, 1);
  assert.equal(turnIndex.sessionRow(SESSION), null);
  assert.equal(turnIndex.sessionRow(freshId).id, freshId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM turns').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingest_state').get().n, 1);
  // The FTS shadow has to shrink with the real table, or search returns ghosts.
  assert.equal(turnIndex.search('flaky').length, 0);
  assert.equal(turnIndex.search('parser').length, 1);

  // A pruned file is simply re-indexed from zero if it is still on disk.
  const again = turnIndex.ingestFile(oldFile, { agent: 'claude' });
  assert.equal(again.ok, true);
  assert.equal(again.messages, 11);

  // Nothing old enough is a no-op, not an error.
  assert.deepEqual(turnIndex.prune({ cutoff: 0 }),
    { cutoff: 0, sessions: 0, messages: 0, turns: 0, files: 0, more: false });
});

test('a bounded prune drops its limit and says there is more to do', (t) => {
  const dir = tempDir(t);
  for (let i = 0; i < 5; i += 1) {
    const id = `stale${i}-2222-3333-4444-555555555555`;
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, jsonl([
      { type: 'user', sessionId: id, cwd: '/tmp/demo-project', timestamp: `2026-08-0${i + 1}T00:00:00.000Z`,
        message: { role: 'user', content: `Old work ${i}` } },
    ]));
    turnIndex.ingestFile(file, { agent: 'claude' });
  }
  const cutoff = Date.parse('2026-09-01T00:00:00.000Z');
  const db = turnIndex.open();
  const remaining = () => db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;

  // The daemon prunes on its event loop, so a huge first sweep must come in bites.
  const firstSweep = turnIndex.prune({ cutoff, limit: 2 });
  assert.equal(firstSweep.sessions, 2);
  assert.equal(firstSweep.more, true);
  assert.equal(remaining(), 3);
  assert.equal(turnIndex.sessionRow('stale0-2222-3333-4444-555555555555'), null, 'the oldest go first');
  assert.ok(turnIndex.sessionRow('stale4-2222-3333-4444-555555555555'));

  let guard = 0;
  let sweep = firstSweep;
  while (sweep.more && (guard += 1) < 10) sweep = turnIndex.prune({ cutoff, limit: 2 });
  assert.equal(sweep.more, false);
  assert.equal(remaining(), 0);
});

test('a working directory is folded onto its main checkout at most once, ever', (t) => {
  const dir = tempDir(t);
  // Every hook is a fresh process, so an in-process memo would not stop this git
  // subprocess from running on every single turn.
  const wt = require('./wt.js');
  const original = wt.isLinkedWorktree;
  let calls = 0;
  wt.isLinkedWorktree = () => { calls += 1; return false; };
  t.after(() => { wt.isLinkedWorktree = original; });

  const shared = path.join(dir, 'shared-project');
  fs.mkdirSync(shared);
  const write = (id, text, at) => {
    const file = path.join(dir, `${id}.jsonl`);
    fs.appendFileSync(file, jsonl([
      { type: 'user', sessionId: id, cwd: shared, timestamp: at, message: { role: 'user', content: text } },
    ]));
    return file;
  };

  const one = write('proj1111-2222-3333-4444-555555555555', 'first', '2026-09-10T00:00:00.000Z');
  assert.equal(turnIndex.ingestFile(one, { agent: 'claude' }).ok, true);
  assert.equal(calls, 1);

  // A later pass on the same session must not resolve it again.
  write('proj1111-2222-3333-4444-555555555555', 'second', '2026-09-10T00:01:00.000Z');
  assert.equal(turnIndex.ingestFile(one, { agent: 'claude' }).ok, true);
  assert.equal(calls, 1);

  // Nor must a different session in the same directory.
  const two = write('proj2222-2222-3333-4444-555555555555', 'elsewhere', '2026-09-10T00:02:00.000Z');
  assert.equal(turnIndex.ingestFile(two, { agent: 'claude' }).ok, true);
  assert.equal(calls, 1, 'the answer for a directory is cached in the index itself');
  assert.equal(turnIndex.sessionRow('proj2222-2222-3333-4444-555555555555').project, shared);

  // A transcript whose working directory is gone (a recycled worktree) keeps its
  // historical answer: there is nothing better to compute, and paying 110 ms per
  // file to rediscover that would make backfill over old history far slower.
  fs.rmSync(shared, { recursive: true, force: true });
  const three = write('proj3333-2222-3333-4444-555555555555', 'after the worktree went away', '2026-09-10T00:03:00.000Z');
  assert.equal(turnIndex.ingestFile(three, { agent: 'claude' }).ok, true);
  assert.equal(calls, 1);
  assert.equal(turnIndex.sessionRow('proj3333-2222-3333-4444-555555555555').project, shared);
});

test('a session that changes directory is re-resolved and does not poison the cache', (t) => {
  const dir = tempDir(t);
  const from = path.join(dir, 'worktree-a');
  const to = path.join(dir, 'worktree-b');
  fs.mkdirSync(from);
  fs.mkdirSync(to);
  const wt = require('./wt.js');
  const original = wt.isLinkedWorktree;
  wt.isLinkedWorktree = () => false; // every directory canonicalizes to itself
  t.after(() => { wt.isLinkedWorktree = original; });

  const id = 'moved111-2222-3333-4444-555555555555';
  const file = path.join(dir, `${id}.jsonl`);
  const line = (cwd, text, at) => ({
    type: 'user', sessionId: id, cwd, timestamp: at, message: { role: 'user', content: text },
  });
  fs.writeFileSync(file, jsonl([line(from, 'start here', '2026-09-10T00:00:00.000Z')]));
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude' }).ok, true);
  assert.equal(turnIndex.sessionRow(id).project, from);

  // The session moves. Keeping the old project would leave a (new cwd, old
  // project) row, which is exactly what later sessions read as the cache.
  fs.appendFileSync(file, jsonl([line(to, 'moved over', '2026-09-10T00:05:00.000Z')]));
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude' }).ok, true);
  const moved = turnIndex.sessionRow(id);
  assert.equal(moved.cwd, to);
  assert.equal(moved.project, to, 'a changed working directory is re-resolved, not carried over');

  const laterId = 'later111-2222-3333-4444-555555555555';
  const laterFile = path.join(dir, `${laterId}.jsonl`);
  fs.writeFileSync(laterFile, jsonl([{
    type: 'user', sessionId: laterId, cwd: to, timestamp: '2026-09-10T01:00:00.000Z',
    message: { role: 'user', content: 'fresh session in the new directory' },
  }]));
  assert.equal(turnIndex.ingestFile(laterFile, { agent: 'claude' }).ok, true);
  assert.equal(turnIndex.sessionRow(laterId).project, to, 'the cache was not poisoned by the move');
});

test('a cached project whose checkout is gone is recomputed, not trusted', (t) => {
  const dir = tempDir(t);
  const cwd = path.join(dir, 'live-worktree');
  fs.mkdirSync(cwd);
  const wt = require('./wt.js');
  const original = wt.isLinkedWorktree;
  let calls = 0;
  wt.isLinkedWorktree = () => { calls += 1; return false; };
  t.after(() => { wt.isLinkedWorktree = original; });

  // A path can be deleted and reused by a different repository. Seed the row the
  // old repository left behind, pointing at a checkout that is no longer there.
  const db = turnIndex.open();
  db.prepare('INSERT INTO sessions (id, agent, kind, cwd, project, last_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('gone1111-2222-3333-4444-555555555555', 'claude', 'interactive', cwd,
      path.join(dir, 'deleted-main-checkout'), Date.parse('2026-09-01T00:00:00.000Z'));

  const id = 'reuse111-2222-3333-4444-555555555555';
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, jsonl([{
    type: 'user', sessionId: id, cwd, timestamp: '2026-09-10T00:00:00.000Z',
    message: { role: 'user', content: 'new repo, same path' },
  }]));
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude' }).ok, true);
  assert.equal(calls, 1, 'a cached answer naming a missing checkout is not trusted');
  assert.equal(turnIndex.sessionRow(id).project, cwd);
});

test('prune re-checks the cutoff under the lock, so a session that woke up survives', (t) => {
  const dir = tempDir(t);
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const id = `race${i}-2222-3333-4444-555555555555`;
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, jsonl([
      { type: 'user', sessionId: id, cwd: '/tmp/demo-project', timestamp: `2026-08-0${i + 1}T00:00:00.000Z`,
        message: { role: 'user', content: `Old work ${i}` } },
      { type: 'assistant', sessionId: id, cwd: '/tmp/demo-project', timestamp: `2026-08-0${i + 1}T00:00:05.000Z`,
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `Done ${i}.` }] } },
    ]));
    turnIndex.ingestFile(file, { agent: 'claude' });
    ids.push(id);
  }
  const cutoff = Date.parse('2026-09-01T00:00:00.000Z');
  const candidates = turnIndex.pruneCandidates({ cutoff });
  assert.deepEqual(candidates, ids, 'oldest first');

  // Between selection and deletion, a turn lands on the first candidate.
  const db = turnIndex.open();
  db.prepare('UPDATE sessions SET last_at = ? WHERE id = ?').run(Date.now(), ids[0]);

  const result = turnIndex.prune({ cutoff, candidates });
  assert.equal(result.sessions, 2, 'the revived session is not counted');
  assert.equal(result.messages, 4, 'counts report what actually went, not what was planned');
  assert.equal(result.turns, 2);
  assert.ok(turnIndex.sessionRow(ids[0]), 'the revived session survives its own prune batch');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(ids[0]).n, 2,
    'and keeps every row it had');
  assert.equal(turnIndex.sessionRow(ids[1]), null);
  assert.equal(turnIndex.sessionRow(ids[2]), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);
});

test('the caller-supplied busy timeout is in force for schema creation, not just ingest', (t) => {
  const dir = tempDir(t);
  const pragma = (handle) => Number(Object.values(handle.prepare('PRAGMA busy_timeout').get())[0]);

  // Creating the schema takes the write lock, so a hook that specified a quarter
  // second must not sit on the default five while migrations run.
  const handle = turnIndex.open(process.env.KEEP_TURN_INDEX_DB, { busyTimeoutMs: 250 });
  assert.equal(pragma(handle), 250);
  assert.equal(handle.prepare('PRAGMA user_version').get().user_version, turnIndex.SCHEMA_VERSION,
    'the schema really was created under that timeout');

  // And a fresh connection made by ingestFile itself carries the option through.
  turnIndex.close();
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, jsonl(claudeRecords()));
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude', busyTimeoutMs: 250 }).ok, true);
  assert.equal(pragma(turnIndex.open()), 250);

  // A caller that asks for nothing still gets the patient default.
  turnIndex.close();
  assert.equal(pragma(turnIndex.open()), 5000);
});

test('hook output delivered as a user message is Keep talking, not Owner', (t) => {
  const dir = tempDir(t);
  // Codex delivers hook output as a user message wrapped in <hook_prompt …>.
  const codexFile = path.join(dir, `rollout-2026-09-12T01-00-00-${CODEX_SESSION}.jsonl`);
  const codexLine = (text, at) => ({ type: 'response_item', timestamp: at, payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  fs.writeFileSync(codexFile, jsonl([
    { type: 'session_meta', timestamp: '2026-09-12T01:00:00.000Z', payload: {
      id: CODEX_SESSION, cwd: '/tmp/demo-project', timestamp: '2026-09-12T01:00:00.000Z', source: 'cli' } },
    codexLine('Port the reload guard', '2026-09-12T01:00:01.000Z'),
    { type: 'response_item', timestamp: '2026-09-12T01:00:02.000Z', payload: { type: 'agent_message', text: 'Ported.' } },
    codexLine('<hook_prompt hook_run_id="stop:14:abc">[keep] Your card kt-1 has a next step.</hook_prompt>',
      '2026-09-12T01:00:03.000Z'),
    { type: 'response_item', timestamp: '2026-09-12T01:00:04.000Z', payload: { type: 'agent_message', text: 'Continuing.' } },
  ]));
  assert.equal(turnIndex.ingestFile(codexFile).ok, true);

  const db = turnIndex.open();
  const kinds = db.prepare("SELECT kind FROM messages WHERE session_id = ? AND role = 'user' ORDER BY seq")
    .all(CODEX_SESSION).map((row) => row.kind);
  assert.deepEqual(kinds, ['human', 'keep'], 'the hook message is keep, not a second human turn');
  const turns = turnIndex.turnsForSession(CODEX_SESSION);
  assert.deepEqual(turns.map((turn) => turn.opener_kind), ['human', 'keep']);

  // Claude wraps it the same way when a hook injects context.
  const claudeFile = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(claudeFile, jsonl([
    claudeUser('Fix the flaky test', { timestamp: '2026-09-12T02:00:00.000Z' }),
    claudeUser('<hook_prompt hook_run_id="stop:2:xyz">[keep] check in first</hook_prompt>',
      { timestamp: '2026-09-12T02:00:10.000Z' }),
  ]));
  assert.equal(turnIndex.ingestFile(claudeFile, { agent: 'claude' }).ok, true);
  assert.deepEqual(
    db.prepare("SELECT kind FROM messages WHERE session_id = ? AND role = 'user' ORDER BY seq").all(SESSION)
      .map((row) => row.kind),
    ['human', 'keep'],
  );

  // And it is not counted as a human opener anywhere the stats look.
  const summary = turnIndex.stats({ since: 0 });
  assert.equal(summary.totals.humanOpeners, 2);
  assert.equal(summary.totals.keepOpeners, 2);
});

test('a forced re-ingest keeps the verdicts on turns that did not move', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, jsonl(claudeRecords()));
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude' }).ok, true);

  // Judge every turn, the way the watcher would.
  const db = turnIndex.open();
  const judge = (n, verdict, message) => db.prepare(`UPDATE turns SET verdict = ?, verdict_reason = ?,
      verdict_message = ?, state_line = ?, verdict_confidence = ?, verdict_model = ?, verdict_ms = ?,
      verdict_at = ?, decision_id = ?, card_id = ? WHERE session_id = ? AND n = ?`)
    .run(verdict, `reason ${n}`, message, `state ${n}`, 0.5, 'fake-model', 42, 1000 + n, `d-${n}`, 'kt-1', SESSION, n);
  const turnsBefore = turnIndex.turnsForSession(SESSION);
  assert.equal(turnsBefore.length, 3);
  for (const turn of turnsBefore) judge(turn.n, 'continue', `message ${turn.n}`);

  // A forced re-ingest rebuilds every turn row from the same transcript.
  const again = turnIndex.ingestFile(file, { agent: 'claude', force: true });
  assert.equal(again.ok, true);
  assert.equal(again.turns, 3);

  const after = turnIndex.turnsForSession(SESSION);
  assert.equal(after.length, 3);
  for (const turn of after) {
    assert.equal(turn.verdict, 'continue', `turn ${turn.n} kept its verdict`);
    assert.equal(turn.verdict_message, `message ${turn.n}`);
    assert.equal(turn.state_line, `state ${turn.n}`);
    assert.equal(turn.decision_id, `d-${turn.n}`, 'and still points at its ledger entry');
    assert.equal(turn.verdict_model, 'fake-model');
    assert.equal(turn.verdict_confidence, 0.5);
    assert.equal(turn.verdict_at, 1000 + turn.n);
  }
  // The parking table is emptied once the file is fully read.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM turn_verdicts_kept').get().n, 0);
});

test('a verdict is dropped when the assistant side of its turn changed', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, `${SESSION}.jsonl`);
  const at = (m, s) => new Date(Date.UTC(2026, 8, 12, 0, m, s)).toISOString();
  const conversation = (answer) => [
    { type: 'user', sessionId: SESSION, cwd: '/tmp/demo-project', timestamp: at(0, 0),
      message: { role: 'user', content: 'which cap should we use' } },
    { type: 'assistant', sessionId: SESSION, cwd: '/tmp/demo-project', timestamp: at(0, 5),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: answer }] } },
  ];
  fs.writeFileSync(file, jsonl(conversation('I would put the cap on the reader.')));
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude' }).ok, true);

  const db = turnIndex.open();
  const judge = () => db.prepare(`UPDATE turns SET verdict = 'continue', verdict_message = 'yes, do that',
      state_line = 'proposed the reader cap', verdict_at = 5000, decision_id = 'd-1' WHERE session_id = ?`).run(SESSION);
  judge();
  db.prepare("UPDATE sessions SET state_line = 'proposed the reader cap', last_verdict = 'continue', last_verdict_at = 5000 WHERE id = ?").run(SESSION);

  // Same opener, different answer: the verdict judged advice that is no longer
  // what the session said, so it must not be re-attached.
  fs.writeFileSync(file, jsonl(conversation('Actually the cap belongs on the writer.')));
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude', force: true }).ok, true);

  const after = turnIndex.turnsForSession(SESSION);
  assert.equal(after.length, 1);
  assert.equal(after[0].verdict, null, 'a changed assistant side drops the verdict');
  assert.equal(after[0].decision_id, null);
  // And the denormalized session copy stops describing a verdict that is gone.
  const session = turnIndex.sessionRow(SESSION);
  assert.equal(session.state_line, null);
  assert.equal(session.last_verdict, null);
  assert.equal(session.last_verdict_at, null);

  // An unchanged re-ingest keeps both the verdict and the session copy.
  judge();
  db.prepare("UPDATE sessions SET state_line = 'proposed the reader cap', last_verdict = 'continue', last_verdict_at = 5000 WHERE id = ?").run(SESSION);
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude', force: true }).ok, true);
  assert.equal(turnIndex.turnsForSession(SESSION)[0].verdict, 'continue');
  assert.equal(turnIndex.sessionRow(SESSION).state_line, 'proposed the reader cap');
});

test('a verdict is dropped when the tools the turn ran changed', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, `${SESSION}.jsonl`);
  const at = (s) => new Date(Date.UTC(2026, 8, 12, 0, 0, s)).toISOString();
  // Same prose, same number of tool calls, different tools: the judge was shown
  // the tool list, so this is not the turn it judged.
  const conversation = (toolName, filePath) => [
    { type: 'user', sessionId: SESSION, cwd: '/tmp/demo-project', timestamp: at(0),
      message: { role: 'user', content: 'look at the cap' } },
    { type: 'assistant', sessionId: SESSION, cwd: '/tmp/demo-project', timestamp: at(5),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [
        { type: 'text', text: 'Had a look.' },
        { type: 'tool_use', id: 't1', name: toolName, input: { file_path: filePath } },
      ] } },
  ];
  fs.writeFileSync(file, jsonl(conversation('Read', '/tmp/demo-project/a.js')));
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude' }).ok, true);

  const db = turnIndex.open();
  const before = turnIndex.turnsForSession(SESSION)[0];
  assert.equal(before.tool_count, 1);
  assert.equal(before.last_assistant, 'Had a look.');
  const judge = () => db.prepare(`UPDATE turns SET verdict = 'quiet', state_line = 'looked at the cap',
    verdict_at = 9000 WHERE session_id = ?`).run(SESSION);
  judge();

  fs.writeFileSync(file, jsonl(conversation('Write', '/tmp/demo-project/a.js')));
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude', force: true }).ok, true);
  const after = turnIndex.turnsForSession(SESSION)[0];
  assert.equal(after.tool_count, 1, 'same count');
  assert.equal(after.last_assistant, 'Had a look.', 'same prose');
  assert.notDeepEqual(JSON.parse(after.tools), JSON.parse(before.tools), 'different tools');
  assert.equal(after.verdict, null, 'so the verdict does not come back');

  // The same turn re-ingested unchanged still keeps it.
  judge();
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude', force: true }).ok, true);
  assert.equal(turnIndex.turnsForSession(SESSION)[0].verdict, 'quiet');
});

test('a capped re-ingest restores verdicts only once the file is fully read', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, `${SESSION}.jsonl`);
  const filler = 'y'.repeat(3000);
  const records = [];
  for (let i = 0; i < 12; i += 1) {
    const at = (s) => new Date(Date.UTC(2026, 8, 12, 0, i, s)).toISOString();
    records.push({ type: 'user', sessionId: SESSION, cwd: '/tmp/demo-project', timestamp: at(0),
      message: { role: 'user', content: `task ${i}` } });
    records.push({ type: 'assistant', sessionId: SESSION, cwd: '/tmp/demo-project', timestamp: at(5),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `done ${i}. ${filler}` }] } });
  }
  fs.writeFileSync(file, jsonl(records));
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude' }).ok, true);

  const db = turnIndex.open();
  db.prepare("UPDATE turns SET verdict = 'quiet', state_line = 'judged', verdict_at = 7000 WHERE session_id = ?").run(SESSION);
  const judged = db.prepare('SELECT COUNT(*) AS n FROM turns WHERE verdict IS NOT NULL').get().n;
  assert.equal(judged, 12);

  // Force a re-ingest small enough that it takes several passes.
  let result = turnIndex.ingestFile(file, { agent: 'claude', force: true, maxBytes: 8 * 1024 });
  assert.equal(result.partial, true, 'the fixture must need more than one pass');
  let guard = 0;
  while (result.partial && (guard += 1) < 200) {
    // Mid-way, nothing has been restored and the verdicts are still parked.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM turns WHERE verdict IS NOT NULL').get().n, 0,
      'a half-built turn is not compared against its parked verdict');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM turn_verdicts_kept').get().n, 12);
    result = turnIndex.ingestFile(file, { agent: 'claude', maxBytes: 8 * 1024 });
  }
  assert.equal(result.partial, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM turns WHERE verdict IS NOT NULL').get().n, 12,
    'every verdict comes back on the final pass');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM turn_verdicts_kept').get().n, 0);
});

test('a verdict is dropped when the turn it described no longer exists', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, jsonl(claudeRecords()));
  turnIndex.ingestFile(file, { agent: 'claude' });
  const db = turnIndex.open();
  db.prepare("UPDATE turns SET verdict = 'continue', verdict_message = 'keep going', verdict_at = 1 WHERE session_id = ?")
    .run(SESSION);

  // The transcript is rewritten with different openers, so turn 2 is no longer
  // the turn that was judged. A verdict about a turn that moved is worse than
  // none: it would put Owner's decision against text he never saw.
  const rewritten = claudeRecords().map((record) => {
    if (record.type !== 'user' || typeof record.message.content !== 'string') return record;
    return { ...record, message: { ...record.message, content: `${record.message.content} (rewritten)` } };
  });
  fs.writeFileSync(file, jsonl(rewritten));
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude', force: true }).ok, true);

  const after = turnIndex.turnsForSession(SESSION);
  assert.ok(after.length >= 1);
  assert.equal(after.every((turn) => turn.verdict === null), true, 'moved turns lose their verdicts');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM turn_verdicts_kept').get().n, 0, 'and nothing is left parked');
});

test('migration 13 adds the attention columns, and a parked verdict carries them across a re-ingest', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, jsonl(claudeRecords()));
  turnIndex.ingestFile(file, { agent: 'claude' });
  const db = turnIndex.open();

  const attention = ['attention_rule', 'attention_state', 'attention_confidence', 'attention_needs_input'];
  const turns = db.prepare('PRAGMA table_info(turns)').all().map((row) => row.name);
  for (const column of attention) assert.ok(turns.includes(column), `turns.${column} exists`);
  const parked = db.prepare('PRAGMA table_info(turn_verdicts_kept)').all().map((row) => row.name);
  for (const column of attention) assert.ok(parked.includes(column), `turn_verdicts_kept.${column} exists`);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, turnIndex.SCHEMA_VERSION);

  db.prepare(`UPDATE turns SET verdict = 'continue', verdict_message = 'keep going', verdict_at = 1,
      attention_rule = 'prose-request', attention_state = 'needs-input',
      attention_confidence = 'inferred', attention_needs_input = 1
    WHERE session_id = ?`).run(SESSION);

  // The record belongs to the verdict it was taken beside, so an unchanged
  // re-ingest must bring both back or neither.
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude', force: true }).ok, true);
  const after = turnIndex.turnsForSession(SESSION).filter((turn) => turn.verdict);
  assert.ok(after.length, 'the verdicts came back');
  for (const turn of after) {
    assert.equal(turn.attention_rule, 'prose-request');
    assert.equal(turn.attention_state, 'needs-input');
    assert.equal(turn.attention_confidence, 'inferred');
    assert.equal(turn.attention_needs_input, 1);
  }
});

test('the database carries its schema version, fingerprint column and journal limit', (t) => {
  tempDir(t);
  const db = turnIndex.open();
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, turnIndex.SCHEMA_VERSION);
  const columns = db.prepare('PRAGMA table_info(ingest_state)').all().map((row) => row.name);
  assert.ok(columns.includes('head_sha'), 'migration 2 adds the fingerprint column to a fresh database too');
  assert.equal(Object.values(db.prepare('PRAGMA journal_size_limit').get())[0], 64 * 1024 * 1024);
});

test('migration 14 creates sparse indexes for the unjudged watcher queue', (t) => {
  tempDir(t);
  const db = turnIndex.open();
  const indexes = new Map(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index'").all()
    .map((row) => [row.name, row.sql]));
  assert.match(indexes.get('turns_unjudged'), /WHERE ended = 1 AND verdict IS NULL/);
  assert.match(indexes.get('turns_unjudged_started'), /ended_at IS NULL/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 14);
});
