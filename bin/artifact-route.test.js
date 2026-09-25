'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createRegistryService } = require('./registry-route.js');
const { createArtifactService } = require('./artifact-route.js');
const { ARTIFACT_FILE_MAX_BYTES, ARTIFACT_COMMAND_MAX_BYTES, ARTIFACT_MAX_FILES } = require('./registry-commands.js');

const AWS1 = { class: 'node', node: 'aws1' };
const KEY = 'a-0123456789abcdef';

function tempDir(t, prefix = 'keep-artifact-route-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A child process stand-in that records what it was asked to run and, while the
// daemon's temporary copies still exist, what they held.
function fakeSpawn(answer = () => ({ code: 0, stdout: 'stored\n', stderr: '' })) {
  const calls = [];
  const spawn = (file, args, options) => {
    const copies = args.slice(args.indexOf('--') + 2).map((copy) => ({ copy, bytes: fs.readFileSync(copy) }));
    calls.push({ file, args, options, copies });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { setImmediate(() => child.emit('close', null, 'SIGKILL')); };
    const result = answer({ file, args, options });
    setImmediate(() => {
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
      child.emit('close', result.code, null);
    });
    return child;
  };
  return { spawn, calls };
}

function services(t, overrides = {}) {
  const root = overrides.root || tempDir(t);
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  if (!overrides.noCard) fs.writeFileSync(path.join(root, 'tasks', 'some-card.md'), '---\ntitle: Some card\n---\n');
  const tmpRoot = tempDir(t, 'keep-artifact-tmp-');
  const fake = overrides.fake || fakeSpawn(overrides.answer);
  const registry = createRegistryService({
    root,
    ...(overrides.realSpawn ? {} : { spawn: fake.spawn }),
    daemonNode: () => 'main',
    location: (id) => ({ 'sess-aws1': { node: 'aws1', agent: 'claude' }, 'sess-main': { node: 'main', agent: 'claude' } })[id] || null,
    env: overrides.env || { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C' },
    configFile: path.join(root, 'config.json'),
  });
  const artifacts = createArtifactService({ registry, tmpRoot, ...(overrides.artifactOptions || {}) });
  return { registry, artifacts, root, tmpRoot, calls: fake.calls };
}

function fileOf(name, bytes, extra = {}) {
  const content = Buffer.from(bytes);
  return {
    name, size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex'),
    content: content.toString('base64'), source: `/home/someone/shots/${name}`, ...extra,
  };
}

function body(root, extra = {}) {
  return {
    card: 'some-card', note: 'the login screen', files: [fileOf('shot.png', 'png bytes')],
    cwd: root, session: 'sess-aws1', agent: 'claude', idempotencyKey: KEY, ...extra,
  };
}

test('the daemon writes each file under its own name, runs its own keep artifact as the node\'s session, and removes the copies', async (t) => {
  const { artifacts, root, tmpRoot, calls } = services(t, { answer: () => ({ code: 0, stdout: '/r/.keep/artifacts/some-card/shot.png\n', stderr: '' }) });
  const files = [fileOf('shot.png', 'first'), fileOf('shot.png', 'second, from another directory'), fileOf('notes.txt', 'text')];
  const answer = await artifacts.handle(AWS1, body(root, { files, pane: 'p3@aws1' }));
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.status, 0);
  assert.equal(answer.body.stdout, '/r/.keep/artifacts/some-card/shot.png\n');
  assert.equal(calls.length, 1);
  const [call] = calls;
  const dashes = call.args.indexOf('--');
  assert.deepEqual(call.args.slice(1, dashes + 2), ['artifact', '-m', 'the login screen', '--', 'some-card']);
  assert.deepEqual(call.copies.map(({ copy }) => path.basename(copy)), ['shot.png', 'shot.png', 'notes.txt'],
    'each copy keeps the name it had on the node');
  assert.deepEqual(call.copies.map(({ bytes }) => bytes.toString()), ['first', 'second, from another directory', 'text']);
  for (const { copy } of call.copies) assert.ok(copy.startsWith(`${tmpRoot}${path.sep}`));
  assert.equal(call.options.cwd, root);
  assert.equal(call.options.env.CLAUDE_CODE_SESSION_ID, 'sess-aws1');
  assert.equal(call.options.env.KEEP_REMOTE_CALLER, 'aws1');
  assert.equal(call.options.env.KEEP_PANE, 'p3@aws1');
  assert.deepEqual(JSON.parse(call.options.env.KEEP_ARTIFACT_SOURCES), files.map((file) => file.source));
  assert.deepEqual(fs.readdirSync(tmpRoot), [], 'the temporary copies are gone');
  // A listing carries no files and no note.
  const listed = await artifacts.handle(AWS1, body(root, { files: [], note: null, idempotencyKey: `${KEY}-list` }));
  assert.equal(listed.status, 200);
  assert.deepEqual(calls[1].args.slice(1), ['artifact', '--', 'some-card']);
});

test('only a node, or the daemon\'s own callers, may post an artifact', async (t) => {
  const { artifacts, root, calls } = services(t);
  assert.deepEqual(await artifacts.handle(null, body(root)), { status: 403, body: { error: 'unauthorized' } });
  assert.deepEqual(await artifacts.handle({ class: 'proxy' }, body(root)), { status: 403, body: { error: 'unauthorized' } });
  assert.deepEqual(await artifacts.handle({ class: 'node', node: 'main' }, body(root)), { status: 403, body: { error: 'unauthorized' } });
  // A node acts only for its own sessions and panes.
  assert.equal((await artifacts.handle(AWS1, body(root, { session: 'sess-main' }))).status, 403);
  assert.equal((await artifacts.handle(AWS1, body(root, { pane: 'p1@main' }))).status, 403);
  assert.equal(calls.length, 0);
});

test('a file whose bytes do not match its sha256 or size is refused, and nothing is recorded or run', async (t) => {
  const { artifacts, root, calls } = services(t);
  const damaged = { ...fileOf('shot.png', 'png bytes'), content: Buffer.from('png bytez').toString('base64') };
  const mismatch = await artifacts.handle(AWS1, body(root, { files: [damaged] }));
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.body.error, /shot\.png: sha256 mismatch/);
  const short = await artifacts.handle(AWS1, body(root, { files: [{ ...fileOf('shot.png', 'png bytes'), size: 3 }] }));
  assert.equal(short.status, 400);
  assert.match(short.body.error, /9 bytes arrived, 3 were sent/);
  const notBase64 = await artifacts.handle(AWS1, body(root, { files: [{ ...fileOf('shot.png', 'x'), size: 3, content: '!!!!' }] }));
  assert.equal(notBase64.status, 400);
  assert.match(notBase64.body.error, /content must be base64/);
  assert.equal(calls.length, 0);
  // The digest is checked as the file is written, inside the journalled run: a run
  // that throws before its CLI is spawned leaves no record, so a corrected resend runs.
  const ops = path.join(root, '.keep', 'registry-ops');
  assert.deepEqual(fs.existsSync(ops) ? fs.readdirSync(ops) : [], []);
  const fixed = await artifacts.handle(AWS1, body(root));
  assert.equal(fixed.status, 200);
  assert.equal(calls.length, 1);
});

