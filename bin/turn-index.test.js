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
