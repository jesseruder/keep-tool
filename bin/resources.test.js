'use strict';

for (const key of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[key];

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const resources = require('./resources.js');
const live = require('./watcher-live.js');

const KEEP = path.join(__dirname, 'keep.js');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-resources-test-'));
  for (const directory of ['tasks', 'archive', 'resources']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  return root;
}

function cli(root, args) {
  return spawnSync(process.execPath, [KEEP, ...args], {
    encoding: 'utf8',
    env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' },
  });
}

const STAGING = {
  staging: {
    title: 'staging sandbox environment',
    commands: ['terraform apply', 'heroku .* --remote staging', '--app castle-staging'],
    paths: ['terraform/main.tf', 'terraform/staging/**'],
    deploys: ['heroku:staging'],
    noteFor: '+2h',
  },
};

test('the unreadable-command marker is the same value the watcher emits', () => {
  assert.equal(resources.UNREADABLE_COMMAND, live.UNREADABLE_COMMAND);
});

test('a command matcher is a case-insensitive regex over the normalized command', () => {
  const touched = resources.touchedResources({ commands: ['bash -lc "TERRAFORM APPLY -auto-approve"'] }, STAGING);
  assert.deepEqual(touched.map((row) => row.name), ['staging']);
  assert.match(touched[0].evidence, /^command terraform apply -auto-approve$/i);
  assert.equal(touched[0].noteFor, '+2h');
});

test('an argv command is normalized by steps.js before any matcher sees it', () => {
  assert.deepEqual(
    resources.touchedResources({ commands: [['heroku', 'ps', '--app', 'castle-staging']] }, STAGING).map((row) => row.name),
    ['staging'],
  );
  // The normalized form is one shell-quoted line, so a declaration's regex is
  // matched against that line rather than against a re-split argv.
  assert.deepEqual(resources.normalizeCommands([['heroku', 'ps', '--app', 'castle staging']]),
    ["heroku ps --app 'castle staging'"]);
});

test('a path matcher is a glob over the turn files, absolute or relative', () => {
  const relative = resources.touchedResources({ files: ['terraform/staging/net.tf'] }, STAGING);
  assert.deepEqual(relative.map((row) => row.name), ['staging']);
  assert.equal(relative[0].evidence, 'file terraform/staging/net.tf');
  const declared = { project: '~/castle/castle-sandboxes', resources: STAGING };
  const inside = path.join(os.homedir(), 'castle/castle-sandboxes/terraform/main.tf');
  assert.deepEqual(resources.touchedResources({ files: [inside] }, declared).map((row) => row.name), ['staging']);
  assert.deepEqual(resources.touchedResources({ files: ['docs/terraform.md'] }, STAGING), []);
});

test('a relative glob does not match the same name in somebody else\'s tree', () => {
  // Only the path as written and the path relative to the declaring project are
  // candidates. Matching every trailing sub-path would make terraform/main.tf a
  // match for a vendored copy of a different file.
  assert.deepEqual(resources.touchedResources({ files: ['vendor/foo/terraform/main.tf'] }, STAGING), []);
  assert.deepEqual(resources.touchedResources(
    { files: ['/somewhere/else/castle-sandboxes/terraform/main.tf'] },
    { project: '~/castle/castle-sandboxes', resources: STAGING },
  ), []);
  assert.deepEqual(resources.fileCandidates('/a/b/c/d.tf', '/a/b'), ['/a/b/c/d.tf', 'c/d.tf']);
});

test('a deploy matcher is <kind>:<target substring> over deployCommand results', () => {
  const touched = resources.touchedResources(
    { deploys: [{ kind: 'heroku', target: 'heroku (app castle-staging)', ref: 'HEAD', dir: '' }] },
    { staging: { deploys: ['heroku:staging'] } },
  );
  assert.deepEqual(touched.map((row) => row.name), ['staging']);
  assert.match(touched[0].evidence, /^deploy heroku: heroku \(app castle-staging\)$/);
  assert.deepEqual(resources.touchedResources(
    { deploys: [{ kind: 'heroku', target: 'heroku (app castle-prod)' }] },
    { staging: { deploys: ['heroku:staging'] } },
  ), []);
  // A bare kind matches any target of that kind.
  assert.equal(resources.touchedResources(
    { deploys: [{ kind: 'android', target: 'android device (default)' }] },
    { phone: { deploys: ['android'] } },
  ).length, 1);
});

test('an unreadable command never matches anything', () => {
  assert.deepEqual(resources.touchedResources({ commands: [resources.UNREADABLE_COMMAND] }, STAGING), []);
});

test('a bad regex disables that matcher, never the declaration and never by throwing', () => {
  const declarations = { staging: { commands: ['terraform (apply', 'heroku pg:reset'], paths: ['terraform/**'] } };
  assert.deepEqual(resources.touchedResources({ commands: ['terraform (apply'] }, declarations), []);
  assert.deepEqual(resources.touchedResources({ commands: ['heroku pg:reset'] }, declarations).map((row) => row.name), ['staging']);
  assert.deepEqual(resources.touchedResources({ files: ['terraform/main.tf'] }, declarations).map((row) => row.name), ['staging']);
  const problems = resources.badMatchers(declarations);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'command');
  assert.equal(problems[0].pattern, 'terraform (apply');
});

test('badMatchers reports an empty glob and an invalid name', () => {
  const problems = resources.badMatchers({ staging: { paths: ['terraform/**', '  '] }, 'Not A Name': {} });
  assert.deepEqual(problems.map((row) => `${row.name}:${row.kind}`).sort(), ['Not A Name:name', 'staging:paths']);
});