test('files past the per-file, per-command or count bound are refused', async (t) => {
  const { artifacts, root, calls } = services(t);
  const big = await artifacts.handle(AWS1, body(root, { files: [fileOf('big.bin', Buffer.alloc(ARTIFACT_FILE_MAX_BYTES + 1))] }));
  assert.equal(big.status, 413);
  assert.match(big.body.error, /artifact too large: big\.bin/);
  const count = Math.floor(ARTIFACT_COMMAND_MAX_BYTES / ARTIFACT_FILE_MAX_BYTES) + 1;
  const full = fileOf('part.bin', Buffer.alloc(ARTIFACT_FILE_MAX_BYTES));
  const together = await artifacts.handle(AWS1, body(root, { files: Array.from({ length: count }, () => full) }));
  assert.equal(together.status, 413);
  assert.match(together.body.error, /larger than 20 MB together/);
  const many = await artifacts.handle(AWS1, body(root, { files: Array.from({ length: ARTIFACT_MAX_FILES + 1 }, (_, i) => fileOf(`f${i}.txt`, 'x')) }));
  assert.equal(many.status, 413);
  const note = await artifacts.handle(AWS1, body(root, { note: 'x'.repeat(4097) }));
  assert.equal(note.status, 400);
  assert.match(note.body.error, /note is longer than 4096 bytes/);
  assert.equal(calls.length, 0);
});

