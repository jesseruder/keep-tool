'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const inventory = require('./node-inventory.js');

// Credential-shaped strings planted all over a fake home. None may leave the machine.
const SECRETS = {
  claudeCredentials: 'sk-ant-oat01-PLANTEDclaudeCREDENTIAL0000000000',
  npm: 'npm_PLANTEDnpmTOKEN1234567890abcdef',
  netrc: 'PLANTEDnetrcPASSWORD42',
  aws: 'PLANTEDawsSECRETkey0123456789abcdefABCD',
  env: 'PLANTEDdotenvVALUE99',
  mcpUrl: 'PLANTEDurlQUERYtoken77',
  mcpArg: 'PLANTEDargVALUE31',
  mcpEnv: 'PLANTEDmcpENVvalue55',
  mcpHeader: 'PLANTEDheaderBEARER88',
  settingsEnv: 'PLANTEDsettingsENV12',
  codexAuth: 'PLANTEDcodexAUTH65',
  codexToml: 'PLANTEDcodexBEARER43',
  piAuth: 'PLANTEDpiAUTH21',
  origin: 'PLANTEDoriginPAT19',
  helper: 'PLANTEDapiKeyHelper',
  hook: 'ghp_PLANTEDhookTOKEN0123456789',
};

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function fakeHome(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-inventory-home-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const primary = path.join(home, '.claude');
  const second = path.join(home, '.claude-second');
  write(path.join(primary, '.credentials.json'), { claudeAiOauth: { accessToken: SECRETS.claudeCredentials } });
  write(path.join(home, '.claude.json'), {
    theme: 'dark',
    oauthAccount: { emailAddress: 'owner@example.com', organizationName: 'Example' },
    mcpServers: {
      gateway: { type: 'http', url: `https://mcp.example.com/mcp?token=${SECRETS.mcpUrl}`, headers: { Authorization: `Bearer ${SECRETS.mcpHeader}` } },
      local: { type: 'stdio', command: 'npx', args: ['-y', 'example-mcp', '--api-key', SECRETS.mcpArg], env: { EXAMPLE_TOKEN: SECRETS.mcpEnv } },
    },
    projects: {
      [path.join(home, 'src', 'app')]: { mcpServers: { tracker: { type: 'http', url: 'https://tracker.example.com/mcp' } } },
    },
  });
  write(path.join(primary, 'settings.json'), {
    model: 'opus',
    env: { EXAMPLE_API_KEY: SECRETS.settingsEnv, PLAIN_FLAG: '1' },
    apiKeyHelper: `echo ${SECRETS.helper}`,
    hooks: { Stop: [{ hooks: [{ type: 'command', command: `${home}/bin/stop-hook --token ${SECRETS.hook}` }] }] },
    permissions: { allow: ['Bash(ls:*)'] },
  });
  write(path.join(primary, 'CLAUDE.md'), '# global\n');
  write(path.join(primary, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n');
  write(path.join(primary, 'projects', '-src-app', 'memory', 'MEMORY.md'), '- note\n');
  write(path.join(second, '.claude.json'), { mcpServers: {} });
  write(path.join(second, 'CLAUDE.md'), '# global, older\n');
  write(path.join(home, '.npmrc'), `//registry.npmjs.org/:_authToken=${SECRETS.npm}\n`);
  write(path.join(home, '.netrc'), `machine example.com login me password ${SECRETS.netrc}\n`);
  write(path.join(home, '.aws', 'credentials'), `[default]\naws_secret_access_key = ${SECRETS.aws}\n`);
  write(path.join(home, '.codex', 'auth.json'), { tokens: { access_token: SECRETS.codexAuth } });
  write(path.join(home, '.codex', 'config.toml'), [
    'model = "gpt-test"',
    'model_reasoning_effort = "high"',
    '[mcp_servers.docs]',
    'url = "https://docs.example.com/mcp"',
    `bearer_token = "${SECRETS.codexToml}"`,
    '[mcp_servers.docs.env]',
    'X = "1"',
    '[profiles.fast]',
    'model = "gpt-fast"',
  ].join('\n'));
  write(path.join(home, '.pi', 'agent', 'auth.json'), { key: SECRETS.piAuth });
  write(path.join(home, 'bin', 'tool.sh'), `#!/bin/sh\nexport TOKEN=${SECRETS.env}\n`);
  const repo = path.join(home, 'src', 'app');
  write(path.join(repo, '.env'), `SECRET=${SECRETS.env}\n`);
  write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return { home, primary, second, repo };
}

// No subprocess at all: the login shell, the tool versions, git and the logins are
// all answered here, the way a machine with those tools would answer them.
function fakeExec(calls, origin) {
  return (file, args, options, callback) => {
    calls.push({ file, args });
    const reply = (stdout) => setImmediate(() => callback(null, stdout, ''));
    if (args[0] === '-C' && args[2] === 'status') reply('# branch.oid 0123456789abcdef\n# branch.head main\n? stray\n');
    else if (args[0] === '-C' && args[2] === 'remote') reply(`${origin}\n`);
    else reply('');
    return { stdin: { end() {} } };
  };
}

function options(fixture, extra = {}) {
  const calls = [];
  return {
    calls,
    value: {
      home: fixture.home,
      claudeDirs: [fixture.primary, fixture.second],
      codexDirs: [path.join(fixture.home, '.codex')],
      repoRoots: [path.join(fixture.home, 'src')],
      keepDir: path.join(fixture.home, 'keep'),
      shellEnv: { PATH: '/nonexistent-bin', JAVA_HOME: '/opt/java' },
      tools: [],
      logins: false,
      execFile: fakeExec(calls, `https://someone:${SECRETS.origin}@github.com/example/app.git`),
      ...extra,
    },
  };
}

test('no planted credential ever appears in the inventory', async (t) => {
  const fixture = fakeHome(t);
  const { value } = options(fixture);
  const text = inventory.toLines(await inventory.collectInventory(value)).join('\n');
  for (const [name, secret] of Object.entries(SECRETS)) {
    assert.ok(!text.includes(secret), `${name} leaked: ${text.split('\n').find((line) => line.includes(secret))}`);
  }
  // What is there instead: presence, names and hashes.
  const lines = new Map(inventory.toLines(await inventory.collectInventory(value)).map((line) => {
    const [section, key, ...rest] = line.split('\t');
    return [`${section} ${key}`, rest.join('\t')];
  }));
  assert.equal(lines.get('claude:~/.claude credentials-file'), 'present');
  assert.equal(lines.get('codex:~/.codex auth.json'), 'present');
  assert.equal(lines.get('pi auth.json'), 'present');
  assert.equal(lines.get('misc .netrc'), 'present');
  assert.equal(lines.get('misc .aws/credentials'), 'present');
  assert.match(lines.get('dotfile .npmrc'), /^sha=[0-9a-f]{12} bytes=\d+$/);
  assert.equal(lines.get('claude:~/.claude settings.json:env:EXAMPLE_API_KEY'), 'set');
  assert.equal(lines.get('claude:~/.claude settings.json:env:PLAIN_FLAG'), '1');
  assert.equal(lines.get('claude:~/.claude settings.json:apiKeyHelper'), 'set');
  assert.equal(lines.get('claude:~/.claude mcp:user:gateway'), 'http https://mcp.example.com/mcp?token=*** headers=[Authorization]');
  assert.equal(lines.get('claude:~/.claude mcp:user:local'), 'stdio npx -y example-mcp --api-key *** env=[EXAMPLE_TOKEN]');
  assert.match(lines.get('claude:~/.claude settings.json:hooks:Stop'), /^command:~\/bin\/stop-hook --token \*\*\*$/);
  assert.match(lines.get('repo ~/src/app'), /^main@0123456 origin=https:\/\/github.com\/example\/app.git dirty=1 env=\[\.env\]/);
  assert.equal(lines.get('codex:~/.codex config:mcp_servers'), 'docs');
  assert.equal(lines.get('codex:~/.codex config:profiles'), 'fast');
  assert.equal(lines.get('codex:~/.codex config:model'), '"gpt-test"', 'a profile\'s model is not the top-level one');
});

test('the inventory reads each config dir, a project-scope MCP server, and is the same twice', async (t) => {
  const fixture = fakeHome(t);
  const first = await inventory.collectInventory(options(fixture).value);
  const second = await inventory.collectInventory(options(fixture).value);
  assert.deepEqual(first, second, 'two runs over the same machine agree line for line');
  assert.deepEqual(first.map((entry) => `${entry.section}\t${entry.key}`), first.map((entry) => `${entry.section}\t${entry.key}`).slice().sort(),
    'sorted by section then key');
  const get = (section, key) => (first.find((entry) => entry.section === section && entry.key === key) || {}).value;
  assert.equal(get('claude:~/.claude', 'mcp:project:~/src/app:tracker'), 'http https://tracker.example.com/mcp');
  assert.equal(get('claude:~/.claude', 'login'), 'owner@example.com org=Example');
  assert.match(get('claude:~/.claude', 'skills/alpha'), /^dir sha=[0-9a-f]{12} bytes=\d+$/);
  assert.match(get('claude:~/.claude', 'memory:-src-app'), /^1 files MEMORY.md=sha=/);
  assert.notEqual(get('claude:~/.claude', 'CLAUDE.md'), get('claude:~/.claude-second', 'CLAUDE.md'));
  assert.equal(get('claude:~/.claude-second', 'skills'), 'absent');
  assert.equal(get('claude:~/.claude-second', 'credentials-file'), 'absent');
  assert.equal(get('env', 'JAVA_HOME'), '/opt/java');
  assert.equal(get('inventory', 'partial'), undefined);
});

test('a collection past its deadline answers with what it has and names what was cut', async (t) => {
  const fixture = fakeHome(t);
  const hung = (file, args, opts, callback) => ({ stdin: { end() {} } });
  const entries = await inventory.collectInventory({ ...options(fixture).value, execFile: hung, deadlineMs: 200 });
  const partial = entries.find((entry) => entry.section === 'inventory' && entry.key === 'partial');
  assert.ok(partial && /repos/.test(partial.value), `partial names the repos: ${partial && partial.value}`);
  assert.ok(entries.some((entry) => entry.section === 'claude:~/.claude'), 'what finished is kept');
});

test('a remote caller may only point the collection at directories under the home', () => {
  const home = '/home/someone';
  assert.deepEqual(inventory.requestOptions({
    claudeDirs: ['~/.claude', '/home/someone/.claude-b', '/etc', '~/../other', 'relative', 7, '~/.claude'],
    codexDirs: 'not-a-list',
    repoRoots: ['~'],
    home: '/elsewhere',
  }, home), { claudeDirs: ['/home/someone/.claude', '/home/someone/.claude-b'], repoRoots: ['/home/someone'] });
  assert.deepEqual(inventory.requestOptions({}, home), {});
});

test('scrub leaves ordinary text and hides credential shapes', () => {
  assert.equal(inventory.scrub('node ~/bin/keep.js hook stop'), 'node ~/bin/keep.js hook stop');
  assert.equal(inventory.scrub('curl -H "Authorization: Bearer abc.def"'), 'curl -H "Authorization: *** ***');
  assert.equal(inventory.scrub('https://user:pw@host/x?key=1&v=2'), 'https://***@host/x?key=***&v=***');
  assert.equal(inventory.scrub('PASSWORD=hunter2 other'), 'PASSWORD=*** other');
  assert.equal(inventory.scrub('uses ghp_abcdefghij0123456789'), 'uses ***');
  assert.equal(inventory.safeArgs(['--token=abc', '--port', '8080', '-y', 'pkg']), '--token=*** --port 8080 -y pkg');
});

const A = [
  { section: 'claude:~/.claude', key: 'skills/alpha', value: 'dir sha=aaa' },
  { section: 'claude:~/.claude', key: 'skills/beta', value: 'dir sha=bbb' },
  { section: 'claude:~/.claude', key: 'memory:-proj-one', value: '1 files' },
  { section: 'claude:~/.claude', key: 'CLAUDE.md', value: 'sha=111' },
  { section: 'claude:~/.claude', key: 'settings.json:model', value: '"opus"' },
  { section: 'repo', key: '~/src/app', value: 'main@1111111' },
  { section: 'repo', key: '~/wt/app/one', value: 'wt/one@2222222' },
  { section: 'tool', key: 'gh', value: 'present' },
  { section: 'tool', key: 'brew', value: 'present' },
  { section: 'tool-path', key: 'gh', value: '/opt/homebrew/bin/gh' },
  { section: 'pi', key: 'AGENTS.md', value: 'sha=999' },
];
const B = [
  { section: 'claude:~/.claude', key: 'skills/alpha', value: 'dir sha=aaa' },
  { section: 'claude:~/.claude', key: 'skills/gamma', value: 'dir sha=ccc' },
  { section: 'claude:~/.claude', key: 'CLAUDE.md', value: 'sha=222' },
  { section: 'claude:~/.claude', key: 'settings.json:model', value: '"opus"' },
  { section: 'repo', key: '~/src/app', value: 'main@1111111' },
  { section: 'tool', key: 'gh', value: 'absent' },
  { section: 'tool', key: 'brew', value: 'absent' },
  { section: 'tool-path', key: 'gh', value: 'absent' },
  { section: 'pi', key: 'AGENTS.md', value: 'sha=999' },
];

test('the comparer sorts each key into only-on-A, only-on-B, differ or same, with its noise class', () => {
  const sections = inventory.compareInventories(A, B);
  const claude = sections.find((row) => row.section === 'claude:~/.claude');
  assert.equal(claude.same, 2);
  assert.deepEqual(claude.onlyA.map((item) => [item.key, item.noise]), [['memory:-proj-one', 'per-project memory dirs'], ['skills/beta', null]]);
  assert.deepEqual(claude.onlyB.map((item) => item.key), ['skills/gamma']);
  assert.deepEqual(claude.differ, [{ key: 'CLAUDE.md', a: 'sha=111', b: 'sha=222', noise: null }]);
  const repo = sections.find((row) => row.section === 'repo');
  assert.deepEqual(repo.onlyA, [{ key: '~/wt/app/one', value: 'wt/one@2222222', noise: 'worktrees under ~/wt' }]);
  const tool = sections.find((row) => row.section === 'tool');
  assert.deepEqual(tool.differ.map((item) => [item.key, item.noise]), [['brew', 'platform-specific tools'], ['gh', null]]);
  assert.equal(sections.find((row) => row.section === 'pi').same, 1);
});

test('the report hides the noisy classes as counts unless asked for all of it', () => {
  const sections = inventory.compareInventories(A, B);
  const report = inventory.renderComparison(sections, { nameA: 'main', nameB: 'mini' });
  assert.equal(report, [
    'main vs mini: 4 sections with differences, 1 identical',
    '',
    '## claude:~/.claude  same 2 · only on main 2 · only on mini 1 · differ 1',
    '  only on main:',
    '    skills/beta = dir sha=bbb',
    '  only on mini:',
    '    skills/gamma = dir sha=ccc',
    '  differ:',
    '    CLAUDE.md',
    '      main  sha=111',
    '      mini  sha=222',
    '  hidden: 1 per-project memory dirs (--all shows them)',
    '',
    '## repo  same 1 · only on main 1 · only on mini 0 · differ 0',
    '  hidden: 1 worktrees under ~/wt (--all shows them)',
    '',
    '## tool  same 0 · only on main 0 · only on mini 0 · differ 2',
    '  differ:',
    '    gh',
    '      main  present',
    '      mini  absent',
    '  hidden: 1 platform-specific tools (--all shows them)',
    '',
    '## tool-path  same 0 · only on main 0 · only on mini 0 · differ 1',
    '  hidden: 1 tool locations (--all shows them)',
    '',
    'identical: pi',
  ].join('\n'));
  const everything = inventory.renderComparison(sections, { nameA: 'main', nameB: 'mini', all: true });
  assert.match(everything, /memory:-proj-one = 1 files/);
  assert.match(everything, /~\/wt\/app\/one = wt\/one@2222222/);
  assert.match(everything, /brew\n {6}main {2}present\n {6}mini {2}absent/);
  assert.doesNotMatch(everything, /hidden:/);
});

test('keep node audit prints the daemon node beside the node, and says when a host is too old', async () => {
  const { nodeAudit } = require('./commands/nodes.js');
  const asked = [];
  const client = (hello) => ({
    descriptor: hello,
    request: async (type, params, requestOptions) => {
      asked.push({ type, params, requestOptions });
      return { inventory: inventory.toLines(B), partial: false, version: 1 };
    },
    close() {},
  });
  const home = '/home/someone';
  const deps = {
    homedir: home,
    daemonNode: 'main',
    accounts: { list: () => [
      { agent: 'claude', configDir: `${home}/.claude` },
      { agent: 'claude', configDir: `${home}/.claude-second` },
      { agent: 'codex', configDir: `${home}/.codex` },
    ] },
    collectInventory: async (scope) => { asked.push({ type: 'local', params: scope }); return A; },
    connect: async () => client({ protocol: 1, inventory: 1 }),
  };
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await nodeAudit(['mini'], deps);
    await nodeAudit(['mini', '--json'], deps);
  } finally { console.log = original; }
  assert.equal(lines[0], inventory.renderComparison(inventory.compareInventories(A, B), { nameA: 'main', nameB: 'mini' }));
  const json = JSON.parse(lines[1]);
  assert.equal(json.node, 'mini');
  assert.equal(json.daemonNode, 'main');
  assert.deepEqual(json.partial, { daemon: false, node: false });
  assert.equal(json.sections.length, 5);
  const remote = asked.find((call) => call.type === 'inventory');
  assert.deepEqual(remote.params, {
    claudeDirs: ['~/.claude', '~/.claude-second'], codexDirs: ['~/.codex'], repoRoots: ['~', '~/wt'],
  }, 'the node is told where to look, relative to its own home');
  assert.equal(remote.requestOptions.timeoutMs, 60e3);
  const local = asked.find((call) => call.type === 'local');
  assert.deepEqual(local.params.claudeDirs, [`${home}/.claude`, `${home}/.claude-second`]);

  await assert.rejects(nodeAudit(['mini'], { ...deps, connect: async () => client({ protocol: 1, stats: 1 }) }),
    /predates the inventory verb[\s\S]*git pull[\s\S]*keep host reload/);
  await assert.rejects(nodeAudit([], deps), /keep node audit <name>/);
  await assert.rejects(nodeAudit(['Bad'], deps), /lowercase letters and digits/);
  await assert.rejects(nodeAudit(['mini'], { ...deps, connect: async () => { throw new Error('refused'); } }), /cannot reach node mini: refused/);
});
