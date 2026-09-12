'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