test('a name that is not a plain file name is refused', async (t) => {
  const { artifacts, root, calls } = services(t);
  for (const name of ['../escape.png', 'dir/shot.png', '..', '.', 'two\nlines.txt', 'back\\slash', '', 'nul\0.txt']) {
    const answer = await artifacts.handle(AWS1, body(root, { files: [fileOf(name, 'x')] }));
    assert.equal(answer.status, 400, JSON.stringify(name));
  }
  const relative = await artifacts.handle(AWS1, body(root, { files: [fileOf('ok.png', 'x', { source: 'shots/ok.png' })] }));
  assert.equal(relative.status, 400);
  assert.match(relative.body.error, /source must be an absolute path/);
  assert.equal(calls.length, 0);
});

test('a card the daemon does not have is refused before anything runs', async (t) => {
  const { artifacts, root, calls } = services(t, { noCard: true });
  const answer = await artifacts.handle(AWS1, body(root));
  assert.equal(answer.status, 404);
  assert.match(answer.body.error, /no task "some-card" on the daemon/);
  assert.equal((await artifacts.handle(AWS1, body(root, { card: '../tasks/x' }))).status, 400);
  assert.equal((await artifacts.handle(AWS1, body(root, { card: 'Some_Card' }))).status, 400);
  assert.equal(calls.length, 0);
});

test('a resend under its key is answered from the journal, and the key used for other files is refused', async (t) => {
  let n = 0;
  const { artifacts, root, calls } = services(t, { answer: () => { n += 1; return { code: 0, stdout: `stored ${n}\n`, stderr: '' }; } });
  const first = await artifacts.handle(AWS1, body(root));
  assert.equal(first.body.replayed, false);
  const again = await artifacts.handle(AWS1, body(root));
  assert.deepEqual(again, { status: 200, body: { ...first.body, replayed: true } });
  assert.equal(calls.length, 1);
  const other = await artifacts.handle(AWS1, body(root, { files: [fileOf('shot.png', 'other bytes')] }));
  assert.equal(other.status, 409);
  assert.equal(calls.length, 1);
  // The journal names the files by their digest, never holds their bytes.
  const [entry] = fs.readdirSync(path.join(root, '.keep', 'registry-ops'));
  const recorded = fs.readFileSync(path.join(root, '.keep', 'registry-ops', entry), 'utf8');
  assert.equal(recorded.includes(Buffer.from('png bytes').toString('base64')), false);
});

test('a daemon on its way to a restart refuses an artifact with 503 and writes nothing', async (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, 'tasks'));
  fs.writeFileSync(path.join(root, 'tasks', 'some-card.md'), '---\ntitle: Some card\n---\n');
  const fake = fakeSpawn();
  const registry = createRegistryService({
    root, spawn: fake.spawn, daemonNode: () => 'main', stopping: () => true,
    location: () => ({ node: 'aws1', agent: 'claude' }), env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C' },
    configFile: path.join(root, 'config.json'),
  });
  const artifacts = createArtifactService({ registry, tmpRoot: tempDir(t) });
  assert.deepEqual(await artifacts.handle(AWS1, body(root)), { status: 503, body: { error: 'daemon restarting' } });
  assert.equal(fake.calls.length, 0);
});

