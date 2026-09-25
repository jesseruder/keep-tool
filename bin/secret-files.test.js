'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const secretFiles = require('./secret-files.js');

function home(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-secret-home-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const init = spawnSync('git', ['init', '-q', dir]);
  assert.equal(init.status, 0, String(init.stderr));
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
}

const opts = (h) => ({ home: h, keepRoot: path.join(h, 'keep') });

test('writes a whole-file secret with owner-only permissions and reports no value', (t) => {
  const h = home(t);
  const result = secretFiles.writeSecret({ path: '~/.config/tool/token', value: 'abc123\n' }, opts(h));
  const file = path.join(h, '.config/tool/token');
  assert.equal(fs.readFileSync(file, 'utf8'), 'abc123');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(result, { path: file, key: null, replaced: false, bytes: 6, mode: '0600' });
  assert.ok(!JSON.stringify(result).includes('abc123'));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['token'], 'no temp file is left behind');
});

test('refuses to overwrite a file or a key without replace', (t) => {
  const h = home(t);
  const file = path.join(h, 'token');
  fs.writeFileSync(file, 'old');
  assert.throws(() => secretFiles.writeSecret({ path: file, value: 'new' }, opts(h)), /already exists.*--replace/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  secretFiles.writeSecret({ path: file, value: 'new', replace: true }, opts(h));
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  const env = path.join(h, 'app.env');
  fs.writeFileSync(env, 'A=1\nTOKEN=old\n');
  assert.throws(() => secretFiles.writeSecret({ path: env, key: 'TOKEN', value: 'x' }, opts(h)), /already sets TOKEN/);
});

test('upserts KEY=value in a dotenv file and keeps its other lines', (t) => {
  const h = home(t);
  const env = path.join(h, 'app.env');
  fs.writeFileSync(env, '# comment\nA=1\nTOKEN=old\nB=2\nTOKEN=dup\n', { mode: 0o644 });
  const result = secretFiles.writeSecret({ path: env, key: 'TOKEN', value: 'new value', replace: true }, opts(h));
  assert.equal(fs.readFileSync(env, 'utf8'), "# comment\nA=1\nTOKEN='new value'\nB=2\n");
  assert.equal(result.replaced, true);
  assert.equal(fs.statSync(env).mode & 0o777, 0o600, 'the file is tightened to 0600');
  secretFiles.writeSecret({ path: env, key: 'OTHER', value: 'plain-1' }, opts(h));
  assert.match(fs.readFileSync(env, 'utf8'), /\nOTHER=plain-1\n$/);
});

test('keeps an export prefix, and uses one in a file that exports', () => {
  assert.equal(secretFiles.upsertDotenv('export A=1\n', 'B', 'x'), 'export A=1\nexport B=x\n');
  assert.equal(secretFiles.upsertDotenv('export B=old\n', 'B', 'x'), 'export B=x\n');
  assert.equal(secretFiles.upsertDotenv('', 'B', 'x'), 'B=x\n');
  assert.equal(secretFiles.upsertDotenv('A=1', 'B', 'x'), 'A=1\nB=x\n');
});

test('a dotenv value is bare, single-quoted, or refused', () => {
  assert.equal(secretFiles.dotenvValue('ghp_abc/123+=='), 'ghp_abc/123+==');
  assert.equal(secretFiles.dotenvValue('a b$c"d'), `'a b$c"d'`);
  assert.throws(() => secretFiles.dotenvValue("it's"), /single quote/);
  assert.throws(() => secretFiles.dotenvValue('a\nb'), /one line/);
});

test('refuses destinations outside home, in the registry, or through a symlink', (t) => {
  const h = home(t);
  assert.throws(() => secretFiles.checkDestination({ path: '/etc/token' }, opts(h)), /under/);
  assert.throws(() => secretFiles.checkDestination({ path: 'relative/token' }, opts(h)), /absolute/);
  assert.throws(() => secretFiles.checkDestination({ path: '~/keep/.keep/x' }, opts(h)), /Keep registry/);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-secret-out-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(h, 'link'));
  assert.throws(() => secretFiles.checkDestination({ path: '~/link/token' }, opts(h)), /resolves outside/);
  fs.writeFileSync(path.join(h, 'real'), '');
  fs.symlinkSync(path.join(h, 'real'), path.join(h, 'alias'));
  assert.throws(() => secretFiles.checkDestination({ path: '~/alias', replace: true }, opts(h)), /symlink/);
  assert.throws(() => secretFiles.checkDestination({ path: '~/x', key: 'bad-key' }, opts(h)), /environment variable/);
});

test('refuses a file git would commit, and allows a gitignored one', (t) => {
  const h = home(t);
  const repo = path.join(h, 'repo');
  gitRepo(repo);
  assert.throws(() => secretFiles.checkDestination({ path: path.join(repo, 'config.json') }, opts(h)), /not gitignored/);
  assert.throws(() => secretFiles.checkDestination({ path: path.join(repo, 'sub/new/token') }, opts(h)), /not gitignored/);
  const ok = secretFiles.checkDestination({ path: path.join(repo, '.env'), key: 'TOKEN' }, opts(h));
  assert.equal(ok.path, path.join(repo, '.env'));
});

test('value rules: trims a trailing newline, refuses empty, oversize and stray line breaks', () => {
  assert.equal(secretFiles.normalizeValue('tok\r\n'), 'tok');
  assert.throws(() => secretFiles.normalizeValue('\n'), /empty/);
  assert.throws(() => secretFiles.normalizeValue('a\nb'), /line breaks/);
  assert.equal(secretFiles.normalizeValue('-----BEGIN-----\nx\n', { multiline: true }), '-----BEGIN-----\nx\n');
  assert.throws(() => secretFiles.normalizeValue('x'.repeat(64 * 1024 + 1), { multiline: true }), /64 KiB/);
  assert.throws(() => secretFiles.normalizeValue(42), /text/);
});

test('a repeated request id answers from its receipt instead of writing again', (t) => {
  const h = home(t);
  const receiptDir = path.join(h, 'receipts');
  const params = { requestId: 'a1b2c3d4', path: path.join(h, 'app.env'), key: 'TOKEN', value: 'first' };
  const first = secretFiles.handle(params, { ...opts(h), receiptDir });
  assert.equal(first.replaced, false);
  const again = secretFiles.handle({ ...params, value: 'second' }, { ...opts(h), receiptDir });
  assert.equal(again.repeated, true);
  assert.equal(fs.readFileSync(params.path, 'utf8'), 'TOKEN=first\n', 'the retry did not write');
  assert.ok(!fs.readFileSync(path.join(receiptDir, 'a1b2c3d4.json'), 'utf8').includes('first'), 'a receipt holds no value');
  assert.throws(() => secretFiles.handle({ ...params, requestId: 'ffffffff' }, { ...opts(h), receiptDir }), /already sets TOKEN/,
    'another request is still refused');
});

test('an error never carries the value', (t) => {
  const h = home(t);
  const value = 'sk-SECRETVALUE-123';
  const cases = [
    () => secretFiles.writeSecret({ path: '/etc/x', value }, opts(h)),
    () => secretFiles.writeSecret({ path: '~/x.env', key: 'K', value: `${value}'` }, opts(h)),
    () => secretFiles.writeSecret({ path: '~/x', value: `${value}\nmore` }, opts(h)),
  ];
  for (const run of cases) {
    try { run(); assert.fail('expected a refusal'); }
    catch (error) { assert.ok(!String(error.message).includes('SECRETVALUE'), error.message); }
  }
});
