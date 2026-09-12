'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { headlessSettingsArgs, automationEnv } = require('./summarize.js');
const { profileEnvironment } = require('./agent-launcher.js');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { EventEmitter } = require('node:events');

function fixture(run, failSpawn = false) {
  const files = new Map(), children = [], removed = [], directories = [];
  const fakeFs = { existsSync: () => true, mkdirSync() {},
    mkdtempSync(prefix) { const dir = prefix + directories.length; directories.push(dir); return dir; },
    rmSync(dir) { removed.push(dir); },
    readFileSync(file) { if (!files.has(file)) throw Error('missing'); return files.get(file); },
    writeFileSync(file, value) { files.set(file, value); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
  };
  const context = vm.createContext({ module: { exports: {} }, process: { pid: 123, env: { KEEP_DIR: '/unrelated-keep-registry', CLAUDE_CODE_SESSION_ID: 'parent', CODEX_THREAD_ID: 'parent', KEEP_TASK: 'unrelated-card', ANTHROPIC_API_KEY: 'test-key' }, stderr: { write() {} } }, setTimeout: () => 1, clearTimeout() {},
    require: name => name === 'fs' ? fakeFs : name === './keep.js' ? { ROOT: '/unrelated-keep-checkout' } : name === 'child_process' ? {
      spawn(cmd, args, options) {
        if (failSpawn) throw Error('spawn failed');
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        Object.assign(child, { cmd, args, options }); children.push(child); return child;
      },
    } : require(name),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'summarize.js'), 'utf8'), context);
  run({ summary: context.module.exports, files, children, removed, directories });
}

test('generation isolates cwd, instructions, customizations, tools and session context', () => fixture(({ summary, children, removed, directories }) => {
  summary.getSummary('session-sandbox', 'Browser fleet: 12 successful jobs', 'Write a summary');
  const child = children[0], value = flag => child.args[child.args.indexOf(flag) + 1];
  assert.equal(child.options.cwd, directories[0]);
  assert.notEqual(child.options.cwd, '/unrelated-keep-checkout');
  assert.ok(child.args.includes('--safe-mode'));
  assert.ok(child.args.includes('--no-session-persistence'));
  assert.ok(child.args.includes('--strict-mcp-config'));
  assert.ok(child.args.includes('--disable-slash-commands'));
  assert.equal(value('--tools'), '');
  assert.equal(value('--mcp-config'), '{"mcpServers":{}}');
  assert.match(value('--system-prompt'), /separate session/);
  assert.match(value('-p'), /12 successful jobs/);
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'KEEP_TASK']) assert.equal(child.options.env[key], undefined);
  assert.equal(child.options.env.ANTHROPIC_API_KEY, 'test-key', 'normal authentication remains available');
  child.stdout.emit('data', 'Browser fleet: 12 successful jobs'); child.emit('close', 0);
  assert.deepEqual(removed, directories);
  assert.equal(summary.peekSummary('session-sandbox').text, 'Browser fleet: 12 successful jobs');
}));

test('legacy caches cannot contaminate titles, and instruction changes regenerate', () => fixture(({ summary, files, children }) => {
  const file = '/unrelated-keep-checkout/.keep/summaries/session-sandbox.json';
  files.set(file, JSON.stringify({ text: 'Keep model usage tracking', hash: 'legacy', generatedAt: Date.now() }));
  assert.equal(summary.peekSummary('session-sandbox'), null);
  assert.equal(summary.getSummary('session-sandbox', 'Browser rollout', 'Summary').text, null);
  children[0].stdout.emit('data', 'Browser rollout'); children[0].emit('close', 0);
  assert.equal(summary.getSummary('session-sandbox', 'Browser rollout', 'Summary').fresh, true);
  assert.equal(JSON.parse(files.get(file)).generatorVersion, summary.GENERATOR_VERSION);
  assert.equal(summary.getSummary('session-sandbox', 'Browser rollout', 'Title').fresh, false);
  assert.equal(children.length, 2);
}));