test('a real keep artifact stores a node\'s file in the registry through the daemon\'s own CLI', async (t) => {
  const root = tempDir(t);
  for (const dir of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const env = { ...process.env, KEEP_DIR: root };
  delete env.CLAUDE_CODE_SESSION_ID;
  assert.equal(spawnSync('git', ['init', '-q', root], { env }).status, 0);
  spawnSync('git', ['-C', root, 'config', 'user.name', 'Keep Test'], { env });
  spawnSync('git', ['-C', root, 'config', 'user.email', 'keep@example.test'], { env });
  const { registry, artifacts, tmpRoot } = services(t, {
    root, noCard: true, realSpawn: true, env: { PATH: process.env.PATH, HOME: root, LANG: 'C' },
  });
  const added = await registry.handle(AWS1, {
    command: 'add', args: ['Artifact card'], cwd: root, session: 'sess-aws1', agent: 'claude', idempotencyKey: 'add-0123456789abcdef',
  });
  assert.equal(added.body.status, 0, added.body.stderr);
  const stored = await artifacts.handle(AWS1, body(root, { card: 'artifact-card', files: [fileOf('shot.png', 'png bytes')] }));
  assert.equal(stored.status, 200);
  assert.equal(stored.body.status, 0, stored.body.stderr);
  const destination = path.join(root, '.keep', 'artifacts', 'artifact-card', 'shot.png');
  assert.equal(stored.body.stdout, `${destination}\n`);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'png bytes');
  const card = fs.readFileSync(path.join(root, 'tasks', 'artifact-card.md'), 'utf8');
  assert.match(card, /Stored .*shot\.png \(from aws1:\/home\/someone\/shots\/shot\.png\)/, 'the log names the node\'s file, not the copy');
  assert.match(card, /the login screen/);
  assert.deepEqual(fs.readdirSync(tmpRoot), []);
});

test('a file larger than one decode slice is written whole and exact', async (t) => {
  const { DECODE_SLICE_CHARS } = require('./artifact-route.js');
  const { artifacts, root, calls } = services(t);
  const bytes = crypto.randomBytes(Math.ceil(DECODE_SLICE_CHARS * 3 / 4) * 2 + 17);
  const answer = await artifacts.handle(AWS1, body(root, { files: [fileOf('big.bin', bytes)] }));
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(Buffer.compare(calls[0].copies[0].bytes, bytes), 0);
});

// Admission, before the node API reads a body: one upload per node, two in all.
test('artifact uploads are admitted one per node and two in all, and a slot frees once when released', (t) => {
  const { artifacts } = services(t);
  const first = artifacts.admit(AWS1);
  assert.equal(typeof first.release, 'function');
  const busy = artifacts.admit(AWS1);
  assert.equal(busy.status, 429);
  assert.equal(busy.body.busy, true);
  assert.equal(busy.headers['retry-after'], '2');
  assert.equal(typeof artifacts.admit({ class: 'node', node: 'aws2' }).release, 'function');
  assert.equal(artifacts.admit({ class: 'node', node: 'aws3' }).status, 429, 'two in all');
  first.release();
  first.release();
  assert.equal(artifacts.uploads(), 1, 'a slot is freed once');
  assert.equal(typeof artifacts.admit(AWS1).release, 'function', 'admitted once the first finished');
});

test('the decoder refuses padding before the last slice and a byte count other than the one sent, and leaves no partial file', async (t) => {
  const { writeDecoded } = require('./artifact-route.js');
  const dir = tempDir(t);
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  // "A" and "A" as two padded groups: each decodes alone, but padding mid-stream is not base64.
  const padded = path.join(dir, 'padded.bin');
  await assert.rejects(writeDecoded(fs.promises, padded, { name: 'padded.bin', content: 'QQ==QQ==', size: 2, sha256: sha('AA') }, 4),
    /padded\.bin: content must be base64/);
  assert.equal(fs.existsSync(padded), false);
  const short = path.join(dir, 'short.bin');
  await assert.rejects(writeDecoded(fs.promises, short, { name: 'short.bin', content: Buffer.from('abcdef').toString('base64'), size: 7, sha256: sha('abcdef') }, 4),
    /short\.bin: 6 bytes decoded, 7 were sent/);
  assert.equal(fs.existsSync(short), false);
  const good = path.join(dir, 'good.bin');
  await writeDecoded(fs.promises, good, { name: 'good.bin', content: Buffer.from('abcdefg').toString('base64'), size: 7, sha256: sha('abcdefg') }, 4);
  assert.equal(fs.readFileSync(good, 'utf8'), 'abcdefg');
});

