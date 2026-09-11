'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { relatedCards } = require('./review-related');
const { assessment, reportMessage } = require('./review-quality');

test('OOM resolution and explicit successors are retrieved without treating all telemetry as fixed', () => {
  const card = (id, title, project='/sandbox', body='', status='done') => ({ id, fm: { title, project, status }, body });
  const task = card('monitoring','Sandbox monitoring','/sandbox','## 2026-09-02 12:00 — check-in\nOOM classification, teardown re-entry, unknown warm failures. Follow successor-work.', 'active');
  const oom = card('oom','Correct sandbox OOM classification','/sandbox','## 2026-09-03 12:00 — done\nAuthoritative OOM events deployed; commit abc1234.');
  const successor = card('successor-work','Native lifecycle proof','/other');
  const candidates = [task,oom,successor,card('unrelated','Other completed sandbox work'),card('wrong-project','OOM classification','/another')];
  const found = relatedCards(task,candidates,[{ card:'oom',key:'key',outcome:{status:'fixed',message:'Docker events authoritative',evidence:'abc1234'} }]);
  assert.deepEqual(new Set(found.map(c=>c.id)),new Set(['oom','successor-work']));
  assert.match(found.find(c=>c.id==='oom').evidence,/abc1234/);
  assert.equal(found.find(c=>c.id==='oom').outcomes[0].status,'fixed');
  const many=Array.from({length:20},(_,i)=>card('match-'+i,'OOM classification'));
  assert.equal(relatedCards({...task,fm:{...task.fm,depends_on:many.map(c=>c.id)}},many).length,4);
});

test('an unverified authorization allegation is publicly a question and quoted hypothesis', () => {
  const uncertain = {...assessment({basis:'needs-verification',question:'Did an earlier instruction authorize the deployment?',unknown:'Earlier human instructions have not been checked.'}),subject:'production deployment'};
  const text = reportMessage(uncertain,'The session deployed without permission.');
  assert.match(text,/^Open verification question: Did an earlier instruction/);
  assert.match(text,/Still unknown: Earlier human instructions/);
  assert.match(text,/\n> The session deployed without permission\./);
  assert.equal(reportMessage({...uncertain,basis:'observed'},'Verified fact.'),'Verified fact.');
});

test('closing a card after bundle blocks forced notes and ack without consuming evidence; other batch cards still land', () => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'keep-freshness-')));
  const env={...process.env,KEEP_DIR:root,KEEP_PORT:'1',KEEP_ALLOW_PUSH:'0',KEEP_NO_PUSH:'1',KEEP_ALERT_CHANNELS:'none',GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.test',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.test'};
  delete env.KEEP_REVIEWER; delete env.KEEP_REVIEWER_NAME; delete env.CLAUDE_CODE_SESSION_ID; delete env.CODEX_THREAD_ID; delete env.CODEX_SESSION_ID;
  const run=args=>spawnSync(process.execPath,[path.join(__dirname,'keep.js'),...args],{cwd:root,env,encoding:'utf8'});
  const ok=args=>{const r=run(args);assert.equal(r.status,0,r.stderr);return r.stdout;};
  const state=id=>JSON.parse(fs.readFileSync(path.join(root,'.keep','review',id+'.json'),'utf8'));
  const bundle=id=>ok(['review-bundle',id,'--force']).match(/bundle: ([0-9a-f]{8})/)[1];
  try {
    for(const dir of ['tasks','archive','reviews','digests']) fs.mkdirSync(path.join(root,dir));
    spawnSync('git',['init','-q',root]);
    for(const name of ['Sound card','Other card'])ok(['add',name,'--status','active','--project',root,'-m','Started']);
    const b=bundle('sound-card'), other=bundle('other-card');
    ok(['checkin','sound-card','--status','done','-m','Sound fixed and reviewed']);
    const before=state('sound-card');
    const note=['review-note','sound-card','--bundle',b,'--kind','wrong-status','--subject','Still waiting','--force','-m','The sound card is unfinished.'];
    assert.equal(run(note).status,5);
    assert.equal(run(['review-ack','sound-card','--bundle',b]).status,5);
    assert.deepEqual(state('sound-card'),before);
    const landing=path.join(root,'landing.json');
    fs.writeFileSync(landing,JSON.stringify({notes:[{id:'sound-card',bundle:b,kind:'wrong-status',subject:'Still waiting',severity:'low',message:'Unfinished'},{id:'other-card',bundle:other,kind:'other',subject:'Check coverage',severity:'low',message:'Coverage may be missing.',question:'Was the parent suite run?',unknown:'Parent transcript not checked.'},{id:'other-card',bundle:other,kind:'other',subject:'Check authorization',severity:'low',message:'Authorization may exist earlier.',question:'What instruction authorized the action?',unknown:'Earlier instruction not read.'}]}));
    const batch=run(['review-land','--file',landing]);
    assert.match(batch.stdout,/card changed after review evidence/);
    assert.equal(Object.keys(state('sound-card').findings).length,0);
    assert.equal(Object.keys(state('other-card').findings).length,2,'own review notes do not invalidate sibling findings: '+batch.stdout+batch.stderr);
    assert.match(ok(['show','other-card']),/Open verification question: Was the parent suite run/);
    const planBundle=bundle('sound-card');
    ok(['plan','sound-card','--set','New remaining acceptance step']);
    assert.equal(run(['review-ack','sound-card','--bundle',planBundle]).status,5,'plan edits invalidate evidence');
    const rebuilt=bundle('sound-card');ok(['review-ack','sound-card','--bundle',rebuilt]);
    ok(['checkin','sound-card','-m','New owner evidence after acknowledged bundle']);
    assert.equal(run(['review-note','sound-card','--bundle',rebuilt,'--kind','other','--subject','old claim','-m','Old evidence']).status,5,'consumed bundles retain their original evidence fingerprint');
    const current=bundle('sound-card');ok(['review-ack','sound-card','--bundle',current]);
    fs.writeFileSync(landing,JSON.stringify({notes:[
      {id:'sound-card',bundle:rebuilt,kind:'other',subject:'stale batch claim',severity:'low',message:'Old evidence'},
      {id:'sound-card',bundle:current,kind:'other',subject:'current batch claim',severity:'low',message:'Current evidence'},
    ]}));
    const mixed=run(['review-land','--file',landing]);
    assert.match(mixed.stdout,/rebuild/);
    assert.deepEqual(Object.values(state('sound-card').findings).map(f=>f.subject),['current batch claim'],'each note retains its own bundle evidence: '+mixed.stdout+mixed.stderr);
    ok(['add','Plan only','--status','active','--project',root,'--plan','Verify implementation']);
    const planOnly=bundle('plan-only');
    for (const subject of ['first note','sibling note']) {
      ok(['review-note','plan-only','--bundle',planOnly,'--kind','other','--subject',subject,'-m','Check evidence']);
    }
    ok(['review-ack','plan-only','--bundle',planOnly]);
    ok(['add','Sandbox monitoring','--project',root,'--status','active','-m','OOM classification and teardown re-entry need checking.']);
    ok(['add','Correct sandbox OOM classification','--project',root,'--status','done','-m','Authoritative OOM logging deployed; commit abc1234.']);
    const related=ok(['review-bundle','sandbox-monitoring','--force']);
    assert.match(related,/related work/);
    assert.match(related,/correct-sandbox-oom-classification \[done\]/);
    assert.match(related,/abc1234/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