test('failed generations clean their temporary directories and do not cache output', () => fixture(({ summary, children, directories, removed, files }) => {
  summary.getSummary('failed', 'source', 'instruction');
  children[0].stdout.emit('data', 'partial'); children[0].emit('close', 1);
  assert.deepEqual(removed, directories);
  assert.equal(files.size, 0);
}));

test('synchronous spawn failures also clean their temporary directory', () => fixture(({ summary, directories, removed }) => {
  summary.getSummary('failed', 'source', 'instruction');
  assert.deepEqual(removed, directories);
}, true));

test('previous-title feedback does not invalidate an unchanged source after the cooldown', () => fixture(({ summary, children }) => {
  const { liveTitle } = require('./titles');
  const session = { id: 'sandbox', kind: 'codex', title: 'Original title', lastUser: 'Implement browser storage' };
  const deps = { ...summary, now: () => Date.now() + 3 * 60e3 };
  liveTitle(session, deps);
  children[0].stdout.emit('data', 'Browser storage'); children[0].emit('close', 0);
  assert.equal(liveTitle(session, deps), 'Browser storage');
  assert.equal(children.length, 1);
  session.lastUser = 'Implement browser storage rollout controls';
  liveTitle(session, deps);
  assert.equal(children.length, 2, 'changed source still regenerates');
}));

function withDisabledPlugins(value, fn) {
  const previous = process.env.KEEP_HEADLESS_DISABLED_PLUGINS;
  if (value === undefined) delete process.env.KEEP_HEADLESS_DISABLED_PLUGINS;
  else process.env.KEEP_HEADLESS_DISABLED_PLUGINS = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.KEEP_HEADLESS_DISABLED_PLUGINS;
    else process.env.KEEP_HEADLESS_DISABLED_PLUGINS = previous;
  }
}

test('headless settings disable the Codex plugin by default', () => {
  withDisabledPlugins(undefined, () => {
    assert.deepEqual(headlessSettingsArgs(), [
      '--settings',
      JSON.stringify({ enabledPlugins: { 'codex@openai-codex': false } }),
    ]);
  });
});

test('headless settings disable a custom comma-separated plugin list', () => {
  withDisabledPlugins('first@example, second@example', () => {
    assert.deepEqual(JSON.parse(headlessSettingsArgs()[1]), {
      enabledPlugins: {
        'first@example': false,
        'second@example': false,
      },
    });
  });
});

test('an empty disabled plugin setting opts out', () => {
  withDisabledPlugins('', () => {
    assert.deepEqual(headlessSettingsArgs(), []);
  });
});

test('automation account selection is stable and strips inherited alternate credentials', () => {
  const account = { id: 'background', label: 'Background', agent: 'claude', configDir: '/profiles/background', managed: true };
  const purposes = [];
  const accountApi = {
    automationFor(agent, purpose) {
      assert.equal(agent, 'claude');
      purposes.push(purpose);
      return account;
    },
    envFor(selected, base) { return profileEnvironment('claude', selected, base); },
  };
  const inherited = {
    PATH: '/bin', ANTHROPIC_API_KEY: 'alternate', CLAUDE_CODE_OAUTH_TOKEN: 'alternate-oauth',
    CLAUDE_CONFIG_DIR: '/wrong-profile',
  };
  const first = automationEnv('standup', inherited, accountApi);
  const second = automationEnv('standup', inherited, accountApi);
  assert.equal(first.account.id, 'background');
  assert.equal(second.account.id, 'background');
  assert.equal(first.env.CLAUDE_CONFIG_DIR, '/profiles/background');
  assert.equal(first.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, '/profiles/background');
  assert.equal(first.env.KEEP_AGENT_ACCOUNT_ID, 'background');
  assert.equal(first.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(first.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.deepEqual(purposes, ['standup', 'standup']);
});