// A node API over a real socket, with the artifact service's first run held open
// until the test lets it finish.
async function heldNodeApi(t) {
  const http = require('node:http');
  const nodeApi = require('./serve/node-api.js');
  const { routes, matchRoute, routeDenial } = require('./serve/routes.js');
  const keepConsole = require('./console.js');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let spawned = 0;
  const fake = fakeSpawn(() => ({ code: 0, stdout: 'stored\n', stderr: '' }));
  const spawn = (...args) => {
    spawned += 1;
    const child = fake.spawn(...args);
    if (spawned === 1) {
      const emit = child.emit.bind(child);
      child.emit = (name, ...rest) => (name === 'close' ? held.then(() => emit(name, ...rest)) : emit(name, ...rest));
    }
    return child;
  };
  const { artifacts, root } = services(t, { fake: { spawn, calls: fake.calls } });
  const read = [];
  let peak = 0;
  const handler = nodeApi.createNodeApiHandler({
    routes: routes({ json: (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); },
      nodeApiEnabled: () => true, artifactService: artifacts }),
    matchRoute, routeDenial, principal: keepConsole.principal, log: () => {},
    tokenStore: nodeApi.createNodeTokenStore({ initial: { aws1: 'aws1-secret' }, read: () => ({ aws1: 'aws1-secret' }) }),
    readBody: (req) => new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('error', reject);
      req.on('end', () => { read.push(req.url); resolve(JSON.parse(data)); });
    }),
    admit: (pathname, who) => {
      if (pathname !== '/api/artifact') return null;
      const answer = artifacts.admit(who);
      peak = Math.max(peak, artifacts.uploads());
      return answer;
    },
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { nodeApiRequest } = require('./remote-cli.js');
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (key) => nodeApiRequest(url, '/api/artifact', { payload: body(root, { idempotencyKey: key }), token: 'aws1-secret', timeoutMs: 10e3 });
  // Sends a whole upload and hangs up without waiting for the answer.
  const postAndAbort = (key) => new Promise((resolve) => {
    const payload = JSON.stringify(body(root, { idempotencyKey: key }));
    const req = http.request(`${url}/api/artifact`, {
      method: 'POST', agent: false,
      headers: { 'x-keep': '1', 'x-keep-node-token': 'aws1-secret', 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    });
    req.on('error', () => resolve());
    req.on('response', (res) => { res.resume(); res.on('end', resolve); });
    req.end(payload, () => setTimeout(() => { req.destroy(); resolve(); }, 20));
  });
  const until = async (fn) => { while (!fn()) await new Promise((resolve) => setTimeout(resolve, 5)); };
  return { artifacts, post, postAndAbort, release, read, until, spawned: () => spawned, peak: () => peak };
}

test('through the node API a second upload from one node is turned away unread, and admitted after the first', async (t) => {
  const api = await heldNodeApi(t);
  const first = api.post(`${KEY}-one`);
  await api.until(() => api.spawned() === 1);
  const second = await api.post(`${KEY}-two`);
  assert.equal(second.status, 429);
  assert.equal(JSON.parse(second.data).busy, true);
  assert.equal(api.read.length, 1, 'the refused upload was never read');
  api.release();
  assert.equal((await first).status, 200);
  const again = await api.post(`${KEY}-two`);
  assert.equal(again.status, 200, again.data);
  assert.equal(JSON.parse(again.data).stdout, 'stored\n');
});

test('an upload whose client hangs up holds its slot until its run ends, and a burst of hang-ups never runs two at once', async (t) => {
  const api = await heldNodeApi(t);
  await api.postAndAbort(`${KEY}-gone`);
  await api.until(() => api.spawned() === 1);
  assert.equal(api.artifacts.uploads(), 1, 'the run goes on after its client left, and so does its slot');
  for (let i = 0; i < 5; i += 1) await api.postAndAbort(`${KEY}-burst-${i}`);
  const refused = await api.post(`${KEY}-next`);
  assert.equal(refused.status, 429);
  assert.equal(api.read.length, 1, 'no upload behind it was read');
  assert.equal(api.spawned(), 1);
  assert.equal(api.peak(), 1, 'never more than one in flight for the node');
  api.release();
  await api.until(() => api.artifacts.uploads() === 0);
  const admitted = await api.post(`${KEY}-next`);
  assert.equal(admitted.status, 200, admitted.data);
});

