'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function codexDateDir(configDir) {
  const now = new Date();
  return path.join(configDir, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
}

function writeCodexRollout(configDir, sid, cwd) {
  const dir = codexDateDir(configDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-test-${sid}.jsonl`);
  const at = new Date().toISOString();
  fs.writeFileSync(file, [
    { type: 'session_meta', timestamp: at, payload: { id: sid, cwd } },
    { type: 'event_msg', timestamp: at, payload: { type: 'user_message', message: `work in ${cwd}` } },
    { type: 'event_msg', timestamp: at, payload: { type: 'agent_message', message: `done in ${cwd}` } },
    { type: 'event_msg', timestamp: at, payload: { type: 'task_complete' } },
  ].map(JSON.stringify).join('\n') + '\n');
  return file;
}

function writeCleanLedger(root, agent, sid, file) {
  const stat = fs.statSync(file);
  const dir = path.join(root, '.keep', 'background-jobs', agent, sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, jobs: {}, calls: {}, notices: {},
    gap: false, recovering: false, checkpoint: { offset: stat.size, mtime: stat.mtimeMs }, source: { agent, sid, file } }));
}

test('dashboard worker freezes an unchanged settled exit and still publishes its exact source', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-settled-integration-'));
  try {
    const root = path.join(home, 'keep');
    const project = path.join(home, '.claude', 'projects', '-work');
    const sid = 'settled-integration';
    const transcript = path.join(project, `${sid}.jsonl`);
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(root, 'archive'), { recursive: true });
    const at = new Date().toISOString();
    const rows = [
      { type: 'mode', mode: 'normal', sessionId: sid },
      { type: 'user', sessionId: sid, timestamp: at, cwd: '/work', message: { content: 'Finish it' } },
      { type: 'assistant', sessionId: sid, timestamp: at,
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Final answer remains visible' }] } },
      { type: 'user', sessionId: sid, timestamp: at, message: { content: '<command-name>/exit</command-name>' } },
      { type: 'user', sessionId: sid, timestamp: at, message: { content: '<local-command-stdout>Goodbye!</local-command-stdout>' } },
    ];
    fs.writeFileSync(transcript, `${rows.map(JSON.stringify).join('\n')}\n`);
    const sourceStat = fs.statSync(transcript);
    const ledgerDir = path.join(root, '.keep', 'background-jobs', 'claude', sid);
    fs.mkdirSync(ledgerDir, { recursive: true });
    const crypto = require('node:crypto');
    const anchorBytes = fs.readFileSync(transcript).subarray(-Math.min(64, sourceStat.size));
    const sourceId = `${crypto.createHash('sha256').update(path.resolve(transcript)).digest('hex')}:${sourceStat.dev}:${sourceStat.ino}`;
    const ledgerFile = path.join(ledgerDir, 'state.json');
    fs.writeFileSync(ledgerFile, JSON.stringify({ version: 1, jobs: {}, calls: {}, notices: {}, gap: false, recovering: false,
      checkpoint: { identity: sourceId, offset: sourceStat.size, mtime: sourceStat.mtimeMs,
        anchor: crypto.createHash('sha256').update(anchorBytes).digest('hex') },
      source: { agent: 'claude', sid, file: transcript } }));
    const script = `
      require('./bin/summarize').getSummary = () => ({ text: null });
      require('./bin/titles').applyLiveTitles = () => {};
      const fs = require('node:fs');
      const lifecycle = require('./bin/session-lifecycle');
      let lifecycleReads = 0;
      const realLifecycleRead = lifecycle.read;
      lifecycle.read = (...args) => { lifecycleReads++; return realLifecycleRead(...args); };
      const realReadFile = fs.readFileSync;
      const realOpen = fs.openSync;
      let transcriptOpens = 0, ledgerReads = 0;
      fs.openSync = (...args) => { if (args[0] === ${JSON.stringify(transcript)}) transcriptOpens++; return realOpen(...args); };
      fs.readFileSync = (...args) => { if (args[0] === ${JSON.stringify(ledgerFile)}) ledgerReads++; return realReadFile(...args); };
      const serve = require('./bin/serve');
      const pane = { id: 'pane-old', pid: 10, agentPid: 11, alive: false, agentAlive: false,
        createdAt: ${JSON.stringify(at)}, exitedAt: ${JSON.stringify(at)},
        meta: { sessionId: ${JSON.stringify(sid)}, agent: 'claude', accountId: 'claude/default' } };
      const build = () => { const targets=[]; const state=serve.buildState({ dashboard:true, dashboardWorker:true,
        hostPanes:[pane], collectBackgroundTargets:targets, collectSummaryRequests:[], collectHealthErrors:[],
        dashboardRuntime:{ health:{}, runs:[], usage:null, digest:null } });
        return { session:state.sessions.find(x=>x.id===${JSON.stringify(sid)}), source:targets.find(x=>x.sid===${JSON.stringify(sid)})?.file }; };
      const first=build(), counts=[transcriptOpens,lifecycleReads,ledgerReads], second=build();
      pane.alive=true; pane.agentAlive=true; pane.agentPid=12;
      fs.appendFileSync(${JSON.stringify(transcript)}, JSON.stringify({type:'user',sessionId:${JSON.stringify(sid)},timestamp:new Date().toISOString(),message:{content:'Resume'}})+'\\n');
      serve.invalidateDashboardSources({kind:'claude',root:${JSON.stringify(path.join(home, '.claude', 'projects'))},name:'-work/${sid}.jsonl'});
      const resumed=build();
      process.stdout.write(JSON.stringify({ first, second, counts, after:[transcriptOpens,lifecycleReads,ledgerReads], resumed }));
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, HOME: home, KEEP_DIR: root, KEEP_CONFIG: '' },
      encoding: 'utf8', timeout: 20000,
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.first.session.lastAssistantFull, 'Final answer remains visible');
    assert.equal(result.second.session.lastAssistantFull, 'Final answer remains visible');
    assert.equal(result.second.source, transcript, 'cached rows keep exact per-build summary authority');
    assert.deepEqual(result.after.slice(0, 3).map((value, i) => value - result.counts[i]), [1, 1, 1],
      'only the later resumed build rereads transcript, lifecycle, and ledger; the unchanged exited build adds zero');
    assert.equal(result.resumed.session.runtime.state, 'live');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('exited sessions with uncertain job history keep reading the ledger on every build', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-settled-uncertain-'));
  try {
    const root = path.join(home, 'keep');
    const project = path.join(home, '.claude', 'projects', '-work');
    const sid = 'uncertain-integration';
    const transcript = path.join(project, `${sid}.jsonl`);
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(root, 'archive'), { recursive: true });
    const at = new Date().toISOString();
    fs.writeFileSync(transcript, [
      { type: 'mode', mode: 'normal', sessionId: sid },
      { type: 'user', sessionId: sid, timestamp: at, cwd: '/work', message: { content: 'Finish it' } },
      { type: 'assistant', sessionId: sid, timestamp: at,
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] } },
      { type: 'user', sessionId: sid, timestamp: at, message: { content: '<command-name>/exit</command-name>' } },
      { type: 'user', sessionId: sid, timestamp: at, message: { content: '<local-command-stdout>Goodbye!</local-command-stdout>' } },
    ].map(JSON.stringify).join('\n') + '\n');
    writeCleanLedger(root, 'claude', sid, transcript);
    const ledger = path.join(root, '.keep', 'background-jobs', 'claude', sid, 'state.json');
    const state = JSON.parse(fs.readFileSync(ledger, 'utf8'));
    state.gap = true;
    fs.writeFileSync(ledger, JSON.stringify(state));
    const script = `
      require('./bin/summarize').getSummary=()=>({text:null}); require('./bin/titles').applyLiveTitles=()=>{};
      const fs=require('node:fs'); let ledgerReads=0; const read=fs.readFileSync;
      fs.readFileSync=(f,...a)=>{if(f===${JSON.stringify(ledger)})ledgerReads++;return read(f,...a)};
      const serve=require('./bin/serve'); const pane={id:'pane-old',pid:1,agentPid:2,alive:false,agentAlive:false,
        createdAt:${JSON.stringify(at)},exitedAt:${JSON.stringify(at)},
        meta:{sessionId:${JSON.stringify(sid)},agent:'claude',accountId:'claude/default'}};
      const build=()=>serve.buildState({dashboard:true,dashboardWorker:true,hostPanes:[pane],collectBackgroundTargets:[],
        collectSummaryRequests:[],collectHealthErrors:[],dashboardRuntime:{health:{},runs:[],usage:null,digest:null}})
        .sessions.find(x=>x.id===${JSON.stringify(sid)});
      const first=build(),afterFirst=ledgerReads,second=build();
      process.stdout.write(JSON.stringify({afterFirst,ledgerReads,first:first.unknownBackgroundJobs,second:second.unknownBackgroundJobs}));
    `;
    const child = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'),
      env: { ...process.env, HOME: home, KEEP_DIR: root, KEEP_CONFIG: '' }, encoding: 'utf8', timeout: 20000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.afterFirst, 1);
    assert.equal(result.ledgerReads, 2, 'uncertain ledgers are never served from the settled cache');
    assert.ok(result.first.includes('history-gap'));
    assert.ok(result.second.includes('history-gap'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Codex authority switch refreshes text and exact source without a watcher event', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-settled-account-'));
  try {
    const root = path.join(home, 'keep');
    const a = path.join(home, '.codex-a'), b = path.join(home, '.codex-b');
    const sid = 'shared-codex';
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(root, 'archive'), { recursive: true });
    const fileA = writeCodexRollout(a, sid, '/account-a');
    const fileB = writeCodexRollout(b, sid, '/account-b');
    writeCleanLedger(root, 'codex', sid, fileA);
    const config = path.join(home, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
      { id: 'codex-a', label: 'A', agent: 'codex', configDir: a },
      { id: 'codex-b', label: 'B', agent: 'codex', configDir: b },
    ], defaultAccounts: { codex: 'codex-a' } }));
    const authorityDir = path.join(root, '.keep', 'session-accounts');
    fs.mkdirSync(authorityDir, { recursive: true });
    const authorityFile = path.join(authorityDir, `${sid}.json`);
    const pin = (accountId) => fs.writeFileSync(authorityFile, JSON.stringify({ version: 1, sessionId: sid,
      agent: 'codex', accountId, updatedAt: Date.now() }));
    pin('codex-a');
    const script = `
      require('./bin/summarize').getSummary=()=>({text:null}); require('./bin/titles').applyLiveTitles=()=>{};
      const fs=require('node:fs'), serve=require('./bin/serve');
      const pane={id:'pane-shared',pid:1,agentPid:2,alive:false,agentAlive:false,createdAt:new Date().toISOString(),
        exitedAt:new Date().toISOString(),meta:{sessionId:${JSON.stringify(sid)},agent:'codex'}};
      const build=()=>{const targets=[];const state=serve.buildState({dashboard:true,dashboardWorker:true,hostPanes:[pane],
        collectBackgroundTargets:targets,collectSummaryRequests:[],collectHealthErrors:[],dashboardRuntime:{health:{},runs:[],usage:null,digest:null}});
        const session=state.sessions.find(x=>x.id===${JSON.stringify(sid)}); const target=targets.find(x=>x.sid===${JSON.stringify(sid)});
        return {project:session?.project,answer:session?.lastAssistantFull,account:session?.accountId,file:target?.file};};
      const first=build();
      fs.writeFileSync(${JSON.stringify(authorityFile)},JSON.stringify({version:1,sessionId:${JSON.stringify(sid)},agent:'codex',accountId:'codex-b',updatedAt:Date.now()}));
      const second=build(); process.stdout.write(JSON.stringify({first,second}));
    `;
    const child = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'),
      env: { ...process.env, HOME: home, KEEP_DIR: root, KEEP_CONFIG: config }, encoding: 'utf8', timeout: 20000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.deepEqual(result.first, { project: '/account-a', answer: 'done in /account-a', account: 'codex-a', file: fileA });
    assert.deepEqual(result.second, { project: '/account-b', answer: 'done in /account-b', account: 'codex-b', file: fileB });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('old host-backed Codex session uses the settled cache and exact rollout source', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-settled-old-codex-'));
  try {
    const root = path.join(home, 'keep'), configDir = path.join(home, '.codex');
    const sid = 'old-host-codex';
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(root, 'archive'), { recursive: true });
    const file = writeCodexRollout(configDir, sid, '/old-project');
    const old = new Date(Date.now() - 3 * 86400e3); fs.utimesSync(file, old, old);
    writeCleanLedger(root, 'codex', sid, file);
    const config = path.join(home, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
      { id: 'codex-only', label: 'Codex', agent: 'codex', configDir },
    ], defaultAccounts: { codex: 'codex-only' } }));
    const ledger = path.join(root, '.keep', 'background-jobs', 'codex', sid, 'state.json');
    const script = `
      require('./bin/summarize').getSummary=()=>({text:null}); require('./bin/titles').applyLiveTitles=()=>{};
      const fs=require('node:fs'), lifecycle=require('./bin/codex-lifecycle'); let lifecycleReads=0,ledgerReads=0;
      const state=lifecycle.state; lifecycle.state=(...a)=>{lifecycleReads++;return state(...a)};
      const read=fs.readFileSync; fs.readFileSync=(f,...a)=>{if(f===${JSON.stringify(ledger)})ledgerReads++;return read(f,...a)};
      const serve=require('./bin/serve'); const pane={id:'pane-old',pid:1,agentPid:2,alive:false,agentAlive:false,
        createdAt:new Date().toISOString(),exitedAt:new Date().toISOString(),meta:{sessionId:${JSON.stringify(sid)},agent:'codex',accountId:'codex-only'}};
      const build=()=>{const targets=[];const value=serve.buildState({dashboard:true,dashboardWorker:true,hostPanes:[pane],
        collectBackgroundTargets:targets,collectSummaryRequests:[],collectHealthErrors:[],dashboardRuntime:{health:{},runs:[],usage:null,digest:null}});
        return {session:value.sessions.find(x=>x.id===${JSON.stringify(sid)}),file:targets.find(x=>x.sid===${JSON.stringify(sid)})?.file};};
      const first=build(), before={lifecycleReads,ledgerReads}, second=build();
      process.stdout.write(JSON.stringify({first:{id:first.session?.id,file:first.file},second:{id:second.session?.id,file:second.file},before,after:{lifecycleReads,ledgerReads}}));
    `;
    const child = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'),
      env: { ...process.env, HOME: home, KEEP_DIR: root, KEEP_CONFIG: config }, encoding: 'utf8', timeout: 20000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.deepEqual(result.first, { id: sid, file });
    assert.deepEqual(result.second, result.first);
    assert.deepEqual(result.after, result.before, 'unchanged old host backfill adds no lifecycle or ledger reads');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('actual dashboard build preserves exact source targets for more than 300 old sessions', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-settled-many-sources-'));
  try {
    const root = path.join(home, 'keep'), project = path.join(home, '.claude', 'projects', '-bulk');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(root, 'archive'), { recursive: true });
    const panes = [], expected = {};
    const old = new Date(Date.now() - 3 * 86400e3);
    for (let i = 0; i < 320; i++) {
      const sid = `bulk-${String(i).padStart(3, '0')}`, file = path.join(project, `${sid}.jsonl`);
      fs.writeFileSync(file, [
        { type: 'mode', mode: 'normal', sessionId: sid },
        { type: 'user', sessionId: sid, timestamp: old.toISOString(), cwd: '/bulk', message: { content: `task ${i}` } },
        { type: 'assistant', sessionId: sid, timestamp: old.toISOString(), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: `done ${i}` }] } },
      ].map(JSON.stringify).join('\n') + '\n');
      fs.utimesSync(file, old, old); writeCleanLedger(root, 'claude', sid, file); expected[sid] = file;
      panes.push({ id: `pane-${i}`, pid: i + 1, agentPid: i + 1000, alive: false, agentAlive: false,
        createdAt: old.toISOString(), exitedAt: old.toISOString(), meta: { sessionId: sid, agent: 'claude', accountId: 'claude/default' } });
    }
    const script = `
      require('./bin/summarize').getSummary=()=>({text:null}); require('./bin/titles').applyLiveTitles=()=>{};
      const serve=require('./bin/serve'),panes=${JSON.stringify(panes)},targets=[];
      serve.buildState({dashboard:true,dashboardWorker:true,hostPanes:panes,collectBackgroundTargets:targets,
        collectSummaryRequests:[],collectHealthErrors:[],dashboardRuntime:{health:{},runs:[],usage:null,digest:null}});
      process.stdout.write(JSON.stringify(Object.fromEntries(targets.map(x=>[x.sid,x.file]))));
    `;
    const child = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'),
      env: { ...process.env, HOME: home, KEEP_DIR: root, KEEP_CONFIG: '' }, encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), expected);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
