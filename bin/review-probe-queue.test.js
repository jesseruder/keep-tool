'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('queue backoff leaves cursors intact and yields to human, result, card, Git and attention changes', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-probe-queue-')));
  const source = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const cp = require('node:child_process');
    const root = process.env.KEEP_DIR;
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    cp.execFileSync('git', ['init', '-q', project]);
    cp.execFileSync('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'initial']);
    const file = path.join(root, 'probe.jsonl');
    require('./bin/transcripts').findSessionFile = () => file;
    const keep = require('./bin/keep.js');
    const task = { id: 'probe-fixture', fm: { title: 'Probe', project, status: 'active', sessions: [{ id: 'probe-worker', agent: 'claude' }] }, body: '' };
    keep.loadAll = () => [task];
    const review = require('./bin/review');
    const probes = require('./bin/review-probes');
    const now = Date.now();
    const rows = [
      { type:'user', isMeta:true, promptSource:'system', scheduledTaskId:'cron', scheduledFireId:'fire', message:{content:'Check'} },
      { type:'assistant', message:{content:[{type:'tool_use',id:'call',name:'mcp__browser__read',input:{tab:1}}],stop_reason:'tool_use'} },
      { type:'user', message:{content:[{type:'tool_result',tool_use_id:'call',content:'pending'}]} },
      { type:'assistant', message:{content:[{type:'text',text:'Still pending'}],stop_reason:'end_turn'} }
    ];
    const write = () => fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\\n')+'\\n');
    write();
    const candidate = probes.combineProbes([{id:'probe-worker',probe:probes.scanProbes(rows)}]);
    const state = review.emptyState(task.id);
    state.lastReviewedAt = now - 31*60e3;
    state.lastStatus = 'active';
    state.sessions = {'probe-worker':{offset:0}};
    const git = review.gitState(project, '');
    state.git = {sha:git.head,dirtyHash:git.dirtyHash};
    state.probe = probes.acknowledgeProbe(probes.acknowledgeProbe(null,candidate,true,now),candidate,false,now);
    review.saveState(state);
    const queue = () => review.reviewQueue({minScore:-100});
    assert.equal(queue().skips['probe-backoff'],1);
    assert.equal(review.loadState(task.id).sessions['probe-worker'].offset,0);
    rows[2].message.content[0].content='approved'; write();
    assert.equal(queue().skips['probe-backoff'],0);
    rows[2].message.content[0].content='pending'; write();
    rows.push({type:'user',message:{content:'Please change the plan'}}); write();
    assert.equal(queue().skips['probe-backoff'],0);
    rows.pop(); write();
    task.fm.status='blocked'; assert.equal(queue().skips['probe-backoff'],0); task.fm.status='active';
    fs.writeFileSync(path.join(project,'new-code.js'),'changed');
    assert.equal(queue().skips['probe-backoff'],0);
    fs.unlinkSync(path.join(project,'new-code.js'));
    fs.mkdirSync(path.join(root,'.keep','attention'),{recursive:true});
    fs.writeFileSync(path.join(root,'.keep','attention','probe-worker.json'),JSON.stringify({type:'question'}));
    assert.equal(queue().skips['probe-backoff'],0);
    fs.unlinkSync(path.join(root,'.keep','attention','probe-worker.json'));
    assert.equal(queue().skips['probe-backoff'],1);
    rows[2].message.content[0].is_error=true; write();
    assert.equal(queue().skips['probe-backoff'],0);
    assert.equal(review.loadState(task.id).sessions['probe-worker'].offset,0);
    // A concurrent outcome lands after bundle gathering began but before staging.
    keep.loadTask = () => task;
    const lock = keep.withLock;
    let injected = false;
    keep.withLock = fn => {
      if (!injected) {
        injected = true;
        const fresh = review.loadState(task.id);
        fresh.findings['0123456789abcdef'] = { kind: 'other', subject: 'race', outcome: { status: 'incorrect', message: 'Correction landed', evidence: 'owner check-in' } };
        review.saveState(fresh);
      }
      return lock(fn);
    };
    assert.throws(() => review.buildBundle(task.id, { force: true }), /review state changed/);
    assert.equal(review.loadState(task.id).findings['0123456789abcdef'].outcome.status, 'incorrect');
    assert.equal(review.loadState(task.id).sessions['probe-worker'].offset, 0);
    keep.withLock = lock;
    assert.match(review.buildBundle(task.id, { force: true }).md, /Correction landed/);
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', source], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, KEEP_DIR: root, KEEP_ALLOW_PUSH: '0' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