test('a node\'s daily quota refuses the upload that would pass it, counts only accepted uploads, survives a restart and frees with the window', async (t) => {
  let clock = Date.parse('2026-09-20T10:00:00Z');
  const artifactOptions = { now: () => clock, dailyBytes: 20, dailyFiles: 3 };
  let code = 0;
  const { artifacts, root, calls, registry } = services(t, { artifactOptions, answer: () => ({ code, stdout: 'stored\n', stderr: '' }) });
  const upload = (key, content = 'png bytes') => artifacts.handle(AWS1, body(root, { idempotencyKey: `${KEY}-${key}`, files: [fileOf('shot.png', content)] }));
  const ledger = () => JSON.parse(fs.readFileSync(path.join(root, '.keep', 'artifact-quota.json'), 'utf8')).nodes.aws1 || [];
  assert.equal((await upload('a')).status, 200);
  clock += 60e3;
  // A CLI that fails stored nothing and counts nothing.
  code = 1;
  assert.equal((await upload('failed')).body.status, 1);
  code = 0;
  assert.equal(ledger().length, 1);
  assert.equal((await upload('b')).status, 200);
  assert.deepEqual(ledger().map((entry) => entry.bytes), [9, 9]);

  const refused = await upload('c');
  assert.equal(refused.status, 413);
  assert.equal(refused.body.error, 'node aws1 has stored 0.0 MB in 2 artifact files in the last 24 hours; '
    + 'this upload of 0.0 MB in 1 would pass its daily limit of 0.0 MB and 3 files; room frees at 2026-09-21T10:00:00.000Z');
  assert.equal(calls.length, 3, 'nothing was spawned for it');
  assert.equal(ledger().length, 2, 'a refusal takes no quota');
  const ops = path.join(root, '.keep', 'registry-ops');
  assert.equal(fs.readdirSync(ops).length, 3, 'and leaves no journal record');

  // A resend of an accepted upload is still answered from the journal.
  assert.equal((await upload('a')).body.replayed, true);

  // The next daemon reads the same ledger.
  const restarted = createArtifactService({ registry, tmpRoot: tempDir(t), ...artifactOptions });
  assert.equal((await restarted.handle(AWS1, body(root, { idempotencyKey: `${KEY}-c`, files: [fileOf('shot.png', 'png bytes')] }))).status, 413);

  // Once the first upload leaves the window, the same key goes through.
  clock = Date.parse('2026-09-21T10:00:01Z');
  const later = await upload('c');
  assert.equal(later.status, 200, JSON.stringify(later.body));
  assert.deepEqual(ledger().map((entry) => entry.at), [Date.parse('2026-09-20T10:01:00Z'), clock]);
  // Another node has its own quota.
  const other = await artifacts.handle({ class: 'node', node: 'aws2' }, body(root, { idempotencyKey: `${KEY}-aws2`, session: null, agent: null }));
  assert.equal(other.status, 200, JSON.stringify(other.body));
});

test('the store cap refuses an upload that would pass it, counting regular files only', async (t) => {
  const { artifacts, root, calls } = services(t, { artifactOptions: { storeMaxBytes: 16 } });
  const dir = path.join(root, '.keep', 'artifacts', 'older-card');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kept.bin'), Buffer.alloc(8));
  // A link to something large is not part of the store.
  const outside = tempDir(t);
  fs.writeFileSync(path.join(outside, 'large.bin'), Buffer.alloc(4096));
  fs.symlinkSync(path.join(outside, 'large.bin'), path.join(dir, 'link.bin'));
  const refused = await artifacts.handle(AWS1, body(root));
  assert.equal(refused.status, 413);
  assert.equal(refused.body.error, 'the artifact store holds 0.0 MB of its 0.0 MB cap; remove old artifacts under .keep/artifacts on the daemon before storing more');
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(root, '.keep', 'artifact-quota.json')), false);
  const small = await artifacts.handle(AWS1, body(root, { idempotencyKey: `${KEY}-small`, files: [fileOf('tiny.txt', 'tiny')] }));
  assert.equal(small.status, 200, JSON.stringify(small.body));
});