test('no declaration file and empty declarations touch nothing', () => {
  const root = makeRoot();
  try {
    assert.equal(resources.loadResources('/nowhere/at/all', root), null);
    assert.deepEqual(resources.touchedResources({ commands: ['terraform apply'] }, null), []);
    assert.deepEqual(resources.touchedResources({ commands: ['terraform apply'] }, {}), []);
    assert.deepEqual(resources.touchedResources({ commands: ['terraform apply'] }, { project: '~/p', resources: {} }), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('observe stays quiet when the turn already said something about shared state', () => {
  const turn = { session_id: 'abc' };
  const base = { declarations: STAGING, commands: ['terraform apply'] };
  assert.deepEqual(resources.observe(turn, base).map((row) => row.name), ['staging']);
  for (const said of ['keep note castle-sandboxes --scope staging -m "x" --for +2h',
    'keep checkin k-1 -m "done"', 'keep hold castle-sandboxes --for +15m -m "why"']) {
    assert.deepEqual(resources.observe(turn, { ...base, commands: ['terraform apply', said] }), [], said);
  }
  // Mentioning the command inside another program is not saying anything.
  assert.deepEqual(
    resources.observe(turn, { ...base, commands: ['terraform apply', ['grep', '-r', 'keep note', '.']] }).map((row) => row.name),
    ['staging'],
  );
});

test('observe skips a resource this session already has an active note on', () => {
  const turn = { session_id: 'abc' };
  const notes = [{ scopes: ['staging'], by: { sessionId: 'abc' } }];
  assert.deepEqual(resources.observe(turn, { declarations: STAGING, commands: ['terraform apply'], notes }), []);
  const others = [{ scopes: ['staging'], by: { sessionId: 'zzz' } }];
  assert.deepEqual(
    resources.observe(turn, { declarations: STAGING, commands: ['terraform apply'], notes: others }).map((row) => row.name),
    ['staging'],
  );
});

test('observe fails open when the project declares nothing', () => {
  assert.deepEqual(resources.observe({ session_id: 'abc' }, { commands: ['terraform apply'] }), []);
});

test('keep resources lists, adds, removes, and checks a declaration', () => {
  const root = makeRoot();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-resources-project-'));
  try {
    const empty = cli(root, ['resources', project]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /no shared resources declared/);

    const added = cli(root, ['resources', project, '--add', 'staging', '--title', 'staging sandbox',
      '--command', 'terraform apply', '--command', '--app castle-staging',
      '--path', 'terraform/**', '--deploy', 'heroku:staging', '--note-for', '+2h']);
    assert.equal(added.status, 0, added.stderr);

    const listed = cli(root, ['resources', project]);
    assert.match(listed.stdout, /staging — staging sandbox/);
    assert.match(listed.stdout, /command: terraform apply/);
    assert.match(listed.stdout, /path: +terraform\/\*\*/);
    assert.match(listed.stdout, /deploy: +heroku:staging/);

    const checked = cli(root, ['resources', '--check', project, 'terraform apply -auto-approve']);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /^staging — command terraform apply -auto-approve$/m);

    const miss = cli(root, ['resources', '--check', project, 'npm test']);
    assert.match(miss.stdout, /no declared resource matches/);

    const bad = cli(root, ['resources', project, '--add', 'Staging Box']);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /not a resource label/);

    const badRegex = cli(root, ['resources', project, '--add', 'prod', '--command', 'terraform (apply']);
    assert.notEqual(badRegex.status, 0);
    assert.match(badRegex.stderr, /not a valid regex/);

    const removed = cli(root, ['resources', project, '--remove', 'staging']);
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(cli(root, ['resources', project]).stdout, /^ {2}\(none\)$/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('the session-start hook names declared resources on this project', () => {
  const root = makeRoot();
  const project = path.join(root, 'sandboxes');
  fs.mkdirSync(project, { recursive: true });
  try {
    const added = cli(root, ['resources', project, '--add', 'staging', '--command', 'terraform apply']);
    assert.equal(added.status, 0, added.stderr);
    const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1', KEEP_PORT: '1' };
    for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) delete env[key];
    const hook = spawnSync(process.execPath, [KEEP, 'hook', 'session-start'], {
      encoding: 'utf8',
      cwd: project,
      input: JSON.stringify({ session_id: 'session-resources', cwd: project }),
      env,
    });
    assert.equal(hook.status, 0, hook.stderr);
    assert.match(hook.stdout, /Shared resources declared here: staging \(keep resources sandboxes\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('evidence and titles are scrubbed of bidi overrides and zero-width characters', () => {
  const bidi = 'terraform apply ' + '\u202e' + ' --auto';
  const touched = resources.touchedResources({ commands: [bidi] }, STAGING);
  assert.equal(touched.length, 1);
  assert.equal(/[\p{Cf}]/u.test(touched[0].evidence), false, touched[0].evidence);
  assert.match(touched[0].evidence, /^command terraform apply .*--auto$/);
  // Replaced with a space rather than deleted: silently joining two words is how
  // a scrubber invents a word nobody wrote.
  assert.equal(resources.clean('zero' + '\u200b' + 'width'), 'zero width');
  assert.equal(resources.titleOf({ title: 'staging' + '\u202e' + ' box' }), 'staging box');
  assert.equal(resources.clean('<<<fence>>>'), '---fence---');
});

test('a read-only keep notes does not count as saying something', () => {
  const turn = { session_id: 'abc' };
  const base = { declarations: STAGING, commands: ['terraform apply'] };
  assert.deepEqual(
    resources.observe(turn, { ...base, commands: ['terraform apply', 'keep notes'] }).map((row) => row.name),
    ['staging'],
    'reading the notes is not writing one',
  );
  assert.deepEqual(resources.observe(turn, { ...base, commands: ['terraform apply', 'keep note x --scope staging -m "y" --for +2h'] }), []);
});
